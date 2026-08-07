/**
 * Downloads repository — the ONE place the download tables are read for filtering.
 *
 * These reads answer "what is on disk", and they read `cached_items` / `cached_albums` /
 * `cached_playlists` ONLY. They are deliberately never joined to `albums`/`songs`: the
 * download tables have no FK to the library, a downloaded item need not be in the (paged,
 * reapable) library at all, and an offline list that drops rows the user has on disk — or
 * shows rows they don't — is the one thing offline must not do.
 *
 * Two predicates live here and they are NOT the same thing:
 *
 *  - **Membership** — "is this id downloaded" (`downloadedClause`, `listDownloadedAlbumIds`).
 *    Reads `cached_items` alone. Used to filter a list that came from somewhere else (search
 *    results, the home album lists), where the caller already holds the metadata.
 *  - **Visibility** — "which downloaded albums can we RENDER" (`listDownloadedAlbums`).
 *    INNER JOINs `cached_albums`, because a row with no component metadata cannot be drawn.
 *    This is the SQL form of `if (item.albumMeta)` in the store helper it replaces, and it is
 *    what keeps derived partial-album rows (which carry no metadata) out of the list. Never
 *    fall back to `cached_items.name`/`artist` — those are always populated and would surface
 *    rows that are hidden today.
 *
 * Conflating the two would either hide downloaded albums from search or surface metadata-less
 * rows in the library browser.
 */
import type { Child, Playlist } from 'subsonic-api';

import type { InternalDb } from '../client';
import { albumListRowToAlbumID3, type AlbumListRow, type LibraryAlbum } from './albums';
import { colsOf } from './core';
import { playlistListRowToPlaylist, type PlaylistListRow, type LibraryPlaylist } from './playlists';

/** The three library tables that carry a `starred` mark, minus the ones that cannot be
 *  downloaded. Artists are excluded by construction — see `favorites.ts`. */
export type DownloadableEntity = 'songs' | 'albums';

/**
 * SQL form of `isPartialAlbum` — a complete download has at least as many
 * `cached_item_songs` edges as the item's `expected_song_count`.
 *
 * Assumes the enclosing query aliases `cached_items` as `ci`.
 */
export const partialGate = (includePartial: boolean): string =>
  includePartial
    ? ''
    : ' AND (SELECT COUNT(*) FROM cached_item_songs e WHERE e.item_id = ci.item_id)' +
      ' >= ci.expected_song_count';

/**
 * "This id is downloaded." Positive `IN` probes over the DOWNLOAD tables, which are bounded
 * by what is on disk — so unlike a disjointness clause there is no ephemeral-b-tree build to
 * avoid. Both PKs are `id`, so the identical string serves a library row and its remainder
 * counterpart.
 */
export function downloadedClause(entity: DownloadableEntity, includePartial: boolean): string {
  switch (entity) {
    case 'songs':
      return 'id IN (SELECT song_id FROM cached_songs)';
    case 'albums':
      return `id IN (SELECT ci.item_id FROM cached_items ci WHERE ci.type='album'${partialGate(includePartial)})`;
  }
}

/* ------------------------------------------------------------------ */
/*  Projections                                                        */
/* ------------------------------------------------------------------ */

/**
 * `cached_albums` carries every `AlbumListRow` column except the two sort keys, which only
 * the keyset cursor uses — the downloaded list is bounded and sorts in JS via
 * `sortAlbumsByPreference` (which honours `ignoredArticles`, something the SQL has no
 * knowledge of). They project as NULL so the row type is satisfied honestly.
 *
 * Typed against `AlbumListRow` so a stale or misspelled column is a compile error.
 */
type CachedAlbumField = Exclude<
  keyof AlbumListRow,
  | 'id' | 'sort_title' | 'sort_artist'
  | 'artists' | 'genres' | 'discTitles' | 'moods' | 'recordLabels' | 'releaseTypes'
>;

const CACHED_ALBUM_FIELDS: readonly CachedAlbumField[] = [
  'artist_id', 'name', 'artist', 'display_artist', 'cover_art', 'song_count', 'duration',
  'play_count', 'created', 'starred', 'year', 'genre', 'played', 'user_rating', 'version',
  'music_brainz_id', 'sort_name', 'is_compilation', 'explicit_status',
  'original_release_year', 'original_release_month', 'original_release_day',
  'release_year', 'release_month', 'release_day',
];

const CACHED_ALBUM_COLS = [
  'ca."item_id" AS "id"',
  colsOf(CACHED_ALBUM_FIELDS, 'ca'),
  'NULL AS "sort_title"',
  'NULL AS "sort_artist"',
].join(', ');

type CachedPlaylistField = Exclude<keyof PlaylistListRow, 'id' | 'sort_title'>;

const CACHED_PLAYLIST_FIELDS: readonly CachedPlaylistField[] = [
  'name', 'comment', 'cover_art', 'created', 'changed', 'duration', 'owner', 'public',
  'song_count',
];

const CACHED_PLAYLIST_COLS = [
  'cp."item_id" AS "id"',
  colsOf(CACHED_PLAYLIST_FIELDS, 'cp'),
  'NULL AS "sort_title"',
].join(', ');

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

export interface DownloadedFilter {
  includePartial?: boolean;
}

/**
 * The DOWNLOADED albums, rebuilt from their `cached_albums` component rows — the
 * never-reaped source of truth for downloaded metadata, independent of the (paged) library.
 *
 * Bounded by what is on disk, so this is a whole-set read by design; there is no cursor.
 * Children (`artists`/`genres`/…) are deliberately NOT hydrated: the store helper this
 * replaces produced none either, so absent is parity rather than a regression.
 */
export async function listDownloadedAlbums(
  db: InternalDb,
  f: DownloadedFilter = {},
): Promise<AlbumListRow[]> {
  return db.getAllAsync<AlbumListRow>(
    `SELECT ${CACHED_ALBUM_COLS} FROM cached_albums ca ` +
      'JOIN cached_items ci ON ci.item_id = ca.item_id ' +
      `WHERE ci.type='album'${partialGate(f.includePartial === true)}`,
  );
}

/** The downloaded albums as `AlbumID3`, for consumers not yet converted to rows. */
export async function listDownloadedAlbumsAsAlbumID3(
  db: InternalDb,
  f: DownloadedFilter = {},
): Promise<LibraryAlbum[]> {
  return (await listDownloadedAlbums(db, f)).map(albumListRowToAlbumID3);
}

/**
 * The DOWNLOADED playlists. No partial gate: playlists download atomically, so there is no
 * partial state to include or exclude.
 */
export async function listDownloadedPlaylists(db: InternalDb): Promise<PlaylistListRow[]> {
  return db.getAllAsync<PlaylistListRow>(
    `SELECT ${CACHED_PLAYLIST_COLS} FROM cached_playlists cp ` +
      'JOIN cached_items ci ON ci.item_id = cp.item_id ' +
      "WHERE ci.type='playlist'",
  );
}

/** The downloaded playlists as `Playlist`, for consumers not yet converted to rows. */
export async function listDownloadedPlaylistsAsPlaylist(
  db: InternalDb,
): Promise<LibraryPlaylist[]> {
  return (await listDownloadedPlaylists(db)).map(playlistListRowToPlaylist);
}

/**
 * The set of downloaded ALBUM ids — the MEMBERSHIP predicate, for filtering a list that came
 * from elsewhere. Reads `cached_items` only, with no join to `cached_albums`, exactly
 * matching `albumPassesDownloadedFilter`: an album the caller already holds metadata for is
 * downloaded iff it has an item row, whether or not its component row is populated.
 */
export async function listDownloadedAlbumIds(
  db: InternalDb,
  f: DownloadedFilter = {},
): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ item_id: string }>(
    'SELECT ci.item_id FROM cached_items ci ' +
      `WHERE ci.type='album'${partialGate(f.includePartial === true)}`,
  );
  return new Set(rows.map((r) => r.item_id));
}

/**
 * A downloaded song, at the projection the Songs tab's downloaded filter renders.
 *
 * SIX columns of the ~55 `cached_songs` holds, because that is exactly what the JS walk
 * this replaces produced. Widening it (track, disc, year, genre, bitrate, rating, play
 * count) is a deliberate FOLLOW-UP, not part of the move: it changes what the rows render
 * and needs its own verification pass.
 */
export interface DownloadedSongRow {
  id: string;
  title: string;
  artist: string | null;
  /** `cached_songs.album_id` is the file's DIRECTORY, not `Child.albumId` — the server's
   *  album lives in `src_album_id`. Carried across as-is because the map walk did the
   *  same; correcting it belongs with the enrichment follow-up. */
  album_id: string;
  duration: number;
  cover_art: string | null;
}

/**
 * The DOWNLOADED songs. Bounded by what is on disk, so this is a whole-set read by design;
 * there is no cursor. `song_id` is the primary key, so the id-dedupe the map walk needed
 * is structural here. Unsorted — the caller sorts in JS via `byTitle`, which goes through
 * `defaultCollator` (SQL knows nothing about it).
 */
export async function listDownloadedSongs(db: InternalDb): Promise<DownloadedSongRow[]> {
  return db.getAllAsync<DownloadedSongRow>(
    'SELECT "song_id" AS "id", "title", "artist", "album_id", "duration", "cover_art" ' +
      'FROM cached_songs',
  );
}

/** Adapt a downloaded song row to the `Child` the song rows render. */
export function downloadedSongRowToChild(r: DownloadedSongRow): Child {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist ?? undefined,
    albumId: r.album_id,
    duration: r.duration,
    coverArt: r.cover_art ?? undefined,
    isDir: false,
  };
}

/**
 * The set of downloaded PLAYLIST ids — the MEMBERSHIP predicate's playlist twin, for
 * filtering a list that came from elsewhere (the CarPlay playlist node, whose rows come
 * from the `playlists` table and already carry their metadata). `cached_items` ALONE, with
 * no join to `cached_playlists`: requiring a component row here would hide a downloaded
 * playlist whose metadata is not populated, which is the visibility question, not this one.
 *
 * No partial gate, for the same reason `listDownloadedPlaylists` has none — playlists
 * download atomically, so there is no partial state to include or exclude.
 */
export async function listDownloadedPlaylistIds(db: InternalDb): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ item_id: string }>(
    "SELECT ci.item_id FROM cached_items ci WHERE ci.type='playlist'",
  );
  return new Set(rows.map((r) => r.item_id));
}

/**
 * "Is this exact item id downloaded" — MEMBERSHIP for a single id, as a one-row probe
 * rather than a set read.
 *
 * Type-agnostic on purpose: its caller asks about the `__starred__` favourites aggregate,
 * which is neither an album nor a playlist. No partial gate either — the check it replaces
 * (`STARRED_SONGS_ITEM_ID in cachedItems`) is bare membership.
 */
export async function isItemDownloaded(db: InternalDb, itemId: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ one: number }>(
    'SELECT 1 AS one FROM cached_items WHERE item_id = ? LIMIT 1',
    [itemId],
  );
  return row !== null;
}

/** Re-export so consumers can name the produced entity types without reaching into
 *  `albums`/`playlists` for them. */
export type { Playlist };
