/**
 * Favourites repository — the ONE place the starred set is read and written.
 *
 * Favourites live in two halves, chosen by whether the library already holds the row:
 *  - **marked library rows** — `songs`/`albums`/`artists`.`starred` set by `markStarred*`.
 *    The reconcile NEVER inserts into those tables: a row there means "the library sync
 *    put it here", and the presence checks across the app depend on that.
 *  - **the remainder** — `favorite_songs`/`favorite_albums`/`favorite_artists`, holding
 *    the verbatim `getStarred2` envelope for starred items the library does not have.
 *    Normally EMPTY (the library sync enumerates everything the server has).
 *
 * The two halves are kept disjoint at READ time, by a `NOT EXISTS` clause on every
 * remainder query — never by assuming a past reconcile left them disjoint. It cannot:
 * a `getAlbum` response carries `starred`, and `albumRow` writes it, so tapping a
 * remainder album gives it a marked library row seconds later.
 *
 * The PAGED reads order by `starred DESC, id DESC` (newest favourite first) and page
 * through the SAME `keysetPage` primitive against ONE shared cursor, so their cursor
 * semantics cannot drift. The whole-set reads take that as their default and also offer
 * A–Z order on the stored `sort_*` keys — the Favourites TAB wants the former, the
 * Library tab's favourites filter the latter, and both come from this one reader.
 */
import type { AlbumID3, ArtistID3, Child } from 'subsonic-api';

import { mergeSorted, mergeStarredDesc, type StarredEntry } from '@/utils/mergeStarredDesc';

import type { BatchCommand, InternalDb } from '../client';
import { albumSortKeys, artistSortTitle, songSortKeys } from '../sortKeys';
import { getSortArticles } from '../sortArticles';
import {
  ALBUM_LIST_COLS,
  albumListRowToAlbumID3,
  hydrateAlbumRows,
  type AlbumListRow,
  type AlbumSortOrder,
} from './albums';
import { ARTIST_LIST_COLS, artistListRowToArtistID3, hydrateArtistRows, type ArtistListRow } from './artists';
import { countRows, keysetPage, type Cursor } from './core';
// The download predicates live in `downloads.ts` — ONE definition, so the library tab's
// filter and the favourites filter cannot drift apart.
import { downloadedClause, type DownloadableEntity } from './downloads';
import {
  SONG_LIST_COLS,
  hydrateSongRows,
  songListRowToChild,
  type SongListRow,
  type SongSortOrder,
} from './songs';

export type { StarredEntry } from '@/utils/mergeStarredDesc';

/**
 * A whole-set read's result: the item, plus the key SQL ordered it by.
 *
 * The key is carried rather than re-derived because the A–Z scroller's letter comes from
 * it — recomputing one from the envelope is a second derivation of the same thing, and it
 * has silently disagreed with the stored key three times. `AlbumID3`/`ArtistID3`/`Child`
 * are Subsonic API types and stay clean; the wrapper holds the key.
 *
 * `sortKey` is `''` in the default newest-favourite order, which has no A–Z scroller.
 */
export interface StarredItem<T> extends StarredEntry<T> {
  sortKey: string;
}

/** `toAlbum`/`toArtist`/`toSong` and `sortKeyOf` for a list handed `StarredItem`s.
 *  Module-level so their identity is stable across renders. */
export const starredItemOf = <T,>(e: StarredItem<T>): T => e.item;
export const starredSortKeyOf = (e: StarredItem<unknown>): string => e.sortKey;

/** The three library tables that carry a `starred` mark. */
type Entity = 'songs' | 'albums' | 'artists';

const REMAINDER: Record<Entity, string> = {
  songs: 'favorite_songs',
  albums: 'favorite_albums',
  artists: 'favorite_artists',
};

/** Mirrors `bulkUpsert`'s chunk size — a first reconcile marks the whole favourites
 *  set, which unchunked would be one batch of tens of thousands of statements. */
const CHUNK = 500;

/** Filters both halves take. `downloadedOnly` must reach the remainder too: the
 *  download tables have no FK to `songs`, so a remainder favourite CAN be downloaded —
 *  and an offline list that shows unplayable rows is the one thing offline must not do. */
export interface StarredFilter {
  downloadedOnly?: boolean;
  includePartial?: boolean;
}

/** Whole-set album read. `sortOrder` ABSENT keeps the Favourites tab's
 *  newest-favourite-first; set, it is the Library tab's A–Z filter. */
export interface StarredAlbumListOpts extends StarredFilter {
  sortOrder?: AlbumSortOrder;
}

/** Whole-set song read — `sortOrder` as on {@link StarredAlbumListOpts}. Absent is
 *  newest-favourite-first, which is what Play All, Shuffle All, tap-to-play, the CarPlay
 *  queue and the `__starred__` download all read. */
export interface StarredSongListOpts extends StarredFilter {
  sortOrder?: SongSortOrder;
}

/** Whole-set artist read — no download filter (artists are not downloadable). */
export interface StarredArtistListOpts {
  sortOrder?: 'name';
}

/* ------------------------------------------------------------------ */
/*  Predicates — built ONCE per entity, shared verbatim by both halves */
/* ------------------------------------------------------------------ */

/**
 * `DownloadableEntity` excludes artists by construction — an artist is not a downloadable
 * object, so the Downloaded filter hides artist lists outright (see `library.tsx` /
 * `favorites.tsx`) rather than narrowing them to "owns a downloaded album". The type is what
 * stops that predicate being reintroduced.
 */
const isDownloadable = (entity: Entity): entity is DownloadableEntity => entity !== 'artists';

/**
 * "No marked library row owns this id." `NOT EXISTS`, not `NOT IN`: SQLite answers an
 * uncorrelated `NOT IN (SELECT …)` by materialising the whole subquery into an
 * ephemeral b-tree on every execution — 50,000 index entries built per page read to
 * answer a handful of probes. `NOT EXISTS` is a correlated PK probe per remainder row,
 * and has no NULL footgun. The rule is about a subquery over a TABLE on a repeated read —
 * it does not reach the once-per-sync prunes, which have no table to correlate against
 * (see `reconcileAlbums`, `deletePlaylistsNotIn`).
 */
const disjointClause = (entity: Entity): string =>
  `NOT EXISTS (SELECT 1 FROM ${entity} t WHERE t.id = ${REMAINDER[entity]}.id AND t.starred IS NOT NULL)`;

/** WHERE for the LIBRARY half. `starred IS NOT NULL` is the membership test — `0` is a
 *  member (the server sent no date), and every partial index uses the same predicate. */
const libraryWhere = (entity: Entity, f: StarredFilter): string =>
  f.downloadedOnly && isDownloadable(entity)
    ? `starred IS NOT NULL AND ${downloadedClause(entity, f.includePartial === true)}`
    : 'starred IS NOT NULL';

/** WHERE for the REMAINDER half — disjointness first, then the same download filter. */
const remainderWhere = (entity: Entity, f: StarredFilter): string =>
  f.downloadedOnly && isDownloadable(entity)
    ? `${disjointClause(entity)} AND ${downloadedClause(entity, f.includePartial === true)}`
    : disjointClause(entity);

/* ------------------------------------------------------------------ */
/*  Remainder rows → entities                                          */
/* ------------------------------------------------------------------ */

interface RemainderRow {
  id: string;
  starred: number;
  json: string;
  /** Mirrors the library table's key of the same name — `sort_artist` is absent on the
   *  artist remainder, where the name IS the title key. */
  sort_title?: string | null;
  sort_artist?: string | null;
}
interface RemainderSongRow extends RemainderRow {
  duration: number | null;
}

const REMAINDER_SONG_COLS = '"id", "starred", "duration", "sort_title", "sort_artist", "json"';
const REMAINDER_ALBUM_COLS = '"id", "starred", "sort_title", "sort_artist", "json"';
const REMAINDER_ARTIST_COLS = '"id", "starred", "sort_title", "json"';

/** Rehydrate the dates `JSON.stringify` flattened to ISO strings, so a remainder row
 *  and a library row present the same shape. `starred: 0` reads back as `undefined` —
 *  membership without a fabricated date. */
function parseEntry<T extends { created?: Date; starred?: Date }>(row: RemainderRow): StarredEntry<T> {
  const parsed = JSON.parse(row.json) as T;
  return {
    id: row.id,
    starred: row.starred,
    item: {
      ...parsed,
      ...(parsed.created ? { created: new Date(parsed.created) } : {}),
      starred: row.starred ? new Date(row.starred) : undefined,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Paged reads — one page from each half, merged against one cursor    */
/* ------------------------------------------------------------------ */

interface StarredPage<T> {
  rows: StarredEntry<T>[];
  nextCursor: Cursor | null;
}

export interface StarredPageOpts extends StarredFilter {
  cursor?: Cursor | null;
  limit: number;
}

/**
 * Merge one page from each half into the next `limit` rows of the union.
 *
 * Each side returns ITS OWN top-K below the shared cursor, and the true top-K of the
 * union is necessarily a subset of (top-K of A ∪ top-K of B) — so the slice is exactly
 * the next K rows of the merged sequence, and the over-fetched tail is simply re-read
 * on the following page. `nextCursor` is conservative: it can be non-null when the next
 * page turns out empty (which resolves itself), never null when rows remain.
 */
function mergePages<T>(
  lib: StarredPage<T>,
  rem: { rows: StarredEntry<T>[]; hasMore: boolean },
  limit: number,
): StarredPage<T> {
  const all = mergeStarredDesc(lib.rows, rem.rows);
  const rows = all.slice(0, limit);
  const more = all.length > limit || lib.nextCursor != null || rem.hasMore;
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  return { rows, nextCursor: more && last ? { sortKey: last.starred, id: last.id } : null };
}

async function remainderPage<T extends { created?: Date; starred?: Date }>(
  db: InternalDb,
  entity: Entity,
  columns: string,
  opts: StarredPageOpts,
): Promise<{ rows: StarredEntry<T>[]; hasMore: boolean }> {
  const page = await keysetPage<RemainderRow>(db, {
    table: REMAINDER[entity],
    sortCol: 'starred',
    columns,
    direction: 'desc',
    limit: opts.limit,
    cursor: opts.cursor,
    where: remainderWhere(entity, opts),
    sortKeyOf: (r) => r.starred,
  });
  return { rows: page.rows.map((r) => parseEntry<T>(r)), hasMore: page.nextCursor != null };
}

/** One page of starred songs, newest favourite first. */
export async function starredSongsPage(
  db: InternalDb,
  opts: StarredPageOpts,
): Promise<StarredPage<Child>> {
  const page = await keysetPage<SongListRow>(db, {
    table: 'songs',
    sortCol: 'starred',
    columns: SONG_LIST_COLS,
    direction: 'desc',
    limit: opts.limit,
    cursor: opts.cursor,
    where: libraryWhere('songs', opts),
    sortKeyOf: (r) => r.starred ?? 0,
  });
  await hydrateSongRows(db, page.rows);
  const lib: StarredPage<Child> = {
    rows: page.rows.map((r) => ({ id: r.id, starred: r.starred ?? 0, item: songListRowToChild(r) })),
    nextCursor: page.nextCursor,
  };
  return mergePages(lib, await remainderPage<Child>(db, 'songs', REMAINDER_SONG_COLS, opts), opts.limit);
}

/** One page of starred albums, newest favourite first. */
export async function starredAlbumsPage(
  db: InternalDb,
  opts: StarredPageOpts,
): Promise<StarredPage<AlbumID3>> {
  const page = await keysetPage<AlbumListRow>(db, {
    table: 'albums',
    sortCol: 'starred',
    columns: ALBUM_LIST_COLS,
    direction: 'desc',
    limit: opts.limit,
    cursor: opts.cursor,
    where: libraryWhere('albums', opts),
    sortKeyOf: (r) => r.starred ?? 0,
  });
  await hydrateAlbumRows(db, page.rows);
  const lib: StarredPage<AlbumID3> = {
    rows: page.rows.map((r) => ({ id: r.id, starred: r.starred ?? 0, item: albumListRowToAlbumID3(r) })),
    nextCursor: page.nextCursor,
  };
  return mergePages(
    lib,
    await remainderPage<AlbumID3>(db, 'albums', REMAINDER_ALBUM_COLS, opts),
    opts.limit,
  );
}

/** Options for the artist reads — deliberately WITHOUT `StarredFilter`. Artists are not
 *  downloadable, so there is no downloaded variant of this list to ask for. */
export type StarredArtistPageOpts = Omit<StarredPageOpts, keyof StarredFilter>;

/** One page of starred artists, newest favourite first. */
export async function starredArtistsPage(
  db: InternalDb,
  opts: StarredArtistPageOpts,
): Promise<StarredPage<ArtistID3>> {
  const page = await keysetPage<ArtistListRow>(db, {
    table: 'artists',
    sortCol: 'starred',
    columns: ARTIST_LIST_COLS,
    direction: 'desc',
    limit: opts.limit,
    cursor: opts.cursor,
    where: libraryWhere('artists', {}),
    sortKeyOf: (r) => r.starred ?? 0,
  });
  await hydrateArtistRows(db, page.rows);
  const lib: StarredPage<ArtistID3> = {
    rows: page.rows.map((r) => ({ id: r.id, starred: r.starred ?? 0, item: artistListRowToArtistID3(r) })),
    nextCursor: page.nextCursor,
  };
  return mergePages(
    lib,
    await remainderPage<ArtistID3>(db, 'artists', REMAINDER_ARTIST_COLS, opts),
    opts.limit,
  );
}

/* ------------------------------------------------------------------ */
/*  Whole-set reads — O(favourites), never O(library)                  */
/* ------------------------------------------------------------------ */

/** Newest favourite first — the Favourites tab's order, and the default everywhere. */
const STARRED_DESC = '"starred" DESC, "id" DESC';

/**
 * The A–Z `ORDER BY` tuples, as column names. Both halves carry the same `sort_*`
 * columns, so ONE tuple drives both queries and the JS merge of their results.
 * `id` last makes the order total, so the merge below is deterministic.
 *
 * Shared by albums and songs: `AlbumSortOrder` and `SongSortOrder` are the same pair,
 * and both entities key their browse list on the same two columns.
 */
const NAME_ORDER: Record<AlbumSortOrder, readonly string[]> = {
  title: ['sort_title', 'id'],
  artist: ['sort_artist', 'sort_title', 'id'],
};
const ARTIST_NAME_ORDER: readonly string[] = ['sort_title', 'id'];

const orderBySql = (cols: readonly string[]): string => cols.map((c) => `"${c}"`).join(', ');

/**
 * A row's ORDER BY tuple, read off the row. NULL keys collate first in SQLite and read
 * as `''` here, which sorts first too — so a row the migration has not reached yet sits
 * in the same place on both sides of the merge.
 */
const keyTupleOf = (r: object, cols: readonly string[]): string[] =>
  cols.map((c) => ((r as Record<string, unknown>)[c] as string | null | undefined) ?? '');

/** True when `x` sorts at or before `y` under the same tuple. `<` on strings is UTF-16
 *  code units, which is what SQLite's BINARY collation does on TEXT. */
const tupleAtOrBefore = <T>(x: Keyed<T>, y: Keyed<T>): boolean => {
  for (let i = 0; i < x.keys.length; i++) {
    if (x.keys[i] !== y.keys[i]) return x.keys[i] < y.keys[i];
  }
  return true;
};

type Keyed<T> = StarredEntry<T> & { keys: readonly string[] };

/** Merge the two halves under `cols` when given, else newest-favourite-first. The
 *  emitted `sortKey` is the LEADING column of the tuple, which is the one the scroller
 *  letters on — empty in newest-favourite order, which has no A–Z scroller. */
function mergeHalves<T>(
  lib: readonly StarredEntry<T>[],
  rem: readonly StarredEntry<T>[],
  libRows: readonly object[],
  remRows: readonly object[],
  cols: readonly string[] | null,
): StarredItem<T>[] {
  if (!cols) return mergeStarredDesc(lib, rem).map((e) => ({ ...e, sortKey: '' }));
  const key = (e: StarredEntry<T>, i: number, rows: readonly object[]): Keyed<T> => ({
    ...e,
    keys: keyTupleOf(rows[i], cols),
  });
  return mergeSorted(
    lib.map((e, i) => key(e, i, libRows)),
    rem.map((e, i) => key(e, i, remRows)),
    tupleAtOrBefore,
  ).map(({ id, starred, item, keys }) => ({ id, starred, item, sortKey: keys[0] }));
}

async function allRemainder<T extends { created?: Date; starred?: Date }>(
  db: InternalDb,
  entity: Entity,
  columns: string,
  f: StarredFilter,
  order: string = STARRED_DESC,
): Promise<{ entries: StarredEntry<T>[]; rows: RemainderRow[] }> {
  const rows = await db.getAllAsync<RemainderRow>(
    `SELECT ${columns} FROM ${REMAINDER[entity]} WHERE ${remainderWhere(entity, f)} ` +
      `ORDER BY ${order}`,
  );
  return { entries: rows.map((r) => parseEntry<T>(r)), rows };
}

/**
 * The WHOLE starred song set. **O(favourites)** — the one unbounded read this module
 * has, bounded by a user-curated set rather than the library. Its callers (Play All,
 * Shuffle All, tap-to-play, the CarPlay queue, the `__starred__` download, the
 * library-tab favourites filter) each need the full list.
 *
 * `sortOrder` ABSENT is newest favourite first, which every play/download caller wants.
 * Set, it is the Songs tab's favourites filter, ordered in SQL by the same stored keys
 * the browse list uses — so toggling the filter cannot reorder the rows.
 *
 * Returns {@link StarredItem}s: the envelope plus the key it was ordered by. Callers that
 * only want the songs map with {@link starredItemOf}.
 */
export async function listAllStarredSongs(
  db: InternalDb,
  f: StarredSongListOpts = {},
): Promise<StarredItem<Child>[]> {
  const cols = f.sortOrder ? NAME_ORDER[f.sortOrder] : null;
  const order = cols ? orderBySql(cols) : STARRED_DESC;
  const rows = await db.getAllAsync<SongListRow>(
    `SELECT ${SONG_LIST_COLS} FROM songs WHERE ${libraryWhere('songs', f)} ORDER BY ${order}`,
  );
  await hydrateSongRows(db, rows);
  const lib = rows.map((r) => ({ id: r.id, starred: r.starred ?? 0, item: songListRowToChild(r) as Child }));
  const rem = await allRemainder<Child>(db, 'songs', REMAINDER_SONG_COLS, f, order);
  return mergeHalves(lib, rem.entries, rows, rem.rows, cols);
}

/**
 * The whole starred album set. O(favourites) — see above.
 *
 * `sortOrder` ABSENT is newest favourite first, which is what the Favourites TAB shows
 * and what every play/download caller wants. Set, it is the Library tab's A–Z filter,
 * ordered in SQL by the same stored keys the browse list uses — so toggling the filter
 * cannot reorder the rows. Returns {@link StarredItem}s — see `listAllStarredSongs`.
 */
export async function listAllStarredAlbums(
  db: InternalDb,
  f: StarredAlbumListOpts = {},
): Promise<StarredItem<AlbumID3>[]> {
  const cols = f.sortOrder ? NAME_ORDER[f.sortOrder] : null;
  const order = cols ? orderBySql(cols) : STARRED_DESC;
  const rows = await db.getAllAsync<AlbumListRow>(
    `SELECT ${ALBUM_LIST_COLS} FROM albums WHERE ${libraryWhere('albums', f)} ORDER BY ${order}`,
  );
  await hydrateAlbumRows(db, rows);
  const lib = rows.map((r) => ({
    id: r.id,
    starred: r.starred ?? 0,
    item: albumListRowToAlbumID3(r) as AlbumID3,
  }));
  const rem = await allRemainder<AlbumID3>(db, 'albums', REMAINDER_ALBUM_COLS, f, order);
  return mergeHalves(lib, rem.entries, rows, rem.rows, cols);
}

/** The whole starred artist set. `sortOrder: 'name'` is the Library tab's A–Z filter;
 *  absent is newest favourite first (the Favourites tab). O(favourites) — see above.
 *  Returns {@link StarredItem}s — see `listAllStarredSongs`. Takes no download filter:
 *  artists are not downloadable (see {@link DownloadableEntity}). */
export async function listAllStarredArtists(
  db: InternalDb,
  opts: StarredArtistListOpts = {},
): Promise<StarredItem<ArtistID3>[]> {
  const cols = opts.sortOrder === 'name' ? ARTIST_NAME_ORDER : null;
  const order = cols ? orderBySql(cols) : STARRED_DESC;
  const rows = await db.getAllAsync<ArtistListRow>(
    `SELECT ${ARTIST_LIST_COLS} FROM artists WHERE ${libraryWhere('artists', {})} ORDER BY ${order}`,
  );
  await hydrateArtistRows(db, rows);
  const lib = rows.map((r) => ({
    id: r.id,
    starred: r.starred ?? 0,
    item: artistListRowToArtistID3(r) as ArtistID3,
  }));
  const rem = await allRemainder<ArtistID3>(db, 'artists', REMAINDER_ARTIST_COLS, {}, order);
  return mergeHalves(lib, rem.entries, rows, rem.rows, cols);
}

/* ------------------------------------------------------------------ */
/*  Membership ids, counts, totals                                     */
/* ------------------------------------------------------------------ */

const listIds = (db: InternalDb, entity: Entity): Promise<Set<string>> =>
  db
    .getAllAsync<{ id: string }>(
      `SELECT id FROM ${entity} WHERE starred IS NOT NULL UNION SELECT id FROM ${REMAINDER[entity]}`,
    )
    .then((rows) => new Set(rows.map((r) => r.id)));

/** Every starred id — marked library rows UNION the remainder. This is what the star
 *  icons read, so a remainder favourite shows a filled heart too. Index-only on the
 *  library side; `UNION` dedups, so no disjointness clause is needed. */
export const listStarredSongIds = (db: InternalDb): Promise<Set<string>> => listIds(db, 'songs');
export const listStarredAlbumIds = (db: InternalDb): Promise<Set<string>> => listIds(db, 'albums');
export const listStarredArtistIds = (db: InternalDb): Promise<Set<string>> => listIds(db, 'artists');

/** Total starred songs across both halves — the emptiness test for the `__starred__`
 *  download aggregate, answered by two COUNT(*)s instead of a whole-set read. */
export async function countStarredSongs(db: InternalDb): Promise<number> {
  const [lib, rem] = await Promise.all([
    countRows(db, 'songs', 'starred IS NOT NULL'),
    countRows(db, REMAINDER.songs, disjointClause('songs')),
  ]);
  return lib + rem;
}

/** Count + summed duration for the Favourites action bar — two SQL aggregates, both
 *  O(favourites). `duration` is a hot column on `favorite_songs` precisely so the
 *  remainder half does not have to be parsed to answer this. */
export async function starredSongTotals(
  db: InternalDb,
  f: StarredFilter = {},
): Promise<{ count: number; duration: number }> {
  const agg = 'SELECT COUNT(*) AS n, COALESCE(SUM(duration), 0) AS d FROM';
  const [lib, rem] = await Promise.all([
    db.getFirstAsync<{ n: number; d: number }>(
      `${agg} songs WHERE ${libraryWhere('songs', f)}`,
    ),
    db.getFirstAsync<{ n: number; d: number }>(
      `${agg} ${REMAINDER.songs} WHERE ${remainderWhere('songs', f)}`,
    ),
  ]);
  return {
    count: (lib?.n ?? 0) + (rem?.n ?? 0),
    duration: (lib?.d ?? 0) + (rem?.d ?? 0),
  };
}

/** Starred artist names, both halves — the voice-assistant vocabulary donation. */
export async function listStarredArtistNames(db: InternalDb): Promise<string[]> {
  const [lib, rem] = await Promise.all([
    db.getAllAsync<{ name: string | null }>('SELECT "name" FROM artists WHERE starred IS NOT NULL'),
    db.getAllAsync<{ json: string }>(
      `SELECT "json" FROM ${REMAINDER.artists} WHERE ${disjointClause('artists')}`,
    ),
  ]);
  return [
    ...lib.map((r) => r.name ?? ''),
    ...rem.map((r) => (JSON.parse(r.json) as ArtistID3).name ?? ''),
  ].filter((n) => n.length > 0);
}

/**
 * One uniformly-random starred song (id + title), or null when there are none.
 *
 * The `ORDER BY` is load-bearing even though the pick is random: without it the planner
 * may satisfy `starred IS NOT NULL` with a full table scan of `songs` and count rows
 * off, which on a 1–3M-song library is six orders of magnitude off the intended
 * partial-index probe. Returns null rather than retrying if the counts moved between
 * the two reads — the caller simply drops the mix.
 */
export async function randomStarredSong(
  db: InternalDb,
): Promise<{ id: string; title?: string } | null> {
  const [libCount, remCount] = await Promise.all([
    countRows(db, 'songs', 'starred IS NOT NULL'),
    countRows(db, REMAINDER.songs, disjointClause('songs')),
  ]);
  const total = libCount + remCount;
  if (total === 0) return null;
  const k = Math.floor(Math.random() * total);
  if (k < libCount) {
    const row = await db.getFirstAsync<{ id: string; title: string | null }>(
      'SELECT "id", "title" FROM songs WHERE starred IS NOT NULL ' +
        'ORDER BY "starred" DESC, "id" DESC LIMIT 1 OFFSET ?',
      [k],
    );
    return row ? { id: row.id, title: row.title ?? undefined } : null;
  }
  const row = await db.getFirstAsync<{ id: string; json: string }>(
    `SELECT "id", "json" FROM ${REMAINDER.songs} WHERE ${disjointClause('songs')} ` +
      'ORDER BY "starred" DESC, "id" DESC LIMIT 1 OFFSET ?',
    [k - libCount],
  );
  return row ? { id: row.id, title: (JSON.parse(row.json) as Child).title } : null;
}

/* ------------------------------------------------------------------ */
/*  Writers                                                            */
/* ------------------------------------------------------------------ */

/** One favourite to mark on its existing library row. */
export interface StarMark {
  id: string;
  starredAt: number;
}

async function runChunked(db: InternalDb, commands: BatchCommand[]): Promise<void> {
  for (let i = 0; i < commands.length; i += CHUNK) {
    await db.runBatchAsync(commands.slice(i, i + CHUNK));
  }
}

const markStarred = (db: InternalDb, entity: Entity, marks: readonly StarMark[]): Promise<void> =>
  runChunked(
    db,
    marks.map((m): BatchCommand => [`UPDATE ${entity} SET starred = ? WHERE id = ?`, [m.starredAt, m.id]]),
  );

/**
 * Set the starred mark on existing library rows. Deliberately NOT transactional: the
 * marks are recomputed from the payload on every reconcile (startup, pull-to-refresh,
 * every toggle), so a half-applied run repairs itself on the next `fetchStarred`.
 */
export const markStarredSongs = (db: InternalDb, marks: readonly StarMark[]): Promise<void> =>
  markStarred(db, 'songs', marks);
export const markStarredAlbums = (db: InternalDb, marks: readonly StarMark[]): Promise<void> =>
  markStarred(db, 'albums', marks);
export const markStarredArtists = (db: InternalDb, marks: readonly StarMark[]): Promise<void> =>
  markStarred(db, 'artists', marks);

const clearStarredNotIn = (db: InternalDb, entity: Entity, keepIds: readonly string[]): Promise<unknown> =>
  db.runAsync(
    `UPDATE ${entity} SET starred = NULL WHERE starred IS NOT NULL ` +
      'AND id NOT IN (SELECT value FROM json_each(?))',
    [JSON.stringify(keepIds)],
  );

/**
 * Clear every mark not in the payload — the favourites reconcile is the ONLY clearing
 * writer for `starred` (the mappers spread the key conditionally so a library upsert
 * can never wipe one). One statement, ids bound as a JSON array via `json_each` to
 * dodge the bound-variable limit; the caller pays one `JSON.stringify` of the kept set.
 * Not transactional, for the same self-repairing reason as `markStarred*`.
 */
export const clearStarredSongsNotIn = (db: InternalDb, keepIds: readonly string[]): Promise<unknown> =>
  clearStarredNotIn(db, 'songs', keepIds);
export const clearStarredAlbumsNotIn = (db: InternalDb, keepIds: readonly string[]): Promise<unknown> =>
  clearStarredNotIn(db, 'albums', keepIds);
export const clearStarredArtistsNotIn = (db: InternalDb, keepIds: readonly string[]): Promise<unknown> =>
  clearStarredNotIn(db, 'artists', keepIds);

/**
 * Rebuild a remainder table from scratch, TRANSACTIONALLY.
 *
 * These rows are the only local copy of items the library does not have, and restoring
 * them needs a network call the user may not be able to make — so unlike the marks they
 * are not derivable offline, and a delete-then-insert rebuild killed mid-way would leave
 * a fraction of the set. Hence ONE `runAtomicBatchAsync` — the JS thread never yields
 * between the DELETE and the last INSERT, so no other writer's statements land inside
 * our savepoint.
 */
async function replaceRemainder(
  db: InternalDb,
  entity: Entity,
  commands: BatchCommand[],
): Promise<void> {
  await db.runAtomicBatchAsync([
    [`DELETE FROM ${REMAINDER[entity]}`, []] as BatchCommand,
    ...commands,
  ]);
}

/** Replace `favorite_songs` with the starred songs the library does not hold.
 *  `duration`, the sort keys and `json` are written from the SAME payload object in one
 *  statement, so neither the hot column nor the keys can disagree with the envelope. */
export const replaceFavoriteSongs = (db: InternalDb, songs: readonly Child[]): Promise<void> => {
  const articles = getSortArticles();
  return replaceRemainder(
    db,
    'songs',
    songs.map((s): BatchCommand => {
      const keys = songSortKeys(s, articles);
      return [
        'INSERT OR REPLACE INTO favorite_songs (id, starred, duration, sort_title, sort_artist, json) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
        [
          s.id,
          epochOf(s.starred),
          s.duration ?? null,
          keys.sort_title,
          keys.sort_artist,
          JSON.stringify(s),
        ],
      ];
    }),
  );
};

/** The sort keys come from the SAME envelope in the same statement, through the same
 *  `db/sortKeys` derivation the `albums` table uses — nothing is parsed back out of
 *  `json`, and the remainder can never order differently from the library half. */
export const replaceFavoriteAlbums = (db: InternalDb, albums: readonly AlbumID3[]): Promise<void> => {
  const articles = getSortArticles();
  return replaceRemainder(
    db,
    'albums',
    albums.map((a): BatchCommand => {
      const keys = albumSortKeys(a, articles);
      return [
        'INSERT OR REPLACE INTO favorite_albums (id, starred, sort_title, sort_artist, json) ' +
          'VALUES (?, ?, ?, ?, ?)',
        [a.id, epochOf(a.starred), keys.sort_title, keys.sort_artist, JSON.stringify(a)],
      ];
    }),
  );
};

export const replaceFavoriteArtists = (db: InternalDb, artists: readonly ArtistID3[]): Promise<void> => {
  const articles = getSortArticles();
  return replaceRemainder(
    db,
    'artists',
    artists.map((a): BatchCommand => [
      'INSERT OR REPLACE INTO favorite_artists (id, starred, sort_title, json) VALUES (?, ?, ?, ?)',
      [a.id, epochOf(a.starred), artistSortTitle(a, articles), JSON.stringify(a)],
    ]),
  );
};

/** `0` when the server sent no date: keeps `IS NOT NULL` membership, reads back as
 *  `undefined`, and sorts last. Never a fabricated date. */
export function epochOf(v: Date | string | number | null | undefined): number {
  if (v == null) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Move remainder rows whose library row has since arrived onto that row, and drop them.
 *
 * HOUSEKEEPING, not correctness: `disjointClause` already hides these rows from every
 * read, so a promote that never runs costs storage, not accuracy. Bounded by the
 * remainder. The UPDATE runs before the DELETE, so a run interrupted between the two
 * leaves a duplicate the read still ignores.
 */
export async function promoteResolvedFavorites(db: InternalDb): Promise<void> {
  for (const entity of ['songs', 'albums', 'artists'] as const) {
    const remainder = REMAINDER[entity];
    await db.runAsync(
      `UPDATE ${entity} SET starred = (SELECT f.starred FROM ${remainder} f WHERE f.id = ${entity}.id) ` +
        `WHERE id IN (SELECT id FROM ${remainder})`,
    );
    await db.runAsync(`DELETE FROM ${remainder} WHERE id IN (SELECT id FROM ${entity})`);
  }
}
