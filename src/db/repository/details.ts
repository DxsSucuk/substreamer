/**
 * Detail reads over the normalized model — a detail view is a relationship query, not a
 * stored blob.
 *
 * Album detail  = album row + `songs WHERE album_id`.
 * Artist detail = artist row + `albums WHERE artist_id` + `artist_similar` + bio cols,
 *                 with top songs via `artist_top_songs` + its state row.
 * Playlist detail = playlist row + `playlist_songs JOIN songs` (position order).
 *
 * Every entity comes back through the SAME projection + adapter the list reads use, so
 * detail and list can never disagree about which fields a consumer gets.
 *
 * Pure reads; a `null` entity means the id isn't synced yet, and the caller then does an
 * on-demand server fetch that upserts into the normalized tables.
 */
import type { ArtistID3 } from 'subsonic-api';

import type { InternalDb } from '../client';
import {
  ALBUM_LIST_COLS,
  albumListRowToAlbumID3,
  hydrateAlbumRows,
  type AlbumListRow,
  type LibraryAlbum,
} from './albums';
import {
  ARTIST_LIST_COLS,
  artistListRowToArtistID3,
  hydrateArtistRows,
  type ArtistListRow,
  type LibraryArtist,
} from './artists';
import {
  PLAYLIST_LIST_COLS,
  playlistListRowToPlaylist,
  type LibraryPlaylist,
  type PlaylistListRow,
} from './playlists';
import {
  SONG_LIST_COLS,
  SONG_LIST_COLS_S,
  hydrateSongRows,
  songListRowToChild,
  type LibrarySong,
  type SongListRow,
} from './songs';

type Row = Record<string, unknown>;
const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));
const num = (v: unknown): number | undefined => (v == null ? undefined : Number(v));

// ── Album ─────────────────────────────────────────────────────────────────────

export interface AlbumDetail {
  album: LibraryAlbum;
  songs: LibrarySong[];
}

/** Album detail: the album row + its songs (disc/track order). `null` if not synced. */
export async function getAlbumDetail(db: InternalDb, id: string): Promise<AlbumDetail | null> {
  const row = await db.getFirstAsync<AlbumListRow>(
    `SELECT ${ALBUM_LIST_COLS} FROM albums WHERE id = ?`,
    [id],
  );
  if (!row) return null;
  const songRows = await db.getAllAsync<SongListRow>(
    `SELECT ${SONG_LIST_COLS} FROM songs WHERE album_id = ? ORDER BY disc_number, track, sort_title`,
    [id],
  );
  await Promise.all([hydrateAlbumRows(db, [row]), hydrateSongRows(db, songRows)]);
  return { album: albumListRowToAlbumID3(row), songs: songRows.map(songListRowToChild) };
}

// ── Artist ────────────────────────────────────────────────────────────────────

export interface ArtistBase {
  artist: LibraryArtist;
  /** The artist's albums (by `albums.artist_id`), newest first. */
  albums: LibraryAlbum[];
}

export interface ArtistInfoRow {
  /** The SERVER bio. NULL = this server has none (empties are normalised away on write). */
  biography: string | null;
  lastFmUrl: string | null;
  musicBrainzId: string | null;
  smallImageUrl?: string;
  mediumImageUrl?: string;
  largeImageUrl?: string;
  similarArtist: ArtistID3[];
  retrievedAt: number;
}

export interface ArtistBioRow {
  /** The RESOLVED bio (server, else MusicBrainz). NULL = looked, found none. */
  biography: string | null;
  resolvedMbid: string | null;
  /** Negative-cache stamp; NULL = attempted without a usable timestamp. */
  checkedAt: number | null;
}

export interface ArtistTopSongsRow {
  songs: LibrarySong[];
  retrievedAt: number;
  /** The size REQUESTED, so an artist with fewer tracks is not a permanent miss. */
  listLength: number;
  /** Rows written — compare against `songs.length` to catch a reaped junction. */
  songCount: number;
}

/** Base artist: the row + its albums. `null` = we do not hold this artist's albums yet.
 *
 *  Presence is NOT "the row exists" — a row exists for every artist after a list sync, and
 *  `refreshArtistLibrary` populates that table from one call while the album sync is still
 *  paging, so there is a long window where every artist has zero albums. `album_count === 0`
 *  is checked STRICTLY: a NULL count is unknown, so it must read as a miss rather than as a
 *  known-empty artist that never fetches. */
export async function getArtistBase(db: InternalDb, id: string): Promise<ArtistBase | null> {
  const row = await db.getFirstAsync<ArtistListRow>(
    `SELECT ${ARTIST_LIST_COLS} FROM artists WHERE id = ?`,
    [id],
  );
  if (!row) return null;
  const albumRows = await db.getAllAsync<AlbumListRow>(
    `SELECT ${ALBUM_LIST_COLS} FROM albums WHERE artist_id = ? ORDER BY year DESC, sort_title`,
    [id],
  );
  if (albumRows.length === 0 && row.album_count !== 0) return null;
  await Promise.all([hydrateArtistRows(db, [row]), hydrateAlbumRows(db, albumRows)]);
  return {
    artist: artistListRowToArtistID3(row),
    albums: albumRows.map(albumListRowToAlbumID3),
  };
}

/** getArtistInfo2 envelope + its similar artists. `null` = never fetched. */
export async function getArtistInfoRow(db: InternalDb, id: string): Promise<ArtistInfoRow | null> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM artist_info WHERE artist_id = ?', [id]);
  if (!row) return null;
  const similarRows = await db.getAllAsync<{
    similar_artist_id: string | null;
    name: string | null;
    cover_art: string | null;
    album_count: number | null;
    user_rating: number | null;
  }>(
    'SELECT similar_artist_id, name, cover_art, album_count, user_rating ' +
      'FROM artist_similar WHERE artist_id = ? ORDER BY pos',
    [id],
  );
  return {
    biography: str(row.biography) ?? null,
    lastFmUrl: str(row.last_fm_url) ?? null,
    musicBrainzId: str(row.music_brainz_id) ?? null,
    smallImageUrl: str(row.image_url_small),
    mediumImageUrl: str(row.image_url_medium),
    largeImageUrl: str(row.image_url_large),
    similarArtist: similarRows
      .filter((sa) => sa.similar_artist_id != null)
      .map((sa) => ({
        id: String(sa.similar_artist_id),
        name: sa.name ?? '',
        coverArt: sa.cover_art ?? undefined,
        // A reference stub: `artist_similar` holds no album count of its own.
        albumCount: sa.album_count ?? 0,
        userRating: sa.user_rating ?? undefined,
      })),
    retrievedAt: num(row.retrieved_at) ?? 0,
  };
}

/** The RESOLVED biography + negative cache. `null` = never attempted. */
export async function getArtistBioRow(db: InternalDb, id: string): Promise<ArtistBioRow | null> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM artist_bio WHERE artist_id = ?', [id]);
  if (!row) return null;
  return {
    biography: str(row.biography) ?? null,
    resolvedMbid: str(row.resolved_mbid) ?? null,
    checkedAt: num(row.checked_at) ?? null,
  };
}

/** Top songs + the freshness the junction cannot carry. `null` = never fetched.
 *
 *  `songCount` is what was written; the caller compares it against `songs.length` (what the
 *  JOIN actually resolved). `artist_top_songs.song_id` has no FK, so a song reaped by
 *  `deleteAlbumSongsNotIn` silently drops out of the join while the junction row survives —
 *  a junction-row count would therefore never detect it. */
export async function getArtistTopSongsRow(
  db: InternalDb,
  id: string,
): Promise<ArtistTopSongsRow | null> {
  const row = await db.getFirstAsync<Row>(
    'SELECT * FROM artist_top_songs_state WHERE artist_id = ?',
    [id],
  );
  if (!row) return null;
  const songRows = await db.getAllAsync<SongListRow>(
    `SELECT ${SONG_LIST_COLS_S} FROM songs s JOIN artist_top_songs ats ON ats.song_id = s.id ` +
      `WHERE ats.artist_id = ? ORDER BY ats.pos`,
    [id],
  );
  await hydrateSongRows(db, songRows);
  return {
    songs: songRows.map(songListRowToChild),
    retrievedAt: num(row.retrieved_at) ?? 0,
    listLength: num(row.list_length) ?? 0,
    songCount: num(row.song_count) ?? 0,
  };
}

// ── Playlist ────────────────────────────────────────────────────────────────────

export interface PlaylistDetail {
  playlist: LibraryPlaylist;
  /** Ordered tracks via `playlist_songs` (position order). */
  entry: LibrarySong[];
}

/** Playlist detail: playlist row + ordered tracks. `null` if not synced. */
export async function getPlaylistDetail(db: InternalDb, id: string): Promise<PlaylistDetail | null> {
  const row = await db.getFirstAsync<PlaylistListRow>(
    `SELECT ${PLAYLIST_LIST_COLS} FROM playlists WHERE id = ?`,
    [id],
  );
  if (!row) return null;
  const songRows = await db.getAllAsync<SongListRow>(
    `SELECT ${SONG_LIST_COLS_S} FROM songs s JOIN playlist_songs ps ON ps.song_id = s.id ` +
      `WHERE ps.playlist_id = ? ORDER BY ps.position`,
    [id],
  );
  await hydrateSongRows(db, songRows);
  return { playlist: playlistListRowToPlaylist(row), entry: songRows.map(songListRowToChild) };
}
