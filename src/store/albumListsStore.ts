import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createDebouncedPersistStorage } from './persistence';

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
   * + AppState 'active' transitions — fixes #148 ("Recently Played" not
   * syncing without manual pull-to-refresh). Returns true if a refresh
   * was actually triggered.
   */
  refreshAllIfDue: (minIntervalMs: number) => Promise<boolean>;
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
        try {
          await ensureCoverArtAuth();
          const albums = await getRecentlyAddedAlbums(layoutPreferencesStore.getState().listLength);
          reconcileAlbumRatings(albums);
          set({ recentlyAdded: albums });
          prefetchCoverArt(albums);
        } catch {
          // Leave existing state — a transient fetch failure shouldn't blank the row.
        }
      },

      refreshRecentlyPlayed: async () => {
        try {
          await ensureCoverArtAuth();
          const albums = await getRecentlyPlayedAlbums(layoutPreferencesStore.getState().listLength);
          reconcileAlbumRatings(albums);
          set({ recentlyPlayed: albums });
          prefetchCoverArt(albums);
        } catch {
          // Leave existing state — a transient fetch failure shouldn't blank the row.
        }
      },

      refreshFrequentlyPlayed: async () => {
        try {
          await ensureCoverArtAuth();
          const albums = await getFrequentlyPlayedAlbums(layoutPreferencesStore.getState().listLength);
          reconcileAlbumRatings(albums);
          set({ frequentlyPlayed: albums });
          prefetchCoverArt(albums);
        } catch {
          // Leave existing state — a transient fetch failure shouldn't blank the row.
        }
      },

      refreshRandomSelection: async () => {
        try {
          await ensureCoverArtAuth();
          const albums = await getRandomAlbums(layoutPreferencesStore.getState().listLength);
          reconcileAlbumRatings(albums);
          set({ randomSelection: albums });
          prefetchCoverArt(albums);
        } catch {
          // Leave existing state — a transient fetch failure shouldn't blank the row.
        }
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
          reconcileAlbumRatings([...recentlyAdded, ...recentlyPlayed, ...frequentlyPlayed, ...randomSelection]);
          set({
            recentlyAdded,
            recentlyPlayed,
            frequentlyPlayed,
            randomSelection,
            lastRefreshedAt: Date.now(),
          });
          prefetchCoverArt([
            ...recentlyAdded,
            ...recentlyPlayed,
            ...frequentlyPlayed,
            ...randomSelection,
          ]);
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
        if (!conn.isInternetReachable || !conn.isServerReachable) return false;
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
      partialize: (state) => ({
        recentlyAdded: state.recentlyAdded,
        recentlyPlayed: state.recentlyPlayed,
        frequentlyPlayed: state.frequentlyPlayed,
        randomSelection: state.randomSelection,
        lastRefreshedAt: state.lastRefreshedAt,
      }),
    }
  )
);

