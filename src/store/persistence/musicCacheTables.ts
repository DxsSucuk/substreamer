/**
 * Per-row SQLite persistence for the v2 music-downloads stack — query
 * helpers only. The shared handle, PRAGMAs, schema, health reporting, and
 * test injection live in `./db.ts`.
 *
 * Owns four tables in `substreamer7.db`:
 *   - `cached_songs`       — canonical song pool (one row per unique song)
 *   - `cached_items`       — download intents (album/playlist/favorites/song)
 *   - `cached_item_songs`  — many-to-many edges (refcount-via-COUNT)
 *   - `download_queue`     — persisted download queue
 *
 * Error-swallowing: every read returns a safe default ({}, [], 0) and every
 * write is a silent no-op on failure. Consumers never need to handle
 * exceptions from this module.
 */
import { getDb, serializeDbWrite, type InternalDb } from './db';

export interface CachedSongRow {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  albumId: string;
  coverArt?: string;
  bytes: number;
  duration: number;
  suffix: string;
  bitRate?: number;
  bitDepth?: number;
  samplingRate?: number;
  formatCapturedAt: number;
  downloadedAt: number;
  /**
   * Serialised full Subsonic `Child` envelope. Populated by every runtime
   * write and backfilled for legacy rows by Migration 18. Optional in the
   * row type because pre-Migration-18 rows may still be null; callers that
   * need the complete metadata should go through `getSongEnvelope()`.
   */
  rawJson?: string;
}

export interface CachedItemRow {
  itemId: string;
  type: 'album' | 'playlist' | 'favorites' | 'song';
  name: string;
  artist?: string;
  coverArtId?: string;
  expectedSongCount: number;
  parentAlbumId?: string;
  lastSyncAt: number;
  downloadedAt: number;
  /** Joined from cached_item_songs on hydrate, in position order. */
  songIds: string[];
  /**
   * Serialised full Subsonic `AlbumID3` (for album items) or `Playlist`
   * (for playlist items). NULL for `favorites` / `song` intents which have
   * no natural envelope.
   */
  rawJson?: string;
  /**
   * `true` for an auto-created partial `album:<id>` grouping row (built by
   * `ensurePartialAlbumEdge` so playlist/favorites/song-downloaded tracks are
   * browsable by album). Such rows are NOT "real" download holders: a song's
   * file lives only as long as a REAL holder (album-full / playlist / favorites
   * / `song:<id>`) references it. Stamped by which function creates the row,
   * never inferred from counts. Defaults to `false`.
   */
  derived?: boolean;
}

export interface DownloadQueueRow {
  queueId: string;
  itemId: string;
  type: 'album' | 'playlist' | 'favorites' | 'song';
  name: string;
  artist?: string;
  coverArtId?: string;
  status: 'queued' | 'downloading' | 'complete' | 'error';
  totalSongs: number;
  completedSongs: number;
  error?: string;
  addedAt: number;
  queuePosition: number;
  /** JSON-serialized Child[] still needed at download time. */
  songsJson: string;
}

/* ------------------------------------------------------------------ */
/*  Row <-> object mapping helpers                                     */
/* ------------------------------------------------------------------ */

interface RawSongRow {
  song_id: string;
  title: string;
  artist: string | null;
  album: string | null;
  album_id: string;
  cover_art: string | null;
  bytes: number;
  duration: number;
  suffix: string;
  bit_rate: number | null;
  bit_depth: number | null;
  sampling_rate: number | null;
  format_captured_at: number;
  downloaded_at: number;
  raw_json: string | null;
}

interface RawItemRow {
  item_id: string;
  type: string;
  name: string;
  artist: string | null;
  cover_art_id: string | null;
  expected_song_count: number;
  parent_album_id: string | null;
  last_sync_at: number;
  downloaded_at: number;
  raw_json: string | null;
  derived: number | null;
}

interface RawQueueRow {
  queue_id: string;
  item_id: string;
  type: string;
  name: string;
  artist: string | null;
  cover_art_id: string | null;
  status: string;
  total_songs: number;
  completed_songs: number;
  error: string | null;
  added_at: number;
  queue_position: number;
  songs_json: string;
}

function mapSongRow(row: RawSongRow): CachedSongRow {
  const out: CachedSongRow = {
    id: row.song_id,
    title: row.title,
    albumId: row.album_id,
    bytes: row.bytes,
    duration: row.duration,
    suffix: row.suffix,
    formatCapturedAt: row.format_captured_at,
    downloadedAt: row.downloaded_at,
  };
  if (row.artist !== null) out.artist = row.artist;
  if (row.album !== null) out.album = row.album;
  if (row.cover_art !== null) out.coverArt = row.cover_art;
  if (row.bit_rate !== null) out.bitRate = row.bit_rate;
  if (row.bit_depth !== null) out.bitDepth = row.bit_depth;
  if (row.sampling_rate !== null) out.samplingRate = row.sampling_rate;
  if (row.raw_json !== null) out.rawJson = row.raw_json;
  return out;
}

function mapItemRow(row: RawItemRow, songIds: string[]): CachedItemRow {
  const out: CachedItemRow = {
    itemId: row.item_id,
    type: row.type as CachedItemRow['type'],
    name: row.name,
    expectedSongCount: row.expected_song_count,
    lastSyncAt: row.last_sync_at,
    downloadedAt: row.downloaded_at,
    songIds,
  };
  if (row.artist !== null) out.artist = row.artist;
  if (row.cover_art_id !== null) out.coverArtId = row.cover_art_id;
  if (row.parent_album_id !== null) out.parentAlbumId = row.parent_album_id;
  if (row.raw_json !== null) out.rawJson = row.raw_json;
  // Unconditional (NOT the `!== null` optional pattern): a legacy/NULL row maps
  // to `false`, matching the `COALESCE(derived,0)` orphan-count guard so no real
  // holder is ever mistaken for derived.
  out.derived = row.derived === 1;
  return out;
}

function mapQueueRow(row: RawQueueRow): DownloadQueueRow {
  const out: DownloadQueueRow = {
    queueId: row.queue_id,
    itemId: row.item_id,
    type: row.type as DownloadQueueRow['type'],
    name: row.name,
    status: row.status as DownloadQueueRow['status'],
    totalSongs: row.total_songs,
    completedSongs: row.completed_songs,
    addedAt: row.added_at,
    queuePosition: row.queue_position,
    songsJson: row.songs_json,
  };
  if (row.artist !== null) out.artist = row.artist;
  if (row.cover_art_id !== null) out.coverArtId = row.cover_art_id;
  if (row.error !== null) out.error = row.error;
  return out;
}

/**
 * Idempotent `ALTER TABLE ... ADD COLUMN` for older databases that predate a
 * column. The base schema in `db.ts` already includes the column for fresh
 * installs; this helper is for existing users whose DB was created by an
 * earlier release. Used by Migration 17.
 *
 * Uses `PRAGMA table_info(<table>)` to check whether the column is present
 * rather than relying on the "duplicate column" error string, which is
 * awkward to match across SQLite releases.
 *
 * Returns `true` when the column was added, `false` when it already existed
 * or the operation was skipped (DB unavailable / malformed).
 */
export function addColumnIfMissing(
  table: string,
  column: string,
  sqlType: string,
): boolean {
  const db = getDb();
  if (db === null) return false;
  try {
    const cols = db.getAllSync<{ name: string }>(`PRAGMA table_info(${table});`);
    if (cols.some((c) => c.name === column)) return false;
    db.execSync(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType};`);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Hydrate                                                            */
/* ------------------------------------------------------------------ */

/**
 * Read all cached song rows into a Record keyed by song_id. Used once at
 * launch to populate the store's in-memory mirror.
 */
export function hydrateCachedSongs(): Record<string, CachedSongRow> {
  const db = getDb();
  if (db === null) return {};
  try {
    const rows = db.getAllSync<RawSongRow>(
      `SELECT song_id, title, artist, album, album_id, cover_art, bytes,
              duration, suffix, bit_rate, bit_depth, sampling_rate,
              format_captured_at, downloaded_at, raw_json
         FROM cached_songs;`,
    );
    const out: Record<string, CachedSongRow> = {};
    for (const row of rows) {
      if (!row.song_id) continue;
      out[row.song_id] = mapSongRow(row);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Read all cached items with their songId arrays joined in position order.
 * Implemented as two queries + merge in JS (simpler than GROUP_CONCAT).
 */
export function hydrateCachedItems(): Record<string, CachedItemRow> {
  const db = getDb();
  if (db === null) return {};
  try {
    const items = db.getAllSync<RawItemRow>(
      `SELECT item_id, type, name, artist, cover_art_id, expected_song_count,
              parent_album_id, last_sync_at, downloaded_at, raw_json, derived
         FROM cached_items;`,
    );
    const edges = db.getAllSync<{ item_id: string; song_id: string }>(
      'SELECT item_id, song_id FROM cached_item_songs ORDER BY item_id, position ASC;',
    );
    const edgesByItem = new Map<string, string[]>();
    for (const edge of edges) {
      const list = edgesByItem.get(edge.item_id);
      if (list) list.push(edge.song_id);
      else edgesByItem.set(edge.item_id, [edge.song_id]);
    }
    const out: Record<string, CachedItemRow> = {};
    for (const row of items) {
      if (!row.item_id) continue;
      const songIds = edgesByItem.get(row.item_id) ?? [];
      out[row.item_id] = mapItemRow(row, songIds);
    }
    return out;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/*  Async hydrate (boot path — off the JS thread)                      */
/* ------------------------------------------------------------------ */

/** Rows mapped per macrotask yield during async hydration. */
const HYDRATE_MAP_CHUNK = 2000;

async function yieldEvery(i: number): Promise<void> {
  if (i > 0 && i % HYDRATE_MAP_CHUNK === 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Async counterpart of {@link hydrateCachedSongs}. The read runs on
 * expo-sqlite's background thread (`getAllAsync`) and the row→object mapping
 * is chunked with `setTimeout(0)` yields, so a large cached-songs table does
 * not freeze the JS thread at boot. `raw_json` is stored verbatim (parsed
 * lazily via `getSongEnvelope`), so no per-row JSON.parse happens here.
 */
export async function hydrateCachedSongsAsync(): Promise<Record<string, CachedSongRow>> {
  const db = getDb();
  if (db === null) return {};
  try {
    const rows = await db.getAllAsync<RawSongRow>(
      `SELECT song_id, title, artist, album, album_id, cover_art, bytes,
              duration, suffix, bit_rate, bit_depth, sampling_rate,
              format_captured_at, downloaded_at, raw_json
         FROM cached_songs;`,
    );
    const out: Record<string, CachedSongRow> = {};
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.song_id) out[row.song_id] = mapSongRow(row);
      await yieldEvery(i);
    }
    return out;
  } catch {
    return {};
  }
}

/** Async counterpart of {@link hydrateCachedItems}. */
export async function hydrateCachedItemsAsync(): Promise<Record<string, CachedItemRow>> {
  const db = getDb();
  if (db === null) return {};
  try {
    const items = await db.getAllAsync<RawItemRow>(
      `SELECT item_id, type, name, artist, cover_art_id, expected_song_count,
              parent_album_id, last_sync_at, downloaded_at, raw_json, derived
         FROM cached_items;`,
    );
    const edges = await db.getAllAsync<{ item_id: string; song_id: string }>(
      'SELECT item_id, song_id FROM cached_item_songs ORDER BY item_id, position ASC;',
    );
    const edgesByItem = new Map<string, string[]>();
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      const list = edgesByItem.get(edge.item_id);
      if (list) list.push(edge.song_id);
      else edgesByItem.set(edge.item_id, [edge.song_id]);
      await yieldEvery(i);
    }
    const out: Record<string, CachedItemRow> = {};
    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      if (!row.item_id) continue;
      out[row.item_id] = mapItemRow(row, edgesByItem.get(row.item_id) ?? []);
      await yieldEvery(i);
    }
    return out;
  } catch {
    return {};
  }
}

/** Async counterpart of {@link hydrateDownloadQueue}. */
export async function hydrateDownloadQueueAsync(): Promise<DownloadQueueRow[]> {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = await db.getAllAsync<RawQueueRow>(
      `SELECT queue_id, item_id, type, name, artist, cover_art_id, status,
              total_songs, completed_songs, error, added_at, queue_position,
              songs_json
         FROM download_queue
         ORDER BY queue_position ASC;`,
    );
    return rows.map(mapQueueRow);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Counts                                                             */
/* ------------------------------------------------------------------ */

export function countCachedSongs(): number {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = db.getFirstSync<{ c: number }>('SELECT COUNT(*) AS c FROM cached_songs;');
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export function countCachedItems(): number {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = db.getFirstSync<{ c: number }>('SELECT COUNT(*) AS c FROM cached_items;');
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Read a single PRAGMA value from the current connection. Used by the
 * migration diagnostics to verify FK enforcement / journal mode state.
 * Returns `null` on error.
 */
export function readPragma(name: string): string | null {
  const db = getDb();
  if (db === null) return null;
  try {
    const row = db.getFirstSync<Record<string, unknown>>(`PRAGMA ${name};`);
    if (!row) return null;
    // PRAGMA results come back with the pragma name as the key.
    const val = row[name];
    if (val === undefined || val === null) return null;
    return String(val);
  } catch {
    return null;
  }
}

export function countCachedItemSongs(): number {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = db.getFirstSync<{ c: number }>('SELECT COUNT(*) AS c FROM cached_item_songs;');
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export function countDownloadQueueItems(): number {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = db.getFirstSync<{ c: number }>('SELECT COUNT(*) AS c FROM download_queue;');
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Batched, async real-holder refcount for a set of songs in one round-trip.
 * Returns a Map songId → count of edges whose holder is
 * NOT a derived partial-album grouping (`COALESCE(derived,0)=0`). Songs with no real
 * holder are omitted (caller treats a missing key as 0). Chunked to stay under the
 * SQLite bound-variable limit. Fails SAFE like the per-song version: if the `derived`
 * column doesn't exist yet (migration #31 not run) the JOIN throws and we fall back
 * to the raw all-edges count rather than mass-orphaning.
 */
export async function countRealSongRefsForSongsAsync(
  songIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const db = getDb();
  if (db === null || songIds.length === 0) return counts;
  const CHUNK = 500;
  for (let i = 0; i < songIds.length; i += CHUNK) {
    const chunk = songIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    try {
      // eslint-disable-next-line no-await-in-loop
      const rows = await db.getAllAsync<{ song_id: string; c: number }>(
        `SELECT e.song_id AS song_id, COUNT(*) AS c FROM cached_item_songs e
           JOIN cached_items i ON e.item_id = i.item_id
          WHERE e.song_id IN (${placeholders}) AND COALESCE(i.derived, 0) = 0
          GROUP BY e.song_id;`,
        chunk,
      );
      for (const r of rows) counts.set(r.song_id, r.c);
    } catch {
      // eslint-disable-next-line no-await-in-loop
      const rows = await db.getAllAsync<{ song_id: string; c: number }>(
        `SELECT song_id, COUNT(*) AS c FROM cached_item_songs
          WHERE song_id IN (${placeholders})
          GROUP BY song_id;`,
        chunk,
      );
      for (const r of rows) counts.set(r.song_id, r.c);
    }
  }
  return counts;
}

/**
 * Atomic "orphan this song iff no REAL holder remains". Runs the real-ref
 * COUNT and the conditional orphan (edge deletes → song delete → derived-holder
 * prune) inside ONE transaction, so no concurrent insert can add a holder
 * between the count and the delete — the TOCTOU race a two-call
 * count-then-orphan would introduce now that these paths are async. Returns
 * whether it orphaned plus the touched/pruned holders so the store can mirror
 * the change in memory.
 */
export async function orphanSongIfUnreferencedAsync(
  songId: string,
): Promise<{ orphaned: boolean; affectedItems: string[]; prunedItems: string[] }> {
  const db = getDb();
  const affectedItems: string[] = [];
  const prunedItems: string[] = [];
  if (db === null) return { orphaned: false, affectedItems, prunedItems };
  let orphaned = false;
  try {
    await serializeDbWrite(() =>
      db.withTransactionAsync(async () => {
        // Count REAL holders (derived = 0) inside the txn. Fail SAFE to the raw
        // all-edges count if the `derived` column is missing (migration 31 not
        // yet run) so we degrade to the OLD non-destructive behaviour.
        let realRefs: number;
        try {
          const row = await db.getFirstAsync<{ c: number }>(
            `SELECT COUNT(*) AS c FROM cached_item_songs e
               JOIN cached_items i ON e.item_id = i.item_id
              WHERE e.song_id = ? AND COALESCE(i.derived, 0) = 0;`,
            [songId],
          );
          realRefs = row?.c ?? 0;
        } catch {
          const row = await db.getFirstAsync<{ c: number }>(
            'SELECT COUNT(*) AS c FROM cached_item_songs WHERE song_id = ?;',
            [songId],
          );
          realRefs = row?.c ?? 0;
        }
        if (realRefs !== 0) return; // still held by a real holder — keep it
        orphaned = true;
        const edges = await db.getAllAsync<{ item_id: string; position: number }>(
          'SELECT item_id, position FROM cached_item_songs WHERE song_id = ?;',
          [songId],
        );
        const holders = [...new Set(edges.map((e) => e.item_id))];
        for (const e of edges) {
          // eslint-disable-next-line no-await-in-loop
          await db.runAsync(
            'DELETE FROM cached_item_songs WHERE item_id = ? AND position = ?;',
            [e.item_id, e.position],
          );
          // eslint-disable-next-line no-await-in-loop
          await db.runAsync(
            'UPDATE cached_item_songs SET position = position - 1 WHERE item_id = ? AND position > ?;',
            [e.item_id, e.position],
          );
        }
        await db.runAsync('DELETE FROM cached_songs WHERE song_id = ?;', [songId]);
        for (const itemId of holders) {
          affectedItems.push(itemId);
          // eslint-disable-next-line no-await-in-loop
          const cnt = await db.getFirstAsync<{ c: number }>(
            'SELECT COUNT(*) AS c FROM cached_item_songs WHERE item_id = ?;',
            [itemId],
          );
          if ((cnt?.c ?? 0) > 0) continue;
          // eslint-disable-next-line no-await-in-loop
          const der = await db.getFirstAsync<{ d: number }>(
            'SELECT COALESCE(derived, 0) AS d FROM cached_items WHERE item_id = ?;',
            [itemId],
          );
          if ((der?.d ?? 0) === 1) {
            // eslint-disable-next-line no-await-in-loop
            await db.runAsync('DELETE FROM cached_items WHERE item_id = ?;', [itemId]);
            prunedItems.push(itemId);
          }
        }
      }),
    );
  } catch {
    /* dropped */
  }
  return { orphaned, affectedItems, prunedItems };
}

/* ------------------------------------------------------------------ */
/*  cached_songs writes                                                */
/* ------------------------------------------------------------------ */

// Internal helpers take an already-validated non-null `db` — they're only
// called from public functions that have done the null check, or from
// inside `withTransactionSync` callbacks.
async function upsertCachedSongInternal(db: InternalDb, song: CachedSongRow): Promise<void> {
  // UPSERT rather than `INSERT OR REPLACE` — see `upsertCachedItemInternal`
  // for the rationale. Applies the same pattern here for consistency so
  // nobody can accidentally reintroduce the cascade-delete footgun.
  //
  // `raw_json` is written unconditionally; callers that do not have the full
  // envelope pass `undefined` and the column is set NULL. The ON CONFLICT
  // branch only overwrites `raw_json` when a non-null value is supplied so
  // a runtime top-up that fails to include the envelope cannot clobber a
  // row that has one — the `COALESCE(excluded.raw_json, raw_json)` pattern
  // keeps the richer version.
  await db.runAsync(
    `INSERT INTO cached_songs
       (song_id, title, artist, album, album_id, cover_art, bytes, duration,
        suffix, bit_rate, bit_depth, sampling_rate, format_captured_at,
        downloaded_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(song_id) DO UPDATE SET
         title = excluded.title,
         artist = excluded.artist,
         album = excluded.album,
         album_id = excluded.album_id,
         cover_art = excluded.cover_art,
         bytes = excluded.bytes,
         duration = excluded.duration,
         suffix = excluded.suffix,
         bit_rate = excluded.bit_rate,
         bit_depth = excluded.bit_depth,
         sampling_rate = excluded.sampling_rate,
         format_captured_at = excluded.format_captured_at,
         downloaded_at = excluded.downloaded_at,
         raw_json = COALESCE(excluded.raw_json, raw_json);`,
    [
      song.id,
      song.title,
      song.artist ?? null,
      song.album ?? null,
      song.albumId,
      song.coverArt ?? null,
      song.bytes,
      song.duration,
      song.suffix,
      song.bitRate ?? null,
      song.bitDepth ?? null,
      song.samplingRate ?? null,
      song.formatCapturedAt,
      song.downloadedAt,
      song.rawJson ?? null,
    ],
  );
}

export async function upsertCachedSong(song: CachedSongRow): Promise<void> {
  const db = getDb();
  if (db === null) return;
  if (!song.id || !song.albumId) return;
  try {
    await serializeDbWrite(() => upsertCachedSongInternal(db, song));
  } catch {
    /* dropped */
  }
}

export async function deleteCachedSong(songId: string): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeDbWrite(() => db.runAsync('DELETE FROM cached_songs WHERE song_id = ?;', [songId]));
  } catch {
    /* dropped */
  }
}

/* ------------------------------------------------------------------ */
/*  cached_items writes                                                */
/* ------------------------------------------------------------------ */

async function upsertCachedItemInternal(db: InternalDb, item: Omit<CachedItemRow, 'songIds'>): Promise<void> {
  // UPSERT (not `INSERT OR REPLACE`): SQLite implements `OR REPLACE` as
  // DELETE-then-INSERT, which would fire `ON DELETE CASCADE` on the
  // `cached_item_songs` edges table and silently wipe every edge for this
  // item_id. UPSERT updates the row in place with no DELETE, preserving
  // children. This is the root-cause fix for the music-downloads-v2
  // durability bug where offline playlists evaporated after the first
  // downstream write touched the parent item.
  //
  // `raw_json` uses the same COALESCE-on-conflict shape as cached_songs —
  // see that helper for the rationale.
  await db.runAsync(
    `INSERT INTO cached_items
       (item_id, type, name, artist, cover_art_id, expected_song_count,
        parent_album_id, last_sync_at, downloaded_at, raw_json, derived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         type = excluded.type,
         name = excluded.name,
         artist = excluded.artist,
         cover_art_id = excluded.cover_art_id,
         expected_song_count = excluded.expected_song_count,
         parent_album_id = excluded.parent_album_id,
         last_sync_at = excluded.last_sync_at,
         downloaded_at = excluded.downloaded_at,
         raw_json = COALESCE(excluded.raw_json, raw_json),
         derived = excluded.derived;`,
    [
      item.itemId,
      item.type,
      item.name,
      item.artist ?? null,
      item.coverArtId ?? null,
      item.expectedSongCount,
      item.parentAlbumId ?? null,
      item.lastSyncAt,
      item.downloadedAt,
      item.rawJson ?? null,
      item.derived ? 1 : 0,
    ],
  );
}

export async function upsertCachedItem(item: Omit<CachedItemRow, 'songIds'>): Promise<void> {
  const db = getDb();
  if (db === null) return;
  if (!item.itemId) return;
  try {
    await serializeDbWrite(() => upsertCachedItemInternal(db, item));
  } catch {
    /* dropped */
  }
}

/**
 * Delete an item row. FOREIGN KEY ON DELETE CASCADE removes the associated
 * cached_item_songs edges in the same SQLite statement.
 */
export async function deleteCachedItem(itemId: string): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeDbWrite(() => db.runAsync('DELETE FROM cached_items WHERE item_id = ?;', [itemId]));
  } catch {
    /* dropped */
  }
}

/* ------------------------------------------------------------------ */
/*  cached_item_songs (edge) writes                                    */
/* ------------------------------------------------------------------ */

export async function insertCachedItemSong(itemId: string, position: number, songId: string): Promise<void> {
  const db = getDb();
  if (db === null) return;
  if (!itemId || !songId) return;
  try {
    await serializeDbWrite(() =>
      db.runAsync(
        'INSERT OR IGNORE INTO cached_item_songs (item_id, position, song_id) VALUES (?, ?, ?);',
        [itemId, position, songId],
      ),
    );
  } catch {
    /* dropped */
  }
}

/**
 * Remove an edge at a specific position and shift higher positions down by 1
 * so positions remain contiguous within the item.
 */
export async function removeCachedItemSong(itemId: string, position: number): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeDbWrite(() =>
      db.withTransactionAsync(async () => {
        await db.runAsync(
          'DELETE FROM cached_item_songs WHERE item_id = ? AND position = ?;',
          [itemId, position],
        );
        await db.runAsync(
          'UPDATE cached_item_songs SET position = position - 1 WHERE item_id = ? AND position > ?;',
          [itemId, position],
        );
      }),
    );
  } catch {
    /* dropped */
  }
}

/**
 * Reorder one edge within an item from `fromPosition` to `toPosition`. Uses a
 * sentinel position (-1) to avoid primary-key collisions during the shift.
 */
export async function reorderCachedItemSongs(
  itemId: string,
  fromPosition: number,
  toPosition: number,
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  if (fromPosition === toPosition) return;
  try {
    await serializeDbWrite(() =>
      db.withTransactionAsync(async () => {
        // Stash the moving row at a sentinel position that can't collide.
        await db.runAsync(
          'UPDATE cached_item_songs SET position = -1 WHERE item_id = ? AND position = ?;',
          [itemId, fromPosition],
        );
        if (fromPosition < toPosition) {
          // Shift (fromPosition, toPosition] down by 1.
          await db.runAsync(
            `UPDATE cached_item_songs
               SET position = position - 1
               WHERE item_id = ? AND position > ? AND position <= ?;`,
            [itemId, fromPosition, toPosition],
          );
        } else {
          // Shift [toPosition, fromPosition) up by 1.
          await db.runAsync(
            `UPDATE cached_item_songs
               SET position = position + 1
               WHERE item_id = ? AND position >= ? AND position < ?;`,
            [itemId, toPosition, fromPosition],
          );
        }
        // Drop the moving row into its final slot.
        await db.runAsync(
          'UPDATE cached_item_songs SET position = ? WHERE item_id = ? AND position = -1;',
          [toPosition, itemId],
        );
      }),
    );
  } catch {
    /* dropped */
  }
}

/* ------------------------------------------------------------------ */
/*  download_queue writes                                              */
/* ------------------------------------------------------------------ */

async function insertDownloadQueueItemInternal(db: InternalDb, item: DownloadQueueRow): Promise<void> {
  // `download_queue` has no FK children so `INSERT OR REPLACE` is safe here,
  // but we use UPSERT anyway for consistency with the other tables — one
  // pattern everywhere means nobody introduces a regression by copying the
  // wrong line later.
  await db.runAsync(
    `INSERT INTO download_queue
       (queue_id, item_id, type, name, artist, cover_art_id, status,
        total_songs, completed_songs, error, added_at, queue_position,
        songs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(queue_id) DO UPDATE SET
         item_id = excluded.item_id,
         type = excluded.type,
         name = excluded.name,
         artist = excluded.artist,
         cover_art_id = excluded.cover_art_id,
         status = excluded.status,
         total_songs = excluded.total_songs,
         completed_songs = excluded.completed_songs,
         error = excluded.error,
         added_at = excluded.added_at,
         queue_position = excluded.queue_position,
         songs_json = excluded.songs_json;`,
    [
      item.queueId,
      item.itemId,
      item.type,
      item.name,
      item.artist ?? null,
      item.coverArtId ?? null,
      item.status,
      item.totalSongs,
      item.completedSongs,
      item.error ?? null,
      item.addedAt,
      item.queuePosition,
      item.songsJson,
    ],
  );
}

export async function insertDownloadQueueItem(item: DownloadQueueRow): Promise<void> {
  const db = getDb();
  if (db === null) return;
  if (!item.queueId) return;
  try {
    await serializeDbWrite(() => insertDownloadQueueItemInternal(db, item));
  } catch {
    /* dropped */
  }
}

export async function removeDownloadQueueItem(queueId: string): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeDbWrite(() => db.runAsync('DELETE FROM download_queue WHERE queue_id = ?;', [queueId]));
  } catch {
    /* dropped */
  }
}

/**
 * Partial update of a queue row. Only status / completedSongs / error can be
 * updated via this path; other fields are immutable once the item is queued.
 */
export async function updateDownloadQueueItem(
  queueId: string,
  update: Partial<Pick<DownloadQueueRow, 'status' | 'completedSongs' | 'error'>>,
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (update.status !== undefined) {
    clauses.push('status = ?');
    params.push(update.status);
  }
  if (update.completedSongs !== undefined) {
    clauses.push('completed_songs = ?');
    params.push(update.completedSongs);
  }
  if (update.error !== undefined) {
    clauses.push('error = ?');
    params.push(update.error ?? null);
  }
  if (clauses.length === 0) return;
  params.push(queueId);
  try {
    await serializeDbWrite(() =>
      db.runAsync(
        `UPDATE download_queue SET ${clauses.join(', ')} WHERE queue_id = ?;`,
        params,
      ),
    );
  } catch {
    /* dropped */
  }
}

/**
 * Move a queue row from one position to another. Shifts all affected rows'
 * positions inside a single transaction so the contiguous ordering is
 * preserved.
 */
export async function reorderDownloadQueue(fromPosition: number, toPosition: number): Promise<void> {
  const db = getDb();
  if (db === null) return;
  if (fromPosition === toPosition) return;
  try {
    await serializeDbWrite(() =>
      db.withTransactionAsync(async () => {
        // Stash the moving row at a sentinel position.
        await db.runAsync(
          'UPDATE download_queue SET queue_position = -1 WHERE queue_position = ?;',
          [fromPosition],
        );
        if (fromPosition < toPosition) {
          await db.runAsync(
            `UPDATE download_queue
               SET queue_position = queue_position - 1
               WHERE queue_position > ? AND queue_position <= ?;`,
            [fromPosition, toPosition],
          );
        } else {
          await db.runAsync(
            `UPDATE download_queue
               SET queue_position = queue_position + 1
               WHERE queue_position >= ? AND queue_position < ?;`,
            [toPosition, fromPosition],
          );
        }
        await db.runAsync(
          'UPDATE download_queue SET queue_position = ? WHERE queue_position = -1;',
          [toPosition],
        );
      }),
    );
  } catch {
    /* dropped */
  }
}

/* ------------------------------------------------------------------ */
/*  Complex transactional ops                                          */
/* ------------------------------------------------------------------ */

/**
 * Atomically finalise a download: delete the queue row, upsert the item,
 * upsert all songs, and insert every edge — all in a single transaction so
 * consumers never observe a half-committed state.
 */
export async function markDownloadComplete(
  queueId: string,
  item: Omit<CachedItemRow, 'songIds'>,
  songs: CachedSongRow[],
  edges: Array<{ songId: string; position: number }>,
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeDbWrite(() =>
      db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM download_queue WHERE queue_id = ?;', [queueId]);
        await upsertCachedItemInternal(db, item);
        for (const song of songs) {
          if (!song.id || !song.albumId) continue;
          // eslint-disable-next-line no-await-in-loop
          await upsertCachedSongInternal(db, song);
        }
        // Reassign edge positions starting from MAX(position)+1 for this item
        // so a top-up merging into an existing row doesn't collide with the
        // existing 1..K edges (the caller's positions are 1-based within the
        // queue item's `songsJson`, not the cached row).
        const maxRow = await db.getFirstAsync<{ max_pos: number | null }>(
          'SELECT MAX(position) AS max_pos FROM cached_item_songs WHERE item_id = ?;',
          [item.itemId],
        );
        let nextPosition = (maxRow?.max_pos ?? 0) + 1;
        const sortedEdges = [...edges].sort((a, b) => a.position - b.position);
        for (const edge of sortedEdges) {
          if (!edge.songId) continue;
          // eslint-disable-next-line no-await-in-loop
          await db.runAsync(
            'INSERT OR IGNORE INTO cached_item_songs (item_id, position, song_id) VALUES (?, ?, ?);',
            [item.itemId, nextPosition, edge.songId],
          );
          nextPosition++;
        }
      }),
    );
  } catch {
    /* dropped */
  }
}

/**
 * Wipe all four tables and replace their contents in a single transaction.
 * Used by migration task #14 after parsing the v1 blob.
 */
export async function bulkReplace(params: {
  items: Array<Omit<CachedItemRow, 'songIds'>>;
  songs: CachedSongRow[];
  edges: Array<{ itemId: string; position: number; songId: string }>;
  queue: DownloadQueueRow[];
}): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeDbWrite(() =>
      db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM cached_item_songs;');
        await db.runAsync('DELETE FROM download_queue;');
        await db.runAsync('DELETE FROM cached_items;');
        await db.runAsync('DELETE FROM cached_songs;');

        for (const song of params.songs) {
          if (!song.id || !song.albumId) continue;
          // eslint-disable-next-line no-await-in-loop
          await upsertCachedSongInternal(db, song);
        }

        for (const item of params.items) {
          if (!item.itemId) continue;
          // eslint-disable-next-line no-await-in-loop
          await upsertCachedItemInternal(db, item);
        }

        for (const edge of params.edges) {
          if (!edge.itemId || !edge.songId) continue;
          // eslint-disable-next-line no-await-in-loop
          await db.runAsync(
            'INSERT OR IGNORE INTO cached_item_songs (item_id, position, song_id) VALUES (?, ?, ?);',
            [edge.itemId, edge.position, edge.songId],
          );
        }

        for (const q of params.queue) {
          if (!q.queueId) continue;
          // eslint-disable-next-line no-await-in-loop
          await insertDownloadQueueItemInternal(db, q);
        }
      }),
    );
  } catch {
    /* dropped */
  }
}

/**
 * Truncate all four tables. Used by `resetAllStores` on logout / server
 * switch. Edges are deleted first to sidestep the FK constraint regardless of
 * PRAGMA state.
 */
export async function clearAllMusicCacheRows(): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeDbWrite(() =>
      db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM cached_item_songs;');
        await db.runAsync('DELETE FROM download_queue;');
        await db.runAsync('DELETE FROM cached_items;');
        await db.runAsync('DELETE FROM cached_songs;');
      }),
    );
  } catch {
    /* dropped */
  }
}
