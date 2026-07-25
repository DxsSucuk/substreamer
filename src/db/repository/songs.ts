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
import { bulkUpsert, countRows, keysetPage, type Cursor, type Page } from './core';

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
  starred: number | null;
  user_rating: number | null;
}

const SONG_LIST_COLS =
  '"id", "title", "artist", "album", "album_id", "cover_art", "duration", "track", ' +
  '"disc_number", "sort_title", "starred", "user_rating"';

export function upsertSongs(
  db: InternalDb,
  songs: Child[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  return bulkUpsert(
    db,
    {
      table: 'songs',
      idOf: (c) => c.id,
      rowOf: songRow,
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

/** Full A–Z keyset browse of the song library (the big list that used to OOM). */
export function listSongs(
  db: InternalDb,
  opts: { cursor?: Cursor | null; letter?: string | null; limit: number; starredOnly?: boolean },
): Promise<Page<SongListRow>> {
  return keysetPage<SongListRow>(db, {
    table: 'songs',
    sortCol: 'sort_title',
    columns: SONG_LIST_COLS,
    limit: opts.limit,
    cursor: opts.cursor,
    letter: opts.letter,
    where: opts.starredOnly ? 'starred IS NOT NULL' : undefined,
    sortKeyOf: (r) => r.sort_title ?? '',
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
