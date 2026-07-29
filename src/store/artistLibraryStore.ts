import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import i18n from '../i18n/i18n';

import { createDebouncedPersistStorage } from './persistence';

import { upsertArtists } from '../db/repository/artists';
import {
  ensureCoverArtAuth,
  getAllArtists,
  type ArtistID3,
} from '../services/subsonicService';
import { getDb } from './persistence/db';
import { ratingStore } from './ratingStore';
import { serverInfoStore } from './serverInfoStore';

export interface ArtistLibraryState {
  /** All artists in the user's library */
  artists: ArtistID3[];
  /** Whether a fetch is currently in progress */
  loading: boolean;
  /** Last error message, if any */
  error: string | null;
  /** Timestamp of the last successful fetch */
  lastFetchedAt: number | null;

  /** Fetch all artists from the server via getArtists. */
  fetchAllArtists: () => Promise<void>;
  /** Clear all artist data */
  clearArtists: () => void;
}

const PERSIST_KEY = 'substreamer-artist-library';

export const artistLibraryStore = create<ArtistLibraryState>()(
  persist(
    (set, get) => ({
      artists: [],
      loading: false,
      error: null,
      lastFetchedAt: null,

      fetchAllArtists: async () => {
        // Prevent duplicate fetches
        if (get().loading) return;

        set({ loading: true, error: null });
        try {
          await ensureCoverArtAuth();
          const artists = await getAllArtists();

          ratingStore.getState().reconcileRatings(
            artists.map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 }))
          );
          // Array stays for search + filtered views (retired in the search phase).
          set({ artists, loading: false });
          // ALSO populate the normalized `artists` table — the source the keyset
          // artist list reads. Best-effort; a normalized-write failure must not break
          // the array set. Bump `lastFetchedAt` AFTER the write so the list reloads
          // with rows present. Articles match the scroller (server list, else default).
          try {
            const db = getDb();
            if (db) {
              await upsertArtists(
                db,
                artists,
                undefined,
                serverInfoStore.getState().ignoredArticles ?? undefined,
              );
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[artistLibraryStore] normalized artists upsert failed', err);
          }
          set({ lastFetchedAt: Date.now() });
        } catch (e) {
          set({
            loading: false,
            error: e instanceof Error ? e.message : i18n.t('failedToLoadArtists'),
          });
        }
      },

      clearArtists: () =>
        set({
          artists: [],
          loading: false,
          error: null,
          lastFetchedAt: null,
        }),
    }),
    {
      name: PERSIST_KEY,
      storage: createDebouncedPersistStorage(),
      partialize: (state) => ({
        artists: state.artists,
        lastFetchedAt: state.lastFetchedAt,
      }),
    }
  )
);
