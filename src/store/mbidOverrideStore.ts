/**
 * The user's manual MusicBrainz corrections, stored as `mbid_overrides` rows. Every
 * mutation writes through, and {@link MbidOverrideState.hydrateFromDbAsync} reads the map
 * back from those rows in `rehydrateAllStores`.
 *
 * The KV blob is the PREVIOUS home and still the fallback until migration 42 has moved it
 * into rows, which is what {@link MbidOverrideState.sqlAuthoritative} tracks. `persist`
 * stays: it is what hydrates the store on the launch that migration runs.
 *
 * Overrides are never capped, evicted or pruned: the user typed them and there is no
 * server API to re-derive them from.
 */
import { create } from 'zustand';
import { mergeExistingWins } from './mergeRecord';
import { persist } from 'zustand/middleware';

import { createDebouncedPersistStorage } from './persistence';
import {
  deleteMbidOverride,
  overrideName,
  readMbidOverrides,
  replaceMbidOverrides,
  storableOverrides,
  writeMbidOverrides,
} from './persistence/mbidOverrideTable';

export type MbidOverrideType = 'artist' | 'album';

export interface MbidOverride {
  type: MbidOverrideType;
  entityId: string;
  entityName: string;
  mbid: string;
}

interface MbidOverrideState {
  /** Map of entity key ("artist:id" or "album:id") -> MBID override entry */
  overrides: Record<string, MbidOverride>;
  /**
   * True once the rows have been observed to hold everything memory holds — set by
   * {@link MbidOverrideState.hydrateFromDbAsync}, never persisted. While it is false the
   * KV blob is still the complete copy and `partialize` keeps writing it.
   */
  sqlAuthoritative: boolean;
  setOverride: (type: MbidOverrideType, entityId: string, entityName: string, mbid: string) => void;
  removeOverride: (type: MbidOverrideType, entityId: string) => void;
  clearOverrides: () => void;
  /**
   * Merge the given overrides into the existing set: for each key in
   * `incoming`, only set if no local entry exists. Conflict policy is
   * existing-wins so the user's most recent edit on this device is
   * preserved. Used by merge-mode backup restore.
   */
  mergeOverrides: (
    incoming: Record<string, MbidOverride>,
  ) => { added: number; skipped: number };
  /**
   * Replace the whole set with `incoming`, dropping malformed entries. Used by
   * replace-mode backup restore; returns how many were kept. The rows are cleared and
   * rewritten in one atomic batch, so the set is never a mix of the two.
   */
  replaceOverrides: (incoming: Record<string, MbidOverride>) => number;
  /**
   * Replace the in-memory map from `mbid_overrides`, once the rows are known to be the
   * complete set. Called from `rehydrateAllStores`; a no-op whenever it cannot prove
   * that, which leaves the KV-hydrated map alone.
   */
  hydrateFromDbAsync: () => Promise<void>;
}

function overrideKey(type: MbidOverrideType, entityId: string): string {
  return `${type}:${entityId}`;
}

/** Look up an override by type and entity ID. */
export function getOverride(
  overrides: Record<string, MbidOverride>,
  type: MbidOverrideType,
  entityId: string,
): MbidOverride | undefined {
  return overrides[overrideKey(type, entityId)];
}

/** An imported override is untrusted — a backup file can be corrupt or hand-edited. */
const isValidOverride = (value: MbidOverride): boolean =>
  !!value && typeof value === 'object';

/** Rebuild the map from the rows. The key is `${type}:${entityId}` — exactly what the PK
 *  encodes — so a round trip through the table is identity for every writer we have. */
const mapFromRows = (rows: readonly MbidOverride[]): Record<string, MbidOverride> => {
  const overrides: Record<string, MbidOverride> = {};
  for (const row of rows) overrides[overrideKey(row.type, row.entityId)] = row;
  return overrides;
};

const PERSIST_KEY = 'substreamer-mbid-overrides';

/**
 * Resolve once `persist` has finished reading the KV blob. Zustand's hydration REPLACES
 * the state it lands on, so hydrating from SQL first would simply be undone by a
 * late-resolving `getItem`.
 */
const kvHydrated = (): Promise<void> =>
  new Promise<void>((resolve) => {
    if (mbidOverrideStore.persist.hasHydrated()) {
      resolve();
      return;
    }
    const unsubscribe = mbidOverrideStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });

export const mbidOverrideStore = create<MbidOverrideState>()(
  persist(
    (set, get) => ({
      overrides: {},
      sqlAuthoritative: false,

      setOverride: (type: MbidOverrideType, entityId: string, entityName: string, mbid: string) => {
        const entry: MbidOverride = { type, entityId, entityName, mbid };
        set((state) => ({
          overrides: { ...state.overrides, [overrideKey(type, entityId)]: entry },
        }));
        void writeMbidOverrides([entry]);
      },

      removeOverride: (type: MbidOverrideType, entityId: string) => {
        set((state) => {
          const key = overrideKey(type, entityId);
          const { [key]: _, ...rest } = state.overrides;
          return { overrides: rest };
        });
        void deleteMbidOverride(type, entityId);
      },

      clearOverrides: () => {
        set({ overrides: {} });
        void replaceMbidOverrides([]);
      },

      mergeOverrides: (incoming) => {
        const next: Record<string, MbidOverride> = { ...get().overrides };
        const before = new Set(Object.keys(next));
        const { added, skipped } = mergeExistingWins(next, incoming, isValidOverride);
        if (added > 0) {
          set({ overrides: next });
          // Only the keys the merge actually added: one that lost the collision kept the
          // local entry, and rewriting it would swap its mbid for the file's.
          const merged = Object.keys(next)
            .filter((key) => !before.has(key))
            .map((key) => next[key]);
          void writeMbidOverrides(merged);
        }
        return { added, skipped };
      },

      replaceOverrides: (incoming) => {
        const overrides: Record<string, MbidOverride> = {};
        for (const [key, value] of Object.entries(incoming)) {
          if (isValidOverride(value)) overrides[key] = value;
        }
        set({ overrides });
        void replaceMbidOverrides(Object.values(overrides));
        return Object.keys(overrides).length;
      },

      hydrateFromDbAsync: async () => {
        await kvHydrated();
        const rows = await readMbidOverrides();
        // Null is "could not read", not "none". Replacing the map from a failed DB open
        // would blank a set the user typed by hand — and persist that blank over the KV
        // copy, which is the only other place it lives.
        if (rows === null) return;
        const overrides = mapFromRows(rows);
        // The rows are only authoritative once they hold every override the KV-hydrated
        // map holds. A non-empty table is NOT the gate: one correction made after the
        // upgrade makes it non-empty while the blob is still the only copy of the rest,
        // and this read REPLACES the map. The mbid is compared too — it is the whole
        // point of the entry, and a write-through that failed silently would otherwise
        // revert the user's latest edit on the next launch.
        const complete = storableOverrides(Object.values(get().overrides)).every((o) => {
          const stored = overrides[overrideKey(o.type, o.entityId)];
          return stored?.mbid === o.mbid && stored.entityName === overrideName(o.entityName);
        });
        if (!complete) return;
        set({ overrides, sqlAuthoritative: true });
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createDebouncedPersistStorage(),
      // `overrides` leaves the blob the moment the rows are proven to hold them — that is
      // the retirement of the KV copy. Until then it stays, because every `set` here
      // rewrites the blob and dropping it early would erase the only complete copy.
      partialize: (state) => ({
        ...(state.sqlAuthoritative ? {} : { overrides: state.overrides }),
      }),
    }
  )
);
