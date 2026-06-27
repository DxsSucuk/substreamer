import { create } from 'zustand';
import { mergeExistingWins } from './mergeRecord';
import { persist } from 'zustand/middleware';

import { createDebouncedPersistStorage } from './persistence';

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

const PERSIST_KEY = 'substreamer-mbid-overrides';

export const mbidOverrideStore = create<MbidOverrideState>()(
  persist(
    (set, get) => ({
      overrides: {},

      setOverride: (type: MbidOverrideType, entityId: string, entityName: string, mbid: string) =>
        set((state) => {
          const key = overrideKey(type, entityId);
          return {
            overrides: {
              ...state.overrides,
              [key]: { type, entityId, entityName, mbid },
            },
          };
        }),

      removeOverride: (type: MbidOverrideType, entityId: string) =>
        set((state) => {
          const key = overrideKey(type, entityId);
          const { [key]: _, ...rest } = state.overrides;
          return { overrides: rest };
        }),

      clearOverrides: () => set({ overrides: {} }),

      mergeOverrides: (incoming) => {
        const next: Record<string, MbidOverride> = { ...get().overrides };
        const { added, skipped } = mergeExistingWins(
          next,
          incoming,
          (value) => !!value && typeof value === 'object',
        );
        if (added > 0) set({ overrides: next });
        return { added, skipped };
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createDebouncedPersistStorage(),
      partialize: (state) => ({
        overrides: state.overrides,
      }),
    }
  )
);
