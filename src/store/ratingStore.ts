import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { kvStorage } from './persistence';

/**
 * TODO: move to the normalized SQL model, for consistency with everything else
 * we persist. Still KV because this is transient tracking of the user's rating
 * changes — an optimistic value that follows the server's the moment it reports
 * one — not a durable dataset. It is held locally at all because no server API
 * lists the rated items with their current rating.
 */
interface RatingOverride {
  rating: number;
}

interface RatingState {
  overrides: Record<string, RatingOverride>;

  setOverride: (id: string, rating: number) => void;
  removeOverride: (id: string) => void;
  reconcileRatings: (entries: Array<{ id: string; serverRating: number }>) => void;
  clearOverrides: () => void;
}

const PERSIST_KEY = 'substreamer-ratings';

export const ratingStore = create<RatingState>()(
  persist(
    (set) => ({
      overrides: {},

      setOverride: (id, rating) =>
        set((s) => ({
          overrides: { ...s.overrides, [id]: { rating } },
        })),

      removeOverride: (id) =>
        set((s) => {
          const { [id]: _, ...rest } = s.overrides;
          return { overrides: rest };
        }),

      reconcileRatings: (entries) =>
        set((s) => {
          let changed = false;
          const newOverrides = { ...s.overrides };
          for (const { id, serverRating } of entries) {
            const existing = newOverrides[id];
            if (existing && existing.rating !== serverRating) {
              newOverrides[id] = { rating: serverRating };
              changed = true;
            }
          }
          return changed ? { overrides: newOverrides } : s;
        }),

      clearOverrides: () => set({ overrides: {} }),
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({ overrides: state.overrides }),
    }
  )
);
