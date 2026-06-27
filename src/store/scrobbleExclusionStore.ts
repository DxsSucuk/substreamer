import { create } from 'zustand';
import { mergeExistingWins } from './mergeRecord';
import { persist } from 'zustand/middleware';

import { createDebouncedPersistStorage } from './persistence';

export interface ScrobbleExclusion {
  id: string;
  name: string;
}

export type ScrobbleExclusionType = 'album' | 'artist' | 'playlist';

interface ScrobbleExclusionState {
  excludedAlbums: Record<string, ScrobbleExclusion>;
  excludedArtists: Record<string, ScrobbleExclusion>;
  excludedPlaylists: Record<string, ScrobbleExclusion>;
  addExclusion: (type: ScrobbleExclusionType, id: string, name: string) => void;
  removeExclusion: (type: ScrobbleExclusionType, id: string) => void;
  /**
   * Merge the given exclusions into the existing set: union of all three
   * dicts, existing-wins on key conflict (consistent with mbidOverrideStore).
   * Used by merge-mode backup restore. Returns counts across all three types.
   */
  mergeExclusions: (incoming: {
    excludedAlbums?: Record<string, ScrobbleExclusion>;
    excludedArtists?: Record<string, ScrobbleExclusion>;
    excludedPlaylists?: Record<string, ScrobbleExclusion>;
  }) => { added: number; skipped: number };
}

const PERSIST_KEY = 'substreamer-scrobble-exclusions';

function fieldForType(type: ScrobbleExclusionType): keyof Pick<ScrobbleExclusionState, 'excludedAlbums' | 'excludedArtists' | 'excludedPlaylists'> {
  switch (type) {
    case 'album': return 'excludedAlbums';
    case 'artist': return 'excludedArtists';
    case 'playlist': return 'excludedPlaylists';
  }
}

export const scrobbleExclusionStore = create<ScrobbleExclusionState>()(
  persist(
    (set, get) => ({
      excludedAlbums: {},
      excludedArtists: {},
      excludedPlaylists: {},

      addExclusion: (type, id, name) => {
        const field = fieldForType(type);
        set((state) => ({
          [field]: { ...state[field], [id]: { id, name } },
        }));
      },

      removeExclusion: (type, id) => {
        const field = fieldForType(type);
        set((state) => {
          const { [id]: _, ...rest } = state[field];
          return { [field]: rest };
        });
      },

      mergeExclusions: (incoming) => {
        const state = get();
        const next = {
          excludedAlbums: { ...state.excludedAlbums },
          excludedArtists: { ...state.excludedArtists },
          excludedPlaylists: { ...state.excludedPlaylists },
        };
        const isValid = (value: ScrobbleExclusion) =>
          !!value && typeof value === 'object' && !!value.id;
        const results = [
          mergeExistingWins(next.excludedAlbums, incoming.excludedAlbums, isValid),
          mergeExistingWins(next.excludedArtists, incoming.excludedArtists, isValid),
          mergeExistingWins(next.excludedPlaylists, incoming.excludedPlaylists, isValid),
        ];
        const added = results.reduce((sum, r) => sum + r.added, 0);
        const skipped = results.reduce((sum, r) => sum + r.skipped, 0);
        if (added > 0) set(next);
        return { added, skipped };
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createDebouncedPersistStorage(),
      partialize: (state) => ({
        excludedAlbums: state.excludedAlbums,
        excludedArtists: state.excludedArtists,
        excludedPlaylists: state.excludedPlaylists,
      }),
    },
  ),
);
