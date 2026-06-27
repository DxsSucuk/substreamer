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
import * as SQLite from 'expo-sqlite';

/**
 * `RunResult` mirrors `SQLiteRunResult` from expo-sqlite. Existing callers
 * ignore the return value (their TypeScript signature was historically
 * `void`); widening it lets callers that want row-modification counts read
 * them without changing existing call sites.
 */
interface RunResult {
  changes: number;
  lastInsertRowId: number;
}

export interface InternalDb {
  getFirstSync<T>(sql: string, params?: readonly unknown[]): T | undefined;
  getAllSync<T>(sql: string, params?: readonly unknown[]): T[];
  /**
   * Async row read. expo-sqlite runs this on a background native thread, so
   * the SQLite IO does not block the JS thread (unlike `getAllSync`). Used by
   * the songs-library pre-warm / cold fetch — see `fetchAllSongsByTitleAsync`.
   */
  getAllAsync<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * Async single-row read. Like `getAllAsync`, runs on a background native
   * thread so the SQLite IO does not block the JS thread (unlike
   * `getFirstSync`). Used for aggregate recalcs on interactive/hot paths.
   */
  getFirstAsync<T>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  runSync(sql: string, params?: readonly unknown[]): RunResult;
  /**
   * Async write. Like `getAllAsync`/`getFirstAsync`, expo-sqlite runs this on
   * a background native thread so the write IO does not block the JS thread
   * (unlike `runSync`). Used by the async `kvStorage` adapter.
   */
  runAsync(sql: string, params?: readonly unknown[]): Promise<RunResult>;
  execSync(sql: string): void;
  withTransactionSync(fn: () => void): void;
  /**
   * Async transaction. The callback's `runAsync` calls execute on expo-sqlite's
   * background thread within one transaction, so a multi-statement write
   * (e.g. DELETE + N INSERTs) is atomic without blocking the JS thread (unlike
   * `withTransactionSync`).
   */
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

const DB_NAME = 'substreamer7.db';

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
  db = SQLite.openDatabaseSync(DB_NAME) as unknown as InternalDb;
  // PRAGMAs are per-connection. We set them once here on the shared handle;
  // because expo-sqlite pools connections by filename, every consumer that
  // calls `openDatabaseSync(DB_NAME)` (not that anyone should after this
  // refactor) gets a handle backed by the same native connection and sees
  // these settings.
  db.execSync('PRAGMA journal_mode = WAL;');
  // NORMAL matches the long-standing setting for this database; it has
  // persisted reliably for years. FULL was briefly tried during the
  // migration-14 bug hunt — the real cause was unrelated (INSERT OR REPLACE
  // cascade + hydration race), so we reverted.
  db.execSync('PRAGMA synchronous = NORMAL;');
  db.execSync('PRAGMA foreign_keys = ON;');

  // ---- Schema ----
  // Created in FK-safe order: parents before children. Every CREATE is
  // `IF NOT EXISTS` so a second launch against an existing DB is a no-op.

  // storage (KV blob) — no FK, no dependencies.
  db.execSync(
    'CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);',
  );

  // album_details + song_index — detail cache for albums/songs.
  db.execSync(
    `CREATE TABLE IF NOT EXISTS album_details (
       id TEXT PRIMARY KEY NOT NULL,
       json TEXT NOT NULL,
       retrievedAt INTEGER NOT NULL
     );`,
  );
  db.execSync(
    `CREATE TABLE IF NOT EXISTS song_index (
       id TEXT PRIMARY KEY NOT NULL,
       albumId TEXT NOT NULL,
       title TEXT,
       artist TEXT,
       album TEXT,
       duration INTEGER,
       coverArt TEXT,
       userRating INTEGER,
       starred INTEGER,
       year INTEGER,
       track INTEGER,
       disc INTEGER,
       raw_json TEXT
     );`,
  );
  // Forward-compat: add columns to pre-existing installs. SQLite's ADD COLUMN
  // is non-destructive and idempotent via the try/catch.
  try {
    db.execSync('ALTER TABLE song_index ADD COLUMN album TEXT;');
  } catch {
    /* column already exists */
  }
  // `raw_json` preserves the full Subsonic `Child` envelope so the Songs list
  // returns the real song object (artistId, genre, format, ReplayGain, …)
  // instead of a reconstruction from the indexed columns. The other columns
  // exist only for sort/filter (title, starred) and as a legacy fallback for
  // rows written before this column. Backfilled by a migration; written by
  // every upsert going forward.
  try {
    db.execSync('ALTER TABLE song_index ADD COLUMN raw_json TEXT;');
  } catch {
    /* column already exists */
  }
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_song_index_albumId ON song_index (albumId);',
  );
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_song_index_title ON song_index (lower(title));',
  );

  // scrobble_events — completed scrobbles.
  db.execSync(
    `CREATE TABLE IF NOT EXISTS scrobble_events (
       id TEXT PRIMARY KEY NOT NULL,
       song_json TEXT NOT NULL,
       time INTEGER NOT NULL
     );`,
  );
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_scrobble_events_time ON scrobble_events (time);',
  );

  // pending_scrobble_events — the offline transmit queue. Same row shape
  // as scrobble_events but a separate table so a completed row and its
  // still-pending sibling (legitimately sharing `id`) don't collide.
  db.execSync(
    `CREATE TABLE IF NOT EXISTS pending_scrobble_events (
       id TEXT PRIMARY KEY NOT NULL,
       song_json TEXT NOT NULL,
       time INTEGER NOT NULL
     );`,
  );
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_pending_scrobble_events_time ON pending_scrobble_events (time);',
  );

  // Music-cache tables — FK graph: cached_item_songs.item_id → cached_items
  // (ON DELETE CASCADE), cached_item_songs.song_id → cached_songs.
  // `raw_json` preserves the full Subsonic `Child` envelope alongside the
  // indexed/hot columns. Columns above are for sort/filter/display fast paths;
  // `raw_json` is the source of truth for any field a future feature might
  // need (discNumber, track, genre, MusicBrainz id, ReplayGain, contributors,
  // …). Never drop fields from the envelope on write — see CLAUDE.md /
  // plan `new-issue-to-look-distributed-quiche.md`. Nullable initially to
  // keep Migration 17 a pure schema change; Migration 18 backfills.
  db.execSync(
    `CREATE TABLE IF NOT EXISTS cached_songs (
       song_id TEXT PRIMARY KEY NOT NULL,
       title TEXT NOT NULL,
       artist TEXT,
       album TEXT,
       album_id TEXT NOT NULL,
       cover_art TEXT,
       bytes INTEGER NOT NULL,
       duration INTEGER NOT NULL,
       suffix TEXT NOT NULL,
       bit_rate INTEGER,
       bit_depth INTEGER,
       sampling_rate INTEGER,
       format_captured_at INTEGER NOT NULL,
       downloaded_at INTEGER NOT NULL,
       raw_json TEXT
     );`,
  );
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_cached_songs_album_id ON cached_songs(album_id);',
  );
  // `raw_json` preserves the full Subsonic `AlbumID3` / `Playlist` envelope
  // for album and playlist items. Nullable: `favorites` and `song`-intent
  // rows have no natural envelope (favorites is an app-local virtual
  // playlist; `song` intent refers to a Child already stored in
  // `cached_songs.raw_json`).
  db.execSync(
    `CREATE TABLE IF NOT EXISTS cached_items (
       item_id TEXT PRIMARY KEY NOT NULL,
       type TEXT NOT NULL,
       name TEXT NOT NULL,
       artist TEXT,
       cover_art_id TEXT,
       expected_song_count INTEGER NOT NULL,
       parent_album_id TEXT,
       last_sync_at INTEGER NOT NULL,
       downloaded_at INTEGER NOT NULL,
       raw_json TEXT
     );`,
  );
  db.execSync(
    `CREATE TABLE IF NOT EXISTS cached_item_songs (
       item_id TEXT NOT NULL,
       position INTEGER NOT NULL,
       song_id TEXT NOT NULL,
       PRIMARY KEY (item_id, position),
       FOREIGN KEY (item_id) REFERENCES cached_items(item_id) ON DELETE CASCADE,
       FOREIGN KEY (song_id) REFERENCES cached_songs(song_id)
     );`,
  );
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_cached_item_songs_song_id ON cached_item_songs(song_id);',
  );
  // Dedup any rows with the same (item_id, song_id) before adding a UNIQUE
  // index. The PK `(item_id, position)` prevents duplicate inserts at the
  // same position but does not prevent the same song being edged twice at
  // different positions — which could theoretically happen under a
  // concurrent `ensurePartialAlbumEdge` + queue-completion race. Heal
  // in-flight by keeping the lowest-position edge per `(item_id, song_id)`.
  db.execSync(
    `DELETE FROM cached_item_songs
       WHERE rowid NOT IN (
         SELECT MIN(rowid) FROM cached_item_songs
         GROUP BY item_id, song_id
       );`,
  );
  db.execSync(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_cached_item_songs_item_song ON cached_item_songs(item_id, song_id);',
  );
  db.execSync(
    `CREATE TABLE IF NOT EXISTS download_queue (
       queue_id TEXT PRIMARY KEY NOT NULL,
       item_id TEXT NOT NULL,
       type TEXT NOT NULL,
       name TEXT NOT NULL,
       artist TEXT,
       cover_art_id TEXT,
       status TEXT NOT NULL,
       total_songs INTEGER NOT NULL,
       completed_songs INTEGER NOT NULL,
       error TEXT,
       added_at INTEGER NOT NULL,
       queue_position INTEGER NOT NULL,
       songs_json TEXT NOT NULL
     );`,
  );
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_download_queue_status ON download_queue(status);',
  );
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_download_queue_position ON download_queue(queue_position);',
  );

  // cached_images — per-variant record of on-disk cover-art files. No FKs
  // (cover_art_ids come from server and aren't owned by any local table).
  // Composite PK on (cover_art_id, size) means at most one row per variant.
  db.execSync(
    `CREATE TABLE IF NOT EXISTS cached_images (
       cover_art_id TEXT NOT NULL,
       size INTEGER NOT NULL,
       ext TEXT NOT NULL,
       bytes INTEGER NOT NULL,
       cached_at INTEGER NOT NULL,
       PRIMARY KEY (cover_art_id, size)
     );`,
  );
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_cached_images_cached_at ON cached_images (cached_at);',
  );
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_cached_images_cover_art_id ON cached_images (cover_art_id);',
  );

  // image_download_queue — persistent queue for user-initiated cover-art
  // refresh cycles. Each row is one cover_art_id awaiting (or in-progress on,
  // or errored after) a re-download. `PRIMARY KEY (cover_art_id)` dedups
  // duplicate enqueues via INSERT OR IGNORE. Mirrors the shape of
  // download_queue for the music queue — same status enum vocabulary
  // (queued | downloading | error), same retry-once-inline + reset-on-restart
  // policy. See plans/2026-05-23-image-cache-queue-rework.md.
  db.execSync(
    `CREATE TABLE IF NOT EXISTS image_download_queue (
       cover_art_id TEXT PRIMARY KEY NOT NULL,
       scope TEXT NOT NULL,
       status TEXT NOT NULL,
       error TEXT,
       attempts INTEGER NOT NULL DEFAULT 0,
       added_at INTEGER NOT NULL,
       cycle_id TEXT NOT NULL
     );`,
  );
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_image_download_queue_status ON image_download_queue (status, added_at);',
  );
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_image_download_queue_cycle ON image_download_queue (cycle_id);',
  );
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
