/**
 * On-device persistence spikes — DEV only. Run from Settings → DB Spikes and logged to
 * the in-app logger; each spike documents itself at its own `runSpike*`.
 *
 * They exist because Jest cannot reproduce the op-SQLite pool: the test seam runs
 * `executeBatch` synchronously, so a green suite proves logic and never concurrency.
 * Spike K is the worked example of a hazard only a device can show.
 *
 * NOT imported by app code or tests. op-SQLite and the repository are lazy-`require`d so
 * this module stays import-safe where the native module is absent, and never joins the
 * app's boot import graph.
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

/** The directory holding substreamer7.db — `<document>/SQLite`. Mirrors
 *  `resolveDbLocation` in src/db/client.ts. */
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

/** Open a throwaway op-SQLite DB in the app's DB directory (used by the Spike C UI
 *  screen). Returns null when op-SQLite isn't available. */
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

  // Inline write mutex — every write funnels through this chain so at most one
  // transaction is in flight on the single connection. Local to the spike: the app
  // itself has no such mutex, the engine's single pool thread serializes for it.
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

/** Percent-of-total formatter for phase breakdowns. */
const pctOf = (ms: number, total: number): string =>
  `${total > 0 ? Math.round((ms / total) * 100) : 0}%`;
/** Compact thousands label (467000 → "467k"). */
const kLabel = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);

/**
 * Spike D — COLD + timed blob→normalized migration on the REAL app DB, then
 * validate it. Resets the normalized schema first so every run measures a true
 * first-run cost (not an idempotent no-op) — REPEATABLE, so batch-size / async
 * changes can be compared run-to-run. Reports a per-phase breakdown (read / parse
 * / derive / write) so we can see where the time goes, throughput + extrapolation
 * to large libraries, then count validation + keyset/EXPLAIN checks.
 */
export async function runSpikeD(log: Log): Promise<void> {
  log('=== Spike D: COLD + timed normalized migration (REAL DB) ===');
  // Lazy-require so this dev-only module never pulls the DB/migration/repository
  // into the app's boot import graph (the db-spikes route is eagerly loaded).
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { getDb } = require('../../store/persistence/db') as typeof import('../../store/persistence/db');
  const { migrateBlobsToNormalized, checkpointWalAsync } = require('../migrateNormalized') as typeof import('../migrateNormalized');
  const { resetNormalizedSchema } = require('../createNormalizedTables') as typeof import('../createNormalizedTables');
  const { countAlbums } = require('../repository/albums') as typeof import('../repository/albums');
  const { countSongs, listSongs } = require('../repository/songs') as typeof import('../repository/songs');
  const { countArtists } = require('../repository/artists') as typeof import('../repository/artists');
  const { countPlaylists } = require('../repository/playlists') as typeof import('../repository/playlists');
  const { getCoercedColumns, setChunkProfiler } = require('../repository/core') as typeof import('../repository/core');
  /* eslint-enable @typescript-eslint/no-var-requires */

  const db = getDb();
  if (!db) {
    log('DB unavailable — cannot run.');
    return;
  }

  const srcAlbums = db.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM library_albums')?.n ?? 0;
  const srcSongs = db.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM song_index')?.n ?? 0;
  log(`source blobs: library_albums=${srcAlbums}, song_index=${srcSongs}`);

  // COLD: drop + recreate normalized tables so we time a genuine first run.
  log('resetting normalized schema (cold run)…');
  resetNormalizedSchema(db);

  // Accumulate the derive-vs-write split from every bulk-upsert chunk.
  const profile = { readMs: 0, parseMs: 0 };
  let deriveMs = 0;
  let writeMs = 0;
  let chunks = 0;
  setChunkProfiler((t) => {
    deriveMs += t.deriveMs;
    writeMs += t.writeMs;
    chunks += 1;
  });

  log('migrating (keyset-paged, chunked, async executeBatch)…');
  const t0 = now();
  let result;
  try {
    result = await migrateBlobsToNormalized(db, undefined, profile);
  } finally {
    setChunkProfiler(null);
  }
  const totalMs = now() - t0;
  log(`migration done in ${Math.round(totalMs)}ms`);
  log(`  albums:    ${result.albums.migrated}/${result.albums.source} (${result.albums.skipped} skipped)`);
  log(`  songs:     ${result.songs.migrated}/${result.songs.source} (${result.songs.skipped} skipped)`);
  log(`  artists:   ${result.artists.migrated} (${result.artists.source} in library KV)`);
  log(`  playlists: ${result.playlists.migrated} (${result.playlists.source} in library KV)`);

  // --- Phase breakdown: where did the wall-clock go? ---
  const accounted = profile.readMs + profile.parseMs + deriveMs + writeMs;
  const otherMs = Math.max(0, totalMs - accounted);
  log('phase breakdown (where the time went):');
  log(`  read   (SQL blobs):          ${Math.round(profile.readMs)}ms (${pctOf(profile.readMs, totalMs)})`);
  log(`  parse  (JSON.parse):         ${Math.round(profile.parseMs)}ms (${pctOf(profile.parseMs, totalMs)})`);
  log(`  derive (rows + norm + dmeta): ${Math.round(deriveMs)}ms (${pctOf(deriveMs, totalMs)})`);
  log(`  write  (executeBatch async): ${Math.round(writeMs)}ms (${pctOf(writeMs, totalMs)})`);
  log(`  other  (checkpoint + yields): ${Math.round(otherMs)}ms (${pctOf(otherMs, totalMs)})`);

  // --- Throughput + extrapolation to large libraries ---
  const totalItems = result.albums.migrated + result.songs.migrated;
  const itemsPerSec = totalMs > 0 ? totalItems / (totalMs / 1000) : 0;
  log(`throughput: ${Math.round(itemsPerSec)} rows/sec across ${chunks} chunks (${totalItems} rows)`);
  const songsPerSec = totalMs > 0 ? result.songs.migrated / (totalMs / 1000) : 0;
  if (songsPerSec > 0) {
    for (const target of [100_000, 467_000, 1_000_000]) {
      log(`  projected @ ${kLabel(target)} songs: ~${Math.round(target / songsPerSec)}s`);
    }
  }

  // The WAL checkpoint is DEFERRED (async, background) so it never blocks the
  // "migration done" time above — run + time it separately here to show its cost.
  const ckMs = await checkpointWalAsync(db);
  log(`background WAL checkpoint (TRUNCATE, deferred): ${Math.round(ckMs)}ms — runs AFTER completion, off the JS thread, does not block the user`);

  const coerced = getCoercedColumns();
  log(`coerced columns (type↔reality mismatches to fix at mapper): ${coerced.length ? coerced.join(', ') : 'none ✓'}`);

  // --- Count validation ---
  const nAlbums = await countAlbums(db);
  const nSongs = await countSongs(db);
  const nArtists = await countArtists(db);
  const nPlaylists = await countPlaylists(db);
  log(`normalized counts: albums=${nAlbums}, songs=${nSongs}, artists=${nArtists}, playlists=${nPlaylists}`);
  log(`  albums match source? ${nAlbums === srcAlbums ? 'YES ✓' : `NO ✗ (${nAlbums} vs ${srcAlbums})`}`);
  log(`  songs match (source - skipped)? ${nSongs === srcSongs - result.songs.skipped ? 'YES ✓' : `NO ✗ (${nSongs} vs ${srcSongs - result.songs.skipped})`}`);

  // --- Keyset read latency on the real, populated songs table ---
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

  log('Spike D done. Re-run to compare after a tuning change; PASS if counts match + reads fast + index seek.');
}

/** Spike E page size — sweep this to find the memory/throughput sweet spot. */
const SPIKE_E_PAGE = 1000;
/** Cap the spike to a bounded slice so it stays a quick, repeatable measurement. */
const SPIKE_E_MAX_PAGES = 25;

/**
 * Spike E — REMOTE library-sync timing (network → normalized). Instruments the
 * real remote-fetch path: `searchSongsPage` (the exact call the production song
 * sync uses) → `upsertSongs` (the normalized write), with a per-phase breakdown
 * (fetch+parse / derive / write) so we can SEE the bottleneck and tune the remote
 * case empirically. Cold (resets normalized first → fresh inserts), bounded, and
 * repeatable. Answers "what takes the most time" and the double-metaphone-load
 * question directly (derive = the norm + double-metaphone work).
 */
export async function runSpikeE(log: Log): Promise<void> {
  log('=== Spike E: REMOTE library-sync timing (network → normalized) ===');
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { getDb } = require('../../store/persistence/db') as typeof import('../../store/persistence/db');
  const { searchSongsPage } = require('../../services/subsonicService') as typeof import('../../services/subsonicService');
  const { upsertSongs, countSongs } = require('../repository/songs') as typeof import('../repository/songs');
  const { setChunkProfiler } = require('../repository/core') as typeof import('../repository/core');
  const { resetNormalizedSchema } = require('../createNormalizedTables') as typeof import('../createNormalizedTables');
  /* eslint-enable @typescript-eslint/no-var-requires */

  const db = getDb();
  if (!db) {
    log('DB unavailable — cannot run.');
    return;
  }

  log('resetting normalized schema (cold — measures fresh inserts)…');
  resetNormalizedSchema(db);

  let deriveMs = 0;
  let writeMs = 0;
  setChunkProfiler((t) => {
    deriveMs += t.deriveMs;
    writeMs += t.writeMs;
  });

  let fetchMs = 0;
  let totalSongs = 0;
  let pages = 0;
  let offset = 0;
  let missingAlbumId = 0;
  const t0 = now();
  try {
    for (let p = 0; p < SPIKE_E_MAX_PAGES; p++) {
      const f0 = now();
      // eslint-disable-next-line no-await-in-loop
      const page = await searchSongsPage(SPIKE_E_PAGE, offset);
      fetchMs += now() - f0;
      if (page.length === 0) break;
      missingAlbumId += page.filter((s) => !s.albumId).length;
      // eslint-disable-next-line no-await-in-loop
      await upsertSongs(db, page);
      totalSongs += page.length;
      offset += page.length;
      pages += 1;
      log(`  page ${pages}: +${page.length} songs (total ${totalSongs})`);
    }
  } catch (e) {
    log(`Spike E fetch/write error: ${String(e)}`);
  } finally {
    setChunkProfiler(null);
  }
  const totalMs = now() - t0;

  if (totalSongs === 0) {
    log('Spike E: 0 songs fetched — is the app logged in and the server reachable? (searchSongsPage returned empty)');
    return;
  }

  const per1k = (ms: number): string => `${Math.round((ms / totalSongs) * 1000)}ms/1k`;
  const accounted = fetchMs + deriveMs + writeMs;
  const otherMs = Math.max(0, totalMs - accounted);
  log(`fetched ${totalSongs} songs across ${pages} page(s) of ${SPIKE_E_PAGE} in ${Math.round(totalMs)}ms`);
  log('phase breakdown (where the time went):');
  log(`  fetch+parse (network):        ${Math.round(fetchMs)}ms (${pctOf(fetchMs, totalMs)}, ${per1k(fetchMs)})`);
  log(`  derive (rows + norm + dmeta): ${Math.round(deriveMs)}ms (${pctOf(deriveMs, totalMs)}, ${per1k(deriveMs)})`);
  log(`  write (executeBatch async):   ${Math.round(writeMs)}ms (${pctOf(writeMs, totalMs)}, ${per1k(writeMs)})`);
  log(`  other (yield/overhead):       ${Math.round(otherMs)}ms (${pctOf(otherMs, totalMs)})`);
  log(`  songs missing albumId: ${missingAlbumId} (fast-path safety check — >1% forces the basic walk)`);

  const songsPerSec = totalMs > 0 ? totalSongs / (totalMs / 1000) : 0;
  log(`throughput: ${Math.round(songsPerSec)} songs/sec (incl. network)`);
  if (songsPerSec > 0) {
    log(`  projected full remote sync @ 200k songs: ~${Math.round(200_000 / songsPerSec)}s; @ 1M: ~${Math.round(1_000_000 / songsPerSec)}s`);
  }
  log(`normalized songs now: ${await countSongs(db)}`);
  log(`Spike E done. Bottleneck = the biggest phase above. Sweep SPIKE_E_PAGE (now ${SPIKE_E_PAGE}) to tune batch size.`);
}

/**
 * Spike F — split the "derive" cost (the ~25-48% of every sync/migration that
 * Spikes D/E lump together) into its two parts, so we can decide the FTS5 tradeoff
 * with real numbers and NO native rebuild:
 *   - normalize / normalizeArtist  → the `norm_*` columns → REPLACEABLE by FTS5's
 *     unicode61+trigram tokenizer (accent-fold + substring, done in C at insert).
 *   - metaphoneKey (double-metaphone) → the `dmeta_*` columns → the phonetic tier
 *     FTS5 can't do → DROPPABLE (loses voice "corn"→"Korn" recall until re-added).
 * Times each over a real title/artist sample and reports the split + the redundant
 * re-normalize inside metaphoneKey.
 */
export async function runSpikeF(log: Log): Promise<void> {
  log('=== Spike F: search-derive cost split (normalize vs double-metaphone) ===');
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { getDb } = require('../../store/persistence/db') as typeof import('../../store/persistence/db');
  const { normalize, normalizeArtist, metaphoneKey, tokenize } =
    require('../../services/searchMatch') as typeof import('../../services/searchMatch');
  const { doubleMetaphone } = require('double-metaphone') as typeof import('double-metaphone');
  /* eslint-enable @typescript-eslint/no-var-requires */

  const db = getDb();
  if (!db) {
    log('DB unavailable — cannot run.');
    return;
  }

  const SAMPLE = 20000;
  const rows = await db.getAllAsync<{ title: string | null; artist: string | null }>(
    "SELECT json_extract(raw_json,'$.title') AS title, json_extract(raw_json,'$.artist') AS artist FROM song_index LIMIT ?",
    [SAMPLE],
  );
  const n = rows.length;
  if (n === 0) {
    log('no rows in song_index to sample — run a library sync first.');
    return;
  }
  log(`sampled ${n} songs from song_index`);

  let sink = 0; // consume results so nothing is optimized away
  const per1k = (ms: number): string => `${Math.round((ms / n) * 1000)}ms/1k`;
  const timeIt = (label: string, fn: (r: { title: string | null; artist: string | null }) => number): number => {
    const t0 = now();
    for (const r of rows) sink += fn(r);
    const ms = now() - t0;
    log(`  ${label}: ${Math.round(ms)}ms (${per1k(ms)})`);
    return ms;
  };

  const normTitleMs = timeIt('normalize(title)', (r) => normalize(r.title).length);
  const normArtistMs = timeIt('normalizeArtist(artist)', (r) => normalizeArtist(r.artist).length);
  const dmetaTitleMs = timeIt('metaphoneKey(title) [re-norm + dmeta]', (r) => metaphoneKey(r.title).length);
  const dmetaArtistMs = timeIt('metaphoneKey(artist) [re-norm + dmeta]', (r) => metaphoneKey(r.artist).length);

  // Pure phonetic cost: double-metaphone over already-normalized tokens (no re-normalize).
  const preTok = rows.map((r) => tokenize(r.title));
  const dmPure0 = now();
  for (const toks of preTok) for (const t of toks) sink += doubleMetaphone(t)[0].length;
  const dmPureMs = now() - dmPure0;
  log(`  double-metaphone ONLY (pre-normalized title tokens): ${Math.round(dmPureMs)}ms (${per1k(dmPureMs)})`);

  const normWork = normTitleMs + normArtistMs;
  const dmetaWork = dmetaTitleMs + dmetaArtistMs;
  const total = normWork + dmetaWork;
  log('splits (of per-row search-derive work):');
  log(`  normalize (FTS5-replaceable): ${Math.round(normWork)}ms (${pctOf(normWork, total)})`);
  log(`  metaphoneKey (droppable):     ${Math.round(dmetaWork)}ms (${pctOf(dmetaWork, total)})`);
  log(`⇒ dropping double-metaphone removes ~${pctOf(dmetaWork, total)} of search-derive.`);
  log(`⇒ FTS5 (unicode61+trigram) replaces the norm work at insert time (native C), removing the rest.`);
  const redundant = Math.max(0, dmetaWork - dmPureMs);
  log(`note: pure double-metaphone is only ${Math.round(dmPureMs)}ms — ~${pctOf(redundant, dmetaWork)} of metaphoneKey is a REDUNDANT re-normalize (cheap win: derive dmeta from the already-normalized tokens).`);
  if (sink < 0) log(''); // keep sink live
  log('Spike F done.');
}

/** Row scales to measure infix latency at. Seeds incrementally up to the last. */
const SPIKE_G_SCALES = [50_000, 200_000, 500_000, 1_000_000];
/** Word pool for synthetic norm_title/norm_artist (music-ish, deterministic). */
const SPIKE_G_WORDS = [
  'love', 'night', 'dream', 'heart', 'fire', 'blue', 'sky', 'road', 'home', 'time',
  'light', 'dark', 'rain', 'sun', 'moon', 'star', 'sea', 'wind', 'gold', 'soul',
  'life', 'world', 'song', 'dance', 'free', 'lost', 'wild', 'high', 'slow', 'cold',
  'warm', 'deep', 'long', 'black', 'white', 'red', 'green', 'river', 'city', 'story',
  'ghost', 'angel', 'devil', 'king', 'queen', 'child', 'stone', 'glass', 'iron', 'shadow',
];

/**
 * Spike G — prove (or disprove) the infix-at-scale theory that motivates FTS5.
 * Our infix search tier is `norm_* LIKE '%x%'`, which cannot use an index and
 * scans the whole table. This seeds a lean synthetic table up to 1M rows and
 * measures infix latency at each scale — worst case is a RARE term (0 matches),
 * which forces a full scan (a common term short-circuits at LIMIT) — against
 * index-backed prefix (`LIKE 'x%'`) as the baseline, with EXPLAIN to show what
 * scans vs seeks. If infix stays interactive at 1M, the custom search is fine;
 * if it balloons, a trigram column / FTS5 is justified. Throwaway DB, no rebuild.
 */
export async function runSpikeG(log: Log): Promise<void> {
  log('=== Spike G: infix LIKE %x% latency vs scale (the FTS5 infix question) ===');
  const OP = loadOpSqlite(log);
  if (!OP) return;
  const dir = dbDir(log);

  let db: SpikeDb | null = null;
  try {
    db = OP.open({ name: 'spikeG.db', location: dir });
  } catch (e) {
    log(`Spike G FAIL: open threw: ${String(e)}`);
    return;
  }

  // Inline write mutex, local to the spike: one batch in flight at a time.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const P = SPIKE_G_WORDS.length;
  const w = (i: number): string => SPIKE_G_WORDS[((i % P) + P) % P];
  const titleFor = (i: number): string => `${w(i)} ${w(i * 7 + 1)} ${w(i * 13 + 2)}`;
  const artistFor = (i: number): string => `${w(i * 3 + 1)} ${w(i * 17 + 3)}`;
  const commonTerm = SPIKE_G_WORDS[0]; // appears in many rows → early LIMIT short-circuit
  const rareTerm = 'zzqx'; // appears in none → worst-case full scan

  const infixSql = 'SELECT id FROM g WHERE norm_title LIKE ? OR norm_artist LIKE ? LIMIT 60';
  const prefixSql = 'SELECT id FROM g WHERE norm_title LIKE ? ORDER BY norm_title LIMIT 60';
  const measure = async (sql: string, params: unknown[], runs = 8): Promise<number> => {
    const lat: number[] = [];
    for (let k = 0; k < runs; k++) {
      const t0 = now();
      // eslint-disable-next-line no-await-in-loop
      await db!.execute(sql, params);
      lat.push(now() - t0);
    }
    return percentile(lat, 50);
  };

  try {
    db.executeSync('PRAGMA journal_mode = WAL');
    db.executeSync('PRAGMA synchronous = NORMAL');
    db.executeSync('PRAGMA temp_store = MEMORY');
    db.executeSync('PRAGMA cache_size = -32000');
    db.executeSync('DROP TABLE IF EXISTS g');
    db.executeSync('CREATE TABLE g (id TEXT PRIMARY KEY, norm_title TEXT, norm_artist TEXT)');
    db.executeSync('CREATE INDEX idx_g_title ON g (norm_title)'); // serves prefix, NOT infix

    const BATCH = 2000;
    let seeded = 0;
    for (const scale of SPIKE_G_SCALES) {
      const s0 = now();
      while (seeded < scale) {
        const to = Math.min(seeded + BATCH, scale);
        const cmds: Array<[string, unknown[]]> = [];
        for (let i = seeded; i < to; i++) cmds.push(['INSERT INTO g VALUES (?, ?, ?)', [`g${i}`, titleFor(i), artistFor(i)]]);
        // eslint-disable-next-line no-await-in-loop
        await serialize(() => db!.executeBatch(cmds));
        seeded = to;
      }
      log(`seeded to ${kLabel(scale)} rows in ${since(s0)}`);

      // eslint-disable-next-line no-await-in-loop
      const prefixP50 = await measure(prefixSql, [`${commonTerm}%`]);
      // eslint-disable-next-line no-await-in-loop
      const infixCommon = await measure(infixSql, [`%${commonTerm}%`, `%${commonTerm}%`]);
      // eslint-disable-next-line no-await-in-loop
      const infixRare = await measure(infixSql, [`%${rareTerm}%`, `%${rareTerm}%`]);
      log(
        `@ ${kLabel(scale)}: prefix(idx)=${prefixP50}ms | infix common(early-stop)=${infixCommon}ms | ` +
          `infix RARE(full scan)=${infixRare}ms`,
      );
    }

    // Prove what scans vs seeks.
    const plan = (sql: string, params: unknown[]): string =>
      db!.executeSync(`EXPLAIN QUERY PLAN ${sql}`, params).rows.map((r) => String(r.detail)).join(' | ');
    log(`EXPLAIN infix:  ${plan(infixSql, ['%x%', '%x%'])}`);
    log(`EXPLAIN prefix: ${plan(prefixSql, ['x%'])}`);
    log('Spike G done. If infix RARE(full scan) stays interactive (~<100ms) at 1M → custom search is fine; if it balloons → a trigram column / FTS5 is justified.');
  } catch (e) {
    log(`Spike G FAIL: ${String(e)}`);
  } finally {
    try {
      db?.executeSync('DROP TABLE IF EXISTS g');
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Spike H — empty the normalized tables so the next app RELOAD re-runs the BOOT
 * migration (its drift check will see blobs > normalized and re-populate them with
 * progress on the library-sync card + banner). Use this to watch the real
 * background migration on a device whose tables were already filled by Spike D.
 */
export async function runSpikeH(log: Log): Promise<void> {
  log('=== Spike H: reset normalized tables (for a boot-migration test) ===');
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { getDb } = require('../../store/persistence/db') as typeof import('../../store/persistence/db');
  const { resetNormalizedSchema } = require('../createNormalizedTables') as typeof import('../createNormalizedTables');
  /* eslint-enable @typescript-eslint/no-var-requires */
  const db = getDb();
  if (!db) {
    log('DB unavailable — cannot run.');
    return;
  }
  resetNormalizedSchema(db);
  log('normalized tables dropped + recreated EMPTY.');
  log('→ Reload the app. The background boot migration will detect the drift and');
  log('  re-populate them, showing "Upgrading library…" on the banner + a progress');
  log('  bar + % on Settings → Library data.');
}

/* ------------------------------------------------------------------ */
/*  Full remote library sync — FAST (search3) vs SLOW (basic walk)     */
/* ------------------------------------------------------------------ */

async function runFullSyncSpike(log: Log, strategy: 'search3' | 'basic'): Promise<void> {
  const label = strategy === 'search3' ? 'FAST (search3)' : 'SLOW (basic per-album walk)';
  log(`=== Full remote library sync — ${label} ===`);
  const { getDb } = require('../../store/persistence/db') as typeof import('../../store/persistence/db');
  const db = getDb();
  if (!db) {
    log('DB unavailable — abort.');
    return;
  }
  const { runNormalizedLibrarySync } =
    require('../../services/normalizedLibrarySync') as typeof import('../../services/normalizedLibrarySync');
  const { countAlbums } = require('../repository/albums') as typeof import('../repository/albums');
  const { countSongs } = require('../repository/songs') as typeof import('../repository/songs');
  const { countArtists } = require('../repository/artists') as typeof import('../repository/artists');
  const { countPlaylists } = require('../repository/playlists') as typeof import('../repository/playlists');

  log(`forcing transport=${strategy}; full reset + timed run (drops + repopulates the`);
  log('normalized tables — the running app repopulates from this)...');
  // The sync does not drop the tables (that would destroy detail it cannot rebuild), so
  // the spike drops here instead — timing an idempotent re-upsert into a populated table
  // measures a different workload than the cold insert this spike exists to compare.
  const { resetNormalizedSchema } = require('../createNormalizedTables') as typeof import('../createNormalizedTables');
  resetNormalizedSchema(db);
  const t0 = now();
  await runNormalizedLibrarySync({ full: true, forceStrategy: strategy });
  const elapsed = since(t0);

  const [a, s, ar, pl] = await Promise.all([
    countAlbums(db),
    countSongs(db),
    countArtists(db),
    countPlaylists(db),
  ]);
  log(`DONE in ${elapsed}`);
  log(`  albums=${a} songs=${s} artists=${ar} playlists=${pl}`);
  log('→ Run the other path to compare timings (your server supports both).');
}

/** Spike I — full remote library sync via the FAST search3 transport, timed. */
export async function runSpikeI(log: Log): Promise<void> {
  await runFullSyncSpike(log, 'search3');
}

/** Spike J — full remote library sync via the SLOW basic per-album walk, timed. */
export async function runSpikeJ(log: Log): Promise<void> {
  await runFullSyncSpike(log, 'basic');
}

/* ------------------------------------------------------------------ */
/*  Spike K — the savepoint window (atomic-writes Phase 3, C1)         */
/* ------------------------------------------------------------------ */

/**
 * Spike K — prove a failed atomic batch cannot swallow another writer's work.
 *
 * DEVICE-ONLY: Jest's seam runs `executeBatch` synchronously, so it has no pool, no FIFO
 * queue and no window to reproduce. An aborted batch never reaches its RELEASE and leaves
 * the savepoint OPEN, so anything the pool drains before the recovery lands commits inside
 * it and is then discarded by the ROLLBACK — see `runAtomicBatchAsync` in `db/client.ts`.
 *
 * Deterministic, not racy: the independent write is issued synchronously while the batch
 * is still in flight, so the pool order is fixed.
 *
 * Runs the SHIPPED `runAtomicBatchAsync` against the REAL app connection — that is the
 * point — in two throwaway `spike_k_*` tables dropped again at the end. App data is never
 * touched.
 */
export async function runSpikeK(log: Log): Promise<void> {
  log('=== Spike K: a failed batch must not swallow a concurrent write ===');
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { getDb } = require('../../store/persistence/db') as typeof import('../../store/persistence/db');
  const { awaitDbWritesIdle } = require('../client') as typeof import('../client');
  /* eslint-enable @typescript-eslint/no-var-requires */
  const db = getDb();
  if (!db) {
    log('DB unavailable — cannot run.');
    return;
  }

  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean, detail: string): void => {
    if (ok) {
      passed += 1;
      log(`  PASS  ${name}`);
    } else {
      failed += 1;
      log(`  FAIL  ${name} — ${detail}`);
    }
  };

  const cleanup = (): void => {
    db.execSync('DROP TABLE IF EXISTS spike_k_batch');
    db.execSync('DROP TABLE IF EXISTS spike_k_victim');
  };

  try {
    cleanup();
    db.execSync('CREATE TABLE spike_k_batch (id TEXT PRIMARY KEY)');
    db.execSync('CREATE TABLE spike_k_victim (id TEXT PRIMARY KEY)');

    // A batch big enough to still be executing when the independent write is queued
    // behind it, ending in a PRIMARY KEY violation — the same shape as the duplicate
    // `discTitles` a real server sends.
    const commands: Array<readonly [string, readonly (string | number | null)[]]> = [];
    for (let i = 0; i < 2000; i += 1) {
      commands.push(['INSERT INTO spike_k_batch (id) VALUES (?)', [`row-${i}`]]);
    }
    commands.push(['INSERT INTO spike_k_batch (id) VALUES (?)', ['row-0']]); // boom

    const t0 = now();
    const batch = db.runAtomicBatchAsync(commands);
    // SYNCHRONOUSLY, with the batch still on the pool — this is the writer a stranded
    // savepoint would capture. No await may appear between these two lines.
    const independent = db.runAsync('INSERT INTO spike_k_victim (id) VALUES (?)', ['survivor']);

    let batchRejected = false;
    try {
      await batch;
    } catch {
      batchRejected = true;
    }
    let independentRejected = false;
    try {
      await independent;
    } catch {
      independentRejected = true;
    }
    log(`batch settled in ${since(t0)} (2001 statements, last one a PK violation)`);

    check('the failing batch rejects', batchRejected, 'it resolved — the batch did not fail');
    check(
      'the concurrent write SURVIVES the rollback',
      (db.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM spike_k_victim')?.n ?? 0) === 1,
      'the row is gone — it committed inside the stranded savepoint and the ROLLBACK ' +
        'discarded it. THIS IS THE BUG.',
    );
    check(
      'the concurrent write did not report an error',
      !independentRejected,
      'it rejected',
    );
    check(
      "the batch's own partial work is rolled back",
      (db.getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM spike_k_batch')?.n ?? -1) === 0,
      'rows survived — the batch was not atomic',
    );

    // A stranded savepoint makes the next JS-thread BEGIN "cannot start a transaction
    // within a transaction" — the failure that takes logout's schema reset down.
    let beginOk = true;
    try {
      db.withTransactionSync(() => {
        db.runSync('INSERT INTO spike_k_victim (id) VALUES (?)', ['after-begin']);
      });
    } catch (e) {
      beginOk = false;
      log(`  (BEGIN threw: ${String(e)})`);
    }
    check('a JS-thread BEGIN still works afterwards', beginOk, 'nested-BEGIN error');

    // A failed write must settle the in-flight counter, or logout waits forever.
    const idle = await Promise.race([
      awaitDbWritesIdle().then(() => 'idle'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
    ]);
    check(
      'awaitDbWritesIdle resolves after a failed write',
      idle === 'idle',
      'timed out — logout would hang here',
    );

    log(failed === 0 ? `ALL ${passed} CHECKS PASSED` : `${failed} FAILED, ${passed} passed`);
  } catch (e) {
    log(`spike aborted: ${String(e)}`);
  } finally {
    cleanup();
    log('spike_k_* tables dropped.');
  }
}
