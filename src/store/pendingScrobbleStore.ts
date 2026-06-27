import { create } from 'zustand';

import {
  clearPendingScrobbles,
  deletePendingScrobble,
  hydratePendingScrobblesAsync,
  insertPendingScrobble,
} from './persistence/pendingScrobbleTable';

import { type Child } from '../services/subsonicService';

export interface PendingScrobble {
  /** Unique identifier for this pending scrobble entry. */
  id: string;
  /** Full Subsonic songID3 object. */
  song: Child;
  /** Unix timestamp (ms) when playback completed. */
  time: number;
}

export interface PendingScrobbleState {
  pendingScrobbles: PendingScrobble[];

  addScrobble: (song: Child, time: number) => void;
  removeScrobble: (id: string) => void;
  clearAll: () => void;
  /** Called once at app start to load persisted rows into memory. */
  hydrateFromDbAsync: () => Promise<void>;
}

export const pendingScrobbleStore = create<PendingScrobbleState>()((set, get) => ({
  pendingScrobbles: [],

  addScrobble: (song, time) => {
    if (!song?.id || !song.title) return;
    const row: PendingScrobble = {
      id: `${time}-${Math.random().toString(36).slice(2, 8)}`,
      song,
      time,
    };
    // Persist first so the row is on disk before any subscriber acts on
    // the new in-memory state.
    insertPendingScrobble(row);
    set({ pendingScrobbles: [...get().pendingScrobbles, row] });
  },

  removeScrobble: (id) => {
    if (!id) return;
    deletePendingScrobble(id);
    set({ pendingScrobbles: get().pendingScrobbles.filter((s) => s.id !== id) });
  },

  clearAll: () => {
    clearPendingScrobbles();
    set({ pendingScrobbles: [] });
  },

  hydrateFromDbAsync: async () => {
    const restored = await hydratePendingScrobblesAsync();
    set({ pendingScrobbles: restored });
  },
}));

/**
 * Convenience wrapper that exposes the underlying table clear so
 * `resetAllStores` can wipe disk state alongside the in-memory reset.
 */
export function clearPendingScrobbleTable(): void {
  clearPendingScrobbles();
}
