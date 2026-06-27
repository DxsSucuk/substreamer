import { create } from 'zustand';
import { bumpPlayStats } from './playStats';
import { persist } from 'zustand/middleware';

import i18n from '../i18n/i18n';

import { createDebouncedPersistStorage } from './persistence';

import { ensureCached, prefetchCoverArt } from '../services/imageCacheService';
import { coverArtForAlbum, coverArtForArtist } from '../utils/coverArtId';
import {
  ensureCoverArtAuth,
  getStarred2,
  type AlbumID3,
  type ArtistID3,
  type Child,
} from '../services/subsonicService';
import { ratingStore } from './ratingStore';

export interface FavoritesState {
  /** Starred songs */
  songs: Child[];
  /** Starred albums */
  albums: AlbumID3[];
  /** Starred artists */
  artists: ArtistID3[];
  /** Whether a fetch is currently in progress */
  loading: boolean;
  /** Last error message, if any */
  error: string | null;
  /** Timestamp of the last successful fetch */
  lastFetchedAt: number | null;
  /**
   * Optimistic overrides keyed by item ID.
   * When present, `useIsStarred` reads from here instead of the arrays,
   * giving instant UI feedback before `fetchStarred` completes.
   * Cleared automatically when `fetchStarred` succeeds.
   */
  overrides: Record<string, boolean>;

  /** Fetch all starred items from the server via getStarred2.
   *  Pass `{ prefetchCovers: false }` to skip the eager cover-art cache —
   *  used by the background library sync. User-facing refreshes omit it. */
  fetchStarred: (opts?: { prefetchCovers?: boolean }) => Promise<void>;
  /** Set an optimistic override for a single item. */
  setOverride: (id: string, starred: boolean) => void;
  /** Eagerly bump local play stats for a just-scrobbled song and its album
   *  when they appear in the starred lists. No-op for either half that
   *  isn't present. */
  applyLocalPlay: (songId: string, albumId: string | undefined, now: string) => void;
  /** Clear all favorites data */
  clearFavorites: () => void;
}

const PERSIST_KEY = 'substreamer-favorites';

export const favoritesStore = create<FavoritesState>()(
  persist(
    (set, get) => ({
      songs: [],
      albums: [],
      artists: [],
      loading: false,
      error: null,
      lastFetchedAt: null,
      overrides: {},

      fetchStarred: async (opts?: { prefetchCovers?: boolean }) => {
        const prefetchCovers = opts?.prefetchCovers ?? true;
        // Prevent duplicate fetches
        if (get().loading) return;

        set({ loading: true, error: null });
        try {
          await ensureCoverArtAuth();
          const { albums, artists, songs } = await getStarred2();

          const ratingEntries: Array<{ id: string; serverRating: number }> = [
            ...songs.map((s) => ({ id: s.id, serverRating: s.userRating ?? 0 })),
            ...albums.map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 })),
            ...artists.map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 })),
          ];
          ratingStore.getState().reconcileRatings(ratingEntries);

          set({
            songs,
            albums,
            artists,
            loading: false,
            lastFetchedAt: Date.now(),
            overrides: {},
          });

          // Proactively cache cover art for new IDs so they survive offline.
          // Skipped during bulk sync — see prefetchCovers contract above.
          if (prefetchCovers) {
            prefetchCoverArt(songs);
            for (const a of albums) {
              const albumArtId = coverArtForAlbum(a);
              if (albumArtId) ensureCached(albumArtId).catch(() => { /* non-critical */ });
            }
            for (const a of artists) {
              const artistArtId = coverArtForArtist(a);
              if (artistArtId) ensureCached(artistArtId).catch(() => { /* non-critical */ });
            }
          }
        } catch (e) {
          set({
            loading: false,
            error: e instanceof Error ? e.message : i18n.t('failedToLoadFavorites'),
          });
        }
      },

      setOverride: (id: string, starred: boolean) =>
        set((s) => ({ overrides: { ...s.overrides, [id]: starred } })),

      applyLocalPlay: (songId, albumId, now) => {
        const current = get();
        let songs: Child[] = current.songs;
        let albums: AlbumID3[] = current.albums;
        let changed = false;

        const songIdx = current.songs.findIndex((s) => s.id === songId);
        if (songIdx !== -1) {
          const oldSong = current.songs[songIdx];
          const nextSong: Child = bumpPlayStats(oldSong, now);
          songs = current.songs.map((s, i) => (i === songIdx ? nextSong : s));
          changed = true;
        }

        if (albumId) {
          const albumIdx = current.albums.findIndex((a) => a.id === albumId);
          if (albumIdx !== -1) {
            const oldAlbum = current.albums[albumIdx];
            const nextAlbum: AlbumID3 = bumpPlayStats(oldAlbum, now);
            albums = current.albums.map((a, i) => (i === albumIdx ? nextAlbum : a));
            changed = true;
          }
        }

        if (changed) set({ songs, albums });
      },

      clearFavorites: () =>
        set({
          songs: [],
          albums: [],
          artists: [],
          loading: false,
          error: null,
          lastFetchedAt: null,
          overrides: {},
        }),
    }),
    {
      name: PERSIST_KEY,
      storage: createDebouncedPersistStorage(),
      partialize: (state) => ({
        songs: state.songs,
        albums: state.albums,
        artists: state.artists,
        lastFetchedAt: state.lastFetchedAt,
      }),
    }
  )
);
