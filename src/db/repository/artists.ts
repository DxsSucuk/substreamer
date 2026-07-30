/** Artists repository: bulk upsert (row + roles), bio merge, keyset list, count, by-id. */
import type { ArtistID3, ArtistInfo2 } from 'subsonic-api';

import type { InternalDb } from '../client';
import { artistInfoRow, artistRoleRows, artistRow, artistSimilarRows } from './mappers';
import {
  bulkUpsert,
  countRows,
  keysetPage,
  keysetPageBefore,
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

/** Adapt a lean list row to the `ArtistID3` shape the row/card components render
 *  (they read `coverArt`, not `artistImageUrl`, so the lean projection suffices). */
export function artistListRowToArtistID3(r: ArtistListRow): ArtistID3 {
  return {
    id: r.id,
    name: r.name ?? '',
    coverArt: r.cover_art ?? undefined,
    albumCount: r.album_count ?? 0,
    userRating: r.user_rating ?? undefined,
    starred: r.starred ? new Date(r.starred) : undefined,
  } as ArtistID3;
}

/** Build the keyset cursor for an artist row — used by the screen to seed a
 *  backward page from the first loaded row. Artists sort by name only (no compound). */
export const artistCursorOf = (r: ArtistListRow): Cursor => ({
  sortKey: r.sort_title ?? '',
  id: r.id,
});

export function upsertArtists(
  db: InternalDb,
  artists: ArtistID3[],
  onProgress?: (done: number, total: number) => void,
  articles?: readonly string[],
): Promise<number> {
  return bulkUpsert(
    db,
    {
      table: 'artists',
      idOf: (a) => a.id,
      rowOf: (a) => artistRow(a, articles),
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

export function listArtistsBefore(
  db: InternalDb,
  opts: { before: Cursor; limit: number; starredOnly?: boolean },
): Promise<{ rows: ArtistListRow[]; prevCursor: Cursor | null }> {
  return keysetPageBefore<ArtistListRow>(db, {
    table: 'artists',
    sortCol: 'sort_title',
    columns: ARTIST_LIST_COLS,
    limit: opts.limit,
    before: opts.before,
    where: opts.starredOnly ? 'starred IS NOT NULL' : undefined,
    sortKeyOf: (r) => r.sort_title ?? '',
  });
}

export const countArtists = (db: InternalDb, starredOnly = false): Promise<number> =>
  countRows(db, 'artists', starredOnly ? 'starred IS NOT NULL' : undefined);

/** Lean rows for a set of artist ids (unordered) — the downloaded-artist filter hydrates
 *  the artists who own a downloaded album. Ids pass as a JSON array via `json_each` to
 *  dodge the bound-variable limit; an empty id set returns no rows. */
export const listArtistsByIds = (db: InternalDb, ids: string[]): Promise<ArtistListRow[]> =>
  db.getAllAsync<ArtistListRow>(
    `SELECT ${ARTIST_LIST_COLS} FROM artists WHERE id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(ids)],
  );

export const getArtist = (db: InternalDb, id: string): Promise<Record<string, unknown> | null> =>
  db.getFirstAsync('SELECT * FROM artists WHERE id = ?', [id]);

/** Artists that already have persisted top songs — the set whose top-song lists a
 *  list-length change refreshes (replaces the doomed detail store's in-memory map). */
export const listArtistsWithTopSongs = (
  db: InternalDb,
): Promise<{ id: string; name: string | null }[]> =>
  db.getAllAsync<{ id: string; name: string | null }>(
    'SELECT DISTINCT a.id, a.name FROM artists a JOIN artist_top_songs ats ON ats.artist_id = a.id',
  );

/**
 * Persist the artist-detail RESOLVED metadata: the final biography (Subsonic →
 * MusicBrainz fallback — NOT necessarily `info.biography`), the `bio_checked_at`
 * detail-fetch/negative-cache marker, and the `resolved_mbid` actually used. A targeted
 * UPDATE (no-op if the artist row isn't present yet).
 */
export const setArtistDetailMeta = (
  db: InternalDb,
  id: string,
  meta: { biography: string | null; bioCheckedAt: number | null; resolvedMbid: string | null },
): Promise<unknown> =>
  db.runAsync(
    'UPDATE artists SET biography = ?, bio_checked_at = ?, resolved_mbid = ? WHERE id = ?',
    [meta.biography, meta.bioCheckedAt, meta.resolvedMbid, id],
  );

/** Replace an artist's ordered top-song membership (position = array index). The songs
 *  themselves must already be upserted into `songs` by the caller. Async batch (no
 *  sync transaction) so it can't collide with a concurrent write. */
export const setArtistTopSongs = (db: InternalDb, artistId: string, songIds: string[]): Promise<unknown> =>
  db.runBatchAsync([
    ['DELETE FROM artist_top_songs WHERE artist_id = ?', [artistId]],
    ...songIds.map(
      (songId, pos): [string, (string | number)[]] => [
        'INSERT INTO artist_top_songs (artist_id, pos, song_id) VALUES (?, ?, ?)',
        [artistId, pos, songId],
      ],
    ),
  ]);
