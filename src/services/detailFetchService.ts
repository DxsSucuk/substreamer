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
  setArtistTopSongs,
  upsertArtistBio,
  upsertArtistInfo,
  upsertArtists,
} from '../db/repository/artists';
import { setPlaylistSongs, upsertPlaylists } from '../db/repository/playlists';
import { deleteAlbumSongsNotIn, upsertSongs } from '../db/repository/songs';
import {
  getAlbumDetail,
  getArtistBase,
  getArtistBioRow,
  getArtistInfoRow,
  getArtistTopSongsRow,
  getPlaylistDetail,
  type ArtistBase,
  type ArtistBioRow,
  type ArtistInfoRow,
  type ArtistTopSongsRow,
} from '../db/repository/details';
import { getDb } from '../store/persistence/db';

import { getOverride, mbidOverrideStore } from '../store/mbidOverrideStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { ratingStore } from '../store/ratingStore';
import { coverArtForAlbum, coverArtForPlaylist } from '../utils/coverArtId';
import { nonEmptyBio } from '../utils/formatters';
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
  opts?: { prefetchCovers?: boolean; force?: boolean },
): Promise<AlbumWithSongsID3 | null> {
  const db = getDb();
  // LOCAL FIRST — that is what the local database is for. If we already hold this album's
  // tracks we answer from them and make no server round trip at all, reachable or not.
  // Only `force` (pull-to-refresh, a download top-up, the sync reconcile) asks the server,
  // and even then an unanswerable server falls back here rather than returning nothing.
  // A row with no songs is a MISS, not an empty album: the `albums` row exists for
  // everything in the library whether or not its tracks were ever fetched.
  const local = async (): Promise<AlbumWithSongsID3 | null> => {
    if (!db) return null;
    const d = await getAlbumDetail(db, id);
    return d && d.songs.length > 0 ? ({ ...d.album, song: d.songs } as AlbumWithSongsID3) : null;
  };
  if (offlineModeStore.getState().offlineMode) return local();
  if (!opts?.force) {
    const cached = await local();
    if (cached) return cached;
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
        const songs = data.song ?? [];
        await upsertAlbums(db, [data], undefined, articles());
        if (songs.length > 0) {
          await upsertSongs(db, songs, undefined, articles());
          // Drop tracks the server no longer lists for this album — servers that
          // re-key song ids on re-tag would otherwise leave the old and new sets
          // both showing in the track list. Downloaded tracks are exempt.
          await deleteAlbumSongsNotIn(db, data.id, songs.map((s) => s.id));
        }
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
  // A fresh server answer always wins; anything else falls back to what we hold.
  return result === 'timeout' || result == null ? local() : result;
}

/* ------------------------------------------------------------------ */
/*  Artist                                                             */
/* ------------------------------------------------------------------ */

/* ── Artist: four independent parts, each with its own freshness ──────────────── */

/** Single-flight per `part:id`. A request whose invalidation is STRONGER than the one in
 *  flight chains after it rather than joining: joining would return a pre-override result
 *  and report success having changed nothing, while running concurrently would make two
 *  writers of the same row, the slower (unforced) one landing last and clobbering. */
type Strength = 0 | 1 | 2; // none < force < reresolve
const inFlightArtist = new Map<string, { promise: Promise<unknown>; strength: Strength }>();

function singleFlight<T>(key: string, strength: Strength, run: () => Promise<T>): Promise<T> {
  const current = inFlightArtist.get(key);
  const start = (): Promise<T> => {
    const p = run().finally(() => {
      if (inFlightArtist.get(key)?.promise === p) inFlightArtist.delete(key);
    });
    inFlightArtist.set(key, { promise: p, strength });
    return p;
  };
  if (!current) return start();
  if (strength <= current.strength) return current.promise as Promise<T>;
  return current.promise.catch(() => undefined).then(start);
}

const strengthOf = (o?: { force?: boolean; reresolve?: boolean }): Strength =>
  o?.reresolve ? 2 : o?.force ? 1 : 0;

interface ArtistFetchOpts {
  prefetchCovers?: boolean;
  /** Ignore the local row and refetch this part. */
  force?: boolean;
}

/**
 * Base artist: the row + its albums. Local-first; `force` refetches.
 * Every other artist fetcher goes through this first — FKs are enforced, so the component
 * tables cannot be written before the `artists` row exists, and an artist reached from an
 * album or a scrobble may have no row yet.
 */
export function fetchArtistBase(id: string, opts?: ArtistFetchOpts): Promise<ArtistBase | null> {
  return singleFlight(`base:${id}`, strengthOf(opts), async () => {
    const db = getDb();
    const local = async (): Promise<ArtistBase | null> => (db ? getArtistBase(db, id) : null);
    if (offlineModeStore.getState().offlineMode) return local();
    if (!opts?.force) {
      const cached = await local();
      if (cached) return cached;
    }
    const result = await withTimeout(async () => {
      await ensureCoverArtAuth();
      const artistData = await getArtist(id);
      if (!artistData) return null;
      // `getArtist` returns the raw server object; only `getAllArtists` substitutes the
      // Various Artists cover, so without this an artist-page open overwrites it.
      const artist = isVariousArtists(artistData.name)
        ? { ...artistData, coverArt: VARIOUS_ARTISTS_COVER_ART_ID }
        : artistData;
      const albums = artist.album ?? [];
      ratingStore.getState().reconcileRatings([
        { id: artist.id, serverRating: artist.userRating ?? 0 },
        ...albums.map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 })),
      ]);
      if (db) {
        // Both take the (non-re-entrant) mutex per chunk themselves — see `fetchAlbumDetail`.
        await upsertArtists(db, [artist], undefined, articles());
        if (albums.length > 0) await upsertAlbums(db, albums, undefined, articles());
        bumpDetailChanged('artist', id);
      }
      return { artist, albums } as ArtistBase;
    }, FETCH_TIMEOUT_MS);
    return result === 'timeout' || result == null ? local() : result;
  });
}

/** Ensure the `artists` row exists before a component write. */
async function ensureArtistRow(id: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  if (await getArtistBase(db, id)) return true;
  return (await fetchArtistBase(id, { prefetchCovers: false })) != null;
}

/**
 * getArtistInfo2 — images, similar artists, and the SERVER biography. Sole writer of
 * `artist_info` + `artist_similar`.
 */
export function fetchArtistInfo(id: string, opts?: ArtistFetchOpts): Promise<ArtistInfoRow | null> {
  return singleFlight(`info:${id}`, strengthOf(opts), async () => {
    const db = getDb();
    const local = async (): Promise<ArtistInfoRow | null> => (db ? getArtistInfoRow(db, id) : null);
    if (offlineModeStore.getState().offlineMode) return local();
    if (!opts?.force) {
      const cached = await local();
      if (cached) return cached;
    }
    const result = await withTimeout(async () => {
      await ensureCoverArtAuth();
      const info = await getArtistInfo2(id);
      if (!info) return null;
      if (db && (await ensureArtistRow(id))) {
        await upsertArtistInfo(
          db,
          id,
          {
            // Empties and markup-only stubs must read as "this server has none", or a
            // non-null-but-blank bio becomes a permanent local hit that renders nothing
            // and suppresses the MusicBrainz fallback for good.
            biography: nonEmptyBio(info.biography),
            lastFmUrl: info.lastFmUrl ?? null,
            musicBrainzId: info.musicBrainzId ?? null,
            imageUrlSmall: info.smallImageUrl ?? null,
            imageUrlMedium: info.mediumImageUrl ?? null,
            imageUrlLarge: info.largeImageUrl ?? null,
            retrievedAt: Date.now(),
          },
          info,
        );
        bumpDetailChanged('artist', id);
      }
      return local();
    }, FETCH_TIMEOUT_MS);
    return result === 'timeout' || result == null ? local() : result;
  });
}

/**
 * Top songs. Size-dependent, so a `listLength` that no longer matches the setting is a
 * miss — which is what lets the bulk `refreshArtistTopSongs` loop go away.
 */
export function fetchArtistTopSongs(
  id: string,
  opts?: ArtistFetchOpts,
): Promise<ArtistTopSongsRow | null> {
  return singleFlight(`top:${id}`, strengthOf(opts), async () => {
    const db = getDb();
    const size = layoutPreferencesStore.getState().listLength;
    const local = async (): Promise<ArtistTopSongsRow | null> => {
      if (!db) return null;
      const row = await getArtistTopSongsRow(db, id);
      if (!row) return null;
      // Stale if the setting moved, or if the join resolves fewer rows than were written —
      // `artist_top_songs.song_id` has no FK, so a song reaped by `deleteAlbumSongsNotIn`
      // silently drops out while the junction row survives.
      if (row.listLength !== size || row.songs.length !== row.songCount) return null;
      return row;
    };
    if (offlineModeStore.getState().offlineMode) return db ? getArtistTopSongsRow(db, id) : null;
    if (!opts?.force) {
      const cached = await local();
      if (cached) return cached;
    }
    const result = await withTimeout(async () => {
      await ensureCoverArtAuth();
      const base = db ? await getArtistBase(db, id) : null;
      const name = base?.artist.name ?? (await getArtist(id))?.name;
      if (!name) return null;
      const top = await getTopSongs(name, size);
      // null = the call FAILED. Do not stamp: marking "fetched, 0 songs" has no TTL to
      // recover from, and the section would stay empty until a manual pull.
      if (top == null) return null;
      if (db && (await ensureArtistRow(id))) {
        ratingStore.getState().reconcileRatings(
          top.map((sg) => ({ id: sg.id, serverRating: sg.userRating ?? 0 })),
        );
        // `upsertSongs` takes the (non-re-entrant) mutex per chunk itself; only
        // `setArtistTopSongs`, which has none, is wrapped.
        if (top.length > 0) await upsertSongs(db, top, undefined, articles());
        await setArtistTopSongs(db, id, top.map((sg) => sg.id), { listLength: size });
        bumpDetailChanged('artist', id);
      }
      if ((opts?.prefetchCovers ?? true) && top.length > 0) prefetchCoverArt(top);
      return db ? getArtistTopSongsRow(db, id) : null;
    }, FETCH_TIMEOUT_MS);
    return result === 'timeout' || result == null ? local() : result;
  });
}

/**
 * The RESOLVED biography: server bio if this server has one, else MusicBrainz. Sole writer
 * of `artist_bio`.
 *
 * `force` ignores the stored row; `reresolve` additionally ignores the 72h negative cache
 * and redoes the MusicBrainz chain — which is what the MBID-override flows need, and what a
 * pull-to-refresh must NOT do (it would re-hammer a ~1 req/s API on every pull for any
 * artist with no public bio). `reresolve` implies `force`.
 */
export function fetchArtistBio(
  id: string,
  opts?: ArtistFetchOpts & { reresolve?: boolean },
): Promise<ArtistBioRow | null> {
  return singleFlight(`bio:${id}`, strengthOf(opts), async () => {
    const db = getDb();
    const reresolve = opts?.reresolve === true;
    const force = reresolve || opts?.force === true;
    const local = async (): Promise<ArtistBioRow | null> => (db ? getArtistBioRow(db, id) : null);
    if (offlineModeStore.getState().offlineMode) return local();

    if (!force) {
      const cached = await local();
      // A stored bio is a hit outright; a NULL one is only a hit inside the negative-cache
      // window, so a transient miss retries later instead of sticking.
      if (cached?.biography != null && cached.biography.length > 0) return cached;
      if (
        cached &&
        cached.biography == null &&
        cached.checkedAt != null &&
        Date.now() - cached.checkedAt < BIO_NEGATIVE_CACHE_TTL_MS
      ) {
        return cached;
      }
    }

    const write = async (bio: {
      biography: string | null;
      resolvedMbid: string | null;
      checkedAt: number | null;
    }): Promise<ArtistBioRow | null> => {
      if (!db || !(await ensureArtistRow(id))) return null;
      await upsertArtistBio(db, id, bio);
      bumpDetailChanged('artist', id);
      return local();
    };

    const result = await withTimeout(async (signal) => {
      const base = db ? await getArtistBase(db, id) : null;
      const name = base?.artist.name ?? (await getArtist(id))?.name;
      if (!name) return null;

      // Various Artists is static: no remote enrichment at all, but it still persists so
      // the row exists and the override screens do not read it as never-attempted.
      if (isVariousArtists(name)) {
        return write({ biography: getVariousArtistsBio(), resolvedMbid: null, checkedAt: Date.now() });
      }

      const info = (await fetchArtistInfo(id, { force, prefetchCovers: false })) ?? null;
      const serverBio = info?.biography ?? null;
      const override = getOverride(mbidOverrideStore.getState().overrides, 'artist', id);
      if (serverBio) {
        // Write the MBID on this branch too: after an override is removed, MoreOptionsSheet
        // pre-fills from `resolved_mbid`, so short-circuiting here would strand the old one.
        return write({
          biography: serverBio,
          resolvedMbid: override?.mbid ?? info?.musicBrainzId ?? null,
          checkedAt: Date.now(),
        });
      }

      // Server has none — fall back to MusicBrainz, unless a fresh negative cache says we
      // already looked. `reresolve` ignores that, since the inputs just changed.
      if (!reresolve) {
        const cached = await local();
        if (
          cached?.biography == null &&
          cached?.checkedAt != null &&
          Date.now() - cached.checkedAt < BIO_NEGATIVE_CACHE_TTL_MS
        ) {
          return cached;
        }
      }
      const mbid = override?.mbid ?? info?.musicBrainzId ?? (await searchArtistMBID(name, signal));
      const mbBio = mbid ? await getArtistBiography(mbid, signal) : null;
      return write({
        biography: nonEmptyBio(mbBio),
        resolvedMbid: mbid ?? null,
        checkedAt: Date.now(),
      });
    }, FETCH_TIMEOUT_MS);
    return result === 'timeout' || result == null ? local() : result;
  });
}

/**
 * Playlist detail. Online → `getPlaylist`, upsert the playlist row + member songs + ordered
 * membership into the normalized model, reconcile ratings, pre-cache art, notify, return the
 * server envelope. Offline → the persisted normalized detail.
 */
export async function fetchPlaylistDetail(
  id: string,
  opts?: { prefetchCovers?: boolean; force?: boolean },
): Promise<PlaylistWithSongs | null> {
  const db = getDb();
  // Local first — see `fetchAlbumDetail`. Membership we already hold answers immediately;
  // only `force` (pull-to-refresh, post-edit reconcile, download top-up, the sync's detail
  // refresh) asks the server.
  const local = async (): Promise<PlaylistWithSongs | null> => {
    if (!db) return null;
    const d = await getPlaylistDetail(db, id);
    return d && d.entry.length > 0 ? ({ ...d.playlist, entry: d.entry } as PlaylistWithSongs) : null;
  };
  if (offlineModeStore.getState().offlineMode) return local();
  if (!opts?.force) {
    const cached = await local();
    if (cached) return cached;
  }
  const prefetchCovers = opts?.prefetchCovers ?? true;
  await ensureCoverArtAuth();
  const data = await getPlaylist(id);
  if (data) {
    const ratingEntries = (data.entry ?? []).map((s) => ({ id: s.id, serverRating: s.userRating ?? 0 }));
    ratingStore.getState().reconcileRatings(ratingEntries);
    if (db) {
      const entry = data.entry ?? [];
      // The bulk upserts take the (non-re-entrant) mutex per chunk themselves; only
      // `setPlaylistSongs`, which has none, is wrapped.
      await upsertPlaylists(db, [data], undefined, articles());
      if (entry.length > 0) await upsertSongs(db, entry, undefined, articles());
      await setPlaylistSongs(db, id, entry.map((e) => e.id));
      bumpDetailChanged('playlist', id);
    }
    if (prefetchCovers) {
      const playlistArtId = coverArtForPlaylist(data);
      if (playlistArtId) ensureCached(playlistArtId).catch(() => { /* non-critical */ });
      if (data.entry?.length) prefetchCoverArt(data.entry);
    }
    return data;
  }
  return local();
}
