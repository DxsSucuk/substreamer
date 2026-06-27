import { create } from 'zustand';
import { mergeExistingWins } from './mergeRecord';
import { createJSONStorage, persist } from 'zustand/middleware';

import { kvStorage } from './persistence';
import { type Child } from '../services/subsonicService';

/**
 * A saved snapshot of the play queue plus the position of the current track,
 * so the user can later restore the queue and resume playback exactly where
 * they left off. Fully local to Substreamer — never pushed to the server, but
 * included in backups (see backupService) so it survives reinstall/device
 * change like completed plays and scrobble exclusions.
 */
export interface PlayQueueBookmark {
  /** Stable per-bookmark UUID. */
  id: string;
  /** User-facing name (auto-generated or entered). */
  name: string;
  /** Creation time, ms epoch. */
  createdAt: number;
  /** Full queue snapshot, same Child[] shape queuePersistenceService persists. */
  queue: Child[];
  /** Index of the current track within `queue`. */
  currentIndex: number;
  /** Playback position within the current track, in seconds. */
  positionSec: number;
}

type BookmarkSort = 'newest' | 'oldest';

interface BookmarksState {
  bookmarks: Record<string, PlayQueueBookmark>;
  /** When true, tapping the player bookmark icon auto-names the bookmark. */
  autoName: boolean;
  /** Persisted sort order for the bookmarks list. */
  sortOrder: BookmarkSort;

  addBookmark: (bookmark: PlayQueueBookmark) => void;
  removeBookmark: (id: string) => void;
  renameBookmark: (id: string, name: string) => void;
  setAutoName: (autoName: boolean) => void;
  setSortOrder: (sortOrder: BookmarkSort) => void;
  /**
   * Merge incoming bookmarks into the existing set: union, existing-wins on id
   * collision (consistent with scrobbleExclusionStore/mbidOverrideStore). Used
   * by merge-mode backup restore. Returns counts.
   */
  mergeBookmarks: (
    incoming: Record<string, PlayQueueBookmark>,
  ) => { added: number; skipped: number };
}

const PERSIST_KEY = 'substreamer-bookmarks';

export const bookmarksStore = create<BookmarksState>()(
  persist(
    (set, get) => ({
      bookmarks: {},
      autoName: true,
      sortOrder: 'newest',

      addBookmark: (bookmark) =>
        set((state) => ({
          bookmarks: { ...state.bookmarks, [bookmark.id]: bookmark },
        })),

      removeBookmark: (id) =>
        set((state) => {
          const { [id]: _removed, ...rest } = state.bookmarks;
          return { bookmarks: rest };
        }),

      renameBookmark: (id, name) =>
        set((state) => {
          const existing = state.bookmarks[id];
          if (!existing) return state;
          return { bookmarks: { ...state.bookmarks, [id]: { ...existing, name } } };
        }),

      setAutoName: (autoName) => set({ autoName }),
      setSortOrder: (sortOrder) => set({ sortOrder }),

      mergeBookmarks: (incoming) => {
        const next = { ...get().bookmarks };
        const { added, skipped } = mergeExistingWins(
          next,
          incoming,
          (value) =>
            !!value && typeof value === 'object' && !!value.id && Array.isArray(value.queue),
        );
        if (added > 0) set({ bookmarks: next });
        return { added, skipped };
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({
        bookmarks: state.bookmarks,
        autoName: state.autoName,
        sortOrder: state.sortOrder,
      }),
    },
  ),
);
