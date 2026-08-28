/**
 * The server's genre list, stored as `genres` rows. Every fetch writes through, and
 * {@link GenreState.hydrateFromDbAsync} reads the list back from those rows in
 * `rehydrateAllStores`.
 *
 * The KV blob is the PREVIOUS home and still the fallback until migration 38 has moved
 * it into rows, which is what {@link GenreState.sqlAuthoritative} tracks. `persist`
 * stays: it is what hydrates the store on the launch that migration runs.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createDebouncedPersistStorage } from './persistence';
import { readGenres, replaceGenres } from './persistence/genresTable';

import { getGenres, type Genre } from '../services/subsonicService';

export interface GenreState {
  genres: Genre[];
  /**
   * True once the rows have been observed to hold everything memory holds — set by
   * {@link GenreState.hydrateFromDbAsync}, never persisted. While it is false the KV
   * blob is still the complete copy and `partialize` keeps writing it.
   */
  sqlAuthoritative: boolean;
  fetchGenres: () => Promise<void>;
  /**
   * Replace the in-memory list from `genres`, once the rows are known to be the complete
   * set. Called from `rehydrateAllStores`; a no-op whenever it cannot prove that, which
   * leaves the KV-hydrated list alone.
   */
  hydrateFromDbAsync: () => Promise<void>;
}

const PERSIST_KEY = 'substreamer-genres';

/**
 * Resolve once `persist` has finished reading the KV blob. Zustand's hydration REPLACES
 * the state it lands on, so hydrating from SQL first would simply be undone by a
 * late-resolving `getItem`.
 */
const kvHydrated = (): Promise<void> =>
  new Promise<void>((resolve) => {
    if (genreStore.persist.hasHydrated()) {
      resolve();
      return;
    }
    const unsubscribe = genreStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });

export const genreStore = create<GenreState>()(
  persist(
    (set, get) => ({
      genres: [],
      sqlAuthoritative: false,

      fetchGenres: async () => {
        const genres = await getGenres();
        if (genres) {
          set({ genres });
          void replaceGenres(genres);
        }
      },

      hydrateFromDbAsync: async () => {
        await kvHydrated();
        const genres = await readGenres();
        // Null is "could not read", not "none". Replacing the list from a failed DB open
        // would blank the genre chips and the mix builder — and persist that.
        if (genres === null) return;
        // The rows are only authoritative once they hold every genre the KV-hydrated list
        // holds. A non-empty table is NOT the gate: a fetch landing before the migration
        // makes it non-empty while the blob is still the only copy of the rest, and this
        // read REPLACES the list.
        const stored = new Set(genres.map((g) => g.value));
        if (!get().genres.every((g) => stored.has(g.value))) return;
        set({ genres, sqlAuthoritative: true });
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createDebouncedPersistStorage(),
      // `genres` leaves the blob the moment the rows are proven to hold them — that is
      // the retirement of the KV copy. Until then it stays, because every `set` here
      // rewrites the blob and dropping it early would erase the only complete copy.
      partialize: (state) => ({
        ...(state.sqlAuthoritative ? {} : { genres: state.genres }),
      }),
    }
  )
);
