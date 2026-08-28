import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createDebouncedPersistStorage } from './persistence';

import {
  albumListRowToAlbumID3,
  listAlbumListRows,
  replaceAlbumList,
  upsertAlbums,
  type AlbumListType as RepoAlbumListType,
} from '../db/repository/albums';
import { getSortArticles } from '../db/sortArticles';
import { getDb } from './persistence/db';
import { prefetchCoverArt } from '../services/imageCacheService';
import {
  ensureCoverArtAuth,
  getFrequentlyPlayedAlbums,
  getRandomAlbums,
  getRecentlyAddedAlbums,
  getRecentlyPlayedAlbums,
  type AlbumID3,
} from '../services/subsonicService';
import { connectivityStore } from './connectivityStore';
import { layoutPreferencesStore } from './layoutPreferencesStore';
import { offlineModeStore } from './offlineModeStore';
import { ratingStore } from './ratingStore';

function reconcileAlbumRatings(albums: AlbumID3[]) {
  const entries = albums.map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 }));
  ratingStore.getState().reconcileRatings(entries);
}

export type AlbumListType =
  | 'recentlyAdded'
  | 'recentlyPlayed'
  | 'frequentlyPlayed'
  | 'randomSelection';

export interface AlbumListsState {
  recentlyAdded: AlbumID3[];
  recentlyPlayed: AlbumID3[];
  frequentlyPlayed: AlbumID3[];
  randomSelection: AlbumID3[];
  /**
   * Wall-clock ms of the last successful full refresh. Persisted so a
   * cold-start can decide whether the persisted lists are stale enough
   * to warrant an auto-refresh.
   */
  lastRefreshedAt: number;
  setRecentlyAdded: (albums: AlbumID3[]) => void;
  setRecentlyPlayed: (albums: AlbumID3[]) => void;
  setFrequentlyPlayed: (albums: AlbumID3[]) => void;
  setRandomSelection: (albums: AlbumID3[]) => void;
  refreshRecentlyAdded: () => Promise<void>;
  refreshRecentlyPlayed: () => Promise<void>;
  refreshFrequentlyPlayed: () => Promise<void>;
  refreshRandomSelection: () => Promise<void>;
  refreshAll: () => Promise<void>;
  /**
   * Refresh-all gated by minimum-interval-since-last-refresh, offline
   * mode, and server reachability. Used for auto-refresh at app launch
   * + AppState 'active' transitions, so the lists stay current without a
   * manual pull-to-refresh. Returns true if a refresh was triggered.
   */
  refreshAllIfDue: (minIntervalMs: number) => Promise<boolean>;
}


/**
 * One list refresh: fetch, reconcile ratings, write to SQL, then mirror into the store.
 *
 * Order matters. The albums are upserted FIRST because `album_list_entries.album_id` has
 * an FK to `albums` — an id with no row fails the insert. The upsert uses the MERGE policy
 * (`core.ts`): these list endpoints return a partial album view, so an authoritative write
 * would blank genre/year/MBID on rows the library sync populated in full.
 *
 * The store keeps the rendered `AlbumID3[]` for its consumers; SQL is the durable copy,
 * so a star or a rating applied elsewhere shows up the next time the list is read.
 */
async function persistList(
  listType: RepoAlbumListType,
  fetcher: (size: number) => Promise<AlbumID3[]>,
  set: (partial: Partial<AlbumListsState>) => void,
): Promise<void> {
  try {
    await ensureCoverArtAuth();
    const albums = await fetcher(layoutPreferencesStore.getState().listLength);
    reconcileAlbumRatings(albums);
    const db = getDb();
    if (db && albums.length > 0) {
      await upsertAlbums(db, albums, undefined, getSortArticles(), { merge: true });
      await replaceAlbumList(db, listType, albums.map((a) => a.id));
    }
    set({ [listType]: albums } as Partial<AlbumListsState>);
    prefetchCoverArt(albums);
  } catch {
    // Leave existing state — a transient fetch failure shouldn't blank the row.
  }
}

/** Seed the in-memory lists from SQL at startup, so the home screen renders the last
 *  known lists before (or without) a network refresh. */
export async function hydrateAlbumListsFromDb(): Promise<void> {
  const db = getDb();
  if (!db) return;
  const types: RepoAlbumListType[] = [
    'recentlyAdded',
    'recentlyPlayed',
    'frequentlyPlayed',
    'randomSelection',
  ];
  for (const listType of types) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await listAlbumListRows(db, listType);
    if (rows.length > 0) {
      albumListsStore.setState({ [listType]: rows.map(albumListRowToAlbumID3) } as Partial<AlbumListsState>);
    }
  }
}

const PERSIST_KEY = 'substreamer-album-lists';

export const albumListsStore = create<AlbumListsState>()(
  persist(
    (set, get) => ({
      recentlyAdded: [],
      recentlyPlayed: [],
      frequentlyPlayed: [],
      randomSelection: [],
      lastRefreshedAt: 0,

      setRecentlyAdded: (albums) => set({ recentlyAdded: albums }),
      setRecentlyPlayed: (albums) => set({ recentlyPlayed: albums }),
      setFrequentlyPlayed: (albums) => set({ frequentlyPlayed: albums }),
      setRandomSelection: (albums) => set({ randomSelection: albums }),

      refreshRecentlyAdded: async () => {
        await persistList('recentlyAdded', getRecentlyAddedAlbums, set);
      },

      refreshRecentlyPlayed: async () => {
        await persistList('recentlyPlayed', getRecentlyPlayedAlbums, set);
      },

      refreshFrequentlyPlayed: async () => {
        await persistList('frequentlyPlayed', getFrequentlyPlayedAlbums, set);
      },

      refreshRandomSelection: async () => {
        await persistList('randomSelection', getRandomAlbums, set);
      },

      refreshAll: async () => {
        try {
          await ensureCoverArtAuth();
          const size = layoutPreferencesStore.getState().listLength;
          const [recentlyAdded, recentlyPlayed, frequentlyPlayed, randomSelection] =
            await Promise.all([
              getRecentlyAddedAlbums(size),
              getRecentlyPlayedAlbums(size),
              getFrequentlyPlayedAlbums(size),
              getRandomAlbums(size),
            ]);
          const all = [...recentlyAdded, ...recentlyPlayed, ...frequentlyPlayed, ...randomSelection];
          reconcileAlbumRatings(all);
          const db = getDb();
          if (db && all.length > 0) {
            // ONE upsert for all four lists — they overlap heavily, and the id-sorted
            // chunking dedupes the write far better than four separate passes. MERGE:
            // these are partial album views (see `persistList`).
            await upsertAlbums(db, all, undefined, getSortArticles(), { merge: true });
            await replaceAlbumList(db, 'recentlyAdded', recentlyAdded.map((a) => a.id));
            await replaceAlbumList(db, 'recentlyPlayed', recentlyPlayed.map((a) => a.id));
            await replaceAlbumList(db, 'frequentlyPlayed', frequentlyPlayed.map((a) => a.id));
            await replaceAlbumList(db, 'randomSelection', randomSelection.map((a) => a.id));
          }
          set({
            recentlyAdded,
            recentlyPlayed,
            frequentlyPlayed,
            randomSelection,
            lastRefreshedAt: Date.now(),
          });
          prefetchCoverArt(all);
        } catch {
          // Leave existing state on full refresh failure
        }
      },

      refreshAllIfDue: async (minIntervalMs: number) => {
        // Gate 1: offline mode — never burn a network call when the user
        // has explicitly opted out of server traffic.
        if (offlineModeStore.getState().offlineMode) return false;
        // Gate 2: server reachability — skip if the connectivity layer
        // already knows we can't talk to the server (avoids logging a
        // failure for nothing).
        const conn = connectivityStore.getState();
        if (!conn.hasConnection || !conn.isServerReachable) return false;
        // Gate 3: minimum-interval-since-last-refresh — back-to-back
        // foreground/background flips shouldn't each kick a refresh.
        const last = get().lastRefreshedAt;
        if (last > 0 && Date.now() - last < minIntervalMs) return false;
        await get().refreshAll();
        return true;
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createDebouncedPersistStorage(),
      // The four lists live in `album_list_entries` + `albums`; only the refresh
      // timestamp is KV state. `hydrateAlbumListsFromDb()` seeds them at startup.
      partialize: (state) => ({ lastRefreshedAt: state.lastRefreshedAt }),
    }
  )
);

