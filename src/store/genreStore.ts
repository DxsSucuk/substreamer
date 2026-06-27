import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createDebouncedPersistStorage } from './persistence';

import { getGenres, type Genre } from '../services/subsonicService';

export interface GenreState {
  genres: Genre[];
  fetchGenres: () => Promise<void>;
}

const PERSIST_KEY = 'substreamer-genres';

export const genreStore = create<GenreState>()(
  persist(
    (set) => ({
      genres: [],

      fetchGenres: async () => {
        const genres = await getGenres();
        if (genres) {
          set({ genres });
        }
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createDebouncedPersistStorage(),
      partialize: (state) => ({
        genres: state.genres,
      }),
    }
  )
);
