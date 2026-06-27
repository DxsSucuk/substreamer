import { create } from 'zustand';
import { bumpPlayStats } from './playStats';
import { persist } from 'zustand/middleware';

import { getOverride, mbidOverrideStore } from './mbidOverrideStore';
import { createDebouncedPersistStorage } from './persistence';

import { prefetchCoverArt } from '../services/imageCacheService';
import {
  ensureCoverArtAuth,
  getArtist,
  getArtistInfo2,
  getTopSongs,
  isVariousArtists,
  getVariousArtistsBio,
  VARIOUS_ARTISTS_COVER_ART_ID,
  type ArtistInfo2,
  type ArtistWithAlbumsID3,
  type Child,
} from '../services/subsonicService';
import {
  getArtistBiography,
  searchArtistMBID,
} from '../services/musicbrainzService';
import { sanitizeBiographyText } from '../utils/formatters';
import { withTimeout } from '../utils/withTimeout';
import { layoutPreferencesStore } from './layoutPreferencesStore';
import { ratingStore } from './ratingStore';

/** Hard budget for a single artist-detail fetch (server + MB enrichment). */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * How long to remember that a bio lookup returned nothing. Keeps the app
 * from re-hammering MusicBrainz + Wikipedia on every revisit to an artist
 * that genuinely doesn't have a public bio (uncommon names, indie acts).
 * If you suspect a transient outage, the manual refresh path (a future
 * "Refresh artist info" UI) should ignore this TTL.
 */
const BIO_NEGATIVE_CACHE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

interface ArtistDetailEntry {
  artist: ArtistWithAlbumsID3;
  artistInfo: ArtistInfo2 | null;
  topSongs: Child[];
  biography: string | null;
  /** The MBID that was actually used for biography lookup (override > server > auto-search). */
  resolvedMbid: string | null;
  /** Timestamp (Date.now()) when this entry was fetched from the server. */
  retrievedAt: number;
  /** Timestamp (Date.now()) when the bio pipeline last completed (success
   *  or null result). Used to gate the negative-cache TTL so we don't
   *  re-hit MB/Wikipedia every visit for artists with no public bio. */
  bioCheckedAt?: number;
}

export interface ArtistDetailState {
  /** Artist details indexed by artist ID. */
  artists: Record<string, ArtistDetailEntry>;
  /** Fetch artist from API, store it, and return the entry. Returns null on failure.
   *  Pass `{ prefetchCovers: false }` to skip the eager cover-art cache —
   *  used by the background library sync. User-facing fetches omit it. */
  fetchArtist: (id: string, opts?: { prefetchCovers?: boolean }) => Promise<ArtistDetailEntry | null>;
  /** Re-fetch only topSongs for all cached artists (lightweight refresh). */
  refreshTopSongs: () => Promise<void>;
  /** Eagerly bump local play stats for a just-scrobbled song across every
   *  cached artist entry — updates the matching entry in `artist.album[]`
   *  and the matching entry in `topSongs[]`, wherever they appear. */
  applyLocalPlay: (songId: string, albumId: string | undefined, now: string) => void;
  /** Clear all cached artist details. */
  clearArtists: () => void;
}

const PERSIST_KEY = 'substreamer-artist-details';

export const artistDetailStore = create<ArtistDetailState>()(
  persist(
    (set, get) => ({
      artists: {},

      fetchArtist: async (id: string, opts?: { prefetchCovers?: boolean }) => {
        const prefetchCovers = opts?.prefetchCovers ?? true;
        const result = await withTimeout(async (signal) => {
          await ensureCoverArtAuth();

          const artistData = await getArtist(id);
          if (!artistData) return null;

          // Various Artists: skip all remote enrichment, inject static data.
          if (isVariousArtists(artistData.name)) {
            const entry: ArtistDetailEntry = {
              artist: {
                ...artistData,
                coverArt: VARIOUS_ARTISTS_COVER_ART_ID,
              },
              artistInfo: null,
              topSongs: [],
              biography: getVariousArtistsBio(),
              resolvedMbid: null,
              retrievedAt: Date.now(),
            };
            set({ artists: { ...get().artists, [id]: entry } });
            return entry;
          }

          // Normal artist: fetch info and top songs in parallel.
          const [infoData, topSongs] = await Promise.all([
            getArtistInfo2(id),
            getTopSongs(artistData.name, layoutPreferencesStore.getState().listLength).catch(() => [] as Child[]),
          ]);

          // Resolve biography: prefer Subsonic, fall back to MusicBrainz.
          // Within the negative-cache TTL, skip the MB/Wikipedia round-trip
          // when the previous attempt also came back empty — keeps repeat
          // visits to artists with no public bio from re-hammering MB and
          // burning their rate limit on lookups we know will fail.
          let biography: string | null = null;
          let resolvedMbid: string | null = null;
          let bioCheckedAt: number | undefined;
          const subsonicBio = infoData?.biography ? sanitizeBiographyText(infoData.biography) : null;
          if (subsonicBio && subsonicBio.length > 0) {
            biography = subsonicBio;
            resolvedMbid = getOverride(mbidOverrideStore.getState().overrides, 'artist', id)?.mbid
              ?? infoData?.musicBrainzId
              ?? null;
            bioCheckedAt = Date.now();
          } else {
            const cached = get().artists[id];
            const cachedNullStillFresh =
              cached?.biography == null &&
              cached?.bioCheckedAt != null &&
              Date.now() - cached.bioCheckedAt < BIO_NEGATIVE_CACHE_TTL_MS;

            if (cachedNullStillFresh) {
              biography = null;
              resolvedMbid = cached.resolvedMbid;
              bioCheckedAt = cached.bioCheckedAt;
            } else {
              try {
                const override = getOverride(mbidOverrideStore.getState().overrides, 'artist', id);
                const mbid = override?.mbid
                  ?? infoData?.musicBrainzId
                  ?? (await searchArtistMBID(artistData.name, signal));
                resolvedMbid = mbid;
                if (mbid) {
                  const mbBio = await getArtistBiography(mbid, signal);
                  if (mbBio) biography = sanitizeBiographyText(mbBio);
                }
                bioCheckedAt = Date.now();
              } catch {
                /* non-critical — leave bioCheckedAt unset so the next
                 *  visit retries instead of caching a network error. */
              }
            }
          }

          const entry: ArtistDetailEntry = {
            artist: artistData,
            artistInfo: infoData,
            topSongs,
            biography,
            resolvedMbid,
            retrievedAt: Date.now(),
            bioCheckedAt,
          };

          const ratingEntries: Array<{ id: string; serverRating: number }> = [
            { id, serverRating: artistData.userRating ?? 0 },
            ...topSongs.map((s) => ({ id: s.id, serverRating: s.userRating ?? 0 })),
            ...(artistData.album ?? []).map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 })),
          ];
          ratingStore.getState().reconcileRatings(ratingEntries);

          set({
            artists: {
              ...get().artists,
              [id]: entry,
            },
          });

          // Proactively cache cover art for new IDs so they survive offline.
          // Skipped during bulk sync — see prefetchCovers contract above.
          if (prefetchCovers && topSongs.length > 0) prefetchCoverArt(topSongs);

          return entry;
        }, FETCH_TIMEOUT_MS);

        return result === 'timeout' ? null : result;
      },

      refreshTopSongs: async () => {
        const entries = get().artists;
        const size = layoutPreferencesStore.getState().listLength;
        const updates: Record<string, ArtistDetailEntry> = { ...entries };
        const allTopSongs: Child[] = [];
        for (const [id, entry] of Object.entries(entries)) {
          if (isVariousArtists(entry.artist.name)) continue;
          try {
            const topSongs = await getTopSongs(entry.artist.name, size);
            updates[id] = { ...entry, topSongs };
            allTopSongs.push(...topSongs);
          } catch {
            /* keep existing topSongs */
          }
        }
        set({ artists: updates });

        // Proactively cache cover art for new IDs so they survive offline
        if (allTopSongs.length > 0) prefetchCoverArt(allTopSongs);
      },

      applyLocalPlay: (songId, albumId, now) => {
        const current = get().artists;
        let touched = false;
        const next: Record<string, ArtistDetailEntry> = {};
        for (const [id, entry] of Object.entries(current)) {
          let entryChanged = false;

          // Match and bump the album inside artist.album[] if present.
          let updatedArtist = entry.artist;
          if (albumId && entry.artist.album?.length) {
            const albumIdx = entry.artist.album.findIndex((a) => a.id === albumId);
            if (albumIdx !== -1) {
              const oldAlbum = entry.artist.album[albumIdx];
              const nextAlbum = bumpPlayStats(oldAlbum, now);
              const nextAlbums = entry.artist.album.map((a, i) =>
                i === albumIdx ? nextAlbum : a,
              );
              updatedArtist = { ...entry.artist, album: nextAlbums };
              entryChanged = true;
            }
          }

          // Match and bump the song inside topSongs[] if present.
          let updatedTopSongs = entry.topSongs;
          const topSongIdx = entry.topSongs.findIndex((s) => s.id === songId);
          if (topSongIdx !== -1) {
            const oldSong = entry.topSongs[topSongIdx];
            const nextSong: Child = bumpPlayStats(oldSong, now);
            updatedTopSongs = entry.topSongs.map((s, i) =>
              i === topSongIdx ? nextSong : s,
            );
            entryChanged = true;
          }

          if (entryChanged) {
            touched = true;
            next[id] = {
              ...entry,
              artist: updatedArtist,
              topSongs: updatedTopSongs,
            };
          } else {
            next[id] = entry;
          }
        }
        if (touched) set({ artists: next });
      },

      clearArtists: () => set({ artists: {} }),
    }),
    {
      name: PERSIST_KEY,
      storage: createDebouncedPersistStorage(),
      partialize: (state) => ({
        artists: state.artists,
      }),
    }
  )
);

