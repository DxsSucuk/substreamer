/**
 * Generic repository primitives shared by the entity repositories.
 *
 * Writes: id-sorted, chunked upserts — sorting the keys avoids the random-key B-tree
 * write fragmentation that dominates an unsorted bulk write. Each chunk ships as ONE
 * atomic `runAtomicBatchAsync` off the JS thread, with a macrotask yield between chunks
 * so the JS thread stays responsive.
 *
 * Reads: ASYNC keyset pagination (`WHERE (sort_col, id) > (?, ?)`) off the JS
 * thread — O(log n) seeks, never offset scans, never whole-table loads.
 */

import type { BatchCommand, InternalDb } from '../client';

export type Value = string | number | null;
export type Row = Record<string, Value>;

/**
 * Mark `K` as PRESENT on `T` without making it non-nullable — "the projection
 * populates this key", which is what a widened read guarantees. `Required<Pick<>>`
 * would strip `undefined` along with the `?` and force an adapter to invent
 * `new Date(0)`/`0` for a field the server never sent.
 *
 * `Omit` + `Extract` rather than `T & { [P in K]-?: … }`: the `-?` modifier strips
 * `undefined` from the property type exactly like `Required` does, and re-widening
 * with `| undefined` inside a HOMOMORPHIC mapped type is undone by the same modifier.
 * Mapping over `Extract<keyof T, K>` is non-homomorphic, so the keys come out
 * required with `undefined` intact.
 */
export type Complete<T, K extends keyof T> = Omit<T, K> & {
  [P in Extract<keyof T, K>]: T[P] | undefined;
};

/** Join a projection field list into a SELECT column list, optionally table-qualified
 *  (`s."title"`) for queries that JOIN a table sharing column names. Every COLS string
 *  derives from its entity's one field list, so the SQL cannot drift from the row type. */
export const colsOf = <C extends string>(fields: readonly C[], alias?: string): string =>
  fields.map((f) => (alias ? `${alias}."${f}"` : `"${f}"`)).join(', ');

/** A child-table spec: how to derive a parent's child rows from the source object. */
export interface ChildSpec<T> {
  table: string;
  parentCol: string;
  rows: (source: T, parentId: string) => Row[];
}

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Ensure a value is bindable by op-SQLite (string | number | null). Booleans →
 *  0/1, bigint → number, and any stray object/array → JSON text, so a bulk write
 *  never crashes on an unexpected server shape. */
function coerceBind(value: unknown): Value {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number') return value as Value;
  if (t === 'boolean') return value ? 1 : 0;
  if (t === 'bigint') return Number(value);
  return JSON.stringify(value);
}

/**
 * Build an `INSERT … ON CONFLICT(pk) DO UPDATE` command tuple.
 *
 * Two update policies, and picking the wrong one loses data:
 *
 * - **Authoritative (default)** — `col = excluded.col`. Every column takes the incoming
 *   value, NULL included. Correct only for a writer that enumerates the whole entity
 *   and can therefore speak for every field: the library sync, a full `getAlbum`.
 * - **Merge** (`merge: true`) — `col = COALESCE(excluded.col, col)`. A column the payload
 *   does not carry keeps what the row already held. Correct for SUPPLEMENTARY writers
 *   holding a partial view (a list endpoint, an artist's album array): without it, a
 *   leaner payload silently blanks genre, MBID, year and the rest until the next full sync.
 *
 * The merge policy cannot express "the server cleared this field" — a NULL is
 * indistinguishable from "absent". That is deliberate: state columns (`starred`,
 * `user_rating`) are owned by the favourites and rating paths, which write them directly,
 * and the authoritative sync corrects everything else. A stale value that self-heals beats
 * a blanked one that does not.
 */
function buildUpsertRow(table: string, row: Row, pk = 'id', merge = false): BatchCommand {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols
    .filter((c) => c !== pk)
    .map((c) =>
      merge
        ? `${ident(c)} = COALESCE(excluded.${ident(c)}, ${ident(c)})`
        : `${ident(c)} = excluded.${ident(c)}`,
    )
    .join(', ');
  const sql =
    `INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT(${ident(pk)}) DO UPDATE SET ${updates}`;
  return [sql, cols.map((c) => coerceBind(row[c]))];
}

/**
 * Tables carrying `synced_at`, stamped on EVERY write rather than only by the library
 * sync. A full run starts at epoch `E` and everything it writes carries `>= E`; a row
 * written out-of-band during or after it (a detail fetch, a carousel refresh, a browse,
 * a download) also carries `>= E`, so it can never look older than the run that
 * followed it. Keyed on the table, not an opt-in flag, so a writer added later cannot
 * forget it.
 *
 * Albums and songs only. Artists and playlists are enumerated in a single call and
 * already reconcile by set difference (`deleteArtistsNotIn` / `deletePlaylistsNotIn`);
 * the stamp exists for the PAGED entities that cannot.
 */
const STAMPED_TABLES = new Set(['albums', 'songs']);

/** Build a plain INSERT command tuple (child tables; parent rows were just cleared). */
function buildInsertChild(table: string, row: Row): BatchCommand {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  return [
    `INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) VALUES (${placeholders})`,
    cols.map((c) => coerceBind(row[c])),
  ];
}

/** Build a DELETE-all-children-of-parent command tuple. */
const buildDeleteChildren = (table: string, parentCol: string, parentId: string): BatchCommand => [
  `DELETE FROM ${ident(table)} WHERE ${ident(parentCol)} = ?`,
  [parentId],
];

/**
 * Bulk-upsert entities into `table` + their children, id-sorted, one ATOMIC batch
 * per chunk: every parent upsert, child DELETE and child INSERT in the chunk either
 * all commit or none do, so an entity can never end up with its children deleted and
 * not reinserted. The batch's rollback is enqueued behind it in the same tick, so no
 * other writer can be captured by the savepoint.
 *
 * Writes are PIPELINED: each chunk's write is kicked off without awaiting, so the NEXT
 * chunk's row derivation (mappers, incl. norm/dmeta — JS-thread work) runs concurrently
 * with the previous chunk's write on op-SQLite's native thread. That hides the write
 * under the derive (the dominant cost), and the macrotask yield between chunks lets the
 * UI paint between derive bursts. The pipelining depends on `runAtomicBatchAsync`
 * reaching `executeBatch` synchronously. Chunks still commit in id-sorted order
 * (op-SQLite runs one pool thread, FIFO) and all writes are awaited before returning.
 * A failing chunk rejects at the NEXT chunk's drain, so the loop stops there and the
 * caller's cursor does not advance. `onProgress(done, total)` fires per chunk.
 */
export async function bulkUpsert<T>(
  db: InternalDb,
  opts: {
    table: string;
    idOf: (item: T) => string;
    rowOf: (item: T) => Row;
    children?: ChildSpec<T>[];
    chunkSize?: number;
    onProgress?: (done: number, total: number) => void;
    /** SUPPLEMENTARY writer: keep columns the payload does not carry (see
     *  {@link buildUpsertRow}). Default false — authoritative overwrite. */
    merge?: boolean;
  },
  items: T[],
): Promise<number> {
  const { table, idOf, rowOf, children = [], chunkSize = 500, onProgress, merge = false } = opts;
  // One stamp for the whole write (see {@link STAMPED_TABLES}). Always supplied, so
  // `excluded.synced_at` is never NULL and the merge policy's COALESCE takes it —
  // a supplementary writer refreshes the stamp exactly like an authoritative one.
  const syncedAt = STAMPED_TABLES.has(table) ? Date.now() : null;
  const sorted = [...items].sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
  let done = 0;
  let prevWrite: Promise<void> = Promise.resolve();
  for (let i = 0; i < sorted.length; i += chunkSize) {
    const chunk = sorted.slice(i, i + chunkSize);
    // Derive: build every statement for the chunk (JS-thread work). This overlaps
    // the previous chunk's write, which is still running on the native thread.
    const commands: BatchCommand[] = [];
    for (const item of chunk) {
      const id = idOf(item);
      const row = rowOf(item);
      commands.push(
        buildUpsertRow(table, syncedAt === null ? row : { ...row, synced_at: syncedAt }, 'id', merge),
      );
      for (const spec of children) {
        const childRows = spec.rows(item, id);
        // In MERGE mode an absent child set means "this payload has no opinion", not
        // "this entity has none" — replacing it would delete the rows a fuller writer
        // put there and insert nothing, which is exactly the blanking the COALESCE above
        // prevents on the parent. A payload that DOES carry children still replaces them.
        if (merge && childRows.length === 0) continue;
        commands.push(buildDeleteChildren(spec.table, spec.parentCol, id));
        for (const cr of childRows) commands.push(buildInsertChild(spec.table, cr));
      }
    }
    // Drain the previous write (usually already finished, hidden under the derive
    // above), then kick off this chunk's write WITHOUT awaiting so the next derive
    // can overlap it.
    await prevWrite;
    prevWrite = db.runAtomicBatchAsync(commands);
    // Mark it handled NOW. Nothing observes this promise until the next iteration's
    // drain (or the final await below), and the macrotask yield in between is long
    // enough for a failed chunk to be reported as an unhandled rejection. The drain
    // still sees the rejection — `catch` here returns a new promise and leaves
    // `prevWrite` rejecting.
    prevWrite.catch(() => undefined);
    done += chunk.length;
    onProgress?.(done, sorted.length);
    // Yield a macrotask so the UI can paint; the write keeps running meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await prevWrite; // ensure the final chunk is committed before returning
  return done;
}

/** Opaque keyset cursor: the last row's (sortKey, [sortKey2], id). `sortKey` is a
 *  number for integer sort columns (the favourites list keys on `starred` epoch-ms). */
export interface Cursor {
  sortKey: string | number;
  id: string;
  /** Secondary sort key for a compound keyset (e.g. albums sorted artist-then-title). */
  sortKey2?: string;
}

export interface Page<R> {
  rows: R[];
  nextCursor: Cursor | null;
}

interface KeysetPageBase<R> {
  table: string;
  sortCol: string;
  /** Optional secondary sort column for a compound keyset (ordered before id). */
  sortCol2?: string;
  columns: string; // pre-joined projection, must include the sort col(s) + id
  limit: number;
  cursor?: Cursor | null;
  where?: string; // extra predicate, ANDed (e.g. "starred IS NOT NULL")
  sortKeyOf: (row: R) => string | number;
  sortKey2Of?: (row: R) => string;
}

/**
 * `direction: 'desc'` and `letter` are mutually EXCLUSIVE, enforced in the type rather
 * than a comment: the letter branch seeks `sortCol >= ?`, an ascending-only boundary
 * that would silently return the wrong page under a descending ORDER BY.
 */
type KeysetPageOpts<R> = KeysetPageBase<R> &
  ({ direction?: 'asc'; letter?: string | null } | { direction: 'desc'; letter?: never });

/**
 * One keyset page ordered by `(sortCol, id)`. Pass `cursor` to continue after a
 * previous page, or `letter` to seek-and-reset to an A–Z section. Selects only
 * the projection columns (lean list rows), never the full entity.
 *
 * `direction: 'desc'` flips the whole tuple (`< (?, ?)` + `ORDER BY … DESC`), which
 * keeps the cursor a single row-value comparison SQLite serves from a backward index
 * scan with no temp b-tree.
 */
export async function keysetPage<R extends { id: string }>(
  db: InternalDb,
  opts: KeysetPageOpts<R>,
): Promise<Page<R>> {
  const { table, sortCol, sortCol2, columns, limit, cursor, letter, where, sortKeyOf, sortKey2Of } = opts;
  const desc = opts.direction === 'desc';
  const cmp = desc ? '<' : '>';
  const dir = desc ? ' DESC' : '';
  const clauses: string[] = [];
  const params: Value[] = [];
  if (where) clauses.push(`(${where})`);
  if (cursor) {
    if (sortCol2) {
      clauses.push(`(${ident(sortCol)}, ${ident(sortCol2)}, ${ident('id')}) ${cmp} (?, ?, ?)`);
      params.push(cursor.sortKey, cursor.sortKey2 ?? '', cursor.id);
    } else {
      clauses.push(`(${ident(sortCol)}, ${ident('id')}) ${cmp} (?, ?)`);
      params.push(cursor.sortKey, cursor.id);
    }
  } else if (letter != null) {
    // Seek on the PRIMARY sort column only (the A–Z section boundary).
    clauses.push(`${ident(sortCol)} >= ?`);
    params.push(letter.toLowerCase());
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const order = sortCol2
    ? `${ident(sortCol)}${dir}, ${ident(sortCol2)}${dir}, ${ident('id')}${dir}`
    : `${ident(sortCol)}${dir}, ${ident('id')}${dir}`;
  const sql = `SELECT ${columns} FROM ${ident(table)} ${whereSql} ORDER BY ${order} LIMIT ?`;
  // Fetch one extra row as lookahead so a page that happens to be exactly `limit`
  // rows can be told apart from a page that has more after it.
  const rows = await db.getAllAsync<R>(sql, [...params, limit + 1]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = hasMore ? page[page.length - 1] : null;
  return {
    rows: page,
    nextCursor: last
      ? { sortKey: sortKeyOf(last), id: last.id, sortKey2: sortKey2Of?.(last) }
      : null,
  };
}

/**
 * One keyset page BEFORE a cursor — for scrolling backward / prepending after an
 * A–Z jump. Runs the range query descending then reverses to ascending order.
 * `prevCursor` is the first row's key (to page further back), or null at the start
 * of the list. Pair with FlashList `onStartReached` + maintainVisibleContentPosition.
 */
export async function keysetPageBefore<R extends { id: string }>(
  db: InternalDb,
  opts: {
    table: string;
    sortCol: string;
    sortCol2?: string;
    columns: string;
    limit: number;
    before: Cursor;
    where?: string;
    sortKeyOf: (row: R) => string;
    sortKey2Of?: (row: R) => string;
  },
): Promise<{ rows: R[]; prevCursor: Cursor | null }> {
  const { table, sortCol, sortCol2, columns, limit, before, where, sortKeyOf, sortKey2Of } = opts;
  const clauses = sortCol2
    ? [`(${ident(sortCol)}, ${ident(sortCol2)}, ${ident('id')}) < (?, ?, ?)`]
    : [`(${ident(sortCol)}, ${ident('id')}) < (?, ?)`];
  const params: Value[] = sortCol2
    ? [before.sortKey, before.sortKey2 ?? '', before.id]
    : [before.sortKey, before.id];
  if (where) clauses.unshift(`(${where})`);
  const order = sortCol2
    ? `${ident(sortCol)} DESC, ${ident(sortCol2)} DESC, ${ident('id')} DESC`
    : `${ident(sortCol)} DESC, ${ident('id')} DESC`;
  const sql = `SELECT ${columns} FROM ${ident(table)} WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT ?`;
  const desc = await db.getAllAsync<R>(sql, [...params, limit + 1]);
  const hasMore = desc.length > limit;
  const page = (hasMore ? desc.slice(0, limit) : desc).reverse();
  const first = page.length ? page[0] : null;
  return {
    rows: page,
    prevCursor:
      hasMore && first ? { sortKey: sortKeyOf(first), id: first.id, sortKey2: sortKey2Of?.(first) } : null,
  };
}

/**
 * One child table fetched for a whole page of parents and grouped by parent id, in
 * `pos` order. Ids pass as a JSON array via `json_each` rather than a literal `IN (…)`
 * list because several widened reads are unpaged (a whole playlist, a whole
 * discography, the whole downloaded set) and would blow the bound-variable limit.
 *
 * Cost is N index probes per table either way — the child tables are
 * `PRIMARY KEY(parent_id, pos)` — so the win is one statement per table per page
 * instead of one per row.
 */
export async function fetchChildren<R extends Record<string, unknown>, T>(
  db: InternalDb,
  opts: { table: string; parentCol: string; columns: readonly string[]; orderBy?: string },
  parentIds: readonly string[],
  map: (row: R) => T,
): Promise<Map<string, T[]>> {
  const out = new Map<string, T[]>();
  if (parentIds.length === 0) return out;
  const { table, parentCol, columns, orderBy = 'pos' } = opts;
  const rows = await db.getAllAsync<R & { parent_key: string }>(
    `SELECT ${ident(parentCol)} AS parent_key, ${colsOf(columns)} FROM ${ident(table)} ` +
      `WHERE ${ident(parentCol)} IN (SELECT value FROM json_each(?)) ` +
      `ORDER BY ${ident(parentCol)}, ${ident(orderBy)}`,
    [JSON.stringify(parentIds)],
  );
  for (const row of rows) {
    const list = out.get(row.parent_key);
    if (list) list.push(map(row));
    else out.set(row.parent_key, [map(row)]);
  }
  return out;
}

/** COUNT(*) of a table (optionally filtered) — never loads rows to count. */
export async function countRows(db: InternalDb, table: string, where?: string): Promise<number> {
  const sql = `SELECT COUNT(*) AS n FROM ${ident(table)}${where ? ` WHERE ${where}` : ''}`;
  const row = await db.getFirstAsync<{ n: number }>(sql);
  return row?.n ?? 0;
}
