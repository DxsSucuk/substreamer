/** Artists repository: bulk upsert (row + roles), bio merge, keyset list, count, by-id. */
import type { ArtistID3, ArtistInfo2 } from 'subsonic-api';

import type { InternalDb } from '../client';
import { artistInfoRow, artistRoleRows, artistRow, artistSimilarRows } from './mappers';
import {
  bulkUpsert,
  countRows,
  keysetPage,
  replaceChildrenSync,
  upsertRowSync,
  type Cursor,
  type Page,
} from './core';

/** Lean projection for list rendering. */
export interface ArtistListRow {
  id: string;
  name: string | null;
  cover_art: string | null;
  album_count: number | null;
  sort_title: string | null;
  starred: number | null;
  user_rating: number | null;
}

export const ARTIST_LIST_COLS =
  '"id", "name", "cover_art", "album_count", "sort_title", "starred", "user_rating"';

export function upsertArtists(
  db: InternalDb,
  artists: ArtistID3[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  return bulkUpsert(
    db,
    {
      table: 'artists',
      idOf: (a) => a.id,
      rowOf: artistRow,
      children: [{ table: 'artist_roles', parentCol: 'artist_id', rows: artistRoleRows }],
      onProgress,
    },
    artists,
  );
}

/**
 * Merge getArtistInfo2 (bio/images + similar artists) into an existing artist.
 * A partial upsert — it only touches the bio columns, never the base ArtistID3
 * fields, so a later library re-sync and a bio fetch don't clobber each other.
 */
export function upsertArtistInfo(db: InternalDb, id: string, info: ArtistInfo2): void {
  db.withTransactionSync(() => {
    upsertRowSync(db, 'artists', artistInfoRow(id, info));
    replaceChildrenSync(db, 'artist_similar', 'artist_id', id, artistSimilarRows(info, id));
  });
}

export function listArtists(
  db: InternalDb,
  opts: { cursor?: Cursor | null; letter?: string | null; limit: number; starredOnly?: boolean },
): Promise<Page<ArtistListRow>> {
  return keysetPage<ArtistListRow>(db, {
    table: 'artists',
    sortCol: 'sort_title',
    columns: ARTIST_LIST_COLS,
    limit: opts.limit,
    cursor: opts.cursor,
    letter: opts.letter,
    where: opts.starredOnly ? 'starred IS NOT NULL' : undefined,
    sortKeyOf: (r) => r.sort_title ?? '',
  });
}

export const countArtists = (db: InternalDb, starredOnly = false): Promise<number> =>
  countRows(db, 'artists', starredOnly ? 'starred IS NOT NULL' : undefined);

export const getArtist = (db: InternalDb, id: string): Promise<Record<string, unknown> | null> =>
  db.getFirstAsync('SELECT * FROM artists WHERE id = ?', [id]);
