/**
 * Generic repository primitives shared by the entity repositories.
 *
 * Writes: id-sorted, transaction-wrapped, chunked upserts (the evidence-based fix
 * for random-key B-tree write fragmentation — see the design doc). Bulk writes
 * are SYNC within a per-chunk transaction (op-SQLite `executeSync` is fast and
 * this mirrors the existing bulk-sync path), with the CALLER yielding a macrotask
 * between chunks so the JS thread stays responsive.
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

const nowMs = (): number => {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
};

/** Per-chunk timing split, for the dev spikes to see where a bulk write spends its
 *  time: `deriveMs` = JS-thread work building rows (mappers, incl. norm/dmeta);
 *  `writeMs` = the off-thread `executeBatch`. */
export interface ChunkTiming {
  deriveMs: number;
  writeMs: number;
  rows: number;
}
let chunkProfiler: ((t: ChunkTiming) => void) | null = null;
/** Dev/spike-only: observe per-chunk derive-vs-write timing during a bulk upsert.
 *  Pass null to clear. Zero cost in production (a single null check per chunk). */
export const setChunkProfiler = (fn: ((t: ChunkTiming) => void) | null): void => {
  chunkProfiler = fn;
};

/** A child-table spec: how to derive a parent's child rows from the source object. */
export interface ChildSpec<T> {
  table: string;
  parentCol: string;
  rows: (source: T, parentId: string) => Row[];
}

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Records `table.column` for any value that had to be coerced from a non-scalar —
 *  a subsonic-api type↔reality mismatch worth fixing at the mapper. */
const coercedColumns = new Set<string>();
export const getCoercedColumns = (): string[] => [...coercedColumns].sort();

/** Ensure a value is bindable by op-SQLite (string | number | null). Booleans →
 *  0/1, bigint → number, and any stray object/array → JSON text (recorded above)
 *  so a bulk write never crashes on an unexpected server shape. */
function coerceBind(table: string, col: string, value: unknown): Value {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number') return value as Value;
  if (t === 'boolean') return value ? 1 : 0;
  if (t === 'bigint') return Number(value);
  coercedColumns.add(`${table}.${col}`);
  return JSON.stringify(value);
}

/** Build an `INSERT … ON CONFLICT(pk) DO UPDATE` command tuple (all other cols). */
function buildUpsertRow(table: string, row: Row, pk = 'id'): BatchCommand {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols
    .filter((c) => c !== pk)
    .map((c) => `${ident(c)} = excluded.${ident(c)}`)
    .join(', ');
  const sql =
    `INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT(${ident(pk)}) DO UPDATE SET ${updates}`;
  return [sql, cols.map((c) => coerceBind(table, c, row[c]))];
}

/** Build a plain INSERT command tuple (child tables; parent rows were just cleared). */
function buildInsertChild(table: string, row: Row): BatchCommand {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  return [
    `INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) VALUES (${placeholders})`,
    cols.map((c) => coerceBind(table, c, row[c])),
  ];
}

/** Build a DELETE-all-children-of-parent command tuple. */
const buildDeleteChildren = (table: string, parentCol: string, parentId: string): BatchCommand => [
  `DELETE FROM ${ident(table)} WHERE ${ident(parentCol)} = ?`,
  [parentId],
];

/** INSERT one row with ON CONFLICT(pk) DO UPDATE — SYNC, for the small single-row
 *  writes that run inside a caller's `withTransactionSync` (e.g. artist bio merge). */
export function upsertRowSync(db: InternalDb, table: string, row: Row, pk = 'id'): void {
  const [sql, params] = buildUpsertRow(table, row, pk);
  db.runSync(sql, params);
}

/** Replace all child rows for one parent (delete-then-insert) inside the caller's txn. */
export function replaceChildrenSync(
  db: InternalDb,
  table: string,
  parentCol: string,
  parentId: string,
  rows: Row[],
): void {
  const [dsql, dparams] = buildDeleteChildren(table, parentCol, parentId);
  db.runSync(dsql, dparams);
  for (const row of rows) {
    const [sql, params] = buildInsertChild(table, row);
    db.runSync(sql, params);
  }
}

/**
 * Bulk-upsert entities into `table` + their children, id-sorted, one atomic
 * `executeBatch` per chunk. Writes are PIPELINED: each chunk's write is kicked off
 * without awaiting, so the NEXT chunk's row derivation (mappers, incl. norm/dmeta —
 * JS-thread work) runs concurrently with the previous chunk's write on op-SQLite's
 * native thread. That hides the write under the derive (the dominant cost), and the
 * macrotask yield between chunks lets the UI paint between derive bursts. Chunks
 * still commit in id-sorted order (op-SQLite runs execute FIFO on one thread) and
 * all writes are awaited before returning. `onProgress(done, total)` fires per chunk.
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
  },
  items: T[],
): Promise<number> {
  const { table, idOf, rowOf, children = [], chunkSize = 500, onProgress } = opts;
  const sorted = [...items].sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
  let done = 0;
  let prevWrite: Promise<void> = Promise.resolve();
  for (let i = 0; i < sorted.length; i += chunkSize) {
    const chunk = sorted.slice(i, i + chunkSize);
    // Derive: build every statement for the chunk (JS-thread work). This overlaps
    // the previous chunk's write, which is still running on the native thread.
    const d0 = nowMs();
    const commands: BatchCommand[] = [];
    for (const item of chunk) {
      const id = idOf(item);
      commands.push(buildUpsertRow(table, rowOf(item)));
      for (const spec of children) {
        commands.push(buildDeleteChildren(spec.table, spec.parentCol, id));
        for (const cr of spec.rows(item, id)) commands.push(buildInsertChild(spec.table, cr));
      }
    }
    const deriveMs = nowMs() - d0;
    // Drain the previous write (usually already finished, hidden under the derive
    // above) — `writeMs` is the EXPOSED tail past that overlap — then kick off this
    // chunk's write WITHOUT awaiting so the next derive can overlap it.
    const w0 = nowMs();
    await prevWrite;
    const writeMs = nowMs() - w0;
    prevWrite = db.runBatchAsync(commands);
    done += chunk.length;
    chunkProfiler?.({ deriveMs, writeMs, rows: chunk.length });
    onProgress?.(done, sorted.length);
    // Yield a macrotask so the UI can paint; the write keeps running meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await prevWrite; // ensure the final chunk is committed before returning
  return done;
}

/** Opaque keyset cursor: the last row's (sortKey, [sortKey2], id). */
export interface Cursor {
  sortKey: string;
  id: string;
  /** Secondary sort key for a compound keyset (e.g. albums sorted artist-then-title). */
  sortKey2?: string;
}

export interface Page<R> {
  rows: R[];
  nextCursor: Cursor | null;
}

/**
 * One keyset page ordered by `(sortCol, id)`. Pass `cursor` to continue after a
 * previous page, or `letter` to seek-and-reset to an A–Z section. Selects only
 * the projection columns (lean list rows), never the full entity.
 */
export async function keysetPage<R extends { id: string }>(
  db: InternalDb,
  opts: {
    table: string;
    sortCol: string;
    /** Optional secondary sort column for a compound keyset (ordered before id). */
    sortCol2?: string;
    columns: string; // pre-joined projection, must include the sort col(s) + id
    limit: number;
    cursor?: Cursor | null;
    letter?: string | null;
    where?: string; // extra predicate, ANDed (e.g. "starred IS NOT NULL")
    sortKeyOf: (row: R) => string;
    sortKey2Of?: (row: R) => string;
  },
): Promise<Page<R>> {
  const { table, sortCol, sortCol2, columns, limit, cursor, letter, where, sortKeyOf, sortKey2Of } = opts;
  const clauses: string[] = [];
  const params: Value[] = [];
  if (where) clauses.push(`(${where})`);
  if (cursor) {
    if (sortCol2) {
      clauses.push(`(${ident(sortCol)}, ${ident(sortCol2)}, ${ident('id')}) > (?, ?, ?)`);
      params.push(cursor.sortKey, cursor.sortKey2 ?? '', cursor.id);
    } else {
      clauses.push(`(${ident(sortCol)}, ${ident('id')}) > (?, ?)`);
      params.push(cursor.sortKey, cursor.id);
    }
  } else if (letter != null) {
    // Seek on the PRIMARY sort column only (the A–Z section boundary).
    clauses.push(`${ident(sortCol)} >= ?`);
    params.push(letter.toLowerCase());
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const order = sortCol2
    ? `${ident(sortCol)}, ${ident(sortCol2)}, ${ident('id')}`
    : `${ident(sortCol)}, ${ident('id')}`;
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
