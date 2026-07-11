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
 *
 * No in-memory copy of the songs themselves — the table is too large to keep
 * fully in JS, and we want the UI driven by SQL pagination.
 */
export interface SongIndexState {
  totalCount: number;
  hasHydrated: boolean;

  /** Write one album's songs into the index, replacing any prior entries for that album. */
  upsertSongsForAlbum: (albumId: string, songs: Child[]) => void;
  /** Patch the in-memory songs-library view for an album WITHOUT a disk write —
   *  used when the song_index write is done atomically elsewhere (fetchAlbum's
   *  combined album_details + song_index transaction). */
  patchSongsInMemory: (albumId: string, songs: Child[]) => void;
  /** Adjust `totalCount` by a known net row delta (inserted − replaced) after an
   *  atomic album persist commits — avoids a `SELECT COUNT(*)` per album. */
  addSongsToCount: (delta: number) => void;
  /** Set `totalCount` from the authoritative DB row count (one COUNT). Used by
   *  the bulk paged song sync — a per-page delta would double-count on a re-sync
   *  that upserts already-present songs. */
  refreshCountFromDb: () => Promise<void>;
  /** Reap songs for a batch of albums (Phase-5 orphan reaping). */
  deleteSongsForAlbums: (albumIds: readonly string[]) => void;
  /** Reset and re-read the count from the database (background COUNT). */
  hydrateFromDbAsync: () => Promise<void>;
  /** Force-sync the in-store count with the live DB count (diagnostics). */
  refreshCount: () => void;
}

export const songIndexStore = create<SongIndexState>()((set) => ({
  totalCount: 0,
  hasHydrated: false,

  upsertSongsForAlbum: (albumId, songs) => {
    // Optimistically patch the in-memory songs list synchronously so the UI
    // updates immediately; the SQL write runs off-thread. song_index is
    // write-through and idempotent (DELETE + INSERT OR REPLACE in one async
    // transaction), so a fire-and-forget write is safe — a late/partial write
    // self-heals on the next fetch. The totalCount (settings-only) refreshes
    // when the async write resolves.
    songLibraryStore.getState().patchAlbum(albumId, songs);
    void (async () => {
      await dbUpsertSongsForAlbumAsync(albumId, songs);
      set({ totalCount: await countSongIndexAsync() });
    })();
  },

  patchSongsInMemory: (albumId, songs) => {
    songLibraryStore.getState().patchAlbum(albumId, songs);
  },

  addSongsToCount: (delta) => {
    set((s) => ({ totalCount: Math.max(0, s.totalCount + delta) }));
  },

  refreshCountFromDb: async () => {
    set({ totalCount: await countSongIndexAsync() });
  },

  deleteSongsForAlbums: (albumIds) => {
    if (albumIds.length === 0) return;
    songLibraryStore.getState().removeAlbums(albumIds);
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
