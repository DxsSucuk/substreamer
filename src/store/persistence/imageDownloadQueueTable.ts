/**
 * Per-row SQLite persistence for the image-cache download queue — the
 * cover-art equivalent of `download_queue` for music. One row per
 * cover_art_id awaiting re-download as part of a user-initiated refresh
 * cycle. Owns the `image_download_queue` table in `substreamer7.db`.
 *
 * Shape mirrors `musicCacheTables.ts` deliberately: same status enum
 * vocabulary (queued / downloading / error), same retry-once-inline +
 * reset-on-restart policy (no exponential backoff), same idempotent
 * INSERT OR IGNORE semantics on the primary key.
 *
 * Error-swallowing: every read returns a safe default ([], null, 0) and
 * every write is a silent no-op on failure. Consumers never need to
 * handle exceptions from this module.
 *
 * See plans/2026-05-23-image-cache-queue-rework.md for the design.
 */
import { getDb } from './db';

export type ImageDownloadQueueScope = 'refresh-downloads' | 'refresh-all';
export type ImageDownloadQueueStatus = 'queued' | 'downloading' | 'error';

export interface ImageDownloadQueueRow {
  coverArtId: string;
  scope: ImageDownloadQueueScope;
  status: ImageDownloadQueueStatus;
  error?: string;
  attempts: number;
  addedAt: number;
  cycleId: string;
}

interface RawImageQueueRow {
  cover_art_id: string;
  scope: string;
  status: string;
  error: string | null;
  attempts: number;
  added_at: number;
  cycle_id: string;
}

function mapRow(row: RawImageQueueRow): ImageDownloadQueueRow {
  const out: ImageDownloadQueueRow = {
    coverArtId: row.cover_art_id,
    scope: row.scope as ImageDownloadQueueScope,
    status: row.status as ImageDownloadQueueStatus,
    attempts: row.attempts,
    addedAt: row.added_at,
    cycleId: row.cycle_id,
  };
  if (row.error !== null) out.error = row.error;
  return out;
}

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

/**
 * Read the full queue in oldest-first order. Used at launch (via
 * `imageDownloadQueueStore.hydrateFromDb()`) and after worker batches.
 */
export function hydrateImageDownloadQueue(): ImageDownloadQueueRow[] {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = db.getAllSync<RawImageQueueRow>(
      `SELECT cover_art_id, scope, status, error, attempts, added_at, cycle_id
         FROM image_download_queue
         ORDER BY added_at ASC;`,
    );
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

/**
 * Pick the next row to process (oldest queued first). Single-threaded JS
 * makes the read+update sequence in the worker effectively atomic; we
 * don't need SELECT … FOR UPDATE.
 */
export function pickNextQueuedImageRow(): ImageDownloadQueueRow | null {
  const db = getDb();
  if (db === null) return null;
  try {
    const row = db.getFirstSync<RawImageQueueRow>(
      `SELECT cover_art_id, scope, status, error, attempts, added_at, cycle_id
         FROM image_download_queue
         WHERE status = 'queued'
         ORDER BY added_at ASC
         LIMIT 1;`,
    );
    return row ? mapRow(row) : null;
  } catch {
    return null;
  }
}

export function countImageQueueRowsByStatus(
  status: ImageDownloadQueueStatus,
): number {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = db.getFirstSync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM image_download_queue WHERE status = ?;`,
      [status],
    );
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export function countImageQueueRowsByCycle(cycleId: string): number {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = db.getFirstSync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM image_download_queue WHERE cycle_id = ?;`,
      [cycleId],
    );
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Writes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Insert a row if not already present (dedupes via PK). No-op if the
 * cover_art_id is already in the queue under ANY scope or status —
 * matches the music queue's idempotent enqueue semantics. Returns true
 * if a row was actually inserted.
 */
export function enqueueImage(
  coverArtId: string,
  scope: ImageDownloadQueueScope,
  cycleId: string,
  now: number = Date.now(),
): boolean {
  const db = getDb();
  if (db === null) return false;
  try {
    const result = db.runSync(
      `INSERT OR IGNORE INTO image_download_queue
         (cover_art_id, scope, status, error, attempts, added_at, cycle_id)
         VALUES (?, ?, 'queued', NULL, 0, ?, ?);`,
      [coverArtId, scope, now, cycleId],
    );
    return result.changes > 0;
  } catch {
    return false;
  }
}

/**
 * Bulk version of `enqueueImage` wrapped in a transaction. Used when a
 * refresh cycle enumerates hundreds of IDs at once. Returns the count of
 * rows actually inserted (PK conflicts are silently skipped).
 */
export function enqueueImagesBulk(
  coverArtIds: readonly string[],
  scope: ImageDownloadQueueScope,
  cycleId: string,
  now: number = Date.now(),
): number {
  const db = getDb();
  if (db === null) return 0;
  if (coverArtIds.length === 0) return 0;
  let inserted = 0;
  try {
    db.withTransactionSync(() => {
      for (const id of coverArtIds) {
        const result = db.runSync(
          `INSERT OR IGNORE INTO image_download_queue
             (cover_art_id, scope, status, error, attempts, added_at, cycle_id)
             VALUES (?, ?, 'queued', NULL, 0, ?, ?);`,
          [id, scope, now, cycleId],
        );
        if (result.changes > 0) inserted++;
      }
    });
  } catch {
    /* swallow — partial inserts roll back via the transaction wrapper */
  }
  return inserted;
}

export function markImageDownloading(coverArtId: string): void {
  const db = getDb();
  if (db === null) return;
  try {
    db.runSync(
      `UPDATE image_download_queue
         SET status = 'downloading', error = NULL
         WHERE cover_art_id = ?;`,
      [coverArtId],
    );
  } catch {
    /* no-op */
  }
}

/**
 * Move a row to the error state, recording the last error message and
 * incrementing the attempts counter. The next `resetStalledImageRows`
 * pass (e.g. at app restart) will move this back to `'queued'` for a
 * fresh attempt — matches music's policy of "retry every session".
 */
export function markImageError(coverArtId: string, error: string): void {
  const db = getDb();
  if (db === null) return;
  try {
    db.runSync(
      `UPDATE image_download_queue
         SET status = 'error', error = ?, attempts = attempts + 1
         WHERE cover_art_id = ?;`,
      [error, coverArtId],
    );
  } catch {
    /* no-op */
  }
}

/**
 * Delete a row on successful download. The cover-art's "true state" is
 * the presence of rows in `cached_images`, so we don't keep a 'complete'
 * status — the absence of a queue row IS completion.
 */
export function removeImageFromQueue(coverArtId: string): void {
  const db = getDb();
  if (db === null) return;
  try {
    db.runSync(
      `DELETE FROM image_download_queue WHERE cover_art_id = ?;`,
      [coverArtId],
    );
  } catch {
    /* no-op */
  }
}

/**
 * Drop every row belonging to a refresh cycle. Used for Cancel. Rows
 * currently in `'downloading'` state are NOT killed mid-fetch (matches
 * music's `cancelDownload` semantics) — but their post-fetch update
 * becomes a no-op because the row is gone.
 */
export function clearImageQueueByCycle(cycleId: string): number {
  const db = getDb();
  if (db === null) return 0;
  try {
    const result = db.runSync(
      `DELETE FROM image_download_queue WHERE cycle_id = ?;`,
      [cycleId],
    );
    return result.changes;
  } catch {
    return 0;
  }
}

/**
 * Reset stalled rows back to `'queued'` so the worker re-processes them.
 * Called at boot (mirrors `recoverStalledDownloadsAsync` for music):
 *
 *   - Any row in `'downloading'` is presumed dead (the previous session
 *     was killed mid-fetch). Reset; increment attempts.
 *   - Any row in `'error'` gets a fresh shot per session. Reset; do not
 *     touch attempts (transient failures shouldn't keep climbing forever).
 */
export function resetStalledImageRows(): number {
  const db = getDb();
  if (db === null) return 0;
  try {
    const downloading = db.runSync(
      `UPDATE image_download_queue
         SET status = 'queued', attempts = attempts + 1
         WHERE status = 'downloading';`,
    );
    const errored = db.runSync(
      `UPDATE image_download_queue
         SET status = 'queued', error = NULL
         WHERE status = 'error';`,
    );
    return downloading.changes + errored.changes;
  } catch {
    return 0;
  }
}

/**
 * Reset error rows belonging to a specific cycle. Used by the
 * "Retry failed (N)" button in Settings.
 */
export function resetErrorRowsForCycle(cycleId: string): number {
  const db = getDb();
  if (db === null) return 0;
  try {
    const result = db.runSync(
      `UPDATE image_download_queue
         SET status = 'queued', error = NULL, attempts = 0
         WHERE status = 'error' AND cycle_id = ?;`,
      [cycleId],
    );
    return result.changes;
  } catch {
    return 0;
  }
}

/** Test-only / diagnostic: clear the entire table. */
export function clearImageDownloadQueue(): void {
  const db = getDb();
  if (db === null) return;
  try {
    db.runSync(`DELETE FROM image_download_queue;`);
  } catch {
    /* no-op */
  }
}
