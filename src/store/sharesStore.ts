/**
 * The user's public share links, stored as `shares` + `share_entries` rows. Every fetch
 * and every delete writes through, and {@link SharesState.hydrateFromDbAsync} reads the
 * list back from those rows in `rehydrateAllStores`.
 *
 * The KV blob is the PREVIOUS home and still the fallback until migration 38 has moved
 * it into rows, which is what {@link SharesState.sqlAuthoritative} tracks. `persist`
 * stays: it is what hydrates the store on the launch that migration runs.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import {
  deleteShare as apiDeleteShare,
  getShares,
  type Share,
} from '../services/subsonicService';
import { kvStorage } from './persistence';
import {
  deleteShareRow,
  readShares,
  replaceShares,
  storableEntries,
} from './persistence/sharesTable';

interface SharesState {
  shares: Share[];
  loading: boolean;
  error: string | null;
  /** True when the server reports sharing is not available/authorized */
  notAvailable: boolean;
  /**
   * True once the rows have been observed to hold everything memory holds — set by
   * {@link SharesState.hydrateFromDbAsync}, never persisted. While it is false the KV
   * blob is still the complete copy and `partialize` keeps writing it.
   */
  sqlAuthoritative: boolean;

  fetchShares: () => Promise<void>;
  removeShare: (id: string) => Promise<boolean>;
  clear: () => void;
  /**
   * Replace the in-memory list from `shares`, once the rows are known to be the complete
   * set. Called from `rehydrateAllStores`; a no-op whenever it cannot prove that, which
   * leaves the KV-hydrated list alone.
   */
  hydrateFromDbAsync: () => Promise<void>;
}

/**
 * Resolve once `persist` has finished reading the KV blob. Zustand's hydration REPLACES
 * the state it lands on, so hydrating from SQL first would simply be undone by a
 * late-resolving `getItem`.
 */
const kvHydrated = (): Promise<void> =>
  new Promise<void>((resolve) => {
    if (sharesStore.persist.hasHydrated()) {
      resolve();
      return;
    }
    const unsubscribe = sharesStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });

export const sharesStore = create<SharesState>()(
  persist(
    (set, get) => ({
      shares: [],
      loading: false,
      error: null,
      notAvailable: false,
      sqlAuthoritative: false,

      fetchShares: async () => {
        set({ loading: true, error: null, notAvailable: false });
        const result = await getShares();
        if (result.ok) {
          const shares = result.shares ?? [];
          set({ shares, loading: false });
          void replaceShares(shares);
        } else if (result.reason === 'not-available') {
          // Clearing the rows as well as the list is what the blob did: `partialize`
          // wrote the empty array straight back over it.
          set({ shares: [], loading: false, notAvailable: true, error: result.message });
          void replaceShares([]);
        } else {
          set({ loading: false, error: result.message });
        }
      },

      removeShare: async (id: string) => {
        const success = await apiDeleteShare(id);
        if (success) {
          set({ shares: get().shares.filter((s) => s.id !== id) });
          // The entries cascade with the parent row.
          void deleteShareRow(id);
        }
        return success;
      },

      clear: () => set({ shares: [], loading: false, error: null, notAvailable: false }),

      hydrateFromDbAsync: async () => {
        await kvHydrated();
        const shares = await readShares();
        // Null is "could not read", not "none". Replacing the list from a failed DB open
        // would render "no shares yet" over a set that is still on the server — and
        // persist that.
        if (shares === null) return;
        // The rows are only authoritative once they hold every share the KV-hydrated list
        // holds. A non-empty table is NOT the gate: a fetch landing before the migration
        // makes it non-empty while the blob is still the only copy of the rest, and this
        // read REPLACES the list. The entry count is part of it because a share whose
        // entries were lost renders with no title and no artwork.
        const stored = new Map(shares.map((s) => [s.id, s.entry?.length ?? 0]));
        const complete = get().shares.every(
          (s) => (stored.get(s.id) ?? -1) >= storableEntries(s).length,
        );
        if (!complete) return;
        set({ shares, sqlAuthoritative: true });
      },
    }),
    {
      name: 'substreamer-shares',
      storage: createJSONStorage(() => kvStorage),
      // `shares` leaves the blob the moment the rows are proven to hold them — that is
      // the retirement of the KV copy. Until then it stays, because every `set` here
      // rewrites the blob and dropping it early would erase the only complete copy.
      partialize: (state) => ({
        ...(state.sqlAuthoritative ? {} : { shares: state.shares }),
      }),
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<SharesState>),
        /* Guard against corrupted persisted data where shares is not an array */
        shares: Array.isArray((persisted as Partial<SharesState>)?.shares)
          ? (persisted as Partial<SharesState>).shares!
          : [],
      }),
    },
  ),
);
