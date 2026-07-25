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
import type { InternalDb } from '../client';

export type Value = string | number | null;
export type Row = Record<string, Value>;

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

/** INSERT one row with ON CONFLICT(pk) DO UPDATE of every other column. */
export function upsertRowSync(db: InternalDb, table: string, row: Row, pk = 'id'): void {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols
    .filter((c) => c !== pk)
    .map((c) => `${ident(c)} = excluded.${ident(c)}`)
    .join(', ');
  const sql =
    `INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT(${ident(pk)}) DO UPDATE SET ${updates}`;
  db.runSync(
    sql,
    cols.map((c) => coerceBind(table, c, row[c])),
  );
}

/** Replace all child rows for one parent (delete-then-insert) inside the caller's txn. */
export function replaceChildrenSync(
  db: InternalDb,
  table: string,
  parentCol: string,
  parentId: string,
  rows: Row[],
): void {
  db.runSync(`DELETE FROM ${ident(table)} WHERE ${ident(parentCol)} = ?`, [parentId]);
  for (const row of rows) upsertRowSyncNoConflict(db, table, row);
}

/** Plain INSERT (child tables have composite PKs; parent rows were just cleared). */
function upsertRowSyncNoConflict(db: InternalDb, table: string, row: Row): void {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  db.runSync(
    `INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) VALUES (${placeholders})`,
    cols.map((c) => coerceBind(table, c, row[c])),
  );
}

/**
 * Bulk-upsert entities into `table` + their children, id-sorted, one transaction
 * per chunk. Yields a macrotask between chunks so a large migration/sync never
 * blocks the JS thread for long. `onProgress(done, total)` fires per chunk.
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
  for (let i = 0; i < sorted.length; i += chunkSize) {
    const chunk = sorted.slice(i, i + chunkSize);
    db.withTransactionSync(() => {
      for (const item of chunk) {
        const id = idOf(item);
        upsertRowSync(db, table, rowOf(item));
        for (const spec of children) {
          replaceChildrenSync(db, spec.table, spec.parentCol, id, spec.rows(item, id));
        }
      }
    });
    done += chunk.length;
    onProgress?.(done, sorted.length);
    // yield to the JS thread between chunks
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return done;
}

/** Opaque keyset cursor: the last row's (sortKey, id). */
export interface Cursor {
  sortKey: string;
  id: string;
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
    columns: string; // pre-joined projection, must include the sort col + id
    limit: number;
    cursor?: Cursor | null;
    letter?: string | null;
    where?: string; // extra predicate, ANDed (e.g. "starred IS NOT NULL")
    sortKeyOf: (row: R) => string;
  },
): Promise<Page<R>> {
  const { table, sortCol, columns, limit, cursor, letter, where, sortKeyOf } = opts;
  const clauses: string[] = [];
  const params: Value[] = [];
  if (where) clauses.push(`(${where})`);
  if (cursor) {
    clauses.push(`(${ident(sortCol)}, ${ident('id')}) > (?, ?)`);
    params.push(cursor.sortKey, cursor.id);
  } else if (letter != null) {
    clauses.push(`${ident(sortCol)} >= ?`);
    params.push(letter.toLowerCase());
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql =
    `SELECT ${columns} FROM ${ident(table)} ${whereSql} ` +
    `ORDER BY ${ident(sortCol)}, ${ident('id')} LIMIT ?`;
  // Fetch one extra row as lookahead so a page that happens to be exactly `limit`
  // rows can be told apart from a page that has more after it.
  const rows = await db.getAllAsync<R>(sql, [...params, limit + 1]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = hasMore ? page[page.length - 1] : null;
  return {
    rows: page,
    nextCursor: last ? { sortKey: sortKeyOf(last), id: last.id } : null,
  };
}

/** COUNT(*) of a table (optionally filtered) — never loads rows to count. */
export async function countRows(db: InternalDb, table: string, where?: string): Promise<number> {
  const sql = `SELECT COUNT(*) AS n FROM ${ident(table)}${where ? ` WHERE ${where}` : ''}`;
  const row = await db.getFirstAsync<{ n: number }>(sql);
  return row?.n ?? 0;
}
