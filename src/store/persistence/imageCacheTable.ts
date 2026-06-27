/**
 * Per-row SQLite persistence for the image cache — query helpers only.
 *
 * Every cover-art ID cached to disk is represented by up to four rows, one
 * per size variant (50 / 150 / 300 / 600). The source is always 600px, with
 * an `ext` that matches the Content-Type from the Subsonic fetch (`jpg` /
 * `png` / `webp`). The smaller variants are always derived locally as JPEG,
 * so for those `ext === 'jpg'`.
 *
 * A row must only be written AFTER the corresponding file has been renamed
 * to its final name on disk. That ordering, combined with the idempotent
 * `ON CONFLICT` upsert below, makes a mid-generation crash safe: the
 * partially-cached directory simply has fewer rows in the table, and the
 * next `cacheAllSizes()` / reconciliation pass regenerates what's missing.
 */
import { getDb, type InternalDb } from './db';

export interface CachedImageRow {
  coverArtId: string;
  size: number; // 50 | 150 | 300 | 600
  ext: string; // 'jpg' | 'png' | 'webp' (variants are always 'jpg')
  bytes: number;
  cachedAt: number; // ms epoch
}

interface RawRow {
  cover_art_id: string;
  size: number;
  ext: string;
  bytes: number;
  cached_at: number;
}

function mapRow(row: RawRow): CachedImageRow {
  return {
    coverArtId: row.cover_art_id,
    size: row.size,
    ext: row.ext,
    bytes: row.bytes,
    cachedAt: row.cached_at,
  };
}

/* ------------------------------------------------------------------ */
/*  Aggregate read — powers `imageCacheStore` on hydrate               */
/* ------------------------------------------------------------------ */

export interface ImageCacheAggregates {
  /** Sum of every variant file's size in bytes. */
  totalBytes: number;
  /** COUNT(*) — total variant files on disk. */
  fileCount: number;
  /** COUNT(DISTINCT cover_art_id) — unique logical images. */
  imageCount: number;
  /** Count of cover_art_ids with fewer than 4 variants. */
  incompleteCount: number;
}

const EMPTY_AGGREGATES: ImageCacheAggregates = {
  totalBytes: 0,
  fileCount: 0,
  imageCount: 0,
  incompleteCount: 0,
};

/**
 * Single-query derivation of every aggregate the store needs. Replaces the
 * two-walk `getImageCacheStats()` filesystem scan on every launch.
 */
export function hydrateImageCacheAggregates(): ImageCacheAggregates {
  const db = getDb();
  if (db === null) return { ...EMPTY_AGGREGATES };
  try {
    const totals = db.getFirstSync<{
      total_bytes: number | null;
      file_count: number;
      image_count: number;
    }>(
      `SELECT
         COALESCE(SUM(bytes), 0) AS total_bytes,
         COUNT(*) AS file_count,
         COUNT(DISTINCT cover_art_id) AS image_count
       FROM cached_images;`,
    );
    // Exclude cover_art_ids currently in the image-download queue: those
    // rows are "in progress" (queued or downloading), not "incomplete".
    // Mid-refresh a cover is briefly missing variants between delete and
    // download-complete, and without this filter the Settings count
    // ticks up to 1 and back to 0 on every row, making the screen flash.
    const incomplete = db.getFirstSync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM (
         SELECT cover_art_id FROM cached_images
           WHERE cover_art_id NOT IN (
             SELECT cover_art_id FROM image_download_queue
           )
           GROUP BY cover_art_id HAVING COUNT(*) < 4
       );`,
    );
    return {
      totalBytes: totals?.total_bytes ?? 0,
      fileCount: totals?.file_count ?? 0,
      imageCount: totals?.image_count ?? 0,
      incompleteCount: incomplete?.c ?? 0,
    };
  } catch {
    return { ...EMPTY_AGGREGATES };
  }
}

/**
 * Async twin of {@link hydrateImageCacheAggregates}. Uses `getFirstAsync` so the
 * two scans of `cached_images` run on a background native thread instead of
 * blocking the JS thread. Use this on interactive/hot paths (e.g. the recalc
 * after every image download); the sync version is reserved for one-shot boot
 * hydration where ordering matters.
 */
export async function hydrateImageCacheAggregatesAsync(): Promise<ImageCacheAggregates> {
  const db = getDb();
  if (db === null) return { ...EMPTY_AGGREGATES };
  try {
    const totals = await db.getFirstAsync<{
      total_bytes: number | null;
      file_count: number;
      image_count: number;
    }>(
      `SELECT
         COALESCE(SUM(bytes), 0) AS total_bytes,
         COUNT(*) AS file_count,
         COUNT(DISTINCT cover_art_id) AS image_count
       FROM cached_images;`,
    );
    // See the sync version for why in-queue cover_art_ids are excluded.
    const incomplete = await db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM (
         SELECT cover_art_id FROM cached_images
           WHERE cover_art_id NOT IN (
             SELECT cover_art_id FROM image_download_queue
           )
           GROUP BY cover_art_id HAVING COUNT(*) < 4
       );`,
    );
    return {
      totalBytes: totals?.total_bytes ?? 0,
      fileCount: totals?.file_count ?? 0,
      imageCount: totals?.image_count ?? 0,
      incompleteCount: incomplete?.c ?? 0,
    };
  } catch {
    return { ...EMPTY_AGGREGATES };
  }
}

/* ------------------------------------------------------------------ */
/*  Single-variant writes                                              */
/* ------------------------------------------------------------------ */

function upsertCachedImageInternal(db: InternalDb, row: CachedImageRow): void {
  db.runSync(
    `INSERT INTO cached_images (cover_art_id, size, ext, bytes, cached_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cover_art_id, size) DO UPDATE SET
         ext = excluded.ext,
         bytes = excluded.bytes,
         cached_at = excluded.cached_at;`,
    [row.coverArtId, row.size, row.ext, row.bytes, row.cachedAt],
  );
}

/**
 * Record a variant as cached on disk. Must be called AFTER the file has
 * been renamed from its `.tmp` to its final name.
 */
export function upsertCachedImage(row: CachedImageRow): void {
  const db = getDb();
  if (db === null) return;
  if (!row.coverArtId || !row.size) return;
  try {
    upsertCachedImageInternal(db, row);
  } catch {
    /* dropped */
  }
}

/* ------------------------------------------------------------------ */
/*  Deletion                                                           */
/* ------------------------------------------------------------------ */

/**
 * Delete every row for a cover_art_id. Returns the freed bytes/count so
 * the in-memory aggregates can be updated incrementally.
 */
export function deleteCachedImagesForCoverArt(
  coverArtId: string,
): { bytes: number; count: number } {
  const db = getDb();
  if (db === null || !coverArtId) return { bytes: 0, count: 0 };
  try {
    const totals = db.getFirstSync<{
      total_bytes: number | null;
      file_count: number;
    }>(
      `SELECT COALESCE(SUM(bytes), 0) AS total_bytes, COUNT(*) AS file_count
         FROM cached_images WHERE cover_art_id = ?;`,
      [coverArtId],
    );
    db.runSync('DELETE FROM cached_images WHERE cover_art_id = ?;', [
      coverArtId,
    ]);
    return {
      bytes: totals?.total_bytes ?? 0,
      count: totals?.file_count ?? 0,
    };
  } catch {
    return { bytes: 0, count: 0 };
  }
}

/**
 * Delete a single variant row. Used by the SQL-side of reconciliation when
 * a DB row's file has vanished from disk.
 */
export function deleteCachedImageVariant(
  coverArtId: string,
  size: number,
): void {
  const db = getDb();
  if (db === null) return;
  try {
    db.runSync(
      'DELETE FROM cached_images WHERE cover_art_id = ? AND size = ?;',
      [coverArtId, size],
    );
  } catch {
    /* dropped */
  }
}

/** Remove every row. Used on logout / clearImageCache via resetAllStores. */
export function clearAllCachedImages(): void {
  const db = getDb();
  if (db === null) return;
  try {
    db.runSync('DELETE FROM cached_images;');
  } catch {
    /* dropped */
  }
}

/* ------------------------------------------------------------------ */
/*  Point reads                                                        */
/* ------------------------------------------------------------------ */

export function hasCachedImage(coverArtId: string, size: number): boolean {
  const db = getDb();
  if (db === null) return false;
  try {
    const row = db.getFirstSync<{ c: number }>(
      'SELECT 1 AS c FROM cached_images WHERE cover_art_id = ? AND size = ? LIMIT 1;',
      [coverArtId, size],
    );
    return !!row;
  } catch {
    return false;
  }
}

/** All variants for a single cover-art id, ordered by size ascending. */
export function getCachedImagesForCoverArt(
  coverArtId: string,
): CachedImageRow[] {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = db.getAllSync<RawRow>(
      `SELECT cover_art_id, size, ext, bytes, cached_at
         FROM cached_images WHERE cover_art_id = ? ORDER BY size ASC;`,
      [coverArtId],
    );
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

/**
 * Async twin of {@link getCachedImagesForCoverArt}. The single source of truth
 * for "which variants does this cover have?" on the render + decision paths —
 * `getAllAsync` keeps the SQLite work off the JS thread. A cover has ≤4 rows,
 * so callers filter the small result in memory.
 */
export async function getCachedImagesForCoverArtAsync(
  coverArtId: string,
): Promise<CachedImageRow[]> {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = await db.getAllAsync<RawRow>(
      `SELECT cover_art_id, size, ext, bytes, cached_at
         FROM cached_images WHERE cover_art_id = ? ORDER BY size ASC;`,
      [coverArtId],
    );
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Incomplete detection                                               */
/* ------------------------------------------------------------------ */

/**
 * Every distinct cover_art_id that has at least one variant cached on
 * disk. Used by the image-download-queue's "refresh all cached covers"
 * cycle to enumerate everything currently in the cache for re-download.
 */
export function getAllCachedCoverArtIds(): string[] {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = db.getAllSync<{ cover_art_id: string }>(
      `SELECT DISTINCT cover_art_id FROM cached_images
         ORDER BY cover_art_id ASC;`,
    );
    return rows.map((r) => r.cover_art_id);
  } catch {
    return [];
  }
}

/**
 * Every cover_art_id whose row count is < 4 AND that isn't currently
 * in the image-download queue. Excluding in-flight covers keeps the
 * Repair button from racing the refresh worker for the same rows.
 */
export function findIncompleteCovers(): string[] {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = db.getAllSync<{ cover_art_id: string }>(
      `SELECT cover_art_id FROM cached_images
         WHERE cover_art_id NOT IN (
           SELECT cover_art_id FROM image_download_queue
         )
         GROUP BY cover_art_id HAVING COUNT(*) < 4
         ORDER BY cover_art_id ASC;`,
    );
    return rows.map((r) => r.cover_art_id);
  } catch {
    return [];
  }
}

export function countIncompleteCovers(): number {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = db.getFirstSync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM (
         SELECT cover_art_id FROM cached_images
           WHERE cover_art_id NOT IN (
             SELECT cover_art_id FROM image_download_queue
           )
           GROUP BY cover_art_id HAVING COUNT(*) < 4
       );`,
    );
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Browser listing                                                    */
/* ------------------------------------------------------------------ */

export interface CachedImageEntry {
  coverArtId: string;
  files: Array<{ size: number; ext: string; bytes: number; cachedAt: number }>;
  /** Convenience: true when every size variant (50/150/300/600) is present. */
  complete: boolean;
}

export type CacheBrowserFilter = 'all' | 'complete' | 'incomplete';

const EXPECTED_VARIANTS = 4;

/**
 * Sentinel cover-art IDs rendered from bundled assets (CachedImage's
 * asset resolver) rather than the disk cache. If rows for these ever
 * exist — e.g. left over from an older app version — they're stale and
 * should not surface in the image-cache browser UI. Inlined here because
 * `imageCacheService.ts` has the same duplicate for circular-import
 * reasons, and the persistence layer shouldn't depend on the service.
 */
const SENTINEL_COVER_ART_IDS: ReadonlySet<string> = new Set([
  '__starred_cover__',
  '__various_artists_cover__',
]);

/**
 * List every cached image grouped by cover_art_id, with an optional
 * complete/incomplete filter. Drives the image-cache-browser screen —
 * replaces the whole-tree `listCachedImagesAsync()` disk walk with a
 * single indexed SQL scan.
 */
export function listCachedImagesForBrowser(
  filter: CacheBrowserFilter = 'all',
): CachedImageEntry[] {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = db.getAllSync<RawRow>(
      `SELECT cover_art_id, size, ext, bytes, cached_at
         FROM cached_images ORDER BY cover_art_id ASC, size ASC;`,
    );
    const entries: CachedImageEntry[] = [];
    let current: CachedImageEntry | null = null;
    for (const row of rows) {
      if (!current || current.coverArtId !== row.cover_art_id) {
        if (current) {
          current.complete = current.files.length === EXPECTED_VARIANTS;
          entries.push(current);
        }
        current = { coverArtId: row.cover_art_id, files: [], complete: false };
      }
      current.files.push({
        size: row.size,
        ext: row.ext,
        bytes: row.bytes,
        cachedAt: row.cached_at,
      });
    }
    if (current) {
      current.complete = current.files.length === EXPECTED_VARIANTS;
      entries.push(current);
    }
    // Hide sentinel coverArtIds from the browser UI — if stale rows
    // exist for them, they're permanently "incomplete" (the download
    // pipeline can't service them) but the bundled artwork still
    // renders. Suppressing them here keeps the user's incomplete list
    // clean even if imageCacheService's sweep hasn't run yet.
    const visible = entries.filter((e) => !SENTINEL_COVER_ART_IDS.has(e.coverArtId));
    if (filter === 'complete') return visible.filter((e) => e.complete);
    if (filter === 'incomplete') return visible.filter((e) => !e.complete);
    return visible;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Bulk insert — used by the migration and by reconciliation          */
/* ------------------------------------------------------------------ */

export function bulkInsertCachedImages(rows: readonly CachedImageRow[]): void {
  const db = getDb();
  if (db === null) return;
  if (rows.length === 0) return;
  try {
    db.withTransactionSync(() => {
      for (const row of rows) {
        if (!row.coverArtId || !row.size) continue;
        upsertCachedImageInternal(db, row);
      }
    });
  } catch {
    /* dropped */
  }
}

/* ------------------------------------------------------------------ */
/*  Diagnostic                                                         */
/* ------------------------------------------------------------------ */

export function countCachedImages(): number {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = db.getFirstSync<{ c: number }>(
      'SELECT COUNT(*) AS c FROM cached_images;',
    );
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}
