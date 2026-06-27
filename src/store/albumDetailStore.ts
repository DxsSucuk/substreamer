import { create } from 'zustand';

import { ensureCached, prefetchCoverArt } from '../services/imageCacheService';
import { albumLibraryStore } from './albumLibraryStore';
import { coverArtForAlbum } from '../utils/coverArtId';
import {
  ensureCoverArtAuth,
  getAlbum,
  type AlbumWithSongsID3,
} from '../services/subsonicService';
import { withTimeout } from '../utils/withTimeout';
import {
  clearDetailTables,
  deleteAlbumDetail,
  hydrateAlbumDetailsAsync,
  upsertAlbumDetailAsync,
} from './persistence/detailTables';
import { ratingStore } from './ratingStore';
import { songIndexStore } from './songIndexStore';

/** Hard budget for a single album-detail fetch. */
const FETCH_TIMEOUT_MS = 15_000;

interface AlbumDetailEntry {
  album: AlbumWithSongsID3;
  /** Timestamp (Date.now()) when this entry was fetched from the server. */
  retrievedAt: number;
}

export interface AlbumDetailState {
  /** Album details indexed by album ID (hydrated from SQLite on startup). */
  albums: Record<string, AlbumDetailEntry>;
  /** True after the on-start hydration from SQLite has populated `albums`. */
  hasHydrated: boolean;
  /** Fetch album from API, store it, and return it. Returns null on failure.
   *  Pass `{ prefetchCovers: false }` to skip the eager cover-art cache —
   *  used by the background library sync so a metadata refresh doesn't
   *  kick off hundreds of image downloads. User-facing fetches (detail
   *  screens, pull-to-refresh) omit the flag so art still pre-caches. */
  fetchAlbum: (
    id: string,
    opts?: {
      prefetchCovers?: boolean;
      /** Optimistically merge the fetched album into `albumLibraryStore` (#202):
       *  `'ifAbsent'` adds it only when not yet synced; `'replace'` always
       *  overwrites (use on an explicit album-detail pull-to-refresh so edits
       *  land). Omit to leave the library untouched (bulk walk, downloads). */
      syncToLibrary?: 'ifAbsent' | 'replace';
    },
  ) => Promise<AlbumWithSongsID3 | null>;
  /** Eagerly bump local play stats for a just-scrobbled song. Updates both
   *  the album row (playCount + played) and the matching song inside
   *  `album.data.song[]`. No-op when the album isn't in the cache. */
  applyLocalPlay: (songId: string, albumId: string | undefined, now: string) => void;
  /** True if an entry for `id` already exists in memory. Cheap check used by
   *  the Phase-4 walk to skip already-cached albums. */
  hasEntry: (id: string) => boolean;
  /** Remove a single entry both in-memory and from the SQLite table. */
  removeEntry: (id: string) => void;
  /** Reap a batch of entries — used by Phase-5 library reconciliation. */
  removeEntries: (ids: readonly string[]) => void;
  /** Clear all cached album details (logout, force-resync). */
  clearAlbums: () => void;
  /** Called once at app start to load persisted rows into memory. Reads on a
   * background thread and chunks the per-row JSON.parse so a large detail
   * cache doesn't block the JS thread. Used by `rehydrateAllStores`. */
  hydrateFromDbAsync: () => Promise<void>;
}

export const albumDetailStore = create<AlbumDetailState>()((set, get) => ({
  albums: {},
  hasHydrated: false,

  fetchAlbum: async (id: string, opts?: { prefetchCovers?: boolean; syncToLibrary?: 'ifAbsent' | 'replace' }) => {
    const prefetchCovers = opts?.prefetchCovers ?? true;
    const result = await withTimeout(async () => {
      await ensureCoverArtAuth();
      const data = await getAlbum(id);
      if (data) {
        const ratingEntries: Array<{ id: string; serverRating: number }> = [
          { id: data.id, serverRating: data.userRating ?? 0 },
          ...(data.song ?? []).map((s) => ({ id: s.id, serverRating: s.userRating ?? 0 })),
        ];
        ratingStore.getState().reconcileRatings(ratingEntries);
        const retrievedAt = Date.now();
        // Update in-memory state first — subscribers see the new entry right
        // away. Persistence is explicit and runs after notify; per-row writes
        // are O(1) so this is effectively non-blocking.
        set({
          albums: {
            ...get().albums,
            [id]: { album: data, retrievedAt },
          },
        });
        void upsertAlbumDetailAsync(id, data, retrievedAt);
        // Route song-index writes through songIndexStore so its mutation
        // counter (and totalCount) stay consistent with the SQL table.
        songIndexStore.getState().upsertSongsForAlbum(id, data.song ?? []);

        // Optimistically reflect this album in the lean library list (#202) so
        // album-mode song covers resolve and pull-to-refresh edits propagate.
        // Drop `song` — the library is song-less AlbumID3[]; the full envelope
        // lives in album_details. 'ifAbsent' avoids re-sort churn on a plain
        // open of an already-synced album; 'replace' forces edits through.
        if (opts?.syncToLibrary) {
          const lib = albumLibraryStore.getState();
          const present = lib.albums.some((a) => a.id === id);
          if (opts.syncToLibrary === 'replace' || !present) {
            const { song: _song, ...albumMeta } = data;
            lib.upsertAlbums([albumMeta]);
          }
        }

        // Proactively cache cover art for new IDs so they survive offline.
        // Skipped during bulk sync — see prefetchCovers contract above.
        if (prefetchCovers) {
          const albumArtId = coverArtForAlbum(data);
          if (albumArtId) ensureCached(albumArtId).catch(() => { /* non-critical */ });
          if (data.song?.length) prefetchCoverArt(data.song);
        }
      }
      return data;
    }, FETCH_TIMEOUT_MS);

    return result === 'timeout' ? null : result;
  },

  applyLocalPlay: (songId, albumId, now) => {
    if (!albumId) return;
    const entry = get().albums[albumId];
    if (!entry) return;
    const songs = entry.album.song ?? [];
    const songIdx = songs.findIndex((s) => s.id === songId);
    if (songIdx === -1) {
      // Album in cache but song not in its song list — still bump the album's
      // own play stats (the user is playing a track that belongs to this
      // album, even if our cached song list hasn't been refreshed yet).
      const updatedAlbum: AlbumWithSongsID3 = {
        ...entry.album,
        playCount: (entry.album.playCount ?? 0) + 1,
        played: now,
      };
      const updatedEntry: AlbumDetailEntry = { ...entry, album: updatedAlbum };
      set({ albums: { ...get().albums, [albumId]: updatedEntry } });
      void upsertAlbumDetailAsync(albumId, updatedAlbum, entry.retrievedAt);
      return;
    }
    const oldSong = songs[songIdx];
    const updatedSong = {
      ...oldSong,
      playCount: (oldSong.playCount ?? 0) + 1,
      played: now,
    };
    const updatedSongs = songs.map((s, i) => (i === songIdx ? updatedSong : s));
    const updatedAlbum: AlbumWithSongsID3 = {
      ...entry.album,
      playCount: (entry.album.playCount ?? 0) + 1,
      played: now,
      song: updatedSongs,
    };
    const updatedEntry: AlbumDetailEntry = { ...entry, album: updatedAlbum };
    set({ albums: { ...get().albums, [albumId]: updatedEntry } });
    void upsertAlbumDetailAsync(albumId, updatedAlbum, entry.retrievedAt);
  },

  hasEntry: (id: string) => Object.prototype.hasOwnProperty.call(get().albums, id),

  removeEntry: (id: string) => {
    const { [id]: _removed, ...rest } = get().albums;
    set({ albums: rest });
    deleteAlbumDetail(id);
    songIndexStore.getState().deleteSongsForAlbums([id]);
  },

  removeEntries: (ids: readonly string[]) => {
    if (ids.length === 0) return;
    const current = get().albums;
    const next: Record<string, AlbumDetailEntry> = {};
    const toDelete: string[] = [];
    for (const [aid, entry] of Object.entries(current)) {
      if (ids.includes(aid)) {
        toDelete.push(aid);
      } else {
        next[aid] = entry;
      }
    }
    if (toDelete.length === 0) return;
    set({ albums: next });
    for (const aid of toDelete) deleteAlbumDetail(aid);
    songIndexStore.getState().deleteSongsForAlbums(toDelete);
  },

  clearAlbums: () => {
    set({ albums: {} });
    // clearDetailTables wipes both album_details and song_index atomically.
    // Refresh the index store's counter so UI subscribers see the change.
    clearDetailTables();
    songIndexStore.getState().refreshCount();
  },

  hydrateFromDbAsync: async () => {
    // Idempotent re-read. Can be called multiple times (e.g. once at the
    // auth-rehydrated useEffect, once after migrations complete on splash)
    // without losing data — every write path is write-through so the SQL
    // table is the canonical source of truth.
    const restored = await hydrateAlbumDetailsAsync();
    set({ albums: restored, hasHydrated: true });
  },
}));
