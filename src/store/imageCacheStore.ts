/**
 * Zustand store exposing the image-cache aggregate state held by the
 * per-row `cached_images` SQLite table.
 *
 * The old version of this store persisted its own totalBytes/fileCount
 * aggregates via `persist(createJSONStorage(kvStorage))`. Those are now
 * derived from SQL on every launch via `hydrateFromDbAsync()` and kept in sync
 * by service-layer callers invoking `recalculateFromDb()` after any
 * variant write or delete. `fileCount` used to double as both "files on
 * disk" and "logical images" — we now expose both explicitly plus a
 * count of covers that are missing one or more variants.
 *
 * `maxConcurrentImageDownloads` is a user setting, not cache state, so it
 * lives in a separate tiny KV blob (`substreamer-image-cache-settings`),
 * same pattern as `musicCacheStore`.
 */
import { create } from 'zustand';

import { hydrateImageCacheAggregatesAsync } from './persistence/imageCacheTable';
// Synchronous adapter: the settings blob is read via a synchronous helper;
// the aggregates hydrate via async SQL (see hydrateFromDbAsync).
import { kvStorageSync as kvStorage } from './persistence';

export type MaxConcurrentImageDownloads = 1 | 3 | 5 | 10;

const SETTINGS_KEY = 'substreamer-image-cache-settings';

/**
 * Monotonic token for `recalculateFromDb`. Because the recalc read is async and
 * fire-and-forget, several can be in flight at once (concurrent download
 * completions). We stamp each call and only apply the result if it's still the
 * latest — so an older, slower scan can't clobber a newer aggregate.
 */
let recalcToken = 0;
const DEFAULT_MAX_CONCURRENT: MaxConcurrentImageDownloads = 5;

interface ImageCacheSettings {
  maxConcurrentImageDownloads: MaxConcurrentImageDownloads;
  /** Timestamp of the last successful FS↔SQL reconcile, epoch ms.
   *  Consumed by imageCacheService to throttle reconcile to once per
   *  week in the deferred-init path. Undefined = never run. */
  lastReconcileMs?: number;
}

function readSettingsBlob(): ImageCacheSettings {
  const raw = kvStorage.getItem(SETTINGS_KEY) as string | null;
  if (raw === null) {
    return { maxConcurrentImageDownloads: DEFAULT_MAX_CONCURRENT };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ImageCacheSettings>;
    const max = parsed?.maxConcurrentImageDownloads;
    const validated: ImageCacheSettings = {
      maxConcurrentImageDownloads:
        max === 1 || max === 3 || max === 5 || max === 10
          ? max
          : DEFAULT_MAX_CONCURRENT,
    };
    if (typeof parsed?.lastReconcileMs === 'number' && parsed.lastReconcileMs > 0) {
      validated.lastReconcileMs = parsed.lastReconcileMs;
    }
    return validated;
  } catch {
    return { maxConcurrentImageDownloads: DEFAULT_MAX_CONCURRENT };
  }
}

function writeSettingsBlob(settings: ImageCacheSettings): void {
  try {
    kvStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* dropped — next launch falls back to defaults */
  }
}

/**
 * Return the epoch-ms timestamp of the last successful image-cache
 * reconcile, or undefined when one has never completed. Consumed by the
 * service's deferred-init throttle.
 */
export function getLastReconcileMs(): number | undefined {
  return readSettingsBlob().lastReconcileMs;
}

/**
 * Persist the timestamp of a just-completed reconcile pass. Merges with
 * the existing settings blob so unrelated fields (e.g. the concurrency
 * limit) aren't clobbered.
 */
export function markReconcileRan(ts: number): void {
  const existing = readSettingsBlob();
  writeSettingsBlob({ ...existing, lastReconcileMs: ts });
}

export interface ImageCacheState {
  /** Sum of every variant file's size on disk, in bytes. */
  totalBytes: number;
  /** COUNT(*) — total variant files across every cover. */
  fileCount: number;
  /** COUNT(DISTINCT cover_art_id) — unique logical images. */
  imageCount: number;
  /** Covers with fewer than 4 variants on disk. */
  incompleteCount: number;
  /** Max number of images to download concurrently. Persisted separately. */
  maxConcurrentImageDownloads: MaxConcurrentImageDownloads;
  /** True after the initial SQL aggregate read has populated the store. */
  hasHydrated: boolean;

  /** Re-read every aggregate from SQL on a background native thread (async, so
   *  it never blocks the JS thread). Called by the service layer after writes.
   *  Fire-and-forget; overlapping calls are reconciled latest-wins. */
  recalculateFromDb: () => Promise<void>;
  /** Called once at app start via `rehydrateAllStores()`. Pulls aggregates
   *  from SQL (background thread) and reads the maxConcurrent setting from the
   *  KV blob. */
  hydrateFromDbAsync: () => Promise<void>;
  /** Zero every aggregate in memory. Used by `clearImageCache` /
   *  `resetAllStores` after the underlying rows are dropped. */
  reset: () => void;
  /** Persist and apply a new concurrency limit. */
  setMaxConcurrentImageDownloads: (max: MaxConcurrentImageDownloads) => void;
}

export const imageCacheStore = create<ImageCacheState>()((set) => ({
  totalBytes: 0,
  fileCount: 0,
  imageCount: 0,
  incompleteCount: 0,
  maxConcurrentImageDownloads: DEFAULT_MAX_CONCURRENT,
  hasHydrated: false,

  recalculateFromDb: async () => {
    const token = ++recalcToken;
    const agg = await hydrateImageCacheAggregatesAsync();
    // A newer recalc started while this scan was running — discard the stale
    // result so we don't overwrite fresher aggregates.
    if (token !== recalcToken) return;
    set({
      totalBytes: agg.totalBytes,
      fileCount: agg.fileCount,
      imageCount: agg.imageCount,
      incompleteCount: agg.incompleteCount,
    });
  },

  hydrateFromDbAsync: async () => {
    const agg = await hydrateImageCacheAggregatesAsync();
    const { maxConcurrentImageDownloads } = readSettingsBlob();
    set({
      totalBytes: agg.totalBytes,
      fileCount: agg.fileCount,
      imageCount: agg.imageCount,
      incompleteCount: agg.incompleteCount,
      maxConcurrentImageDownloads,
      hasHydrated: true,
    });
  },

  reset: () => {
    // Invalidate any in-flight async recalc so a stale scan can't repopulate
    // the aggregates after the rows have been dropped.
    recalcToken++;
    set({
      totalBytes: 0,
      fileCount: 0,
      imageCount: 0,
      incompleteCount: 0,
    });
  },

  setMaxConcurrentImageDownloads: (max) => {
    const existing = readSettingsBlob();
    writeSettingsBlob({ ...existing, maxConcurrentImageDownloads: max });
    set({ maxConcurrentImageDownloads: max });
  },
}));
