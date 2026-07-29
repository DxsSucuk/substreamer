/**
 * op-SQLite connection layer for the app's single database (`substreamer7.db`).
 *
 * This is the engine seam for the persistence rebuild: it opens the EXISTING
 * expo-sqlite file in place (validated by Phase-0 Spike A on iOS + Android),
 * applies the long-standing PRAGMAs, and adapts op-SQLite's API to the
 * `InternalDb` surface every persistence module already consumes — so the engine
 * swap is behavior-identical and no caller changes.
 *
 * op-SQLite mandates ONE connection per DB (all `execute` run on one dedicated
 * thread); write serialization is handled by `serializeDbWrite` in
 * `store/persistence/db.ts`, which also owns schema creation and the exports.
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
   * Run many statements as ONE atomic batch off the JS thread (op-SQLite
   * `executeBatch` wraps them in a single transaction on its native thread — the
   * lowest-overhead bulk-write primitive, and non-blocking for the UI). The
   * repository builds these tuples for id-sorted bulk upserts.
   */
  runBatchAsync(commands: readonly BatchCommand[]): Promise<void>;
  execSync(sql: string): void;
  withTransactionSync(fn: () => void): void;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
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

/** Adapt op-SQLite's DB to the `InternalDb` surface. Transactions use manual
 *  BEGIN/COMMIT via `execute` so callers' `run*` calls run inside them on the
 *  single connection thread (write serialization is external, via
 *  `serializeDbWrite`), matching the previous expo-sqlite behavior. */
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
      return toRunResult(await op.execute(sql, toParams(params)));
    },
    async runBatchAsync(commands: readonly BatchCommand[]): Promise<void> {
      if (commands.length === 0) return;
      await op.executeBatch(commands as unknown as SQLBatchTuple[]);
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
    async withTransactionAsync(task: () => Promise<void>): Promise<void> {
      await op.execute('BEGIN');
      try {
        await task();
        await op.execute('COMMIT');
      } catch (e) {
        try {
          await op.execute('ROLLBACK');
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
