/**
 * The albums, artists and playlists the user has opted out of scrobbling, stored as
 * `scrobble_exclusions` rows. Every mutation writes through, and
 * {@link ScrobbleExclusionState.hydrateFromDbAsync} reads the three maps back from those
 * rows in `rehydrateAllStores`.
 *
 * The KV blob is the PREVIOUS home and still the fallback until migration 42 has moved it
 * into rows, which is what {@link ScrobbleExclusionState.sqlAuthoritative} tracks.
 * `persist` stays: it is what hydrates the store on the launch that migration runs.
 *
 * Exclusions are never capped, evicted or pruned: the user set them and there is no
 * server API to re-derive them from.
 */
import { create } from 'zustand';
import { mergeExistingWins } from './mergeRecord';
import { persist } from 'zustand/middleware';

import { createDebouncedPersistStorage } from './persistence';
import {
  deleteScrobbleExclusion,
  exclusionName,
  readScrobbleExclusions,
  replaceScrobbleExclusions,
  storableExclusions,
  writeScrobbleExclusions,
  EXCLUSION_FIELDS,
  EXCLUSION_TYPES,
  type ScrobbleExclusionMaps,
} from './persistence/scrobbleExclusionTable';

export interface ScrobbleExclusion {
  id: string;
  name: string;
}

export type ScrobbleExclusionType = 'album' | 'artist' | 'playlist';

interface ScrobbleExclusionState extends ScrobbleExclusionMaps {
  /**
   * True once the rows have been observed to hold everything memory holds — set by
   * {@link ScrobbleExclusionState.hydrateFromDbAsync}, never persisted. While it is false
   * the KV blob is still the complete copy and `partialize` keeps writing it.
   */
  sqlAuthoritative: boolean;
  addExclusion: (type: ScrobbleExclusionType, id: string, name: string) => void;
  removeExclusion: (type: ScrobbleExclusionType, id: string) => void;
  /**
   * Merge the given exclusions into the existing set: union of all three
   * dicts, existing-wins on key conflict (consistent with mbidOverrideStore).
   * Used by merge-mode backup restore. Returns counts across all three types.
   */
  mergeExclusions: (incoming: Partial<ScrobbleExclusionMaps>) => {
    added: number;
    skipped: number;
  };
  /**
   * Replace all three maps with `incoming`, dropping malformed entries. Used by
   * replace-mode backup restore; returns how many were kept. The rows are cleared and
   * rewritten in one atomic batch, so the set is never a mix of the two.
   */
  replaceExclusions: (incoming: Partial<ScrobbleExclusionMaps>) => number;
  /**
   * Replace the in-memory maps from `scrobble_exclusions`, once the rows are known to be
   * the complete set. Called from `rehydrateAllStores`; a no-op whenever it cannot prove
   * that, which leaves the KV-hydrated maps alone.
   */
  hydrateFromDbAsync: () => Promise<void>;
}

const PERSIST_KEY = 'substreamer-scrobble-exclusions';

function fieldForType(type: ScrobbleExclusionType): keyof ScrobbleExclusionMaps {
  return EXCLUSION_FIELDS[type];
}

/** An imported exclusion is untrusted — a backup file can be corrupt or hand-edited, and
 *  the browser sorts on `name` while the scrobble check matches on the map key. */
const isValidExclusion = (value: ScrobbleExclusion): boolean =>
  !!value && typeof value === 'object' && !!value.id;

/** Only the three maps, dropping anything else the caller passed. */
const pickMaps = (maps: Partial<ScrobbleExclusionMaps>): ScrobbleExclusionMaps => ({
  excludedAlbums: maps.excludedAlbums ?? {},
  excludedArtists: maps.excludedArtists ?? {},
  excludedPlaylists: maps.excludedPlaylists ?? {},
});

/**
 * Resolve once `persist` has finished reading the KV blob. Zustand's hydration REPLACES
 * the state it lands on, so hydrating from SQL first would simply be undone by a
 * late-resolving `getItem`.
 */
const kvHydrated = (): Promise<void> =>
  new Promise<void>((resolve) => {
    if (scrobbleExclusionStore.persist.hasHydrated()) {
      resolve();
      return;
    }
    const unsubscribe = scrobbleExclusionStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });

export const scrobbleExclusionStore = create<ScrobbleExclusionState>()(
  persist(
    (set, get) => ({
      excludedAlbums: {},
      excludedArtists: {},
      excludedPlaylists: {},
      sqlAuthoritative: false,

      addExclusion: (type, id, name) => {
        const field = fieldForType(type);
        set((state) => ({
          [field]: { ...state[field], [id]: { id, name } },
        }));
        void writeScrobbleExclusions([{ type, id, name }]);
      },

      removeExclusion: (type, id) => {
        const field = fieldForType(type);
        set((state) => {
          const { [id]: _, ...rest } = state[field];
          return { [field]: rest };
        });
        void deleteScrobbleExclusion(type, id);
      },

      mergeExclusions: (incoming) => {
        const state = get();
        const next: ScrobbleExclusionMaps = {
          excludedAlbums: { ...state.excludedAlbums },
          excludedArtists: { ...state.excludedArtists },
          excludedPlaylists: { ...state.excludedPlaylists },
        };
        const before = {
          excludedAlbums: new Set(Object.keys(next.excludedAlbums)),
          excludedArtists: new Set(Object.keys(next.excludedArtists)),
          excludedPlaylists: new Set(Object.keys(next.excludedPlaylists)),
        };
        const results = [
          mergeExistingWins(next.excludedAlbums, incoming.excludedAlbums, isValidExclusion),
          mergeExistingWins(next.excludedArtists, incoming.excludedArtists, isValidExclusion),
          mergeExistingWins(next.excludedPlaylists, incoming.excludedPlaylists, isValidExclusion),
        ];
        const added = results.reduce((sum, r) => sum + r.added, 0);
        const skipped = results.reduce((sum, r) => sum + r.skipped, 0);
        if (added > 0) {
          set(next);
          // Only the keys the merge actually added: one that lost the collision kept the
          // local entry, and rewriting it would swap its name for the file's.
          const merged = pickMaps({});
          for (const type of EXCLUSION_TYPES) {
            const field = fieldForType(type);
            for (const [id, value] of Object.entries(next[field])) {
              if (!before[field].has(id)) merged[field][id] = value;
            }
          }
          void writeScrobbleExclusions(storableExclusions(merged));
        }
        return { added, skipped };
      },

      replaceExclusions: (incoming) => {
        const next = pickMaps({});
        for (const type of EXCLUSION_TYPES) {
          const field = fieldForType(type);
          for (const [id, value] of Object.entries(incoming[field] ?? {})) {
            if (isValidExclusion(value)) next[field][id] = value;
          }
        }
        set(next);
        void replaceScrobbleExclusions(storableExclusions(next));
        return (
          Object.keys(next.excludedAlbums).length +
          Object.keys(next.excludedArtists).length +
          Object.keys(next.excludedPlaylists).length
        );
      },

      hydrateFromDbAsync: async () => {
        await kvHydrated();
        const maps = await readScrobbleExclusions();
        // Null is "could not read", not "none". Replacing the maps from a failed DB open
        // would start scrobbling everything the user opted out of — and persist that
        // blank over the KV copy, which is the only other place it lives.
        if (maps === null) return;
        // The rows are only authoritative once they hold every exclusion the KV-hydrated
        // maps hold. A non-empty table is NOT the gate: one exclusion added after the
        // upgrade makes it non-empty while the blob is still the only copy of the rest,
        // and this read REPLACES the maps. The name is compared too — it is the only
        // payload, and it is what the exclusion browser lists and sorts on.
        const complete = storableExclusions(get()).every((e) => {
          const stored = maps[fieldForType(e.type)][e.id];
          return stored !== undefined && stored.name === exclusionName(e.name);
        });
        if (!complete) return;
        set({ ...maps, sqlAuthoritative: true });
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createDebouncedPersistStorage(),
      // The three maps leave the blob the moment the rows are proven to hold them — that
      // is the retirement of the KV copy. Until then they stay, because every `set` here
      // rewrites the blob and dropping them early would erase the only complete copy.
      partialize: (state) =>
        state.sqlAuthoritative
          ? {}
          : {
              excludedAlbums: state.excludedAlbums,
              excludedArtists: state.excludedArtists,
              excludedPlaylists: state.excludedPlaylists,
            },
    },
  ),
);
