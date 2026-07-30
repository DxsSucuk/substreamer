/** Songs repository: bulk upsert (row + children), keyset A–Z list, by-album, count. */
import type { Child } from 'subsonic-api';

import type { InternalDb } from '../client';
import {
  songAlbumArtistRows,
  songArtistRows,
  songContributorRows,
  songGenreRows,
  songMoodRows,
  songRow,
} from './mappers';
import { bulkUpsert, countRows, keysetPage, keysetPageBefore, type Cursor, type Page } from './core';

/** Lean projection for list rendering (the columns a song row needs). */
export interface SongListRow {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  album_id: string | null;
  cover_art: string | null;
  duration: number | null;
  track: number | null;
  disc_number: number | null;
  sort_title: string | null;
  sort_artist: string | null;
  starred: number | null;
  user_rating: number | null;
}

export const SONG_LIST_COLS =
  '"id", "title", "artist", "album", "album_id", "cover_art", "duration", "track", ' +
  '"disc_number", "sort_title", "sort_artist", "starred", "user_rating"';

export type SongSortOrder = 'title' | 'artist';

/** Adapt a lean list row to the `Child` shape the row/card components + playback
 *  expect. Only the fields those consumers read are populated; the stream URL is
 *  built from `id` alone, so the lean projection is sufficient to play a track. */
export function songListRowToChild(r: SongListRow): Child {
  return {
    id: r.id,
    title: r.title ?? '',
    artist: r.artist ?? undefined,
    album: r.album ?? undefined,
    albumId: r.album_id ?? undefined,
    coverArt: r.cover_art ?? undefined,
    duration: r.duration ?? 0,
    track: r.track ?? undefined,
    discNumber: r.disc_number ?? undefined,
    userRating: r.user_rating ?? undefined,
    starred: r.starred ? new Date(r.starred) : undefined,
    isDir: false,
  } as Child;
}

export function upsertSongs(
  db: InternalDb,
  songs: Child[],
  onProgress?: (done: number, total: number) => void,
  articles?: readonly string[],
): Promise<number> {
  return bulkUpsert(
    db,
    {
      table: 'songs',
      idOf: (c) => c.id,
      rowOf: (c) => songRow(c, articles),
      children: [
        { table: 'song_genres', parentCol: 'song_id', rows: songGenreRows },
        { table: 'song_artists', parentCol: 'song_id', rows: songArtistRows },
        { table: 'song_album_artists', parentCol: 'song_id', rows: songAlbumArtistRows },
        { table: 'song_contributors', parentCol: 'song_id', rows: songContributorRows },
        { table: 'song_moods', parentCol: 'song_id', rows: songMoodRows },
      ],
      onProgress,
    },
    songs,
  );
}

/** Sort by artist uses the compound key (sort_artist, sort_title, id); sort by
 *  title is the plain (sort_title, id) key. The A–Z scroller seeks on the primary
 *  column either way. Mirrors the album repository. */
function songSortCols(sortOrder?: SongSortOrder) {
  const byArtist = sortOrder === 'artist';
  return {
    sortCol: byArtist ? 'sort_artist' : 'sort_title',
    sortCol2: byArtist ? 'sort_title' : undefined,
    sortKeyOf: (r: SongListRow) => (byArtist ? r.sort_artist : r.sort_title) ?? '',
    sortKey2Of: byArtist ? (r: SongListRow) => r.sort_title ?? '' : undefined,
  };
}

/** Build the keyset cursor for a song row under the active sort order — used by the
 *  screen to seed a backward page from the first loaded row. */
export function songCursorOf(r: SongListRow, sortOrder?: SongSortOrder): Cursor {
  return sortOrder === 'artist'
    ? { sortKey: r.sort_artist ?? '', sortKey2: r.sort_title ?? '', id: r.id }
    : { sortKey: r.sort_title ?? '', id: r.id };
}

/** Full A–Z keyset browse of the song library (the big list that used to OOM). */
export function listSongs(
  db: InternalDb,
  opts: {
    cursor?: Cursor | null;
    letter?: string | null;
    limit: number;
    starredOnly?: boolean;
    sortOrder?: SongSortOrder;
  },
): Promise<Page<SongListRow>> {
  return keysetPage<SongListRow>(db, {
    table: 'songs',
    columns: SONG_LIST_COLS,
    limit: opts.limit,
    cursor: opts.cursor,
    letter: opts.letter,
    where: opts.starredOnly ? 'starred IS NOT NULL' : undefined,
    ...songSortCols(opts.sortOrder),
  });
}

export function listSongsBefore(
  db: InternalDb,
  opts: { before: Cursor; limit: number; starredOnly?: boolean; sortOrder?: SongSortOrder },
): Promise<{ rows: SongListRow[]; prevCursor: Cursor | null }> {
  return keysetPageBefore<SongListRow>(db, {
    table: 'songs',
    columns: SONG_LIST_COLS,
    limit: opts.limit,
    before: opts.before,
    where: opts.starredOnly ? 'starred IS NOT NULL' : undefined,
    ...songSortCols(opts.sortOrder),
  });
}

/** Album-detail songs: ordered by disc then track. */
export const listSongsByAlbum = (db: InternalDb, albumId: string): Promise<SongListRow[]> =>
  db.getAllAsync<SongListRow>(
    `SELECT ${SONG_LIST_COLS} FROM songs WHERE album_id = ? ORDER BY disc_number, track, sort_title`,
    [albumId],
  );

export const countSongs = (db: InternalDb, starredOnly = false): Promise<number> =>
  countRows(db, 'songs', starredOnly ? 'starred IS NOT NULL' : undefined);

/**
 * Drop this album's songs that the server no longer lists. Servers that derive song ids
 * from path+tags (Navidrome et al.) emit fresh ids after a re-tag, and since nothing
 * else deletes song rows the album's track list would otherwise show the old and new
 * sets forever (`getAlbumDetail` is `WHERE album_id = ?`).
 *
 * Scoped to ONE album and ONE authoritative `getAlbum` response, so it carries no
 * assumption about what a whole sync run saw. Downloaded tracks are exempt — their row
 * backs the offline track list even when the server has moved on. Run it AFTER the
 * upsert: deleting first would leave the album empty if the process died in between.
 */
export const deleteAlbumSongsNotIn = (
  db: InternalDb,
  albumId: string,
  keepIds: string[],
): Promise<unknown> =>
  db.runAsync(
    'DELETE FROM songs WHERE album_id = ? ' +
      'AND id NOT IN (SELECT value FROM json_each(?)) ' +
      'AND id NOT IN (SELECT song_id FROM cached_songs)',
    [albumId, JSON.stringify(keepIds)],
  );

/** Eager +1 play-count + last-played for a just-scrobbled song — a TARGETED scalar
 *  UPDATE (no child-table churn) so normalized play stats stay current for the detail
 *  screens / player. Relative increment mirrors the store bumps; a full resync
 *  overwrites with the server value. No-op if the song isn't in the table yet. */
export const bumpSongPlayStats = (db: InternalDb, id: string, played: string): Promise<unknown> =>
  db.runAsync(
    'UPDATE songs SET play_count = COALESCE(play_count, 0) + 1, played = ? WHERE id = ?',
    [played, id],
  );

/** Distinct albums that have at least one song — the "albums whose songs we have"
 *  numerator for sync progress (over the total album count). Index-backed by
 *  `idx_songs_album`; derived from the persisted table, so it's resume-stable. */
export const countSongAlbums = async (db: InternalDb): Promise<number> =>
  (await db.getFirstAsync<{ n: number }>('SELECT COUNT(DISTINCT album_id) AS n FROM songs'))?.n ?? 0;

/** Distinct album ids that already have songs — the "done" set the basic-path song walk
 *  diffs against the album ids to find which albums still need their songs fetched. */
export const listSongAlbumIds = (db: InternalDb): Promise<string[]> =>
  db
    .getAllAsync<{ album_id: string }>(
      'SELECT DISTINCT album_id FROM songs WHERE album_id IS NOT NULL',
    )
    .then((rows) => rows.map((r) => r.album_id));

/** Which of the given album ids already have their detail (≥1 song) in the normalized
 *  model — the "has detail cached" presence check the downloaded-metadata refresh uses.
 *  Ids pass as a JSON array via `json_each` to dodge the bound-variable limit. */
export const albumIdsWithSongs = (db: InternalDb, ids: string[]): Promise<Set<string>> =>
  ids.length === 0
    ? Promise.resolve(new Set<string>())
    : db
        .getAllAsync<{ album_id: string }>(
          'SELECT DISTINCT album_id FROM songs WHERE album_id IN (SELECT value FROM json_each(?))',
          [JSON.stringify(ids)],
        )
        .then((rows) => new Set(rows.map((r) => r.album_id)));
