import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { kvStorage } from './persistence';

/** Most recent terms kept; older ones drop off the end. */
export const MAX_RECENT_SEARCHES = 10;

export interface RecentSearchState {
  /** Recent search terms, newest first. */
  recentSearches: string[];
  /**
   * Record a term as used. Trims, ignores empty, dedupes case-insensitively
   * (keeping the newest casing), moves it to the front, and caps the list.
   */
  record: (query: string) => void;
  /** Remove a single term (exact match). */
  remove: (term: string) => void;
  /** Clear the whole history. */
  clear: () => void;
}

const PERSIST_KEY = 'substreamer-recent-searches';

export const recentSearchStore = create<RecentSearchState>()(
  persist(
    (set) => ({
      recentSearches: [],

      record: (query) =>
        set((state) => {
          const trimmed = query.trim();
          if (!trimmed) return {};
          const lower = trimmed.toLowerCase();
          // Drop any existing entry with the same (case-insensitive) text so
          // the term moves to the front rather than duplicating.
          const withoutDupe = state.recentSearches.filter(
            (t) => t.toLowerCase() !== lower,
          );
          return {
            recentSearches: [trimmed, ...withoutDupe].slice(
              0,
              MAX_RECENT_SEARCHES,
            ),
          };
        }),

      remove: (term) =>
        set((state) => ({
          recentSearches: state.recentSearches.filter((t) => t !== term),
        })),

      clear: () => set({ recentSearches: [] }),
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({ recentSearches: state.recentSearches }),
    },
  ),
);
