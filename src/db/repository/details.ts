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
import { SONG_LIST_COLS, songListRowToChild, type SongListRow } from './songs';

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

export interface ArtistDetail {
  artist: ArtistID3;
  /** The artist's albums (by `albums.artist_id`), newest first. */
  albums: AlbumID3[];
  /** getArtistInfo2 similar artists (id/name + denormalized art/count/rating), in stored order. */
  similarArtist: ArtistID3[];
  /** Bio text from getArtistInfo2, or null before an info fetch has run. */
  biography: string | null;
  /** getArtistInfo2 image URLs (the artist-detail hero uses `largeImageUrl` as the
   *  fallback when there's no cover-art token). Null before an info fetch has run. */
  artistInfo: { smallImageUrl?: string; mediumImageUrl?: string; largeImageUrl?: string } | null;
  /** Subsonic getTopSongs (persisted via `artist_top_songs`), in stored order. */
  topSongs: Child[];
  /** Detail-fetch marker + MB negative-cache timestamp (epoch ms), null if never fetched. */
  bioCheckedAt: number | null;
  /** The MBID used to resolve the bio (override > server > MB search), null if unknown. */
  resolvedMbid: string | null;
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

/** Artist detail: artist row + its albums + similar artists + bio. `null` if not synced. */
export async function getArtistDetail(db: InternalDb, id: string): Promise<ArtistDetail | null> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM artists WHERE id = ?', [id]);
  if (!row) return null;
  const [albumRows, similarRows, topSongRows] = await Promise.all([
    db.getAllAsync<AlbumListRow>(
      `SELECT ${ALBUM_LIST_COLS} FROM albums WHERE artist_id = ? ORDER BY year DESC, sort_title`,
      [id],
    ),
    db.getAllAsync<{
      similar_artist_id: string | null;
      name: string | null;
      cover_art: string | null;
      album_count: number | null;
      user_rating: number | null;
    }>(
      'SELECT similar_artist_id, name, cover_art, album_count, user_rating ' +
        'FROM artist_similar WHERE artist_id = ? ORDER BY pos',
      [id],
    ),
    db.getAllAsync<SongListRow>(
      `SELECT ${SONG_LIST_COLS} FROM songs s JOIN artist_top_songs ats ON ats.song_id = s.id ` +
        `WHERE ats.artist_id = ? ORDER BY ats.pos`,
      [id],
    ),
  ]);
  const largeImageUrl = str(row.image_url_large);
  const mediumImageUrl = str(row.image_url_medium);
  const smallImageUrl = str(row.image_url_small);
  return {
    artist: artistRowToArtistID3(row),
    albums: albumRows.map(albumListRowToAlbumID3),
    similarArtist: similarRows
      .filter((s) => s.similar_artist_id != null)
      .map(
        (s) =>
          ({
            id: String(s.similar_artist_id),
            name: s.name ?? '',
            coverArt: str(s.cover_art),
            albumCount: num(s.album_count) ?? 0,
            userRating: num(s.user_rating),
          }) as ArtistID3,
      ),
    biography: str(row.biography) ?? null,
    artistInfo:
      largeImageUrl || mediumImageUrl || smallImageUrl
        ? { smallImageUrl, mediumImageUrl, largeImageUrl }
        : null,
    topSongs: topSongRows.map(songListRowToChild),
    bioCheckedAt: num(row.bio_checked_at) ?? null,
    resolvedMbid: str(row.resolved_mbid) ?? null,
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
    `SELECT ${SONG_LIST_COLS} FROM songs s JOIN playlist_songs ps ON ps.song_id = s.id ` +
      `WHERE ps.playlist_id = ? ORDER BY ps.position`,
    [id],
  );
  return { playlist: playlistRowToPlaylist(row), entry: songRows.map(songListRowToChild) };
}
