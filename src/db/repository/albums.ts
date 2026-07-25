/** Albums repository: bulk upsert (row + children), keyset list, count, by-id. */
import type { AlbumID3 } from 'subsonic-api';

import type { InternalDb } from '../client';
import {
  albumArtistRows,
  albumDiscTitleRows,
  albumGenreRows,
  albumMoodRows,
  albumRecordLabelRows,
  albumReleaseTypeRows,
  albumRow,
} from './mappers';
import { bulkUpsert, countRows, keysetPage, type Cursor, type Page } from './core';

/** Lean projection for list rendering (the ~8 columns an album card needs). */
export interface AlbumListRow {
  id: string;
  name: string | null;
  display_artist: string | null;
  cover_art: string | null;
  year: number | null;
  sort_title: string | null;
  starred: number | null;
  user_rating: number | null;
}

export const ALBUM_LIST_COLS =
  '"id", "name", "display_artist", "cover_art", "year", "sort_title", "starred", "user_rating"';

export function upsertAlbums(
  db: InternalDb,
  albums: AlbumID3[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  return bulkUpsert(
    db,
    {
      table: 'albums',
      idOf: (a) => a.id,
      rowOf: albumRow,
      children: [
        { table: 'album_genres', parentCol: 'album_id', rows: albumGenreRows },
        { table: 'album_artists', parentCol: 'album_id', rows: albumArtistRows },
        { table: 'album_release_types', parentCol: 'album_id', rows: albumReleaseTypeRows },
        { table: 'album_moods', parentCol: 'album_id', rows: albumMoodRows },
        { table: 'album_record_labels', parentCol: 'album_id', rows: albumRecordLabelRows },
        { table: 'album_disc_titles', parentCol: 'album_id', rows: albumDiscTitleRows },
      ],
      onProgress,
    },
    albums,
  );
}

export function listAlbums(
  db: InternalDb,
  opts: { cursor?: Cursor | null; letter?: string | null; limit: number; starredOnly?: boolean },
): Promise<Page<AlbumListRow>> {
  return keysetPage<AlbumListRow>(db, {
    table: 'albums',
    sortCol: 'sort_title',
    columns: ALBUM_LIST_COLS,
    limit: opts.limit,
    cursor: opts.cursor,
    letter: opts.letter,
    where: opts.starredOnly ? 'starred IS NOT NULL' : undefined,
    sortKeyOf: (r) => r.sort_title ?? '',
  });
}

export const countAlbums = (db: InternalDb, starredOnly = false): Promise<number> =>
  countRows(db, 'albums', starredOnly ? 'starred IS NOT NULL' : undefined);

export const getAlbum = (db: InternalDb, id: string): Promise<Record<string, unknown> | null> =>
  db.getFirstAsync('SELECT * FROM albums WHERE id = ?', [id]);
