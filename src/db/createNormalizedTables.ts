/**
 * Creates + evolves the normalized tables/indexes, idempotently and
 * NON-DESTRUCTIVELY. Runs at boot (from db.ts) alongside the legacy blob tables and
 * is headless-safe.
 *
 * Schema evolution (a new column/index added to src/db/schema.ts) is handled by
 * reconciling columns with `ALTER TABLE ADD COLUMN`, which PRESERVES every row —
 * NEVER by dropping tables. A new index is created only after its columns exist, so
 * `CREATE INDEX ... (sort_artist, …)` can't fail with `no such column` against a
 * table that predates the column. All normalized columns are nullable, so ADD COLUMN
 * is always legal. (A column added to an already-populated table is NULL until the
 * next sync rewrites the row — acceptable; we never wipe synced data to add a column.)
 *
 * The DDL is generated from src/db/schema.ts (drizzle-kit) so it cannot drift —
 * see src/db/normalizedDdl.ts + scripts/build-normalized-ddl.js.
 */
import type { InternalDb } from './client';
import { NORMALIZED_DDL } from './normalizedDdl';

const isCreateTable = (s: string): boolean => /^\s*CREATE TABLE/i.test(s);
const isCreateIndex = (s: string): boolean => /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(s);

interface ParsedColumn {
  name: string;
  type: string;
  /** The literal from `DEFAULT <literal>`, if the column declares one. */
  defaultSql?: string;
  notNull: boolean;
}

/** Table name + its parsed columns, from a CREATE TABLE statement. Constraint lines
 *  (FOREIGN KEY / PRIMARY KEY(...)) don't start with a backtick-quoted identifier
 *  followed by a type, so they're skipped. Drizzle emits constraints in the order
 *  `DEFAULT <lit> NOT NULL`, which is why the tail is parsed rather than pattern-matched
 *  as a fixed sequence. */
function parseTableColumns(stmt: string): { table: string; columns: ParsedColumn[] } | null {
  const nameM = stmt.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`([^`]+)`/i);
  if (!nameM) return null;
  const open = stmt.indexOf('(');
  const close = stmt.lastIndexOf(')');
  const body = open >= 0 && close > open ? stmt.slice(open + 1, close) : '';
  const columns: ParsedColumn[] = [];
  for (const rawLine of body.split('\n')) {
    const m = rawLine.trim().match(/^`([^`]+)`\s+(text|integer|real|blob|numeric)\b(.*)$/i);
    if (!m) continue;
    const tail = m[3];
    const defM = tail.match(/\bDEFAULT\s+('[^']*'|-?\d+(?:\.\d+)?|NULL|TRUE|FALSE)/i);
    columns.push({
      name: m[1],
      type: m[2],
      defaultSql: defM?.[1],
      notNull: /\bNOT\s+NULL\b/i.test(tail),
    });
  }
  return { table: nameM[1], columns };
}

const existingColumns = (db: InternalDb, table: string): Set<string> =>
  new Set(
    db.getAllSync<{ name: string }>(`PRAGMA table_info("${table}")`).map((r) => r.name),
  );

/**
 * Ensure the normalized schema exists and matches src/db/schema.ts, preserving data.
 * One transaction so it's all-or-nothing. FK targets are resolved at write time, not
 * CREATE time, so statement order within the DDL is irrelevant.
 */
export function ensureNormalizedSchema(db: InternalDb): void {
  db.withTransactionSync(() => {
    // 1. Create any missing tables (fresh install → full schema; existing → no-op).
    for (const stmt of NORMALIZED_DDL) {
      if (isCreateTable(stmt)) db.execSync(stmt);
    }
    // 2. Add any column schema.ts declares that a pre-existing table lacks — the
    //    non-destructive path that lets a new column land on populated tables.
    for (const stmt of NORMALIZED_DDL) {
      if (!isCreateTable(stmt)) continue;
      const parsed = parseTableColumns(stmt);
      if (!parsed) continue;
      const have = existingColumns(db, parsed.table);
      for (const col of parsed.columns) {
        if (have.has(col.name)) continue;
        let ddl = `ALTER TABLE "${parsed.table}" ADD COLUMN "${col.name}" ${col.type}`;
        if (col.defaultSql != null) {
          ddl += ` DEFAULT ${col.defaultSql}`;
          // NOT NULL is only legal on ADD COLUMN when a DEFAULT supplies a value for the
          // existing rows; without one SQLite rejects it outright on a non-empty table.
          if (col.notNull) ddl += ' NOT NULL';
        }
        db.execSync(ddl);
      }
    }
    // 3. Indexes last — every referenced column now exists.
    for (const stmt of NORMALIZED_DDL) {
      if (isCreateIndex(stmt)) db.execSync(stmt);
    }
  });
}

/**
 * The normalized LIBRARY model — the only tables logout (or a full resync) may drop.
 *
 * An explicit allowlist, not "everything in the DDL minus the kept ones": schema.ts also
 * defines the permanent tables (auth/settings KV, downloads, scrobble history, image
 * cache), and a subtract-based rule fails OPEN — forget to classify a new table and it
 * silently joins the drop list. Here an unclassified table is simply never dropped.
 */
export const MODEL_TABLES: readonly string[] = [
  'albums',
  'album_info',
  'songs',
  'artists',
  'playlists',
  'album_artists',
  'album_disc_titles',
  'album_genres',
  'album_moods',
  'album_record_labels',
  'album_release_types',
  'artist_roles',
  'artist_info',
  'artist_bio',
  'artist_similar',
  'artist_top_songs',
  'artist_top_songs_state',
  'playlist_allowed_users',
  'playlist_songs',
  'song_album_artists',
  'song_artists',
  'song_contributors',
  'song_genres',
  'song_moods',
  // Lyrics are server-derived metadata keyed by a server-scoped song id, so logout must
  // drop them — otherwise a colliding id on the next server shows the wrong song's words.
  'lyrics',
  'lyric_lines',
  // The home-screen album lists: ordered ids over `albums`, server-scoped for the same
  // reason favourites are. It FK-cascades from `albums` anyway, but must still be listed
  // — the allowlist fails CLOSED, so an unclassified table is never dropped.
  'album_list_entries',
  // The live player queue AND the saved bookmarks — one table pair, so one answer for
  // both. MODEL, because every snapshot row holds server-scoped song ids: a bookmark
  // surviving into another account plays server A's ids against server B. It also
  // matches what ships today — logout clears both the queue keys and the bookmarks
  // blob via `clearKvStorage` — and the only caller of the drop loop IS logout: a full
  // resync deliberately does not drop tables, so a saved queue survives a resync.
  'queue_snapshots',
  'queue_snapshot_songs',
  'queue_snapshot_song_genres',
  'queue_snapshot_song_artists',
  'queue_snapshot_song_album_artists',
  'queue_snapshot_song_contributors',
  'queue_snapshot_song_moods',
  // The server's genre list, and the user's shares on that server. Both are
  // server-scoped — a share id and its URL belong to one account, and the genre counts
  // describe one library — so logout must drop them, exactly as `clearKvStorage` drops
  // the two blobs they replace.
  'genres',
  'shares',
  'share_entries',
  // Favourites are server-scoped, so logout must drop them: leaving them KEPT would
  // leak server A's favourites into server B.
  'favorite_songs',
  'favorite_albums',
  'favorite_artists',
];

/**
 * Permanent user data that lives in schema.ts for ordered schema management but must
 * NEVER be dropped by logout or a full resync. Losing any of these means losing the
 * login, the downloads (leaving orphaned files on disk), the listening history or the
 * image cache.
 */
export const KEPT_TABLES: readonly string[] = [
  'storage',
  'scrobble_events',
  'scrobble_genres',
  'scrobble_artists',
  'scrobble_album_artists',
  'scrobble_contributors',
  'scrobble_moods',
  'pending_scrobble_events',
  'pending_scrobble_genres',
  'pending_scrobble_artists',
  'pending_scrobble_album_artists',
  'pending_scrobble_contributors',
  'pending_scrobble_moods',
  'cached_songs',
  'cached_song_genres',
  'cached_song_artists',
  'cached_song_album_artists',
  'cached_song_contributors',
  'cached_song_moods',
  'cached_items',
  'cached_albums',
  'cached_playlists',
  'cached_item_songs',
  'download_queue',
  'download_queue_songs',
  'download_queue_song_genres',
  'download_queue_song_artists',
  'download_queue_song_album_artists',
  'download_queue_song_contributors',
  'download_queue_song_moods',
  'cached_images',
  'image_download_queue',
];

/** Every table name in the generated DDL, in emission order. */
export function ddlTableNames(): string[] {
  const names: string[] = [];
  for (const stmt of NORMALIZED_DDL) {
    const m = stmt.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+[`"]?([A-Za-z0-9_]+)[`"]?/i);
    if (m) names.push(m[1]);
  }
  return names;
}

/** The droppable subset: DDL ∩ MODEL_TABLES. */
export function normalizedTableNames(): string[] {
  const model = new Set(MODEL_TABLES);
  return ddlTableNames().filter((n) => model.has(n));
}

/**
 * Drop every normalized table then recreate the schema — a clean COLD reset. This is
 * the ONLY place that drops normalized data, and it's used ONLY by an explicit full
 * library resync (`forceFullResync` → the normalized sync), where the wipe is
 * intended and immediately followed by a full repopulate. Boot must NEVER
 * call this. DROP+CREATE is metadata-only (fast) but runs synchronously.
 */
export function resetNormalizedSchema(db: InternalDb): void {
  db.withTransactionSync(() => {
    for (const name of normalizedTableNames()) db.execSync(`DROP TABLE IF EXISTS "${name}"`);
  });
  ensureNormalizedSchema(db);
}
