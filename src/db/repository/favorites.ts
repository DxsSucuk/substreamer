/**
 * Favourites repository — the ONE place the starred set is read and written.
 *
 * Favourites live in two halves, chosen by whether the library already holds the row:
 *  - **marked library rows** — `songs`/`albums`/`artists`.`starred` set by `markStarred*`.
 *    The reconcile NEVER inserts into those tables: a row there means "the library sync
 *    put it here", and the presence checks across the app depend on that.
 *  - **the remainder** — `favorite_songs`/`favorite_albums`/`favorite_artists`, holding
 *    the starred items the library does not have. Normally EMPTY — but a fresh install,
 *    a logout or a full resync empties the library tables, and then EVERY favourite
 *    lands here until the next library sync.
 *
 * A remainder row stores its entity in COLUMNS, through the same mappers the library
 * half uses (`childSnapshot` for `Child`, the `albums`/`artists` mappers for
 * `AlbumID3`/`ArtistID3`) plus that entity's child tables, so the two halves of a list
 * present the same object. `json` held the pre-columns `getStarred2` envelope; a row
 * still holding one is read from it (see {@link RemainderItems}).
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

import {
  childFromSnapshotRow,
  childSnapshotArrayCommands,
  childSnapshotArrayKey,
  childSnapshotInsertCommand,
  childSnapshotRowFromRaw,
  childSnapshotSelect,
  readChildSnapshotArraysAsync,
  type ChildSnapshotArrays,
} from '../childSnapshot';
import type { BatchCommand, InternalDb } from '../client';
import { albumSortKeys, artistSortTitle, songSortKeys } from '../sortKeys';
import { getSortArticles } from '../sortArticles';
import {
  ALBUM_LIST_COLS,
  ALBUM_LIST_FIELDS,
  albumListRowToAlbumID3,
  hydrateAlbumRows,
  type AlbumListRow,
  type AlbumSortOrder,
} from './albums';
import {
  ARTIST_LIST_COLS,
  ARTIST_LIST_FIELDS,
  artistListRowToArtistID3,
  hydrateArtistRows,
  type ArtistListRow,
} from './artists';
import {
  albumArtistRows,
  albumDiscTitleRows,
  albumGenreRows,
  albumMoodRows,
  albumRecordLabelRows,
  albumReleaseTypeRows,
  albumRow,
  artistRoleRows,
  artistRow,
} from './mappers';
import { countRows, keysetPage, type Cursor, type Row } from './core';
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
 * it does not reach the prunes — `deletePlaylistsNotIn`, whose subquery IS the JS id array
 * (`json_each`, no table to correlate against), or the epoch reap in `reap.ts`, whose
 * download subqueries probe an existing index instead of materialising.
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

/** What every remainder projection carries, whatever the entity: the id, the
 *  membership epoch, the legacy envelope column, and the A–Z keys the merge orders on
 *  (`sort_artist` is absent on the artist remainder, where the name IS the title key). */
type RemainderCore = {
  id: string;
  starred: number | null;
  json: string;
  sort_title?: string | null;
  sort_artist?: string | null;
};

/** The `favorite_songs` projection: the shared `Child` snapshot columns, aliased to
 *  their `ChildSnapshotRow` keys, plus the remainder's own three. `title` is the gate
 *  (see {@link RemainderItems}); the rest are consumed through `childSnapshotRowFromRaw`. */
type FavoriteSongRow = RemainderCore & Record<string, unknown> & { title?: string | null };
type FavoriteAlbumRow = AlbumListRow & { json: string };
type FavoriteArtistRow = ArtistListRow & { json: string };

const REMAINDER_SONG_COLS = `"sort_title", "sort_artist", "json", ${childSnapshotSelect('id')}`;
const REMAINDER_ALBUM_COLS = `${ALBUM_LIST_COLS}, "json"`;
const REMAINDER_ARTIST_COLS = `${ARTIST_LIST_COLS}, "json"`;

const NO_ARRAYS: ChildSnapshotArrays = {};
const NO_ROW_ARRAYS = new Map<string, ChildSnapshotArrays>();

/**
 * The pre-columns envelope, for a row Migration 40 has not converted.
 *
 * Rehydrates the dates `JSON.stringify` flattened to ISO strings so a remainder item and
 * a library item read the same. An unparseable envelope yields an EMPTY item rather than
 * throwing: the row still contributes its id and its star, where a throw would take the
 * whole Favourites list down.
 */
function parseEnvelope<T>(json: string): T {
  try {
    const parsed = (JSON.parse(json) ?? {}) as T & { created?: string | Date };
    return parsed.created ? { ...parsed, created: new Date(parsed.created) } : parsed;
  } catch {
    return {} as T;
  }
}

/**
 * Build one remainder row's entity from ITS OWN columns, or from its envelope until it
 * has them.
 *
 * The gate is per ROW and on CONTENT: the entity's name column is written
 * unconditionally by the only writer, so NULL means "this row predates the columns" —
 * `ALTER TABLE ADD COLUMN` leaves exactly that. Reading such a row through the columns
 * would return an item with no title, no artist and no stream metadata, and these feed
 * Play All, CarPlay and the `__starred__` download.
 */
type RemainderItems<T, R extends RemainderCore> = (db: InternalDb, rows: R[]) => Promise<T[]>;

const songItems: RemainderItems<Child, FavoriteSongRow> = async (db, rows) => {
  const stored = rows.filter((r) => r.title != null);
  const arrays =
    stored.length > 0
      ? await readChildSnapshotArraysAsync(db, {
          tablePrefix: 'favorite_song',
          keyColumns: ['song_id'],
          where: 'song_id IN (SELECT value FROM json_each(?))',
          params: [JSON.stringify(stored.map((r) => r.id))],
        })
      : NO_ROW_ARRAYS;
  return rows.map((r) =>
    r.title == null
      ? parseEnvelope<Child>(r.json)
      : childFromSnapshotRow(
          childSnapshotRowFromRaw(r),
          arrays.get(childSnapshotArrayKey([r.id])) ?? NO_ARRAYS,
        ),
  );
};

const albumItems: RemainderItems<AlbumID3, FavoriteAlbumRow> = async (db, rows) => {
  const stored = rows.filter((r) => r.name != null);
  if (stored.length > 0) await hydrateAlbumRows(db, stored, 'favorite_album');
  return rows.map((r) =>
    r.name == null ? parseEnvelope<AlbumID3>(r.json) : albumListRowToAlbumID3(r),
  );
};

const artistItems: RemainderItems<ArtistID3, FavoriteArtistRow> = async (db, rows) => {
  const stored = rows.filter((r) => r.name != null);
  if (stored.length > 0) await hydrateArtistRows(db, stored, 'favorite_artist');
  return rows.map((r) =>
    r.name == null ? parseEnvelope<ArtistID3>(r.json) : artistListRowToArtistID3(r),
  );
};

/** The row's stored epoch is the item's `starred`, whichever source the item came from:
 *  `0` reads back as `undefined` — membership without a fabricated date. */
const entryOf = <T extends { starred?: Date }>(row: RemainderCore, item: T): StarredEntry<T> => ({
  id: row.id,
  starred: row.starred ?? 0,
  item: { ...item, starred: row.starred ? new Date(row.starred) : undefined },
});

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

async function remainderPage<T extends { starred?: Date }, R extends RemainderCore>(
  db: InternalDb,
  entity: Entity,
  columns: string,
  items: RemainderItems<T, R>,
  opts: StarredPageOpts,
): Promise<{ rows: StarredEntry<T>[]; hasMore: boolean }> {
  const page = await keysetPage<R & { id: string }>(db, {
    table: REMAINDER[entity],
    sortCol: 'starred',
    columns,
    direction: 'desc',
    limit: opts.limit,
    cursor: opts.cursor,
    where: remainderWhere(entity, opts),
    sortKeyOf: (r) => r.starred ?? 0,
  });
  const built = await items(db, page.rows);
  return {
    rows: page.rows.map((r, i) => entryOf(r, built[i])),
    hasMore: page.nextCursor != null,
  };
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
  return mergePages(
    lib,
    await remainderPage(db, 'songs', REMAINDER_SONG_COLS, songItems, opts),
    opts.limit,
  );
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
    await remainderPage(db, 'albums', REMAINDER_ALBUM_COLS, albumItems, opts),
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
    await remainderPage(db, 'artists', REMAINDER_ARTIST_COLS, artistItems, opts),
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

async function allRemainder<T extends { starred?: Date }, R extends RemainderCore>(
  db: InternalDb,
  entity: Entity,
  columns: string,
  items: RemainderItems<T, R>,
  f: StarredFilter,
  order: string = STARRED_DESC,
): Promise<{ entries: StarredEntry<T>[]; rows: R[] }> {
  const rows = await db.getAllAsync<R>(
    `SELECT ${columns} FROM ${REMAINDER[entity]} WHERE ${remainderWhere(entity, f)} ` +
      `ORDER BY ${order}`,
  );
  const built = await items(db, rows);
  return { entries: rows.map((r, i) => entryOf(r, built[i])), rows };
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
  const rem = await allRemainder(db, 'songs', REMAINDER_SONG_COLS, songItems, f, order);
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
  const rem = await allRemainder(db, 'albums', REMAINDER_ALBUM_COLS, albumItems, f, order);
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
  const rem = await allRemainder(db, 'artists', REMAINDER_ARTIST_COLS, artistItems, {}, order);
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
 *  O(favourites) and both over stored columns, on either half. */
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

/** Starred artist names, both halves — the voice-assistant vocabulary donation. The
 *  remainder answers from its own `name` column, falling back to the envelope for a row
 *  Migration 40 has not converted. */
export async function listStarredArtistNames(db: InternalDb): Promise<string[]> {
  const [lib, rem] = await Promise.all([
    db.getAllAsync<{ name: string | null }>('SELECT "name" FROM artists WHERE starred IS NOT NULL'),
    db.getAllAsync<{ name: string | null; json: string }>(
      `SELECT "name", "json" FROM ${REMAINDER.artists} WHERE ${disjointClause('artists')}`,
    ),
  ]);
  return [
    ...lib.map((r) => r.name ?? ''),
    ...rem.map((r) => r.name ?? parseEnvelope<ArtistID3>(r.json).name ?? ''),
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
  const row = await db.getFirstAsync<{ id: string; title: string | null; json: string }>(
    `SELECT "id", "title", "json" FROM ${REMAINDER.songs} WHERE ${disjointClause('songs')} ` +
      'ORDER BY "starred" DESC, "id" DESC LIMIT 1 OFFSET ?',
    [k - libCount],
  );
  if (!row) return null;
  return { id: row.id, title: row.title ?? parseEnvelope<Child>(row.json).title };
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
 * What a remainder row holds beyond its entity: the membership epoch, the derived A–Z
 * keys and the legacy envelope column.
 *
 * Passed in rather than derived so ONE command builder serves both writers — the
 * reconcile derives all three from the payload, and Migration 40 hands back exactly what
 * the row already holds, so converting a row cannot move it in the list or discard its
 * envelope. `sort_artist` is unused by the artist remainder, where the name IS the key.
 */
export interface RemainderOwn {
  starred: number;
  /** Column names, so `songSortKeys`/`albumSortKeys` spread straight in. */
  sort_title: string;
  sort_artist: string;
  json: string;
}

/** One mapper `Row` as an INSERT — the statement derives from the row the mapper
 *  produced, so there is no second column list to drift from it. */
const insertRow = (table: string, row: Row): BatchCommand => {
  const cols = Object.keys(row);
  return [
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => row[c]),
  ];
};

const childRowCommands = (table: string, rows: readonly Row[]): BatchCommand[] =>
  rows.map((r) => insertRow(table, r));

/** A mapper row narrowed to the columns the remainder table has — the library tables
 *  also carry the `norm_*`/`dmeta_*` search derivatives and `synced_at`, neither of
 *  which the remainder is read through. */
const pickColumns = (row: Row, fields: readonly string[]): Row => {
  const out: Row = {};
  for (const f of fields) out[f] = row[f] ?? null;
  return out;
};

/** The `Child` as the snapshot columns store it: `title` written even when the server
 *  sent none — it is the read gate — and `starred` as the remainder's epoch-or-0, which
 *  its `starred` column is NOT NULL for. */
const snapshotChild = (s: Child, starredAt: number): Child => ({
  ...s,
  title: s.title ?? '',
  starred: new Date(starredAt),
});

/** The statements that write one starred song the library does not hold: its `Child`
 *  snapshot columns, the remainder's own three, and the five array tables. */
export const favoriteSongCommands = (song: Child, own: RemainderOwn): BatchCommand[] => {
  const child = snapshotChild(song, own.starred);
  return [
    childSnapshotInsertCommand({
      table: 'favorite_songs',
      key: { sort_title: own.sort_title, sort_artist: own.sort_artist, json: own.json },
      child,
      idColumn: 'id',
    }),
    ...childSnapshotArrayCommands({
      tablePrefix: 'favorite_song',
      key: { song_id: song.id },
      child,
    }),
  ];
};

/** As {@link favoriteSongCommands}, through the `albums` mapper and its six child
 *  tables. `name` is written even when the server sent none — it is the read gate. */
export const favoriteAlbumCommands = (
  album: AlbumID3,
  own: RemainderOwn,
  articles?: readonly string[],
): BatchCommand[] => [
  insertRow('favorite_albums', {
    ...pickColumns(albumRow(album, articles), ALBUM_LIST_FIELDS),
    name: album.name ?? '',
    starred: own.starred,
    sort_title: own.sort_title,
    sort_artist: own.sort_artist,
    json: own.json,
  }),
  ...childRowCommands('favorite_album_genres', albumGenreRows(album, album.id)),
  ...childRowCommands('favorite_album_artists', albumArtistRows(album, album.id)),
  ...childRowCommands('favorite_album_release_types', albumReleaseTypeRows(album, album.id)),
  ...childRowCommands('favorite_album_moods', albumMoodRows(album, album.id)),
  ...childRowCommands('favorite_album_record_labels', albumRecordLabelRows(album, album.id)),
  ...childRowCommands('favorite_album_disc_titles', albumDiscTitleRows(album, album.id)),
];

/** As {@link favoriteSongCommands}, through the `artists` mapper and `artist_roles`. */
export const favoriteArtistCommands = (
  artist: ArtistID3,
  own: RemainderOwn,
  articles?: readonly string[],
): BatchCommand[] => [
  insertRow('favorite_artists', {
    ...pickColumns(artistRow(artist, articles), ARTIST_LIST_FIELDS),
    name: artist.name ?? '',
    starred: own.starred,
    sort_title: own.sort_title,
    json: own.json,
  }),
  ...childRowCommands('favorite_artist_roles', artistRoleRows(artist, artist.id)),
];

/**
 * Rebuild a remainder table from scratch, TRANSACTIONALLY.
 *
 * These rows are the only local copy of items the library does not have, and restoring
 * them needs a network call the user may not be able to make — so unlike the marks they
 * are not derivable offline, and a delete-then-insert rebuild killed mid-way would leave
 * a fraction of the set. Hence ONE `runAtomicBatchAsync` — the JS thread never yields
 * between the DELETE and the last INSERT, so no other writer's statements land inside
 * our savepoint. The leading DELETE cascades the previous rows' child tables away.
 *
 * The payload is deduped by id: the child tables FK to the row, so `INSERT OR REPLACE`
 * — which is DELETE-then-INSERT — would cascade away the arrays it had just written. A
 * server that repeats an id gets its last copy, exactly as `OR REPLACE` gave it.
 */
async function replaceRemainder<T extends { id: string }>(
  db: InternalDb,
  entity: Entity,
  items: readonly T[],
  commandsOf: (item: T) => BatchCommand[],
): Promise<void> {
  const unique = [...new Map(items.map((i) => [i.id, i])).values()];
  await db.runAtomicBatchAsync([
    [`DELETE FROM ${REMAINDER[entity]}`, []] as BatchCommand,
    ...unique.flatMap(commandsOf),
  ]);
}

/** `''` for the envelope column: it is `NOT NULL` and holds only pre-columns rows. */
const NEW_ROW_JSON = '';

/** Replace `favorite_songs` with the starred songs the library does not hold. The
 *  columns and the sort keys come from the SAME payload object in one statement, so
 *  they cannot disagree. */
export const replaceFavoriteSongs = (db: InternalDb, songs: readonly Child[]): Promise<void> => {
  const articles = getSortArticles();
  return replaceRemainder(db, 'songs', songs, (s) =>
    favoriteSongCommands(s, {
      starred: epochOf(s.starred),
      ...songSortKeys(s, articles),
      json: NEW_ROW_JSON,
    }),
  );
};

/** The sort keys come through the same `db/sortKeys` derivation the `albums` table
 *  uses, so the remainder can never order differently from the library half. */
export const replaceFavoriteAlbums = (db: InternalDb, albums: readonly AlbumID3[]): Promise<void> => {
  const articles = getSortArticles();
  return replaceRemainder(db, 'albums', albums, (a) =>
    favoriteAlbumCommands(
      a,
      { starred: epochOf(a.starred), ...albumSortKeys(a, articles), json: NEW_ROW_JSON },
      articles,
    ),
  );
};

export const replaceFavoriteArtists = (db: InternalDb, artists: readonly ArtistID3[]): Promise<void> => {
  const articles = getSortArticles();
  return replaceRemainder(db, 'artists', artists, (a) =>
    favoriteArtistCommands(
      a,
      {
        starred: epochOf(a.starred),
        sort_title: artistSortTitle(a, articles),
        sort_artist: '',
        json: NEW_ROW_JSON,
      },
      articles,
    ),
  );
};

/* ------------------------------------------------------------------ */
/*  Migration 40 — the one-time envelope → columns conversion          */
/* ------------------------------------------------------------------ */

/** The entity one remainder table holds. The conversion walks all three. */
export type StarredEntity = Entity;
export const STARRED_ENTITIES: readonly Entity[] = ['songs', 'albums', 'artists'];

/** The column whose NULL means "this row is still read from its envelope". */
const GATE_COLUMN: Record<Entity, string> = { songs: 'title', albums: 'name', artists: 'name' };

/** One remainder row the columns have not reached: everything the row owns, plus the
 *  envelope to convert it from. */
export interface UnconvertedFavorite extends RemainderOwn {
  id: string;
}

/** The rows Migration 40 still has to convert. `favorite_artists` has no `sort_artist`
 *  column — the name IS its key — so the projection supplies the empty one the shared
 *  {@link RemainderOwn} shape expects. */
export const readUnconvertedFavorites = (
  db: InternalDb,
  entity: Entity,
): Promise<UnconvertedFavorite[]> =>
  db.getAllAsync<UnconvertedFavorite>(
    `SELECT "id", "starred", COALESCE("sort_title", '') AS sort_title, ` +
      `${entity === 'artists' ? `'' AS sort_artist` : `COALESCE("sort_artist", '') AS sort_artist`}, ` +
      `"json" FROM ${REMAINDER[entity]} WHERE "${GATE_COLUMN[entity]}" IS NULL`,
  );

/** The write for one row, or null when its envelope yields nothing to write — an
 *  unparseable one, or an entity with no name for the gate to key on. Left alone rather
 *  than converted to an empty row: the envelope is all that row has. */
function convertCommands(
  entity: Entity,
  row: UnconvertedFavorite,
  articles: readonly string[] | undefined,
): BatchCommand[] | null {
  if (entity === 'songs') {
    const song = parseEnvelope<Child>(row.json);
    return song.title ? favoriteSongCommands({ ...song, id: row.id }, row) : null;
  }
  if (entity === 'albums') {
    const album = parseEnvelope<AlbumID3>(row.json);
    return album.name ? favoriteAlbumCommands({ ...album, id: row.id }, row, articles) : null;
  }
  const artist = parseEnvelope<ArtistID3>(row.json);
  return artist.name ? favoriteArtistCommands({ ...artist, id: row.id }, row, articles) : null;
}

/**
 * Convert one row: its envelope into its columns and child tables, in ONE atomic batch
 * that keeps the row's own `starred`, sort keys and envelope exactly as they were.
 *
 * Reads the gate column back afterwards, because the write "returning" proves nothing
 * about what landed. False means the row still reads from its envelope, which is the
 * safe direction — these rows feed Play All, CarPlay and the `__starred__` download,
 * and a row read through empty columns is a favourite that has silently vanished.
 */
export async function convertFavoriteRow(
  db: InternalDb,
  entity: Entity,
  row: UnconvertedFavorite,
): Promise<boolean> {
  const commands = convertCommands(entity, row, getSortArticles());
  if (commands === null) return false;
  await db.runAtomicBatchAsync([
    [`DELETE FROM ${REMAINDER[entity]} WHERE id = ?`, [row.id]] as BatchCommand,
    ...commands,
  ]);
  const back = await db.getFirstAsync<{ gate: string | null }>(
    `SELECT "${GATE_COLUMN[entity]}" AS gate FROM ${REMAINDER[entity]} WHERE id = ?`,
    [row.id],
  );
  return back != null && back.gate !== null;
}

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
