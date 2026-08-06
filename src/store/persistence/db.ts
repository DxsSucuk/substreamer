/**
 * Central SQLite persistence service.
 *
 * Owns the single `SQLite.openDatabaseSync('substreamer7.db')` call, PRAGMAs,
 * schema creation for every table the app uses, health reporting, and the
 * test-injection seam. Every other module in `src/store/persistence/` (the
 * Zustand StateStorage adapter + the three row-table query helpers) pulls its
 * handle from `getDb()` instead of opening its own.
 *
 * Why one module:
 * - Before consolidation, four modules each called `openDatabaseSync` at
 *   import and each ran their own PRAGMA block. Expo-sqlite pools native
 *   connections by filename so runtime was fine, but the PRAGMAs drifted
 *   during the migration-14 bug hunt and kept us editing four files in
 *   lockstep. One PRAGMA block removes that class of bug.
 * - Schema CREATE statements ran in whatever order the import graph
 *   happened to resolve. With a single init block here, FK-dependent
 *   tables are created after their parents in explicit source order.
 * - Init-failure handling lives in one place. The KV-blob adapter
 *   (`kvStorage.ts`) still falls back to an in-memory Map so the UI
 *   can render; row-table modules still become safe no-ops. Both paths
 *   read the same `dbHealthy` / `dbInitError` here.
 *
 * Tests: call `__setDbForTests(fake)` to swap the handle. The single seam
 * replaces four per-module `__setDbForTests` exports.
 */
import { openDbConnection, type InternalDb } from '@/db/client';
import { ensureNormalizedSchema } from '@/db/createNormalizedTables';

// The DB surface types (`InternalDb`, `RunResult`) live in the op-SQLite client
// now; re-export so existing consumers importing them from this module keep working.
export type { BatchCommand, InternalDb, RunResult } from '@/db/client';

let db: InternalDb | null = null;
let initError: Error | null = null;

/**
 * In-memory fallback for the KV (blob) storage when the DB is unavailable.
 * Used only by `kvStorage.ts`. Row-table modules refuse writes when the
 * DB is null rather than falling back (row data silently going to memory is
 * worse than not writing at all).
 */
export const kvFallback = new Map<string, string>();

try {
  // Open op-SQLite on the existing file, apply PRAGMAs, and log the boot
  // diagnostic (engine + resolved path). See src/db/client.ts.
  const conn = openDbConnection();
  db = conn.db;

  // cached_item_songs dedup — a one-time heal, NOT schema, so it stays here. It must
  // run BEFORE the UNIQUE (item_id, song_id) index, which `ensureNormalizedSchema`
  // creates inside a single all-or-nothing transaction below: surviving duplicates
  // would fail that CREATE and take DB init down. The PK (item_id, position) prevents
  // a duplicate insert at the same position but not the same song at two positions,
  // which a concurrent `ensurePartialAlbumEdge` + queue-completion race could produce.
  // Guarded on the table existing — a fresh install has not created it yet (and it
  // can hold no duplicates).
  const itemSongsTable = db.getFirstSync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='cached_item_songs'",
  );
  if ((itemSongsTable?.n ?? 0) > 0) {
    db.execSync(
      `DELETE FROM cached_item_songs
         WHERE rowid NOT IN (
           SELECT MIN(rowid) FROM cached_item_songs
           GROUP BY item_id, song_id
         );`,
    );
  }

  // The superseded non-unique position index. `CREATE UNIQUE INDEX IF NOT EXISTS`
  // under the same name is a no-op, so the constraint below arrives under a new
  // name and this one is retired here (same pattern as idx_song_index_title).
  db.execSync('DROP INDEX IF EXISTS idx_download_queue_position;');

  // download_queue position renumber — a one-time heal, NOT schema, so it stays
  // here for the same reason the dedup above does: it must run BEFORE the UNIQUE
  // (queue_position) index that `ensureNormalizedSchema` creates inside a single
  // all-or-nothing transaction, or surviving duplicates fail that CREATE and null
  // the whole DB handle. Duplicates are possible on every install predating the
  // constraint — the slot was a JS-computed MAX+1 over an in-memory mirror, which
  // reads 0 for an enqueue that beats `hydrateFromDbAsync`. Rows are RENUMBERED,
  // never deleted: each duplicate is a real queued download. Guarded on the table
  // existing — a fresh install has not created it yet.
  const queueTable = db.getFirstSync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='download_queue'",
  );
  if ((queueTable?.n ?? 0) > 0) {
    const duplicates = db.getFirstSync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT queue_position FROM download_queue
          GROUP BY queue_position HAVING COUNT(*) > 1 LIMIT 1
       )`,
    );
    if ((duplicates?.n ?? 0) > 0) {
      // `conn.db`, not `db`: the mutable module binding loses its non-null
      // narrowing inside the callback.
      conn.db.withTransactionSync(() => {
        // Dense 1..N in (queue_position, added_at, queue_id) order — deterministic,
        // so two devices repairing the same queue agree. Written NEGATED first: a
        // positive target can collide with a row that has not been renumbered yet,
        // and negative space is disjoint from every untouched row.
        conn.db.execSync(
          `UPDATE download_queue SET queue_position = -ranked.rn
             FROM (SELECT queue_id,
                          ROW_NUMBER() OVER (ORDER BY queue_position, added_at, queue_id) AS rn
                     FROM download_queue) AS ranked
            WHERE ranked.queue_id = download_queue.queue_id;`,
        );
        conn.db.execSync(
          'UPDATE download_queue SET queue_position = -queue_position WHERE queue_position < 0;',
        );
      });
    }
  }

  // Normalized model: create the songs/albums/artists/playlists tables + children at
  // boot so the live sync can dual-write them (not just the one-time migration).
  // Generated DDL, all CREATE ... IF NOT EXISTS — idempotent + FK-safe.
  ensureNormalizedSchema(db);
} catch (e) {
  db = null;
  initError = e instanceof Error ? e : new Error(String(e));
  // eslint-disable-next-line no-console
  console.warn(
    '[persistence/db] init failed; SQLite unavailable, KV falls back to memory, row tables refuse writes:',
    initError.message,
  );
}

/** Shared handle accessor. Returns null when the DB failed to open. */
export function getDb(): InternalDb | null {
  return db;
}

/**
 * Global write-serialization mutex for the shared connection.
 *
 * `withTransactionAsync` is NOT exclusive: it issues `BEGIN`, then yields the JS
 * thread while its inner `runAsync` calls queue on the native background thread.
 * A second async transaction can slip its own `BEGIN` into that gap. Android's
 * SQLite rejects the nested `BEGIN` outright ("cannot start a transaction within
 * a transaction" / "cannot rollback - no transaction is active"); iOS happens to
 * tolerate the interleave, which is why this only surfaced on Android.
 *
 * Every row-table module shares ONE connection (`getDb()`), so a per-module
 * mutex only serializes a module against itself and lets cross-module
 * transactions collide (e.g. a `cached_items` download write vs a `scrobble_events`
 * flush at the same moment). ALL async transactions must funnel through this single
 * chain so at most one is ever in flight connection-wide. (`withTransactionSync`
 * is exempt — it runs to completion without yielding, so it can't interleave.)
 * A thrown task can't break the chain (the settle-to-undefined always resolves).
 */
let dbWriteChain: Promise<unknown> = Promise.resolve();
export function serializeDbWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = dbWriteChain.then(task, task);
  dbWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * True when the SQLite-backing store is currently available.
 *
 * Implemented as a function (not a const captured at module load) so callers
 * see live state — both for the rare runtime swap via `__setDbForTests` and
 * because destructured ESM-import bindings under our CommonJS-style test
 * transpile are otherwise frozen at first import.
 *
 * In production the db handle is opened once at module load and never
 * reassigned, so this stays effectively constant for the JS bundle's
 * lifetime — but the function form keeps both consumers honest and tests
 * trivially mockable.
 */
export function isDbHealthy(): boolean {
  return db !== null;
}

/** The error captured at init time, or null on success. */
export const dbInitError: Error | null = initError;

/**
 * Test-only: swap the shared handle. The sole `__setDbForTests` seam for
 * every persistence module — replaces four per-module exports.
 */
export function __setDbForTests(fake: InternalDb | null): void {
  db = fake;
}
