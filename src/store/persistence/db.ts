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
export type { InternalDb, RunResult } from '@/db/client';

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
  // Full sort-key index for the Songs library list. The list orders by
  // `(title IS NULL), lower(title), id` (NULL titles last, then case-insensitive
  // title, then a stable id tiebreak) — a leading `(title IS NULL)` term the old
  // single-column `idx_song_index_title` could NOT serve, so every render did a
  // full ~38k-row SCAN + TEMP B-TREE sort (confirmed via EXPLAIN QUERY PLAN).
  // This composite matches the ORDER BY exactly → ordered index scan, no sort;
  // it also serves the downloaded-only JOIN's ordering.
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_song_index_sort ON song_index((title IS NULL), lower(title), id);',
  );
  // Retire the superseded single-column index on existing installs: it never
  // served the list sort (leading `(title IS NULL)` term) and no query filters
  // on `lower(title)`, so it was pure write-cost dead weight.
  db.execSync('DROP INDEX IF EXISTS idx_song_index_title;');
  // Partial index for the Favorites filter (`WHERE starred = 1`): indexes only
  // starred rows, pre-sorted to the list ORDER BY, so the Favorites view reads
  // just those rows with no scan and no sort.
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_song_index_starred ON song_index((title IS NULL), lower(title), id) WHERE starred = 1;',
  );
  // Fuzzy-search columns (populated by the upsert fns + a backfill migration).
  // Nullable — a headless-first boot before backfill degrades to exact/prefix on
  // raw columns. `norm_*` = normalized (accent-folded, punctuation-stripped) text
  // for exact/prefix/infix; `dmeta_*` = per-token Double-Metaphone for phonetic
  // recall (empty codes excluded so non-Latin titles never collide). See searchMatch.ts.
  for (const col of ['norm_title', 'norm_artist', 'dmeta_title', 'dmeta_artist']) {
    try {
      db.execSync(`ALTER TABLE song_index ADD COLUMN ${col} TEXT;`);
    } catch {
      /* column already exists */
    }
  }
  db.execSync('CREATE INDEX IF NOT EXISTS idx_song_index_norm_title ON song_index (norm_title);');
  db.execSync('CREATE INDEX IF NOT EXISTS idx_song_index_dmeta_title ON song_index (dmeta_title);');
  db.execSync('CREATE INDEX IF NOT EXISTS idx_song_index_dmeta_artist ON song_index (dmeta_artist);');

  // library_albums — the lean album-browse LIST (all albums, song-less
  // `AlbumID3`). Replaces the old `substreamer-album-library` KV blob: written
  // progressively one page at a time by the paginated album-list sync so a
  // very large library persists as it arrives (no monolithic blob that fails
  // at ~100k) and resumes across restarts. `raw_json` is the full `AlbumID3`
  // envelope (repo convention — never drop fields); the other columns are hot
  // paths only: `sortKey` for ordered hydration (`ORDER BY sortKey`), and
  // `starred`/`userRating` so ratings reconcile without parsing every blob.
  // No FK. Headless-safe: this CREATE runs on every getDb(), so the table
  // exists even on a headless-first boot (migrations don't run headless).
  db.execSync(
    `CREATE TABLE IF NOT EXISTS library_albums (
       id TEXT PRIMARY KEY NOT NULL,
       sortKey TEXT NOT NULL,
       starred INTEGER,
       userRating INTEGER,
       created INTEGER,
       raw_json TEXT NOT NULL
     );`,
  );
  db.execSync(
    'CREATE INDEX IF NOT EXISTS idx_library_albums_sortKey ON library_albums (sortKey, id);',
  );
  // Fuzzy-search columns for album/artist matching (see song_index above).
  for (const col of ['norm_name', 'norm_artist', 'dmeta_name', 'dmeta_artist']) {
    try {
      db.execSync(`ALTER TABLE library_albums ADD COLUMN ${col} TEXT;`);
    } catch {
      /* column already exists */
    }
  }
  db.execSync('CREATE INDEX IF NOT EXISTS idx_library_albums_norm_name ON library_albums (norm_name);');
  db.execSync('CREATE INDEX IF NOT EXISTS idx_library_albums_dmeta_name ON library_albums (dmeta_name);');
  db.execSync('CREATE INDEX IF NOT EXISTS idx_library_albums_dmeta_artist ON library_albums (dmeta_artist);');

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
       raw_json TEXT,
       derived INTEGER DEFAULT 0
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
 * transactions collide (e.g. the library-album page write vs the song_index
 * write during a sync). ALL async transactions must funnel through this single
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
