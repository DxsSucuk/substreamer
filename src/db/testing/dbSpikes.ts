/**
 * Phase 0 de-risking spikes — DEV/on-device only.
 *
 * These are throwaway validation harnesses for the persistence rebuild, run from
 * a dev trigger and logged to the in-app logger. They are NOT imported by app
 * code or tests; op-SQLite is lazy-`require`d so this module stays import-safe
 * where the native module is absent.
 *
 *  - Spike A (BLOCKING): can op-SQLite open the EXISTING `substreamer7.db` that
 *    expo-sqlite created, read real data, and does its resolved path stay under
 *    the "SQLite" backup-exclusion? This decides "keep the file" vs "copy/migrate".
 *  - Spike B: does ONE op-SQLite connection + the `serializeDbWrite` mutex + WAL
 *    keep interactive read latency acceptable while a bulk sync writes? And does
 *    `reactiveExecute` fire on a transactional write + dispose on unsub?
 *
 * Delete this module (and its trigger) once Phase 0 exits.
 */
type Log = (message: string) => void;

const now = (): number => {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
};

const since = (t0: number): string => `${Math.round(now() - t0)}ms`;

/** Zero-padded numeric sort key so string ORDER BY matches numeric order — a
 *  stand-in for the real `sort_title` in the synthetic dataset. */
const padSort = (n: number): string => n.toString().padStart(10, '0');

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx]);
}

// Minimal shapes for the op-SQLite surface we touch (avoids importing the native
// module's types at module scope; the real module is loaded lazily below).
interface SpikeQueryResult {
  rows: Array<Record<string, unknown>>;
  rowsAffected: number;
}
export interface SpikeDb {
  execute: (query: string, params?: unknown[]) => Promise<SpikeQueryResult>;
  executeSync: (query: string, params?: unknown[]) => SpikeQueryResult;
  executeBatch: (commands: Array<[string, unknown[]]>) => Promise<{ rowsAffected?: number }>;
  transaction: (fn: (tx: { execute: (q: string, p?: unknown[]) => Promise<SpikeQueryResult> }) => Promise<void>) => Promise<void>;
  reactiveExecute: (params: {
    query: string;
    arguments: unknown[];
    fireOn: { table: string; ids?: number[] }[];
    callback: (response: SpikeQueryResult) => void;
  }) => () => void;
  getDbPath: (location?: string) => string;
  close: () => void;
}
interface OpSqliteModule {
  open: (opts: { name: string; location?: string; readOnly?: boolean }) => SpikeDb;
  IOS_LIBRARY_PATH?: string;
  IOS_DOCUMENT_PATH?: string;
  ANDROID_DATABASE_PATH?: string;
  ANDROID_FILES_PATH?: string;
}

function loadOpSqlite(log: Log): OpSqliteModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@op-engineering/op-sqlite') as OpSqliteModule;
  } catch (e) {
    log(`[spike] op-SQLite not available (needs a dev-client rebuild): ${String(e)}`);
    return null;
  }
}

/** The directory holding substreamer7.db — `<document>/SQLite`. op-SQLite owns it
 *  now (expo-sqlite removed); mirrors src/db/client.ts's resolveDbLocation. */
function dbDir(log: Log): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Paths } = require('expo-file-system') as { Paths: { document: { uri: string } } };
    const docPath = Paths.document.uri.replace(/^file:\/\//, '').replace(/\/+$/, '');
    return `${docPath}/SQLite`;
  } catch (e) {
    log(`[spike] could not resolve DB dir: ${String(e)}`);
    return undefined;
  }
}

/** Open a throwaway op-SQLite DB at expo-sqlite's default directory (used by the
 *  Spike C UI screen). Returns null when op-SQLite isn't available. */
export function openSpikeDb(name: string, log: Log = () => undefined): SpikeDb | null {
  const OP = loadOpSqlite(log);
  if (!OP) return null;
  const dir = dbDir(log);
  try {
    return OP.open({ name, location: dir });
  } catch (e) {
    log(`[spike] open ${name} failed: ${String(e)}`);
    return null;
  }
}

/**
 * Spike A (BLOCKING) — open the existing substreamer7.db in place and read it.
 * Read-only probes (SELECT/PRAGMA reads only, no writes/checkpoint) so the live
 * expo-sqlite connection is never disturbed during the test.
 */
export async function runSpikeA(log: Log): Promise<void> {
  log('=== Spike A: op-SQLite opens the existing substreamer7.db in place ===');
  const OP = loadOpSqlite(log);
  if (!OP) return;

  const dir = dbDir(log);
  log(`DB dir: ${dir ?? "(undefined)"}`);
  log(`op-sqlite IOS_LIBRARY_PATH:  ${OP.IOS_LIBRARY_PATH ?? '(none)'}`);
  log(`op-sqlite IOS_DOCUMENT_PATH: ${OP.IOS_DOCUMENT_PATH ?? '(none)'}`);
  log(`op-sqlite ANDROID_DATABASE_PATH: ${OP.ANDROID_DATABASE_PATH ?? '(none)'}`);
  if (!dir) {
    log('Spike A ABORT: no expo-sqlite dir to target. Pass an explicit location instead.');
    return;
  }

  let db: SpikeDb | null = null;
  try {
    db = OP.open({ name: 'substreamer7.db', location: dir });
  } catch (e) {
    log(`Spike A FAIL: op-SQLite open threw: ${String(e)}`);
    log('→ Fallback path: copy the file to op-SQLite\'s own dir (+ re-add backup exclusion), or migrate to a new file.');
    return;
  }

  try {
    const path = db.getDbPath();
    log(`op-sqlite resolved path: ${path}`);
    const excluded = path.includes('/SQLite/') || path.endsWith('/SQLite');
    log(`under the "SQLite" backup exclusion? ${excluded ? 'YES ✓' : 'NO ✗ — DB would leave the iCloud backup exclusion!'}`);

    const tableRows = db.executeSync(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).rows;
    const tables = tableRows.map((r) => String(r.name));
    log(`tables (${tables.length}): ${tables.join(', ')}`);

    for (const t of ['storage', 'library_albums', 'song_index', 'album_details', 'cached_songs']) {
      if (!tables.includes(t)) {
        log(`  ${t}: (absent)`);
        continue;
      }
      try {
        const n = db.executeSync(`SELECT COUNT(*) AS n FROM ${t}`).rows[0]?.n;
        log(`  ${t}: ${n} rows`);
      } catch (e) {
        log(`  ${t}: COUNT failed: ${String(e)}`);
      }
    }
    // Confirm we can pull a real row (not just metadata) through op-SQLite.
    if (tables.includes('library_albums')) {
      const sample = db.executeSync('SELECT id, sortKey FROM library_albums LIMIT 1').rows[0];
      log(`  library_albums sample row: ${sample ? JSON.stringify(sample) : '(empty table)'}`);
    }
    log('Spike A RESULT: op-SQLite read the existing file above. Judge PASS if counts match the live app and the backup-exclusion line says YES.');
  } catch (e) {
    log(`Spike A FAIL during read: ${String(e)}`);
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Spike B — contention + reactivity on a throwaway DB.
 * Proves the ONE-connection + write-mutex + WAL model keeps a keyset page read
 * responsive while a bulk sync writes, and that reactiveExecute fires on a
 * transactional write and disposes on unsub. Uses its own `spikeB.db` file so
 * the real DB is never touched.
 */
export async function runSpikeB(log: Log): Promise<void> {
  log('=== Spike B: one-connection contention + reactiveExecute ===');
  const OP = loadOpSqlite(log);
  if (!OP) return;
  const dir = dbDir(log);

  let db: SpikeDb | null = null;
  try {
    db = OP.open({ name: 'spikeB.db', location: dir });
  } catch (e) {
    log(`Spike B FAIL: open threw: ${String(e)}`);
    return;
  }

  // Inline write mutex mirroring serializeDbWrite — every write funnels through
  // this chain so at most one transaction is in flight on the single connection.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const SEED = 50_000;
  const BATCH = 1_000;
  const insertBatch = (from: number, to: number): Promise<{ rowsAffected?: number }> => {
    const cmds: Array<[string, unknown[]]> = [];
    for (let j = from; j < to; j++) {
      cmds.push(['INSERT INTO t (id, sort_title, name) VALUES (?, ?, ?)', [j, padSort(j), `row ${j}`]]);
    }
    return serialize(() => db!.executeBatch(cmds));
  };

  try {
    db.executeSync('PRAGMA journal_mode = WAL');
    db.executeSync('PRAGMA synchronous = NORMAL');
    db.executeSync('PRAGMA temp_store = MEMORY');
    db.executeSync('DROP TABLE IF EXISTS t');
    db.executeSync('CREATE TABLE t (id INTEGER PRIMARY KEY, sort_title TEXT, name TEXT)');
    db.executeSync('CREATE INDEX idx_t_sort ON t (sort_title, id)');

    // --- Seed (id-sorted batches) ---
    log(`seeding ${SEED} rows in ${BATCH}-row batches...`);
    const s0 = now();
    for (let i = 0; i < SEED; i += BATCH) await insertBatch(i, Math.min(i + BATCH, SEED));
    log(`seed complete in ${since(s0)}`);

    // --- Baseline keyset page read (no concurrent writer) ---
    const b0 = now();
    await db.execute('SELECT id, sort_title FROM t ORDER BY sort_title, id LIMIT 100');
    log(`baseline keyset page read: ${since(b0)}`);

    // --- Read latency WHILE a bulk write runs ---
    let writing = true;
    const writer = (async () => {
      const w0 = now();
      for (let i = SEED; i < SEED * 2; i += BATCH) await insertBatch(i, i + BATCH);
      log(`concurrent bulk write (${SEED} rows) done in ${since(w0)}`);
      writing = false;
    })();

    const latencies: number[] = [];
    while (writing) {
      const r0 = now();
      await db.execute('SELECT id, sort_title FROM t ORDER BY sort_title, id LIMIT 100');
      latencies.push(now() - r0);
      await new Promise((res) => setTimeout(res, 25));
    }
    await writer;
    log(
      `keyset reads during bulk write: n=${latencies.length} ` +
        `p50=${percentile(latencies, 50)}ms p95=${percentile(latencies, 95)}ms ` +
        `max=${Math.round(Math.max(...latencies, 0))}ms`,
    );
    log('→ PASS if p95 stays low (interactive, ~<50ms). If reads stall badly, the two-connection fallback is warranted.');

    // --- reactiveExecute: fires on transactional write, disposes on unsub ---
    const fires: number[] = [];
    const unsub = db.reactiveExecute({
      query: 'SELECT COUNT(*) AS n FROM t',
      arguments: [],
      fireOn: [{ table: 't' }],
      callback: (res) => fires.push(Number(res.rows[0]?.n ?? -1)),
    });
    await serialize(() =>
      db!.transaction(async (tx) => {
        await tx.execute('INSERT INTO t (id, sort_title, name) VALUES (?, ?, ?)', [9_000_001, padSort(9_000_001), 'reactive-1']);
      }),
    );
    // give the native reactive callback a tick to arrive
    await new Promise((res) => setTimeout(res, 50));
    log(`reactiveExecute fired after txn write: ${fires.length > 0 ? `YES ✓ (count=${fires[fires.length - 1]})` : 'NO ✗'}`);

    const firesBefore = fires.length;
    unsub();
    await serialize(() =>
      db!.transaction(async (tx) => {
        await tx.execute('INSERT INTO t (id, sort_title, name) VALUES (?, ?, ?)', [9_000_002, padSort(9_000_002), 'reactive-2']);
      }),
    );
    await new Promise((res) => setTimeout(res, 50));
    log(`reactiveExecute stayed silent after unsub: ${fires.length === firesBefore ? 'YES ✓' : 'NO ✗ (leak)'}`);

    log('Spike B RESULT: judge PASS if read p95 is interactive AND reactive fired on txn + disposed on unsub.');
  } catch (e) {
    log(`Spike B FAIL: ${String(e)}`);
  } finally {
    try {
      db?.executeSync('DROP TABLE IF EXISTS t');
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Spike D — run the blob→normalized migration on the REAL app DB and validate it.
 * Additive + idempotent (creates + populates the normalized tables; never touches
 * the legacy blob tables), so it's safe to run repeatedly. Reports source vs
 * migrated counts, keyset read + A–Z seek latency, and EXPLAIN QUERY PLAN (proving
 * index seeks, not table scans).
 */
export async function runSpikeD(log: Log): Promise<void> {
  log('=== Spike D: normalized migration + validation (REAL DB) ===');
  // Lazy-require so this dev-only module never pulls the DB/migration/repository
  // into the app's boot import graph (the db-spikes route is eagerly loaded).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getDb } = require('../../store/persistence/db') as typeof import('../../store/persistence/db');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { migrateBlobsToNormalized } = require('../migrateNormalized') as typeof import('../migrateNormalized');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { countAlbums } = require('../repository/albums') as typeof import('../repository/albums');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { countSongs, listSongs } = require('../repository/songs') as typeof import('../repository/songs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getCoercedColumns } = require('../repository/core') as typeof import('../repository/core');

  const db = getDb();
  if (!db) {
    log('DB unavailable — cannot run.');
    return;
  }

  const srcAlbums = db.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM library_albums')?.n ?? 0;
  const srcSongs = db.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM song_index')?.n ?? 0;
  log(`source blobs: library_albums=${srcAlbums}, song_index=${srcSongs}`);

  log('migrating (keyset-paged, chunked)…');
  const t0 = now();
  const result = await migrateBlobsToNormalized(db, (m) => log(`  ${m}`));
  log(`migration done in ${since(t0)}`);
  log(`  albums: ${result.albums.migrated}/${result.albums.source} migrated, ${result.albums.skipped} skipped`);
  log(`  songs:  ${result.songs.migrated}/${result.songs.source} migrated, ${result.songs.skipped} skipped`);
  const coerced = getCoercedColumns();
  log(`  coerced columns (type↔reality mismatches to fix at mapper): ${coerced.length ? coerced.join(', ') : 'none ✓'}`);

  const nAlbums = await countAlbums(db);
  const nSongs = await countSongs(db);
  log(`normalized counts: albums=${nAlbums}, songs=${nSongs}`);
  log(`  albums match source? ${nAlbums === srcAlbums ? 'YES ✓' : `NO ✗ (${nAlbums} vs ${srcAlbums})`}`);
  log(`  songs match (source - skipped)? ${nSongs === srcSongs - result.songs.skipped ? 'YES ✓' : `NO ✗ (${nSongs} vs ${srcSongs - result.songs.skipped})`}`);

  // Keyset read latency on the real, populated songs table.
  const r0 = now();
  const first = await listSongs(db, { limit: 100 });
  log(`first keyset page (100 songs) in ${since(r0)} — e.g. "${first.rows[0]?.title ?? '(empty)'}"`);
  const r1 = now();
  const seek = await listSongs(db, { letter: 'm', limit: 100 });
  log(`A–Z seek to 'm' (100 songs) in ${since(r1)} — e.g. "${seek.rows[0]?.title ?? '(none)'}"`);

  // Prove the keyset query uses the (sort_title, id) index rather than scanning.
  try {
    const plan = db.getAllSync<{ detail: string }>(
      'EXPLAIN QUERY PLAN SELECT id, title FROM songs WHERE (sort_title, id) > (?, ?) ORDER BY sort_title, id LIMIT 100',
      ['m', 'x'],
    );
    const detail = plan.map((p) => p.detail).join(' | ');
    log(`EXPLAIN keyset songs: ${detail}`);
    log(`  index seek? ${/USING INDEX/i.test(detail) && !/SCAN/i.test(detail) ? 'YES ✓' : 'CHECK ✗ (see plan)'}`);
  } catch (e) {
    log(`EXPLAIN failed: ${String(e)}`);
  }

  log('Spike D done. PASS if counts match + reads are fast (~single-digit ms) + EXPLAIN shows an index seek.');
}
