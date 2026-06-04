import { create } from 'zustand';

import {
  countSongIndex,
  countSongIndexAsync,
  deleteSongsForAlbumsAsync as dbDeleteSongsForAlbumsAsync,
  upsertSongsForAlbumAsync as dbUpsertSongsForAlbumAsync,
} from './persistence/detailTables';
import { songLibraryStore } from './songLibraryStore';
import type { Child } from '../services/subsonicService';

/**
 * Thin store over the `song_index` SQLite table.
 *
 * The persisted rows in SQLite are the source of truth. This store holds only
 * coordination state:
 *  - `totalCount` — running total of songs in the table (for settings UI)
 *  - `mutationCounter` — monotonic tick incremented on every write. UI code
 *    (the eventual Songs browser in Phase 7) subscribes to this and re-queries
 *    the database via paginated SELECTs when it changes.
 *
 * No in-memory copy of the songs themselves — the table is too large to keep
 * fully in JS, and we want the UI driven by SQL pagination.
 */
export interface SongIndexState {
  totalCount: number;
  mutationCounter: number;
  hasHydrated: boolean;

  /** Write one album's songs into the index, replacing any prior entries for that album. */
  upsertSongsForAlbum: (albumId: string, songs: Child[]) => void;
  /** Reap songs for a batch of albums (Phase-5 orphan reaping). */
  deleteSongsForAlbums: (albumIds: readonly string[]) => void;
  /** Reset and re-read the count from the database (background COUNT). */
  hydrateFromDbAsync: () => Promise<void>;
  /** Force-sync the in-store count with the live DB count (diagnostics). */
  refreshCount: () => void;
}

export const songIndexStore = create<SongIndexState>()((set, get) => ({
  totalCount: 0,
  mutationCounter: 0,
  hasHydrated: false,

  upsertSongsForAlbum: (albumId, songs) => {
    // Optimistically patch the in-memory songs list + bump the counter
    // synchronously so the UI updates immediately; the SQL write runs
    // off-thread. song_index is write-through and idempotent (DELETE + INSERT
    // OR REPLACE in one async transaction), so a fire-and-forget write is safe
    // — a late/partial write self-heals on the next fetch. The totalCount
    // (settings-only) refreshes when the async write resolves.
    songLibraryStore.getState().patchAlbum(albumId, songs);
    set({ mutationCounter: get().mutationCounter + 1 });
    void (async () => {
      await dbUpsertSongsForAlbumAsync(albumId, songs);
      set({ totalCount: await countSongIndexAsync() });
    })();
  },

  deleteSongsForAlbums: (albumIds) => {
    if (albumIds.length === 0) return;
    songLibraryStore.getState().removeAlbums(albumIds);
    set({ mutationCounter: get().mutationCounter + 1 });
    void (async () => {
      await dbDeleteSongsForAlbumsAsync(albumIds);
      set({ totalCount: await countSongIndexAsync() });
    })();
  },

  hydrateFromDbAsync: async () => {
    // Idempotent re-read; the per-row tables are the source of truth.
    set({ totalCount: await countSongIndexAsync(), hasHydrated: true });
  },

  refreshCount: () => {
    set({ totalCount: countSongIndex() });
  },
}));
