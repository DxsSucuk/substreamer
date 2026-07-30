/** Albums repository: bulk upsert (row + children), keyset list, count, by-id. */
import type { AlbumID3, AlbumInfo } from 'subsonic-api';

import type { InternalDb } from '../client';
import {
  albumArtistRows,
  albumDiscTitleRows,
  albumGenreRows,
  albumInfoRow,
  albumMoodRows,
  albumRecordLabelRows,
  albumReleaseTypeRows,
  albumRow,
} from './mappers';
import {
  bulkUpsert,
  countRows,
  keysetPage,
  keysetPageBefore,
  upsertRowSync,
  type Cursor,
  type Page,
} from './core';

/** Lean projection for list rendering (the columns an album row/card needs).
 *  `artist_id` is carried so the search screen's downloaded-artist filter can map an
 *  album back to its artist (search.tsx builds that set from `album.artistId`). */
export interface AlbumListRow {
  id: string;
  name: string | null;
  artist_id: string | null;
  display_artist: string | null;
  cover_art: string | null;
  year: number | null;
  duration: number | null;
  song_count: number | null;
  sort_title: string | null;
  sort_artist: string | null;
  starred: number | null;
  user_rating: number | null;
}

export const ALBUM_LIST_COLS =
  '"id", "name", "artist_id", "display_artist", "cover_art", "year", "duration", "song_count", ' +
  '"sort_title", "sort_artist", "starred", "user_rating"';

export type AlbumSortOrder = 'title' | 'artist';

/** Adapt a lean list row to the `AlbumID3` shape the row/card components render.
 *  Only the fields those components read are populated; required scalars get
 *  harmless defaults (list rows never show created date). */
export function albumListRowToAlbumID3(r: AlbumListRow): AlbumID3 {
  return {
    id: r.id,
    name: r.name ?? '',
    artistId: r.artist_id ?? undefined,
    artist: r.display_artist ?? undefined,
    coverArt: r.cover_art ?? undefined,
    year: r.year ?? undefined,
    duration: r.duration ?? 0,
    songCount: r.song_count ?? 0,
    userRating: r.user_rating ?? undefined,
    starred: r.starred ? new Date(r.starred) : undefined,
    created: new Date(0),
  } as AlbumID3;
}

export function upsertAlbums(
  db: InternalDb,
  albums: AlbumID3[],
  onProgress?: (done: number, total: number) => void,
  articles?: readonly string[],
): Promise<number> {
  return bulkUpsert(
    db,
    {
      table: 'albums',
      idOf: (a) => a.id,
      rowOf: (a) => albumRow(a, articles),
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

/**
 * Merge getAlbumInfo2 (notes/images/lastFmUrl) into an existing album. A partial
 * upsert — it only touches the info columns, never the base AlbumID3 fields, so a
 * later library re-sync and an info fetch don't clobber each other. Mirrors
 * upsertArtistInfo (albums have no info child arrays).
 */
export function upsertAlbumInfo(db: InternalDb, id: string, info: AlbumInfo): void {
  db.withTransactionSync(() => {
    upsertRowSync(db, 'albums', albumInfoRow(id, info));
  });
}

/** Sort by artist uses the compound key (sort_artist, sort_title, id) so albums by
 *  the same artist stay grouped and alphabetised; sort by title is the plain
 *  (sort_title, id) key. The A–Z scroller seeks on the primary column either way. */
function albumSortCols(sortOrder?: AlbumSortOrder) {
  const byArtist = sortOrder === 'artist';
  return {
    sortCol: byArtist ? 'sort_artist' : 'sort_title',
    sortCol2: byArtist ? 'sort_title' : undefined,
    sortKeyOf: (r: AlbumListRow) => (byArtist ? r.sort_artist : r.sort_title) ?? '',
    sortKey2Of: byArtist ? (r: AlbumListRow) => r.sort_title ?? '' : undefined,
  };
}

/** Build the keyset cursor for an album row under the active sort order — used by
 *  the screen to seed a backward page from the first loaded row. */
export function albumCursorOf(r: AlbumListRow, sortOrder?: AlbumSortOrder): Cursor {
  return sortOrder === 'artist'
    ? { sortKey: r.sort_artist ?? '', sortKey2: r.sort_title ?? '', id: r.id }
    : { sortKey: r.sort_title ?? '', id: r.id };
}

export function listAlbums(
  db: InternalDb,
  opts: {
    cursor?: Cursor | null;
    letter?: string | null;
    limit: number;
    starredOnly?: boolean;
    sortOrder?: AlbumSortOrder;
  },
): Promise<Page<AlbumListRow>> {
  return keysetPage<AlbumListRow>(db, {
    table: 'albums',
    columns: ALBUM_LIST_COLS,
    limit: opts.limit,
    cursor: opts.cursor,
    letter: opts.letter,
    where: opts.starredOnly ? 'starred IS NOT NULL' : undefined,
    ...albumSortCols(opts.sortOrder),
  });
}

export function listAlbumsBefore(
  db: InternalDb,
  opts: { before: Cursor; limit: number; starredOnly?: boolean; sortOrder?: AlbumSortOrder },
): Promise<{ rows: AlbumListRow[]; prevCursor: Cursor | null }> {
  return keysetPageBefore<AlbumListRow>(db, {
    table: 'albums',
    columns: ALBUM_LIST_COLS,
    limit: opts.limit,
    before: opts.before,
    where: opts.starredOnly ? 'starred IS NOT NULL' : undefined,
    ...albumSortCols(opts.sortOrder),
  });
}

export const countAlbums = (db: InternalDb, starredOnly = false): Promise<number> =>
  countRows(db, 'albums', starredOnly ? 'starred IS NOT NULL' : undefined);

/** Lean rows for a set of album ids (unordered) — the downloaded set for offline
 *  search. Ids pass as a JSON array via `json_each` to dodge the bound-variable limit;
 *  an empty id set is the caller's job to guard (this returns no rows for it). */
export const listAlbumsByIds = (db: InternalDb, ids: string[]): Promise<AlbumListRow[]> =>
  db.getAllAsync<AlbumListRow>(
    `SELECT ${ALBUM_LIST_COLS} FROM albums WHERE id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(ids)],
  );

/** Delete album rows by id (children cascade via FK ON DELETE). Ids are passed as a
 *  JSON array via `json_each` to dodge the SQLite bound-variable limit. Used by the
 *  incremental removal path so a server-deleted album doesn't ghost in the list. */
export const deleteAlbums = (db: InternalDb, ids: string[]): Promise<unknown> =>
  db.runAsync('DELETE FROM albums WHERE id IN (SELECT value FROM json_each(?))', [
    JSON.stringify(ids),
  ]);

/** Eager +1 play-count + last-played for a just-scrobbled album — a TARGETED scalar
 *  UPDATE (no child-table churn) so normalized play stats stay current for the detail
 *  screens. Relative increment mirrors the store bumps; a full resync overwrites with
 *  the server value. No-op if the album isn't in the table yet. */
export const bumpAlbumPlayStats = (db: InternalDb, id: string, played: string): Promise<unknown> =>
  db.runAsync(
    'UPDATE albums SET play_count = COALESCE(play_count, 0) + 1, played = ? WHERE id = ?',
    [played, id],
  );

export const getAlbum = (db: InternalDb, id: string): Promise<Record<string, unknown> | null> =>
  db.getFirstAsync('SELECT * FROM albums WHERE id = ?', [id]);

/** Every album id in the table — the normalized replacement for the sync's in-memory
 *  `albumLibraryStore.albums` `knownIds` set (change-detect + walk enumeration). */
export const listAlbumIds = (db: InternalDb): Promise<string[]> =>
  db.getAllAsync<{ id: string }>('SELECT id FROM albums').then((rows) => rows.map((r) => r.id));

/** All album lean rows, sort-title order. For the CarPlay/headless A–Z browse + voice
 *  vocabulary — the normalized replacement for reading `albumLibraryStore.albums`.
 *  (NB: whole-table read; a per-letter headless browse is a follow-up memory refinement.) */
export const listAllAlbums = (db: InternalDb): Promise<AlbumListRow[]> =>
  db.getAllAsync<AlbumListRow>(`SELECT ${ALBUM_LIST_COLS} FROM albums ORDER BY sort_title, "id"`);

/**
 * Non-destructive full-sync reconcile: delete album rows whose id is NOT in the current
 * server set AND NOT protected (downloaded/favorited detail we must never reap). Replaces
 * `resetNormalizedSchema` (DROP+recreate) for full sync so offline content survives.
 * Children cascade via FK. Both id sets pass as JSON via `json_each`.
 */
export const reconcileAlbums = (
  db: InternalDb,
  keepIds: string[],
  protectedIds: string[] = [],
): Promise<unknown> =>
  db.runAsync(
    'DELETE FROM albums WHERE id NOT IN (SELECT value FROM json_each(?)) ' +
      'AND id NOT IN (SELECT value FROM json_each(?))',
    [JSON.stringify(keepIds), JSON.stringify(protectedIds)],
  );
