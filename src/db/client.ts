/**
 * op-SQLite connection layer for the app's single database (`substreamer7.db`).
 *
 * This is the engine seam for the persistence rebuild: it opens the EXISTING
 * expo-sqlite file in place (validated by Phase-0 Spike A on iOS + Android),
 * applies the long-standing PRAGMAs, and adapts op-SQLite's API to the
 * `InternalDb` surface every persistence module already consumes — so the engine
 * swap is behavior-identical and no caller changes.
 *
 * op-SQLite mandates ONE connection per DB: every `execute`/`executeBatch` runs on
 * one dedicated pool thread, FIFO, so pool work is serialized by the engine itself.
 * `store/persistence/db.ts` owns schema creation and the exports.
 *
 * Import-safety: op-SQLite is a native module absent under Node/Jest, so a global
 * manual mock (`__mocks__/@op-engineering/op-sqlite.js`) backs it with an
 * in-memory better-sqlite3 adapter for tests.
 */
import {
  open,
  type DB,
  type QueryResult,
  type Scalar,
  type SQLBatchTuple,
} from '@op-engineering/op-sqlite';
import { Directory, Paths } from 'expo-file-system';

/** Mirrors expo-sqlite's `SQLiteRunResult` so existing callers that read
 *  row-modification counts keep working unchanged. */
export interface RunResult {
  changes: number;
  lastInsertRowId: number;
}

/** One statement + its bound params for a batched write. Scalars only (op-SQLite
 *  binds string | number | null); the repository coerces before building these. */
export type BatchCommand = readonly [sql: string, params: ReadonlyArray<string | number | null>];

/**
 * The DB surface every persistence module consumes. Method names/shapes match
 * the expo-sqlite handle they used before, so the op-SQLite swap is invisible to
 * callers. The interactive `*Sync` methods are converted to async in Phase 1.4.
 */
export interface InternalDb {
  getFirstSync<T>(sql: string, params?: readonly unknown[]): T | undefined;
  getAllSync<T>(sql: string, params?: readonly unknown[]): T[];
  getAllAsync<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  runSync(sql: string, params?: readonly unknown[]): RunResult;
  runAsync(sql: string, params?: readonly unknown[]): Promise<RunResult>;
  /**
   * Run many statements off the JS thread in AUTOCOMMIT — **not** a transaction.
   * op-SQLite's `opsqlite_execute_batch` loops the statements with its
   * `BEGIN EXCLUSIVE TRANSACTION` commented out (`cpp/bridge.cpp`), leaving the
   * transaction to the caller, and it aborts on the first failing statement with
   * everything before it already committed. Use it only where a half-applied run
   * is self-repairing; use {@link InternalDb.runAtomicBatchAsync} otherwise.
   */
  runBatchAsync(commands: readonly BatchCommand[]): Promise<void>;
  /**
   * Run many statements as ONE all-or-nothing batch off the JS thread: the same
   * `executeBatch`, bracketed by `SAVEPOINT`/`RELEASE`, with a `ROLLBACK TO`
   * enqueued behind it in the same tick. Rejects with the ORIGINAL statement error,
   * after the savepoint has been popped.
   */
  runAtomicBatchAsync(commands: readonly BatchCommand[]): Promise<void>;
  execSync(sql: string): void;
  /**
   * BEGIN/COMMIT via `executeSync` — on the JS thread, bypassing the pool, so an
   * open pool transaction makes the BEGIN a hard error on Android. Callers must
   * either run where nothing else writes (boot, the migration chain) or await
   * {@link awaitDbWritesIdle} first, as logout does.
   */
  withTransactionSync(fn: () => void): void;
}

export const DB_NAME = 'substreamer7.db';
const DB_SUBDIR = 'SQLite';

/**
 * The plain filesystem directory that holds the DB. expo-sqlite stored
 * `substreamer7.db` under `<document>/SQLite` on both platforms (confirmed in
 * place by Spike A: iOS `.../Documents/SQLite`, Android `.../files/SQLite`).
 * op-SQLite needs a plain path, not a `file://` URI. Defensive: falls back to a
 * bare subdir name if the FS API is unavailable (Jest — the mock forces
 * in-memory and ignores the location anyway).
 */
function resolveDbLocation(): string {
  try {
    const docPath = Paths.document.uri.replace(/^file:\/\//, '').replace(/\/+$/, '');
    return `${docPath}/${DB_SUBDIR}`;
  } catch {
    return DB_SUBDIR;
  }
}

/** Ensure `<document>/SQLite` exists before opening (fresh install: op-SQLite
 *  won't create intermediate dirs the way expo-sqlite did). */
function ensureDbDir(): void {
  try {
    const dir = new Directory(Paths.document, DB_SUBDIR);
    if (!dir.exists) dir.create({ intermediates: true });
  } catch {
    /* already exists, or FS unavailable under test */
  }
}

const toParams = (params?: readonly unknown[]): Scalar[] | undefined =>
  params as unknown as Scalar[] | undefined;

const toRunResult = (r: QueryResult): RunResult => ({
  changes: r.rowsAffected,
  lastInsertRowId: r.insertId ?? 0,
});

/**
 * Pool writes currently outstanding, and everyone waiting for that to reach zero.
 *
 * This TRACKS writes, it does not serialize them: nothing waits on anything else, so
 * there is no ordering cost and no hot-path cost beyond a counter. It exists for the
 * one thing a mutex could never give us — knowing when it is safe to run a JS-thread
 * `BEGIN` (`withTransactionSync`), which bypasses the pool entirely and hard-fails on
 * Android if a pool transaction is open.
 */
let inFlightWrites = 0;
let idleWaiters: Array<() => void> = [];

function trackWrite<T>(work: Promise<T>): Promise<T> {
  inFlightWrites += 1;
  const settle = (): void => {
    inFlightWrites -= 1;
    if (inFlightWrites > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  };
  // Both handlers, and the ORIGINAL promise is what we return: the derived promise
  // always resolves (so a failed write is never an unhandled rejection here), while
  // the caller still sees the rejection it has to handle.
  work.then(settle, settle);
  return work;
}

/**
 * Resolve once no pool-queued write is outstanding on the connection.
 *
 * Await this before any JS-thread `executeSync` transaction — logout's
 * `resetNormalizedSchema` DROP loop is the only runtime caller. It covers EVERY
 * writer, which the JS-side write mutex it replaced could not: a writer that never
 * joined that chain was invisible to it.
 */
export function awaitDbWritesIdle(): Promise<void> {
  if (inFlightWrites === 0) return Promise.resolve();
  return new Promise<void>((resolve) => idleWaiters.push(resolve));
}

/** Adapt op-SQLite's DB to the `InternalDb` surface. `withTransactionSync` issues
 *  its BEGIN/COMMIT via `executeSync`, matching the previous expo-sqlite behavior;
 *  multi-statement ASYNC writes use `runAtomicBatchAsync` rather than a transaction
 *  spanning JS turns. */
function adapt(op: DB): InternalDb {
  return {
    getFirstSync<T>(sql: string, params?: readonly unknown[]): T | undefined {
      return op.executeSync(sql, toParams(params)).rows[0] as T | undefined;
    },
    getAllSync<T>(sql: string, params?: readonly unknown[]): T[] {
      return op.executeSync(sql, toParams(params)).rows as unknown as T[];
    },
    async getAllAsync<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      return (await op.execute(sql, toParams(params))).rows as unknown as T[];
    },
    async getFirstAsync<T>(sql: string, params?: readonly unknown[]): Promise<T | null> {
      return ((await op.execute(sql, toParams(params))).rows[0] ?? null) as T | null;
    },
    runSync(sql: string, params?: readonly unknown[]): RunResult {
      return toRunResult(op.executeSync(sql, toParams(params)));
    },
    async runAsync(sql: string, params?: readonly unknown[]): Promise<RunResult> {
      return toRunResult(await trackWrite(op.execute(sql, toParams(params))));
    },
    async runBatchAsync(commands: readonly BatchCommand[]): Promise<void> {
      if (commands.length === 0) return;
      await trackWrite(op.executeBatch(commands as unknown as SQLBatchTuple[]));
    },
    async runAtomicBatchAsync(commands: readonly BatchCommand[]): Promise<void> {
      if (commands.length === 0) return;
      // Issued SYNCHRONOUSLY — nothing may be awaited above this line, or a
      // pipelining caller (`bulkUpsert`) would derive its next chunk before this
      // one reaches the pool. op-SQLite's pool has exactly ONE thread
      // (`node_modules/@op-engineering/op-sqlite/cpp/OPThreadPool.cpp:14`,
      // `auto numberOfThreads = 1;`; `restartPool()` would rebuild it with
      // `hardware_concurrency()` threads and break that, but has no callers) and
      // runs tasks FIFO, so one `executeBatch` is one indivisible task: no other
      // POOL-queued statement can land between the SAVEPOINT and the RELEASE.
      // (`executeSync` runs on the JS thread and bypasses the pool entirely.)
      // SAVEPOINT, not BEGIN: it nests, so running inside another writer's open
      // transaction neither fails nor lets our recovery destroy their work.
      const batch = trackWrite(
        op.executeBatch([
          ['SAVEPOINT op_batch', []],
          ...commands,
          ['RELEASE op_batch', []],
        ] as unknown as SQLBatchTuple[]),
      );
      // The recovery is enqueued in the SAME TICK, unconditionally, and that is
      // load-bearing rather than tidy: `opsqlite_execute_batch` is a bare loop that
      // rethrows the first statement failure (`cpp/bridge.cpp`), so an aborted batch
      // never reaches its RELEASE and leaves the savepoint OPEN. Deciding to recover
      // from the JS `catch` below would be too late — the rejection has to travel back
      // to JS, and every task the pool drains in the meantime (including writes queued
      // while this batch was still running) would commit inside the stranded savepoint
      // and then be silently discarded by the ROLLBACK. One JS thread means nothing can
      // be issued between two synchronous calls, and FIFO means nothing can execute
      // between the two tasks, so there is no window to be captured by.
      //
      // On the success path the batch has already RELEASEd the savepoint, so
      // `ROLLBACK TO` fails with "no such savepoint" and nothing is undone — that
      // failure is expected and swallowed. Same swallow covers SQLITE_FULL / IOERR /
      // NOMEM, which abort the whole transaction themselves: the batch is already
      // undone, so the recovery's own failure is never the error to report.
      // Tracked like any other write: on the success path it opens nothing, but it is
      // still a queued pool task, and `awaitDbWritesIdle` promises there are none.
      const recovery = trackWrite(
        op.executeBatch([
          ['ROLLBACK TO op_batch', []],
          ['RELEASE op_batch', []],
        ] as unknown as SQLBatchTuple[]),
      ).catch(() => undefined);
      try {
        await batch;
      } catch (e) {
        // Settle the recovery before reporting, so the caller's error handling can
        // never observe a half-applied batch. Always rethrow the statement error.
        await recovery;
        throw e;
      }
    },
    execSync(sql: string): void {
      op.executeSync(sql);
    },
    withTransactionSync(fn: () => void): void {
      op.executeSync('BEGIN');
      try {
        fn();
        op.executeSync('COMMIT');
      } catch (e) {
        try {
          op.executeSync('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw e;
      }
    },
  };
}

export interface DbConnection {
  raw: DB;
  db: InternalDb;
  location: string;
}

/**
 * Open the DB with op-SQLite and apply PRAGMAs (identical to the historical
 * settings). Folds any WAL sidecars expo-sqlite left behind via a one-shot
 * `wal_checkpoint(TRUNCATE)`. Throws on failure (the caller sets init-error state).
 */
export function openDbConnection(): DbConnection {
  ensureDbDir();
  const location = resolveDbLocation();
  const raw = open({ name: DB_NAME, location });

  raw.executeSync('PRAGMA journal_mode = WAL;');
  // Fold any leftover WAL at boot so the first (boot-critical, synchronous) reads
  // aren't stuck rebuilding/traversing a large WAL — e.g. after a big write that
  // didn't checkpoint before an unclean close (a crash/SIGKILL). Best-effort;
  // normally a fast no-op since the WAL auto-checkpoints during use. Safe re: the
  // expo-router mount race, which is fixed by the useLinking patch, not by timing.
  try {
    raw.executeSync('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    /* best-effort */
  }
  raw.executeSync('PRAGMA synchronous = NORMAL;');
  raw.executeSync('PRAGMA foreign_keys = ON;');
  raw.executeSync('PRAGMA busy_timeout = 5000;');
  raw.executeSync('PRAGMA cache_size = -32000;');
  raw.executeSync('PRAGMA temp_store = MEMORY;');

  // Boot diagnostic: engine + resolved file location, then a PRAGMA readback.
  // `console.*` is stripped from release builds — dev/Metro only.
  try {
    // eslint-disable-next-line no-console
    console.log('[db] engine=op-sqlite', { name: DB_NAME, file: raw.getDbPath(), location });
    // eslint-disable-next-line no-console
    console.log('[db] PRAGMA readback', {
      busy_timeout: raw.executeSync('PRAGMA busy_timeout;').rows[0],
      cache_size: raw.executeSync('PRAGMA cache_size;').rows[0],
      temp_store: raw.executeSync('PRAGMA temp_store;').rows[0],
      journal_mode: raw.executeSync('PRAGMA journal_mode;').rows[0],
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[db] readback failed', e);
  }

  return { raw, db: adapt(raw), location };
}
