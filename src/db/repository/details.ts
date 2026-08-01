/**
 * Detail reads over the normalized model — the relationship queries that replace the
 * legacy detail blob stores (`albumDetailStore`/`artistDetailStore`/`playlistDetailStore`).
 *
 * Album detail  = album row + `songs WHERE album_id`.
 * Artist detail = artist row + `albums WHERE artist_id` + `artist_similar` + bio cols.
 *                 (`topSongs` has no normalized table — it's re-fetched on screen open.)
 * Playlist detail = playlist row + `playlist_songs JOIN songs` (position order).
 *
 * Pure reads; a `null` entity means the id isn't synced yet (the caller then does an
 * on-demand server fetch that upserts normalized — Phase A5).
 */
import type { AlbumID3, ArtistID3, Child, ItemDate, Playlist } from 'subsonic-api';

import type { InternalDb } from '../client';
import { ALBUM_LIST_COLS, albumListRowToAlbumID3, type AlbumListRow } from './albums';
import { SONG_LIST_COLS, SONG_LIST_COLS_S, songListRowToChild, type SongListRow } from './songs';

type Row = Record<string, unknown>;
const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));
const num = (v: unknown): number | undefined => (v == null ? undefined : Number(v));
const bool = (v: unknown): boolean | undefined => (v == null ? undefined : Boolean(v));
const date = (v: unknown): Date | undefined => (v == null ? undefined : new Date(Number(v)));
const itemDate = (y: unknown, m: unknown, d: unknown): ItemDate | undefined =>
  y == null && m == null && d == null
    ? undefined
    : ({ year: num(y), month: num(m), day: num(d) } as ItemDate);

// ── Album ─────────────────────────────────────────────────────────────────────

export interface AlbumDetail {
  album: AlbumID3;
  songs: Child[];
}

/** Map a full `albums` row (SELECT *) to AlbumID3 (+ merged AlbumInfo columns). */
function albumRowToAlbumID3(r: Row): AlbumID3 {
  return {
    id: String(r.id),
    name: str(r.name) ?? '',
    artist: str(r.artist),
    artistId: str(r.artist_id),
    displayArtist: str(r.display_artist),
    coverArt: str(r.cover_art),
    songCount: num(r.song_count) ?? 0,
    duration: num(r.duration) ?? 0,
    playCount: num(r.play_count),
    created: date(r.created) ?? new Date(0),
    starred: date(r.starred),
    year: num(r.year),
    genre: str(r.genre),
    played: str(r.played),
    userRating: num(r.user_rating),
    version: str(r.version),
    musicBrainzId: str(r.music_brainz_id),
    sortName: str(r.sort_name),
    isCompilation: bool(r.is_compilation),
    explicitStatus: str(r.explicit_status),
    originalReleaseDate: itemDate(r.original_release_year, r.original_release_month, r.original_release_day),
    releaseDate: itemDate(r.release_year, r.release_month, r.release_day),
  } as AlbumID3;
}

/** Album detail: the album row + its songs (disc/track order). `null` if not synced. */
export async function getAlbumDetail(db: InternalDb, id: string): Promise<AlbumDetail | null> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM albums WHERE id = ?', [id]);
  if (!row) return null;
  const songRows = await db.getAllAsync<SongListRow>(
    `SELECT ${SONG_LIST_COLS} FROM songs WHERE album_id = ? ORDER BY disc_number, track, sort_title`,
    [id],
  );
  return { album: albumRowToAlbumID3(row), songs: songRows.map(songListRowToChild) };
}

// ── Artist ────────────────────────────────────────────────────────────────────

export interface ArtistBase {
  artist: ArtistID3;
  /** The artist's albums (by `albums.artist_id`), newest first. */
  albums: AlbumID3[];
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
  songs: Child[];
  retrievedAt: number;
  /** The size REQUESTED, so an artist with fewer tracks is not a permanent miss. */
  listLength: number;
  /** Rows written — compare against `songs.length` to catch a reaped junction. */
  songCount: number;
}

function artistRowToArtistID3(r: Row): ArtistID3 {
  return {
    id: String(r.id),
    name: str(r.name) ?? '',
    coverArt: str(r.cover_art),
    artistImageUrl: str(r.artist_image_url),
    albumCount: num(r.album_count) ?? 0,
    starred: date(r.starred),
    userRating: num(r.user_rating),
    musicBrainzId: str(r.music_brainz_id),
    sortName: str(r.sort_name),
  } as ArtistID3;
}

/** Base artist: the row + its albums. `null` = we do not hold this artist's albums yet.
 *
 *  Presence is NOT "the row exists" — a row exists for every artist after a list sync, and
 *  `refreshArtistLibrary` populates that table from one call while the album sync is still
 *  paging, so there is a long window where every artist has zero albums. `album_count === 0`
 *  is checked STRICTLY: a NULL count is unknown, so it must read as a miss rather than as a
 *  known-empty artist that never fetches. */
export async function getArtistBase(db: InternalDb, id: string): Promise<ArtistBase | null> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM artists WHERE id = ?', [id]);
  if (!row) return null;
  const albumRows = await db.getAllAsync<AlbumListRow>(
    `SELECT ${ALBUM_LIST_COLS} FROM albums WHERE artist_id = ? ORDER BY year DESC, sort_title`,
    [id],
  );
  if (albumRows.length === 0 && num(row.album_count) !== 0) return null;
  return { artist: artistRowToArtistID3(row), albums: albumRows.map(albumListRowToAlbumID3) };
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
      .map(
        (sa) =>
          ({
            id: String(sa.similar_artist_id),
            name: sa.name ?? '',
            coverArt: str(sa.cover_art),
            albumCount: num(sa.album_count) ?? 0,
            userRating: num(sa.user_rating),
          }) as ArtistID3,
      ),
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
  return {
    songs: songRows.map(songListRowToChild),
    retrievedAt: num(row.retrieved_at) ?? 0,
    listLength: num(row.list_length) ?? 0,
    songCount: num(row.song_count) ?? 0,
  };
}

// ── Playlist ────────────────────────────────────────────────────────────────────

export interface PlaylistDetail {
  playlist: Playlist;
  /** Ordered tracks via `playlist_songs` (position order). */
  entry: Child[];
}

function playlistRowToPlaylist(r: Row): Playlist {
  return {
    id: String(r.id),
    name: str(r.name) ?? '',
    comment: str(r.comment),
    coverArt: str(r.cover_art),
    songCount: num(r.song_count) ?? 0,
    duration: num(r.duration) ?? 0,
    owner: str(r.owner),
    public: bool(r.public),
    created: date(r.created) ?? new Date(0),
    changed: date(r.changed) ?? new Date(0),
  } as Playlist;
}

/** Playlist detail: playlist row + ordered tracks. `null` if not synced. */
export async function getPlaylistDetail(db: InternalDb, id: string): Promise<PlaylistDetail | null> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM playlists WHERE id = ?', [id]);
  if (!row) return null;
  const songRows = await db.getAllAsync<SongListRow>(
    `SELECT ${SONG_LIST_COLS_S} FROM songs s JOIN playlist_songs ps ON ps.song_id = s.id ` +
      `WHERE ps.playlist_id = ? ORDER BY ps.position`,
    [id],
  );
  return { playlist: playlistRowToPlaylist(row), entry: songRows.map(songListRowToChild) };
}
