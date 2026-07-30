/**
 * Shared, normalized-only detail fetch for album / artist / playlist — the target-state
 * replacement for the doomed `*DetailStore.fetchX` actions.
 *
 * Online: fetch from the server, upsert into the normalized tables (the SOLE write — no
 * blob), reconcile ratings, optionally pre-cache cover art, notify open detail screens via
 * `bumpDetailChanged`, and return the entity. Offline: read the persisted normalized detail
 * (no network). ONE shared path for the app detail screens, the CarPlay/voice headless
 * service, the download path, and the background library sync/walk.
 */
import {
  ensureCoverArtAuth,
  getAlbum,
  getArtist,
  getArtistInfo2,
  getPlaylist,
  getTopSongs,
  getVariousArtistsBio,
  isVariousArtists,
  VARIOUS_ARTISTS_COVER_ART_ID,
  type AlbumWithSongsID3,
  type ArtistInfo2,
  type ArtistWithAlbumsID3,
  type Child,
  type PlaylistWithSongs,
} from './subsonicService';
import { getArtistBiography, searchArtistMBID } from './musicbrainzService';
import { ensureCached, prefetchCoverArt } from './imageCacheService';

import { getSortArticles } from '../db/sortArticles';
import { bumpDetailChanged } from '../db/detailNotifier';
import { upsertAlbums } from '../db/repository/albums';
import {
  listArtistsWithTopSongs,
  setArtistDetailMeta,
  setArtistTopSongs,
  upsertArtistInfo,
  upsertArtists,
} from '../db/repository/artists';
import { setPlaylistSongs, upsertPlaylists } from '../db/repository/playlists';
import { deleteAlbumSongsNotIn, upsertSongs } from '../db/repository/songs';
import { getAlbumDetail, getArtistDetail, getPlaylistDetail } from '../db/repository/details';
import { getDb, serializeDbWrite } from '../store/persistence/db';

import { getOverride, mbidOverrideStore } from '../store/mbidOverrideStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { ratingStore } from '../store/ratingStore';
import { coverArtForAlbum, coverArtForPlaylist } from '../utils/coverArtId';
import { sanitizeBiographyText } from '../utils/formatters';
import { withTimeout } from '../utils/withTimeout';

/** Hard budget for a single detail fetch (server + MB enrichment for artists). */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * How long to remember that a bio lookup returned nothing — keeps repeat visits to an
 * artist with no public bio from re-hammering MusicBrainz/Wikipedia. Read from the
 * persisted `bio_checked_at` column (not an in-memory map).
 */
const BIO_NEGATIVE_CACHE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

/** Effective ignored-article list for sort keys (server's, else local default). */
const articles = (): readonly string[] | undefined => getSortArticles();

/** The artist-detail bundle the artist-detail screen renders from a fetch. */
export interface ArtistDetailEntry {
  artist: ArtistWithAlbumsID3;
  artistInfo: ArtistInfo2 | null;
  topSongs: Child[];
  biography: string | null;
  resolvedMbid: string | null;
  retrievedAt: number;
  bioCheckedAt?: number;
}

/* ------------------------------------------------------------------ */
/*  Album                                                              */
/* ------------------------------------------------------------------ */

/**
 * Album detail. Online → `getAlbum`, upsert the album row + its songs into the normalized
 * model (which also reflects it in the library list — #202), reconcile ratings, pre-cache
 * art, notify, return the server envelope. Offline → the persisted normalized detail.
 */
export async function fetchAlbumDetail(
  id: string,
  opts?: { prefetchCovers?: boolean },
): Promise<AlbumWithSongsID3 | null> {
  const db = getDb();
  if (offlineModeStore.getState().offlineMode) {
    if (!db) return null;
    const d = await getAlbumDetail(db, id);
    return d ? ({ ...d.album, song: d.songs } as AlbumWithSongsID3) : null;
  }
  const prefetchCovers = opts?.prefetchCovers ?? true;
  const result = await withTimeout(async () => {
    await ensureCoverArtAuth();
    const data = await getAlbum(id);
    if (data) {
      const ratingEntries: Array<{ id: string; serverRating: number }> = [
        { id: data.id, serverRating: data.userRating ?? 0 },
        ...(data.song ?? []).map((s) => ({ id: s.id, serverRating: s.userRating ?? 0 })),
      ];
      ratingStore.getState().reconcileRatings(ratingEntries);
      if (db) {
        await serializeDbWrite(async () => {
          await upsertAlbums(db, [data], undefined, articles());
          if (data.song && data.song.length > 0) {
            await upsertSongs(db, data.song, undefined, articles());
            // Drop tracks the server no longer lists for this album — servers that
            // re-key song ids on re-tag would otherwise leave the old and new sets
            // both showing in the track list. Downloaded tracks are exempt.
            await deleteAlbumSongsNotIn(db, data.id, data.song.map((s) => s.id));
          }
        });
        bumpDetailChanged('album', id);
      }
      if (prefetchCovers) {
        const albumArtId = coverArtForAlbum(data);
        if (albumArtId) ensureCached(albumArtId).catch(() => { /* non-critical */ });
        if (data.song?.length) prefetchCoverArt(data.song);
      }
    }
    return data ?? null;
  }, FETCH_TIMEOUT_MS);
  return result === 'timeout' ? null : result;
}

/* ------------------------------------------------------------------ */
/*  Artist                                                             */
/* ------------------------------------------------------------------ */

/**
 * Artist detail. Online → `getArtist` (+ `getArtistInfo2` + `getTopSongs`), resolve the
 * biography (Subsonic → MusicBrainz, negative-cached against the persisted `bio_checked_at`),
 * upsert artist + albums + info/similar + top songs into the normalized model, reconcile
 * ratings, pre-cache art, notify, return the bundle. Offline → the persisted normalized detail.
 */
export async function fetchArtistDetail(
  id: string,
  opts?: { prefetchCovers?: boolean },
): Promise<ArtistDetailEntry | null> {
  const db = getDb();
  if (offlineModeStore.getState().offlineMode) {
    if (!db) return null;
    const d = await getArtistDetail(db, id);
    if (!d) return null;
    return {
      artist: { ...d.artist, album: d.albums } as ArtistWithAlbumsID3,
      artistInfo: d.artistInfo
        ? ({ ...d.artistInfo, biography: d.biography ?? undefined, similarArtist: d.similarArtist } as ArtistInfo2)
        : null,
      topSongs: d.topSongs,
      biography: d.biography,
      resolvedMbid: d.resolvedMbid,
      retrievedAt: 0,
      bioCheckedAt: d.bioCheckedAt ?? undefined,
    };
  }
  const prefetchCovers = opts?.prefetchCovers ?? true;
  const result = await withTimeout(async (signal) => {
    await ensureCoverArtAuth();

    const artistData = await getArtist(id);
    if (!artistData) return null;

    // Various Artists: skip all remote enrichment, inject static data + persist so the
    // local-first screen resolves VA offline too.
    if (isVariousArtists(artistData.name)) {
      const vaBio = getVariousArtistsBio();
      const vaArtist = { ...artistData, coverArt: VARIOUS_ARTISTS_COVER_ART_ID };
      const now = Date.now();
      if (db) {
        await serializeDbWrite(async () => {
          await upsertArtists(db, [vaArtist], undefined, articles());
          await setArtistTopSongs(db, id, []);
          await setArtistDetailMeta(db, id, { biography: vaBio, bioCheckedAt: now, resolvedMbid: null });
        });
        bumpDetailChanged('artist', id);
      }
      return {
        artist: vaArtist,
        artistInfo: null,
        topSongs: [],
        biography: vaBio,
        resolvedMbid: null,
        retrievedAt: now,
        bioCheckedAt: now,
      } as ArtistDetailEntry;
    }

    // Normal artist: fetch info + top songs in parallel.
    const [infoData, topSongs] = await Promise.all([
      getArtistInfo2(id),
      getTopSongs(artistData.name, layoutPreferencesStore.getState().listLength).catch(() => [] as Child[]),
    ]);

    // Resolve biography: prefer Subsonic, fall back to MusicBrainz. Within the negative-cache
    // TTL, skip the MB/Wikipedia round-trip when the LAST persisted attempt also came back
    // empty (read from the normalized `bio_checked_at`/`biography` columns).
    let biography: string | null = null;
    let resolvedMbid: string | null = null;
    let bioCheckedAt: number | undefined;
    const subsonicBio = infoData?.biography ? sanitizeBiographyText(infoData.biography) : null;
    if (subsonicBio && subsonicBio.length > 0) {
      biography = subsonicBio;
      resolvedMbid =
        getOverride(mbidOverrideStore.getState().overrides, 'artist', id)?.mbid ??
        infoData?.musicBrainzId ??
        null;
      bioCheckedAt = Date.now();
    } else {
      const cached = db ? await getArtistDetail(db, id) : null;
      const cachedNullStillFresh =
        cached != null &&
        cached.biography == null &&
        cached.bioCheckedAt != null &&
        Date.now() - cached.bioCheckedAt < BIO_NEGATIVE_CACHE_TTL_MS;
      if (cachedNullStillFresh) {
        biography = null;
        resolvedMbid = cached!.resolvedMbid;
        bioCheckedAt = cached!.bioCheckedAt ?? undefined;
      } else {
        try {
          const override = getOverride(mbidOverrideStore.getState().overrides, 'artist', id);
          const mbid =
            override?.mbid ?? infoData?.musicBrainzId ?? (await searchArtistMBID(artistData.name, signal));
          resolvedMbid = mbid;
          if (mbid) {
            const mbBio = await getArtistBiography(mbid, signal);
            if (mbBio) biography = sanitizeBiographyText(mbBio);
          }
          bioCheckedAt = Date.now();
        } catch {
          /* non-critical — leave bioCheckedAt unset so the next visit retries. */
        }
      }
    }

    const ratingEntries: Array<{ id: string; serverRating: number }> = [
      { id, serverRating: artistData.userRating ?? 0 },
      ...topSongs.map((s) => ({ id: s.id, serverRating: s.userRating ?? 0 })),
      ...(artistData.album ?? []).map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 })),
    ];
    ratingStore.getState().reconcileRatings(ratingEntries);

    if (db) {
      await serializeDbWrite(async () => {
        await upsertArtists(db, [artistData], undefined, articles());
        if (artistData.album && artistData.album.length > 0)
          await upsertAlbums(db, artistData.album, undefined, articles());
        if (infoData) upsertArtistInfo(db, id, infoData);
        if (topSongs.length > 0) await upsertSongs(db, topSongs, undefined, articles());
        await setArtistTopSongs(db, id, topSongs.map((s) => s.id));
        // RESOLVED bio + negative-cache marker last, so it wins over info.biography.
        await setArtistDetailMeta(db, id, { biography, bioCheckedAt: bioCheckedAt ?? null, resolvedMbid });
      });
      bumpDetailChanged('artist', id);
    }

    if (prefetchCovers && topSongs.length > 0) prefetchCoverArt(topSongs);

    return {
      artist: artistData,
      artistInfo: infoData,
      topSongs,
      biography,
      resolvedMbid,
      retrievedAt: Date.now(),
      bioCheckedAt,
    } as ArtistDetailEntry;
  }, FETCH_TIMEOUT_MS);

  return result === 'timeout' ? null : result;
}

/**
 * Re-fetch top songs for every artist that already has persisted top songs (invoked when the
 * user changes the list-length preference). Normalized replacement for the doomed detail
 * store's `refreshTopSongs`, which iterated an in-memory artist map.
 */
export async function refreshArtistTopSongs(): Promise<void> {
  const db = getDb();
  if (!db || offlineModeStore.getState().offlineMode) return;
  const size = layoutPreferencesStore.getState().listLength;
  const artists = await listArtistsWithTopSongs(db);
  const allTop: Child[] = [];
  for (const a of artists) {
    if (!a.name || isVariousArtists(a.name)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const top = await getTopSongs(a.name, size);
      // eslint-disable-next-line no-await-in-loop
      await serializeDbWrite(async () => {
        if (top.length > 0) await upsertSongs(db, top, undefined, articles());
        await setArtistTopSongs(db, a.id, top.map((s) => s.id));
      });
      bumpDetailChanged('artist', a.id);
      allTop.push(...top);
    } catch {
      /* keep existing top songs for this artist */
    }
  }
  if (allTop.length > 0) prefetchCoverArt(allTop);
}

/* ------------------------------------------------------------------ */
/*  Playlist                                                           */
/* ------------------------------------------------------------------ */

/**
 * Playlist detail. Online → `getPlaylist`, upsert the playlist row + member songs + ordered
 * membership into the normalized model, reconcile ratings, pre-cache art, notify, return the
 * server envelope. Offline → the persisted normalized detail.
 */
export async function fetchPlaylistDetail(
  id: string,
  opts?: { prefetchCovers?: boolean },
): Promise<PlaylistWithSongs | null> {
  const db = getDb();
  if (offlineModeStore.getState().offlineMode) {
    if (!db) return null;
    const d = await getPlaylistDetail(db, id);
    return d ? ({ ...d.playlist, entry: d.entry } as PlaylistWithSongs) : null;
  }
  const prefetchCovers = opts?.prefetchCovers ?? true;
  await ensureCoverArtAuth();
  const data = await getPlaylist(id);
  if (data) {
    const ratingEntries = (data.entry ?? []).map((s) => ({ id: s.id, serverRating: s.userRating ?? 0 }));
    ratingStore.getState().reconcileRatings(ratingEntries);
    if (db) {
      const entry = data.entry ?? [];
      await serializeDbWrite(async () => {
        await upsertPlaylists(db, [data], undefined, articles());
        if (entry.length > 0) await upsertSongs(db, entry, undefined, articles());
        setPlaylistSongs(db, id, entry.map((e) => e.id));
      });
      bumpDetailChanged('playlist', id);
    }
    if (prefetchCovers) {
      const playlistArtId = coverArtForPlaylist(data);
      if (playlistArtId) ensureCached(playlistArtId).catch(() => { /* non-critical */ });
      if (data.entry?.length) prefetchCoverArt(data.entry);
    }
  }
  return data ?? null;
}
