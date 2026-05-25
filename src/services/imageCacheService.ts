/**
 * Persistent on-disk image cache service.
 *
 * Stores cover art images in {Paths.document}/image-cache/ so they
 * survive app updates and are not purged by the OS.
 *
 * Each cover art ID gets its own subdirectory containing up to 4 size
 * variants (50, 150, 300, 600):
 *
 *   image-cache/{coverArtId}/50.jpg
 *   image-cache/{coverArtId}/150.jpg
 *   image-cache/{coverArtId}/300.jpg
 *   image-cache/{coverArtId}/600.jpg
 *
 * Only the 600px source is downloaded from the server. Smaller
 * variants (300, 150, 50) are generated locally using
 * expo-image-manipulator.
 *
 * Downloads are queued and processed with configurable concurrency,
 * mirroring the pattern used by musicCacheService. Incomplete (.tmp)
 * files are cleaned up on startup and resume from background, and
 * their items are re-queued.
 */

import { Directory, File, Paths } from 'expo-file-system';
import { AppState, type AppStateStatus } from 'react-native';
import { fetch } from 'expo/fetch';

import { listDirectoryAsync } from 'expo-async-fs';
import { resizeImageToFileAsync } from 'expo-image-resize';
import {
  getFsKeyMigrationDone,
  getLastReconcileMs,
  imageCacheStore,
  markFsKeyMigrationDone,
  markReconcileRan,
} from '../store/imageCacheStore';
import { authStore } from '../store/authStore';
import { connectivityStore } from '../store/connectivityStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { fireAndForget } from '../utils/fireAndForget';
import {
  bulkInsertCachedImages,
  type CachedImageEntry as DbCachedImageEntry,
  clearAllCachedImages,
  deleteCachedImageVariant,
  deleteCachedImagesForCoverArt,
  findIncompleteCovers,
  getAllCachedCoverArtIds,
  hasCachedImage as dbHasCachedImage,
  hydrateImageCacheAggregates,
  listCachedImagesForBrowser,
  upsertCachedImage,
  type CacheBrowserFilter,
} from '../store/persistence/imageCacheTable';
import {
  clearImageQueueByCycle,
  countImageQueueRowsByCycle,
  countImageQueueRowsByStatus,
  enqueueImagesBulk,
  type ImageDownloadQueueRow,
  type ImageDownloadQueueScope,
  markImageDownloading,
  markImageError,
  pickNextQueuedImageRow,
  removeImageFromQueue,
  resetErrorRowsForCycle,
  resetStalledImageRows,
} from '../store/persistence/imageDownloadQueueTable';
import { kvStorage } from '../store/persistence';
import { awaitFirstPing } from './connectivityService';
import { logImageCache } from './imageCacheLogger';
import {
  ensureCoverArtAuth,
  getCoverArtUrl,
} from './subsonicService';

// Sentinel cover-art IDs rendered from bundled assets via
// `CachedImage.tsx`, never downloaded. Inlined here (not imported)
// because the canonical `STARRED_COVER_ART_ID` lives in
// `musicCacheService.ts` which already imports from this module
// (cycle), and `VARIOUS_ARTISTS_COVER_ART_ID` from `subsonicService`
// is auto-nulled by jest.mock in the test file. Drift risk is low:
// these strings are baked into multiple layers (backup format, UI
// code, tests).
const SENTINEL_COVER_ART_IDS: ReadonlySet<string> = new Set([
  '__starred_cover__',
  '__various_artists_cover__',
]);

function isSentinelCoverArtId(coverArtId: string): boolean {
  return SENTINEL_COVER_ART_IDS.has(coverArtId);
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** All image size tiers used across the app. */
export const IMAGE_SIZES = [50, 150, 300, 600] as const;

/** Largest variant — also the server-side source we download. Exported
 *  so CachedImage can use it as a fallback when a smaller variant URL
 *  fails server-side. */
export const SOURCE_SIZE = 600;

/** Sizes generated locally from the SOURCE_SIZE image. */
const RESIZE_SIZES = [300, 150, 50] as const;

/** Supported extensions ordered by likelihood. */
const EXTENSIONS = ['.jpg', '.png', '.webp'] as const;

/** Map Content-Type to file extension. */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** JPEG quality for locally generated resize variants. */
const RESIZE_COMPRESS = 0.9;

/* ------------------------------------------------------------------ */
/*  Module state                                                       */
/* ------------------------------------------------------------------ */

let cacheDir: Directory | null = null;
let isProcessing = false;
let appStateSubscription: { remove: () => void } | null = null;

/** CoverArtIds currently being downloaded/resized by a worker. */
const downloading = new Set<string>();

/** Ordered queue of coverArtIds waiting to be processed. */
const downloadQueue: string[] = [];

/**
 * Promise resolvers keyed by coverArtId. When a download finishes
 * (or is skipped), all registered resolvers for that ID are called
 * so callers of cacheAllSizes() are notified.
 */
const pendingResolvers = new Map<string, (() => void)[]>();

/**
 * In-memory URI cache: avoids repeated synchronous filesystem lookups
 * for the same coverArtId + size combination. Keyed by "coverArtId:size".
 */
const uriCache = new Map<string, string | null>();

/* ------------------------------------------------------------------ */
/*  Cache-update subscriptions                                          */
/* ------------------------------------------------------------------ */

/**
 * Per-coverArtId listener registry. When a cover art download or resize
 * lands a new file on disk, every subscriber for that coverArtId is
 * notified so it can re-derive its cached URI.
 *
 * Motivation: CachedImage instances on the home screen sometimes "give
 * up" on a flaky cover after two server errors and sit on the
 * placeholder. Later, the same coverArtId may successfully download via
 * a different code path — e.g. the user navigates to the album-detail
 * hero which retriggers cacheAllSizes from a fresh CachedImage mount,
 * and that attempt succeeds (server-side transient cleared). Without
 * the subscription, the placeholder card has no way to learn about the
 * new file landing on disk. With it, the card auto-refreshes as soon
 * as any subsequent download completes for its coverArtId.
 */
const cacheUpdateListeners = new Map<string, Set<() => void>>();

/**
 * Subscribe to cache-update events for a specific coverArtId. The
 * listener fires exactly once per (download-success OR resize-success)
 * event after subscribing — fire-and-forget; the listener is
 * responsible for calling `getCachedImageUri` to read the new state.
 *
 * Returns an unsubscribe function. Safe to call from useEffect.
 */
export function subscribeImageCacheUpdate(
  coverArtId: string,
  listener: () => void,
): () => void {
  if (!coverArtId) return () => {};
  let listeners = cacheUpdateListeners.get(coverArtId);
  if (!listeners) {
    listeners = new Set();
    cacheUpdateListeners.set(coverArtId, listeners);
  }
  listeners.add(listener);
  return () => {
    const set = cacheUpdateListeners.get(coverArtId);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) cacheUpdateListeners.delete(coverArtId);
  };
}

/**
 * Notify all subscribers for a coverArtId. Called from the source-
 * download success path and from generateResizedVariant's success path.
 * Listener exceptions are swallowed so one bad subscriber can't poison
 * the rest.
 */
function notifyImageCacheUpdate(coverArtId: string): void {
  const listeners = cacheUpdateListeners.get(coverArtId);
  if (!listeners || listeners.size === 0) return;
  for (const listener of listeners) {
    try { listener(); } catch { /* swallow */ }
  }
}

function uriCacheKey(coverArtId: string, size: number): string {
  return `${coverArtId}:${size}`;
}

/**
 * Characters that are either reserved on some filesystems (Windows:
 * `\/:*?"<>|`; legacy macOS: `:`) or otherwise troublesome in URIs.
 * Encoded as `%HH` (uppercase hex) before the coverArtId is used as an
 * on-disk directory name. `%` is included in the unsafe set so the
 * encoding is its own inverse — every distinct coverArtId maps to a
 * distinct on-disk path. The original coverArtId is still used
 * everywhere else (server URLs, SQL rows, URI cache keys) so server
 * and DB keys stay verbatim.
 *
 * Today's notable target is the OpenSubsonic/Navidrome disc-cover
 * format `dc-xxxx:N`, which gets sanitised to `dc-xxxx%3AN` on disk
 * while remaining `dc-xxxx:N` in SQL rows and getCoverArt URLs.
 */
const FS_UNSAFE_CHARS = /[%:\\/?<>*|"\x00]/g;

function coverArtPathKey(coverArtId: string): string {
  return coverArtId.replace(FS_UNSAFE_CHARS, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'),
  );
}

/** Evict every size's URI-cache entry for a coverArtId. Call at every
 *  cleanup site that removes files from disk so a subsequent
 *  getCachedImageUri doesn't return a stale URI pointing at nothing. */
function evictUriCacheForCover(coverArtId: string): void {
  for (const size of IMAGE_SIZES) uriCache.delete(uriCacheKey(coverArtId, size));
}

/**
 * Gate for "is it safe to forcibly delete a cache row right now?"
 * True only when we have positive signal that the server is responding
 * normally — so a failure we just observed can be confidently attributed
 * to the row itself rather than to the network path. Used at every
 * decision point that would otherwise purge a row based on an observed
 * failure.
 *
 * False when:
 *   - User is in offline mode (we agreed not to talk to the server).
 *   - Internet is reported unreachable by NetInfo.
 *   - Server is reported unreachable by the connectivity ping.
 *
 * If we observed an HTTP response from the server (any status), the
 * server proved itself responsive in that exact moment — but we still
 * route through this gate to err on the side of preserving rows when
 * the connectivity store disagrees.
 */
function isPurgeAllowedNow(): boolean {
  const conn = connectivityStore.getState();
  const offline = offlineModeStore.getState().offlineMode;
  return !offline && conn.isInternetReachable && conn.isServerReachable;
}

/**
 * Delete every on-disk variant and DB row for a coverArtId, and evict
 * its URI-cache entries. Used by the sentinel sweep, the 404 short-
 * circuit, the source-download connectivity-gated purge, and the
 * variant-resize threshold purge.
 */
function purgeCoverArtRows(coverArtId: string): { files: number } {
  const result = deleteCachedImagesForCoverArt(coverArtId);
  try {
    const subDir = new Directory(ensureCacheDir(), coverArtPathKey(coverArtId));
    if (subDir.exists) {
      for (const size of IMAGE_SIZES) {
        for (const ext of EXTENSIONS) {
          const file = new File(subDir, `${size}${ext}`);
          if (file.exists) {
            try { file.delete(); } catch { /* best-effort */ }
          }
        }
      }
    }
  } catch {
    /* best-effort — DB is the source of truth */
  }
  for (const s of IMAGE_SIZES) uriCache.delete(uriCacheKey(coverArtId, s));
  variantFailureCount.delete(coverArtId);
  return { files: result.count };
}

/**
 * Remove any cached_images rows + on-disk files for the sentinel cover
 * IDs (`__starred_cover__`, `__various_artists_cover__`). Their images
 * are bundled with the app — CachedImage renders them from the asset
 * resolver, never from the disk cache — so any rows here are stale from
 * a prior app version and will otherwise show up as permanently
 * "Incomplete" because getCoverArtUrl returns null for them.
 *
 * Returns the number of sentinel coverArtIds that had rows (0–2). Safe
 * to call multiple times — idempotent after the first run.
 */
/**
 * One-shot migration: rename any `{image-cache}/*` subdirectory whose
 * name contains a filesystem-hostile char (`:` etc.) to the sanitised
 * form produced by {@link coverArtPathKey}. If a sanitised sibling dir
 * already exists, move the raw-form's variant files into it (skipping
 * collisions) before deleting the now-empty original.
 *
 * Gated by the `fsKeyMigrationV1Done` flag in the image-cache settings
 * blob so it runs at most once per install. No-op on a fresh install
 * (no raw-form dirs exist).
 */
async function migrateFsHostileCacheDirs(): Promise<void> {
  if (getFsKeyMigrationDone()) return;
  let dir: Directory;
  try {
    dir = ensureCacheDir();
  } catch {
    return;
  }
  if (!dir.exists) {
    markFsKeyMigrationDone();
    return;
  }

  let topLevel: string[];
  try {
    topLevel = await listDirectoryAsync(dir.uri);
  } catch {
    // Can't enumerate — leave the flag unset so a later session can retry.
    return;
  }

  for (const name of topLevel) {
    if (!name) continue;
    const sanitised = coverArtPathKey(name);
    if (sanitised === name) continue; // nothing to do

    const src = new Directory(dir, name);
    if (!src.exists) continue;

    const dst = new Directory(dir, sanitised);
    if (!dst.exists) {
      // Simple rename — delete/create isn't exposed; copy each file
      // across then remove the source dir.
      try { dst.create(); } catch { continue; }
    }

    let fileNames: string[] = [];
    try {
      fileNames = await listDirectoryAsync(src.uri);
    } catch {
      continue;
    }
    for (const fileName of fileNames) {
      const srcFile = new File(src, fileName);
      if (!srcFile.exists) continue;
      const dstFile = new File(dst, fileName);
      if (dstFile.exists) {
        // Collision — the sanitised dir already had this variant. Keep
        // the existing file (it's newer or at least already indexed by
        // SQL) and drop the raw-form's copy.
        try { srcFile.delete(); } catch { /* best-effort */ }
        continue;
      }
      try { srcFile.moveSync(dstFile); } catch { /* best-effort */ }
    }

    // Attempt to remove the now-empty src dir.
    try { src.delete(); } catch { /* best-effort */ }
  }

  markFsKeyMigrationDone();
}

function sweepSentinelRows(): number {
  let cleared = 0;
  let totalFiles = 0;
  for (const id of SENTINEL_COVER_ART_IDS) {
    const { files } = purgeCoverArtRows(id);
    if (files > 0) cleared++;
    totalFiles += files;
  }
  if (totalFiles > 0) {
    imageCacheStore.getState().recalculateFromDb();
  }
  return cleared;
}

/* ------------------------------------------------------------------ */
/*  Initialisation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Create the image-cache directory under Paths.document and register
 * the AppState listener for resume-from-background cleanup.
 * Safe to call multiple times (no-ops if already initialised).
 *
 * Expensive scanning (stalled-download recovery, deduplication) is
 * NOT performed here — call {@link deferredImageCacheInit} after the
 * first React frame to avoid blocking the native splash screen.
 */
export function initImageCache(): void {
  if (cacheDir) return;
  // Wrap in try/catch because this is invoked at module-scope from
  // _layout.tsx, before any React error boundary is mounted. On stripped
  // OEM ROMs the synchronous Directory.create() can throw with restricted
  // storage permissions, and an unhandled throw here would crash the JS
  // bundle before the user can even reach the login screen. If init fails
  // here, cacheDir stays null and downstream callers will hit a controlled
  // null deref inside React, where an error boundary CAN catch it.
  try {
    const dir = new Directory(Paths.document, 'image-cache');
    if (!dir.exists) {
      dir.create();
    }
    cacheDir = dir;

    if (!appStateSubscription) {
      appStateSubscription = AppState.addEventListener('change', (next: AppStateStatus) => {
        if (next === 'active') {
          // Wait for the post-resume ping result so the repair pass uses
          // confirmed connectivity state. AppState 'active' triggers a
          // ping in connectivityService; we await its outcome here.
          fireAndForget(
            (async () => {
              if (offlineModeStore.getState().offlineMode) return;
              await awaitFirstPing();
              if (offlineModeStore.getState().offlineMode) return;
              await repairIncompleteImagesAsync('appstate-active');
            })(),
            'imageCache.appStateActive',
          );
        }
      });
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[imageCacheService] initImageCache failed:', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Unregister the AppState listener and clear cached module state.
 * Called from `resetAllStores()` on logout so a background→foreground
 * transition while logged out doesn't fire recovery against a reset store.
 * The next login re-arms the listener via `initImageCache()`.
 */
export function teardownImageCache(): void {
  appStateSubscription?.remove();
  appStateSubscription = null;
  cacheDir = null;
}

/**
 * Run the expensive post-launch work that was split out of
 * {@link initImageCache} to avoid blocking app startup. Should be called
 * once after the first React frame renders.
 *
 * Order matters:
 *   1. `reconcileImageCacheAsync` heals FS↔SQL drift before anything else
 *      reads cache state. Without it, orphan files or missing rows would
 *      confuse the incomplete-detection query.
 *   2. `repairIncompleteImagesAsync` sweeps stale `.tmp` files and
 *      re-queues any covers SQL now reports as incomplete.
 *
 * All filesystem work runs via expo-async-fs, keeping the JS thread free.
 */
/** Reconcile only runs once per this interval in the deferred-init path.
 *  Manual triggers from Settings always run regardless of this throttle. */
const RECONCILE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * True when the last successful reconcile is missing or older than
 * RECONCILE_INTERVAL_MS. Only consulted by the deferred-init path —
 * user-initiated scans from Settings call `reconcileImageCacheAsync`
 * directly and bypass this check entirely.
 */
function shouldRunReconcile(): boolean {
  const last = getLastReconcileMs();
  if (last == null) return true;
  return Date.now() - last >= RECONCILE_INTERVAL_MS;
}

export function deferredImageCacheInit(): Promise<void> {
  // Defer to an idle window so the reconcile/repair FS passes never
  // compete with first-render or initial animations. requestIdleCallback
  // is polyfilled by RN (used elsewhere in dataSyncService, useTransitionComplete).
  return new Promise((resolve) => {
    requestIdleCallback(async () => {
      try {
        // One-shot migration: rename any cache subdirs containing FS-
        // hostile chars (e.g. Navidrome disc IDs like `dc-xxxx:1`) to
        // the sanitised form before reconcile walks the tree.
        await migrateFsHostileCacheDirs();

        // Always sweep sentinel rows, even offline — it's a pure SQL +
        // local-file cleanup and prevents the Settings "Incomplete"
        // count from permanently including rows the download pipeline
        // can never service.
        sweepSentinelRows();

        if (shouldRunReconcile()) {
          await reconcileImageCacheAsync('startup');
        }

        // Repair is non-blocking from here. The startup chain in
        // _layout.tsx awaits this function before running music cache
        // init and data sync init — gating those on connectivity would
        // be wrong. Spin off the repair so the home screen renders
        // immediately and repair runs silently once the connectivity
        // service has produced its first definitive ping result.
        if (!offlineModeStore.getState().offlineMode) {
          fireAndForget(
            (async () => {
              await awaitFirstPing();
              // Re-check offline mode in case the user toggled it during
              // the wait. Belt-and-braces: isPurgeAllowedNow() also
              // checks per-failure inside the repair pass.
              if (offlineModeStore.getState().offlineMode) return;
              await repairIncompleteImagesAsync('startup');
            })(),
            'imageCache.startupRepair',
          );
        }
      } finally {
        // Always resolve — this is a best-effort init, same contract as
        // the previous direct-await implementation.
        resolve();
      }
    });
  });
}

// Auto-resume repair when the user toggles back online. An in-flight
// offline session can accumulate incomplete covers (downloads that were
// mid-variant when the app went offline); the moment connectivity is
// back we want to clear them without making the user open Settings.
offlineModeStore.subscribe((state, prev) => {
  if (state.offlineMode === prev.offlineMode) return;
  if (state.offlineMode) return;
  if (imageCacheStore.getState().incompleteCount <= 0) return;
  // _layout.tsx restarts connectivity monitoring on offline→online; wait
  // for the first post-resume ping so the repair pass acts on confirmed
  // server state rather than the optimistic default.
  fireAndForget(
    (async () => {
      await awaitFirstPing();
      if (offlineModeStore.getState().offlineMode) return;
      await repairIncompleteImagesAsync('offline-resume');
    })(),
    'imageCache.offlineResume',
  );
});

/**
 * Heal drift between the `cached_images` table and the on-disk layout.
 *
 *   - **FS → SQL.** Walk `{image-cache}/{coverArtId}/*` once; for every
 *     real variant file missing a DB row, insert one. Uses file size for
 *     bytes and `Date.now()` for cachedAt (mtime isn't always available
 *     via expo-file-system).
 *   - **SQL → FS.** For every DB row whose file doesn't exist on disk,
 *     delete the row. Handles external removal (iTunes wipe, low-storage
 *     cleanup, manual `rm`).
 *   - Safety gate: if the walk's apparent "missing from SQL" count
 *     dwarfs what we already know about (>100 entries AND the table was
 *     non-empty), log and skip — almost certainly a transient filesystem
 *     issue (cache dir mid-init, security-scoped URL failure), and
 *     wiping a correct DB to match a broken FS view would be worse.
 */
export async function reconcileImageCacheAsync(source: string = 'auto'): Promise<void> {
  const dir = ensureCacheDir();
  if (!dir.exists) {
    logImageCache(`reconcile abort source=${source} reason=cache-dir-missing`);
    return;
  }

  let topLevelNames: string[];
  try {
    topLevelNames = await listDirectoryAsync(dir.uri);
  } catch (e) {
    logImageCache(`reconcile abort source=${source} reason=list-failed err=${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  logImageCache(`reconcile start source=${source} top-level-dirs=${topLevelNames.length}`);

  const preAggregate = hydrateImageCacheAggregates();
  const newRows: Array<{
    coverArtId: string;
    size: number;
    ext: string;
    bytes: number;
    cachedAt: number;
  }> = [];
  // Track the (coverArtId, size) pairs we observe on disk so Pass 2 can
  // ignore rows that match real files. Seed from the new rows too so
  // Pass 2 doesn't delete rows we just queued for insert.
  const seenOnDisk = new Set<string>();
  const diskKey = (coverArtId: string, size: number) => `${coverArtId}::${size}`;

  // Reverse-map from the on-disk (sanitised) directory name back to the
  // SQL-canonical coverArtId so Pass 1 doesn't fork a duplicate row when
  // a pre-existing SQL entry (e.g. `dc-abc:1`) lives under the migrated
  // dir `dc-abc_1`. Built once from the current SQL view.
  const sqlIdByDirName = new Map<string, string>();
  for (const entry of listCachedImagesForBrowser('all')) {
    const dirName = coverArtPathKey(entry.coverArtId);
    // If two SQL ids collide on the same sanitised dir (should be rare),
    // prefer one that contains FS-unsafe chars — it's the "original" form.
    const existing = sqlIdByDirName.get(dirName);
    if (!existing || existing === dirName) {
      sqlIdByDirName.set(dirName, entry.coverArtId);
    }
  }

  // --- Pass 1: FS -> SQL (discover missing rows) ---
  for (const dirName of topLevelNames) {
    if (!dirName) continue;
    const subDir = new Directory(dir, dirName);
    if (!subDir.exists) continue;
    // Resolve the dir name back to its SQL-canonical coverArtId so we
    // upsert into the existing row family rather than a parallel one.
    const coverArtId = sqlIdByDirName.get(dirName) ?? dirName;
    let fileNames: string[] = [];
    try {
      fileNames = await listDirectoryAsync(subDir.uri);
    } catch {
      continue;
    }
    for (const name of fileNames) {
      if (!name || name.endsWith('.tmp')) continue;
      const match = /^(50|150|300|600)\.(jpg|png|webp)$/.exec(name);
      if (!match) continue;
      const size = Number(match[1]);
      const ext = match[2];
      const file = new File(subDir, name);
      if (!file.exists) continue;
      // A zero-byte finalised file is the signature of a crashed write
      // (e.g. ENOSPC between rename and content write, or a kill after
      // the move but before the bytes landed). RNImage renders nothing
      // for it, so delete it here — Pass 2 then drops any stale DB row.
      if ((file.size ?? 0) === 0) {
        try { file.delete(); } catch { /* best-effort */ }
        uriCache.delete(uriCacheKey(coverArtId, size));
        continue;
      }
      seenOnDisk.add(diskKey(coverArtId, size));
      if (dbHasCachedImage(coverArtId, size)) continue;
      newRows.push({
        coverArtId,
        size,
        ext,
        bytes: file.size ?? 0,
        cachedAt: Date.now(),
      });
    }
  }

  // Safety gate against filesystem-unavailable false-positive inserts.
  // A large `newRows` alongside a non-trivial existing table means the
  // table and the FS disagree wildly — treat as suspicious and skip.
  const isMassInsert = newRows.length > 100 && preAggregate.fileCount > 50;
  if (!isMassInsert && newRows.length > 0) {
    bulkInsertCachedImages(newRows);
    logImageCache(`reconcile pass1 inserted=${newRows.length}`);
  } else if (isMassInsert) {
    // eslint-disable-next-line no-console
    console.warn(
      `[reconcileImageCacheAsync] safety gate: ${newRows.length} would-be inserts ` +
        `vs ${preAggregate.fileCount} rows already present — skipping FS→SQL sync this run`,
    );
    logImageCache(
      `reconcile pass1 safety-gate would-insert=${newRows.length} pre-rows=${preAggregate.fileCount}`,
    );
  } else {
    logImageCache('reconcile pass1 no-new-rows');
  }

  // --- Pass 2: SQL -> FS (drop rows whose files are gone or empty) ---
  // Walk the DB's view; delete any row whose file wasn't observed on disk
  // or whose file exists but is zero bytes (crashed write). Guarded by
  // the same mass-missing heuristic — a temporarily-missing cache
  // directory shouldn't wipe the table.
  if (!isMassInsert) {
    const post = listCachedImagesForBrowser('all');
    let droppedCount = 0;
    for (const entry of post) {
      for (const file of entry.files) {
        if (seenOnDisk.has(diskKey(entry.coverArtId, file.size))) continue;
        // Disk paths are sanitised; SQL rows keep the original coverArtId.
        const subDir = new Directory(dir, coverArtPathKey(entry.coverArtId));
        const onDisk = new File(subDir, `${file.size}.${file.ext}`);
        if (onDisk.exists) {
          // Belt-and-braces: if Pass 1 missed a zero-byte file (e.g.
          // listDirectoryAsync failed for that subdir), catch it here.
          if ((onDisk.size ?? 0) === 0) {
            try { onDisk.delete(); } catch { /* best-effort */ }
            deleteCachedImageVariant(entry.coverArtId, file.size);
            uriCache.delete(uriCacheKey(entry.coverArtId, file.size));
            droppedCount++;
          }
          continue;
        }
        deleteCachedImageVariant(entry.coverArtId, file.size);
        uriCache.delete(uriCacheKey(entry.coverArtId, file.size));
        droppedCount++;
      }
    }
    logImageCache(`reconcile pass2 dropped=${droppedCount}`);
    // Always recalc at the end so callers don't have to. If neither pass
    // changed anything, this is a cheap aggregate query that re-syncs
    // the store with the unchanged DB — safe to over-call.
    imageCacheStore.getState().recalculateFromDb();

    // Timestamp the successful pass so the deferred-init throttle can
    // skip this work on the next launch. Only written when the safety
    // gate did NOT trip — otherwise we'd lock in a 7-day skip on a
    // transient filesystem issue.
    markReconcileRan(Date.now());
  } else {
    // Mass-insert safety gate fired — still recalc so the store mirrors
    // the (unchanged) DB and the spinner shows real numbers.
    imageCacheStore.getState().recalculateFromDb();
  }
}

/** Return the initialised cache directory (auto-inits if needed). */
function ensureCacheDir(): Directory {
  if (!cacheDir) initImageCache();
  return cacheDir!;
}

/* ------------------------------------------------------------------ */
/*  Startup / resume recovery                                          */
/* ------------------------------------------------------------------ */

/**
 * Clean up any abandoned `.tmp` files left from a crashed download or
 * variant generation, then re-queue every cover-art ID that's missing
 * one or more size variants on disk.
 *
 * The "incomplete" check used to walk every subdirectory; it now runs
 * as one SQL query (`findIncompleteCovers`). The `.tmp` sweep still
 * walks — `.tmp` files aren't in the DB by design, and a full tree
 * walk catches any that accumulated before the DB row was written.
 *
 * Exposed to the UI as the "Repair" action (settings-storage card +
 * image-cache browser row badge); also fires automatically at launch
 * post-splash and on resume-from-background via AppState.
 */
/**
 * Outcome counts from a repair pass. The Settings UI surfaces this as
 * a toast; tests assert on the individual counts.
 */
export interface RepairOutcome {
  /** Incomplete coverArtIds found when the pass started (post-sentinel-sweep). */
  queued: number;
  /** Covers whose 4 variants are all present on disk after the pass. */
  repaired: number;
  /** Covers still missing one or more variants (transient errors, etc.). */
  failed: number;
  /** Covers whose rows were deleted — sentinel sweep + 404 + 3×-failure. */
  removed: number;
}

export async function repairIncompleteImagesAsync(source: string = 'auto'): Promise<RepairOutcome> {
  logImageCache(`repair start source=${source}`);
  // 1. Sentinel sweep first — these should never have rows. Their count
  //    does NOT enter `queued` (which only covers the user-actionable
  //    incomplete set) but it does add to `removed` so the toast can
  //    report "2 sentinels removed".
  const sentinelCoversCleared = sweepSentinelRows();
  logImageCache(`repair sentinel-sweep cleared=${sentinelCoversCleared}`);

  // 2. .tmp sweep — clean up abandoned half-writes from previous sessions
  //    or crashes before re-queuing anything.
  const dir = ensureCacheDir();
  let subDirNames: string[];
  try {
    subDirNames = await listDirectoryAsync(dir.uri);
  } catch {
    subDirNames = [];
  }
  let tmpDeleted = 0;
  for (const coverArtId of subDirNames) {
    if (!coverArtId) continue;
    const subDir = new Directory(dir, coverArtId);
    if (!subDir.exists) continue;
    let fileNames: string[] = [];
    try {
      fileNames = await listDirectoryAsync(subDir.uri);
    } catch {
      continue;
    }
    for (const name of fileNames) {
      if (!name.endsWith('.tmp')) continue;
      try { new File(subDir, name).delete(); tmpDeleted++; } catch { /* best-effort */ }
    }
  }
  logImageCache(`repair tmp-sweep deleted=${tmpDeleted} top-level-dirs=${subDirNames.length}`);

  // 3. Re-queue and AWAIT completion for each incomplete cover. We use
  //    cacheAllSizes() rather than poking downloadQueue + processQueue()
  //    directly: cacheAllSizes returns a per-coverArtId promise that
  //    resolves in processNext's finally block via resolveWaiters(), so
  //    Promise.all below gives us a real "repair-done" signal that the
  //    Settings overlay can hook into.
  const snapshot = findIncompleteCovers().filter(
    (id) => !isSentinelCoverArtId(id),  // sentinels already handled in step 1
  );
  const queued = snapshot.length;
  logImageCache(`repair incomplete-snapshot queued=${queued} ids=[${snapshot.slice(0, 20).join(',')}${queued > 20 ? `,…+${queued - 20}` : ''}]`);

  if (queued === 0) {
    logImageCache(`repair done queued=0 sentinels-removed=${sentinelCoversCleared}`);
    imageCacheStore.getState().recalculateFromDb();
    return {
      queued: 0,
      repaired: 0,
      failed: 0,
      removed: sentinelCoversCleared,
    };
  }

  await Promise.all(
    snapshot.map((id) =>
      cacheAllSizes(id).catch(() => { /* per-cover failure reported below */ }),
    ),
  );

  // 4. Classify each original coverArtId by its post-pass state in SQL.
  const afterIncomplete = new Set(findIncompleteCovers());
  let repaired = 0;
  let failed = 0;
  let removedDuringRepair = 0;
  for (const id of snapshot) {
    if (afterIncomplete.has(id)) {
      // Still incomplete — transient failure (offline mid-repair, single
      // 5xx below the 3× threshold, etc.). Will retry on next launch.
      failed++;
      logImageCache(`repair classify id=${id} still-incomplete`);
    } else {
      // Either all 4 variants present → repaired, or all rows gone →
      // purged by the 404/3×-failure circuit breaker.
      const has600 = dbHasCachedImage(id, SOURCE_SIZE);
      if (has600) {
        repaired++;
        logImageCache(`repair classify id=${id} repaired`);
      } else {
        removedDuringRepair++;
        logImageCache(`repair classify id=${id} purged`);
      }
    }
  }

  logImageCache(
    `repair done queued=${queued} repaired=${repaired} failed=${failed} removed=${sentinelCoversCleared + removedDuringRepair}`,
  );
  // Final recalc so the store mirrors the post-repair DB. Internal
  // cacheAllSizes paths recalc on each cover, but a final aggregate
  // snapshot guarantees the spinner-completion UI shows real numbers
  // rather than the last in-flight value.
  imageCacheStore.getState().recalculateFromDb();
  return {
    queued,
    repaired,
    failed,
    removed: sentinelCoversCleared + removedDuringRepair,
  };
}

/* ------------------------------------------------------------------ */
/*  Cache lookup (synchronous)                                         */
/* ------------------------------------------------------------------ */

/**
 * Check if a cached image exists for the given coverArtId and size.
 * Returns the local `file://` URI or `null`.
 *
 * Caching policy: only POSITIVE lookups are memoised in `uriCache`. A
 * miss (file not on disk) re-checks the filesystem on every call.
 * Caching nulls was the root cause of "covers vanish after a download"
 * — once a row was poisoned with null (via a transient FS hiccup, an
 * eviction by a sibling code path, or a never-completed download), the
 * map returned null forever even after the file had been written. The
 * cost of re-checking on miss is one sync `file.exists` per render —
 * cheap on-device, no network — and the logic stays simple: the map's
 * presence implies "we know there's a file here", absence implies
 * "ask the filesystem".
 */
export function getCachedImageUri(
  coverArtId: string,
  size: number,
): string | null {
  if (!coverArtId) return null;

  const key = uriCacheKey(coverArtId, size);
  const cached = uriCache.get(key);
  if (cached) return cached;

  const subDir = new Directory(ensureCacheDir(), coverArtPathKey(coverArtId));
  if (!subDir.exists) return null;
  for (const ext of EXTENSIONS) {
    const file = new File(subDir, `${size}${ext}`);
    if (file.exists) {
      uriCache.set(key, file.uri);
      return file.uri;
    }
  }
  return null;
}

/**
 * Evict a single in-memory cache entry so the next lookup hits the
 * filesystem. Used by CachedImage's onError recovery path.
 */
export function evictUriCacheEntry(coverArtId: string, size: number): void {
  uriCache.delete(uriCacheKey(coverArtId, size));
}

/**
 * Delete a single cached variant: file on disk, DB row, and in-memory
 * Map entry. Used by CachedImage when an `onError` indicates the local
 * file is broken and a re-download is needed. Scoped to one size —
 * sibling variants for the same coverArt may still be healthy.
 */
export function deleteCachedVariant(coverArtId: string, size: number): void {
  if (!coverArtId) return;
  uriCache.delete(uriCacheKey(coverArtId, size));
  const subDir = new Directory(ensureCacheDir(), coverArtPathKey(coverArtId));
  if (subDir.exists) {
    for (const ext of EXTENSIONS) {
      const file = new File(subDir, `${size}${ext}`);
      if (file.exists) {
        try { file.delete(); } catch { /* best-effort */ }
      }
    }
  }
  deleteCachedImageVariant(coverArtId, size);
  imageCacheStore.getState().recalculateFromDb();
}

/* ------------------------------------------------------------------ */
/*  Queue management                                                   */
/* ------------------------------------------------------------------ */

/** Resolve and remove all pending promise callbacks for a coverArtId. */
function resolveWaiters(coverArtId: string): void {
  const resolvers = pendingResolvers.get(coverArtId);
  if (resolvers) {
    for (const resolve of resolvers) resolve();
    pendingResolvers.delete(coverArtId);
  }
}

/** Resolve all pending waiters (used when the cache is cleared). */
function resolveAllWaiters(): void {
  for (const [, resolvers] of pendingResolvers) {
    for (const resolve of resolvers) resolve();
  }
  pendingResolvers.clear();
}

/**
 * Enqueue a coverArtId for download + local resize. Returns a Promise
 * that resolves once the image has been fully cached (all 4 sizes) or
 * skipped. No-ops if all sizes are already on disk.
 */
export function cacheAllSizes(coverArtId: string): Promise<void> {
  if (!coverArtId) return Promise.resolve();
  // Sentinels render from bundled assets via CachedImage — never queue
  // them for download. Belt-and-braces guard; CachedImage already maps
  // their coverArtId to `undefined` before calling here.
  if (isSentinelCoverArtId(coverArtId)) return Promise.resolve();

  const allCached = IMAGE_SIZES.every(
    (s) => getCachedImageUri(coverArtId, s) != null,
  );
  if (allCached) {
    logImageCache(`cacheAllSizes id=${coverArtId} all-cached noop`);
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const list = pendingResolvers.get(coverArtId) ?? [];
    list.push(resolve);
    pendingResolvers.set(coverArtId, list);

    if (downloading.has(coverArtId) || downloadQueue.includes(coverArtId)) {
      logImageCache(`cacheAllSizes id=${coverArtId} dedup waiters=${list.length}`);
      return;
    }

    logImageCache(`cacheAllSizes id=${coverArtId} enqueued queue=${downloadQueue.length + 1}`);
    downloadQueue.push(coverArtId);
    processQueue();
  });
}

/* ------------------------------------------------------------------ */
/*  Queue processing                                                   */
/* ------------------------------------------------------------------ */

/**
 * Process the download queue. Spawns up to maxConcurrentImageDownloads
 * workers using the same pool pattern as musicCacheService.
 */
async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  try {
    while (downloadQueue.length > 0) {
      const { maxConcurrentImageDownloads } = imageCacheStore.getState();
      const workerCount = Math.min(
        maxConcurrentImageDownloads,
        downloadQueue.length,
      );
      const workers = Array.from(
        { length: workerCount },
        () => processNext(),
      );
      await Promise.all(workers);
    }
  } finally {
    isProcessing = false;
  }
}

/**
 * Worker loop: dequeue one coverArtId at a time and download + resize.
 */
async function processNext(): Promise<void> {
  while (downloadQueue.length > 0) {
    const coverArtId = downloadQueue.shift()!;
    if (downloading.has(coverArtId)) {
      continue;
    }
    downloading.add(coverArtId);
    try {
      await downloadAndCacheImage(coverArtId);
    } catch {
      /* individual image failure -- continue with the rest */
    } finally {
      downloading.delete(coverArtId);
      for (const s of IMAGE_SIZES) {
        uriCache.delete(uriCacheKey(coverArtId, s));
        getCachedImageUri(coverArtId, s);
      }
      // Re-derive the aggregate totals from SQL once per completed
      // coverArtId. Cheap (indexed scans) and keeps the store correct even
      // when partial-variant failures leave some rows unwritten.
      imageCacheStore.getState().recalculateFromDb();
      resolveWaiters(coverArtId);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Download + resize pipeline                                         */
/* ------------------------------------------------------------------ */

/**
 * Download the 600px source from the server (if not already cached)
 * and generate the 300, 150, and 50px variants locally.
 */
async function downloadAndCacheImage(coverArtId: string): Promise<void> {
  // Defensive — sentinels should never reach the pipeline. Callers
  // already filter via isSentinelCoverArtId() / CachedImage's mapping,
  // but an external `repairIncompleteImagesAsync` could still hand us
  // a stale row that slipped through.
  if (isSentinelCoverArtId(coverArtId)) {
    logImageCache(`downloadAndCacheImage id=${coverArtId} sentinel-skip`);
    return;
  }

  const subDir = new Directory(ensureCacheDir(), coverArtPathKey(coverArtId));
  if (!subDir.exists) subDir.create();

  let source600Uri = getCachedImageUri(coverArtId, SOURCE_SIZE);
  const sourceWasCached = source600Uri != null;
  if (!source600Uri) {
    source600Uri = await downloadSourceImage(coverArtId, subDir);
    if (!source600Uri) {
      logImageCache(`downloadAndCacheImage id=${coverArtId} source-download-null abort`);
      return;
    }
  } else {
    logImageCache(`downloadAndCacheImage id=${coverArtId} source-already-cached uri=${source600Uri}`);
  }

  const needed = RESIZE_SIZES.filter((s) => !getCachedImageUri(coverArtId, s));
  if (needed.length === 0) {
    logImageCache(
      `downloadAndCacheImage id=${coverArtId} all-variants-present source-cached=${sourceWasCached}`,
    );
    return;
  }
  logImageCache(
    `downloadAndCacheImage id=${coverArtId} resize-needed=[${needed.join(',')}] source-cached=${sourceWasCached}`,
  );
  for (const size of needed) {
    await generateResizedVariant(source600Uri, coverArtId, size, subDir);
  }
}

/**
 * Download the source (600px) image from the Subsonic server.
 * Writes to a .tmp file first, then renames on success.
 * Returns the local file:// URI on success, or null on failure.
 */
async function downloadSourceImage(
  coverArtId: string,
  subDir: Directory,
): Promise<string | null> {
  await ensureCoverArtAuth();
  const url = getCoverArtUrl(coverArtId, SOURCE_SIZE);
  if (!url) {
    // Null URL means offline, missing auth, or a sentinel slipped past
    // the upstream guards. Treated as transient — the row is preserved
    // for a later attempt once we're back online / authenticated. Log
    // WHICH of those conditions tripped so future "source-download-null"
    // patterns in user reports are actionable.
    const offline = offlineModeStore.getState().offlineMode;
    const auth = authStore.getState();
    const authState = !auth.isLoggedIn
      ? 'not-logged-in'
      : !auth.serverUrl
        ? 'no-server-url'
        : !auth.username
          ? 'no-username'
          : 'ok';
    logImageCache(
      `download id=${coverArtId} url=null offline=${offline} auth=${authState} sentinel=${isSentinelCoverArtId(coverArtId)}`,
    );
    return null;
  }

  // Transport phase: any throw here is a network/DNS/TLS failure with no
  // Response — server-reachability is unknown, so the row must be
  // preserved. Connectivity service surfaces the outage separately.
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    logImageCache(`download id=${coverArtId} start url=${url}`);
    response = await fetch(url);
  } catch (e) {
    logImageCache(
      `download id=${coverArtId} transport-error preserved err=${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }

  // Server responded. From here on, any failure is server-side or local-
  // pipeline — both purge under the connectivity gate.
  if (!response.ok) {
    if (response.status === 404) {
      // Definitive server signal that this cover doesn't exist (album
      // removed, re-indexed with a new ID, etc.). Always purge — 404 is
      // unambiguous regardless of broader connectivity state.
      // eslint-disable-next-line no-console
      console.warn(
        `[imageCacheService] 404 for coverArt=${coverArtId} — purging cache rows`,
      );
      logImageCache(`download id=${coverArtId} 404 purge`);
      purgeCoverArtRows(coverArtId);
      return null;
    }
    if (isPurgeAllowedNow()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[imageCacheService] HTTP ${response.status} for coverArt=${coverArtId} — purging cache rows`,
      );
      logImageCache(
        `download id=${coverArtId} status=${response.status} purge connectivity=ok`,
      );
      purgeCoverArtRows(coverArtId);
    } else {
      logImageCache(
        `download id=${coverArtId} status=${response.status} preserved connectivity=down`,
      );
    }
    return null;
  }

  // I/O phase: bytes arrived from the server; persist them locally. A
  // throw here means disk full / permission denied / write race. The
  // server is responsive, so under the connectivity gate we purge to
  // keep the row from churning forever on a poisoned local state.
  const contentType = response.headers.get('content-type') ?? '';
  const ext = MIME_TO_EXT[contentType.split(';')[0].trim()] ?? '.jpg';
  const fileName = `${SOURCE_SIZE}${ext}`;
  const tmpName = `${fileName}.tmp`;

  try {
    const tmpFile = new File(subDir, tmpName);
    const bytes = new Uint8Array(await response.arrayBuffer());
    tmpFile.write(bytes);

    const dest = new File(subDir, fileName);
    if (dest.exists) {
      try { dest.delete(); } catch { /* best-effort */ }
    }
    tmpFile.moveSync(dest);

    // DB row is written strictly after the successful rename. Any failure
    // before this point leaves the disk clean of the finalised file and
    // the DB row absent — the two stay consistent.
    upsertCachedImage({
      coverArtId,
      size: SOURCE_SIZE,
      ext: ext.slice(1), // strip leading '.'
      bytes: bytes.length,
      cachedAt: Date.now(),
    });
    uriCache.set(uriCacheKey(coverArtId, SOURCE_SIZE), dest.uri);

    logImageCache(`download id=${coverArtId} ok bytes=${bytes.length} ext=${ext.slice(1)}`);
    notifyImageCacheUpdate(coverArtId);
    return dest.uri;
  } catch (e) {
    const tmp = new File(subDir, tmpName);
    if (tmp.exists) {
      try { tmp.delete(); } catch { /* best-effort */ }
    }
    if (isPurgeAllowedNow()) {
      logImageCache(
        `download id=${coverArtId} io-error purge connectivity=ok err=${e instanceof Error ? e.message : String(e)}`,
      );
      purgeCoverArtRows(coverArtId);
    } else {
      logImageCache(
        `download id=${coverArtId} io-error preserved connectivity=down err=${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return null;
  }
}

/**
 * Per-session resize-failure counter. Variant generation runs against
 * bytes already on disk — the connectivity gate doesn't apply because
 * no network is involved. A small in-session retry budget absorbs
 * transient memory pressure during decode (older Android, low-RAM
 * devices). On the threshold strike, the row is purged: source bytes
 * are most likely corrupt or in an unsupported format, and re-running
 * the same decode would just re-fail. Counter resets on success or
 * after a purge so a fresh download can be evaluated cleanly.
 */
const variantFailureCount = new Map<string, number>();
const MAX_VARIANT_FAILURES = 3;

/**
 * Generate a single resized variant from the 600px source using the
 * local `expo-image-resize` native module. Writes to a .tmp file first,
 * then renames. The module uses `BitmapFactory.decodeFile` (Android) /
 * `UIImage(contentsOfFile:)` (iOS) — no Glide, no coroutine callback
 * surface, so the `expo-image-manipulator` double-resume crash that
 * surfaces on Android 16 is structurally impossible here.
 */
async function generateResizedVariant(
  sourceUri: string,
  coverArtId: string,
  size: number,
  subDir: Directory,
): Promise<void> {
  const fileName = `${size}.jpg`;
  const tmpName = `${fileName}.tmp`;
  const tmpFile = new File(subDir, tmpName);
  const dest = new File(subDir, fileName);

  try {
    await resizeImageToFileAsync(sourceUri, tmpFile.uri, size, RESIZE_COMPRESS);

    // Capture the size off tmpFile BEFORE the move. Reading dest.size
    // after move worked OK with the sync moveSync, but capturing here
    // is robust to either move/moveSync ordering and survives a
    // refactor that swaps the sync variant for the async one (the bug
    // that produced 0-byte upserts pre-fix).
    const fileBytes = tmpFile.size;

    if (dest.exists) {
      try { dest.delete(); } catch { /* best-effort */ }
    }
    tmpFile.moveSync(dest);

    // DB row after rename — mirrors the source-download pattern. A crash
    // between two variants leaves the DB missing the unfinished ones so
    // `findIncompleteCovers()` surfaces them for re-generation.
    upsertCachedImage({
      coverArtId,
      size,
      ext: 'jpg', // every derived variant is JPEG
      bytes: fileBytes,
      cachedAt: Date.now(),
    });
    uriCache.set(uriCacheKey(coverArtId, size), dest.uri);

    // Success — reset any accumulated failures for this cover.
    variantFailureCount.delete(coverArtId);
    logImageCache(`resize id=${coverArtId} size=${size} ok bytes=${fileBytes}`);
    notifyImageCacheUpdate(coverArtId);
  } catch (e) {
    const next = (variantFailureCount.get(coverArtId) ?? 0) + 1;
    variantFailureCount.set(coverArtId, next);
    // Phase 1 diagnostics — capture source-side context on every resize
    // failure so we can pin down the actual offending format from user
    // logs without another instrumentation round-trip. Gated by the
    // image-cache logging flag (see imageCacheLogger). The native
    // modules emit their own decode-path information via the thrown
    // error message when their low-level fallbacks kick in.
    let sourceBytes = -1;
    let sourceExt = 'unknown';
    try {
      const sourceFile = new File(sourceUri.replace(/^file:\/\//, ''));
      if (sourceFile.exists) {
        sourceBytes = sourceFile.size ?? -1;
      }
      // Extension is what the cache wrote based on Content-Type at
      // download time — telling us "claimed format" without needing
      // to do a sync byte read on a file we can't read synchronously
      // in the new expo-file-system API.
      const match = sourceUri.match(/\.([a-z0-9]{2,5})$/i);
      if (match) sourceExt = match[1].toLowerCase();
    } catch {
      /* best-effort — diagnostic only */
    }
    logImageCache(
      `resize id=${coverArtId} size=${size} fail count=${next}/${MAX_VARIANT_FAILURES} `
      + `srcBytes=${sourceBytes} srcExt=${sourceExt} err=${e instanceof Error ? e.message : String(e)}`,
    );
    if (tmpFile.exists) {
      try { tmpFile.delete(); } catch { /* best-effort */ }
    }
    if (next >= MAX_VARIANT_FAILURES) {
      // eslint-disable-next-line no-console
      console.warn(
        `[imageCacheService] ${next} consecutive resize failures for coverArt=${coverArtId} — purging cache rows`,
      );
      logImageCache(`resize id=${coverArtId} threshold-purge`);
      purgeCoverArtRows(coverArtId);
      // No further server-side recovery is attempted. The Subsonic spec
      // for `getCoverArt` accepts only `id` and `size`; the previously-
      // used `format=jpg` query was a no-op (the server returned the
      // same un-decodable bytes). User-visible recovery is handled
      // upstream in CachedImage's source-size fallback, which renders
      // the (decodable) 600 source in the smaller slot when smaller
      // variants are unavailable.
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Cache stats                                                        */
/* ------------------------------------------------------------------ */

export interface ImageCacheStats {
  /** Total bytes used by the image cache. */
  totalBytes: number;
  /** Number of unique cover art images cached. */
  imageCount: number;
  /** Total variant files on disk (every size × every cover). */
  fileCount: number;
  /** Number of covers with fewer than 4 variants on disk. */
  incompleteCount: number;
}

/**
 * Pull cache statistics directly from SQL aggregates. Previously walked
 * the whole `{image-cache}/` tree on every launch; now it's a single
 * indexed scan. Returns `Promise` only to preserve the existing async
 * contract for callers.
 */
export async function getImageCacheStats(): Promise<ImageCacheStats> {
  const agg = hydrateImageCacheAggregates();
  return {
    totalBytes: agg.totalBytes,
    imageCount: agg.imageCount,
    fileCount: agg.fileCount,
    incompleteCount: agg.incompleteCount,
  };
}

/* ------------------------------------------------------------------ */
/*  Cache browsing                                                     */
/* ------------------------------------------------------------------ */

/** A single cached file variant. */
interface CachedFileEntry {
  size: number;
  fileName: string;
  uri: string;
}

/** A cached image with all its size variants. */
export interface CachedImageEntry {
  coverArtId: string;
  files: CachedFileEntry[];
  /** True when all four size variants (50/150/300/600) are cached. */
  complete: boolean;
}

/**
 * List all cached images grouped by coverArtId — backed by a single
 * indexed SQL scan of `cached_images` (not a recursive disk walk).
 * Optional filter narrows to complete-only or incomplete-only entries
 * for the browser screen.
 *
 * File URIs are reconstructed from `(coverArtId, size, ext)` using the
 * same layout every code path writes to: `{image-cache}/{id}/{size}.{ext}`.
 */
export async function listCachedImagesAsync(
  filter: CacheBrowserFilter = 'all',
): Promise<CachedImageEntry[]> {
  // URIs are deterministic from (dir.uri, coverArtId, size, ext), so build
  // them by string concat. Constructing `new File()` / `new Directory()` for
  // every row crosses the native bridge and at 21k+ rows becomes the dominant
  // cost of opening the browser.
  const dirUri = ensureCacheDir().uri;
  const dbEntries: DbCachedImageEntry[] = listCachedImagesForBrowser(filter);
  return dbEntries.map((entry) => ({
    coverArtId: entry.coverArtId,
    complete: entry.complete,
    files: entry.files.map((f) => {
      const fileName = `${f.size}.${f.ext}`;
      return {
        size: f.size,
        fileName,
        uri: `${dirUri}/${entry.coverArtId}/${fileName}`,
      };
    }),
  }));
}

/**
 * Delete all cached variants for a single coverArtId.
 * Updates the imageCacheStore stats accordingly.
 */
export async function deleteCachedImage(coverArtId: string): Promise<void> {
  if (!coverArtId) return;

  evictUriCacheForCover(coverArtId);

  const subDir = new Directory(ensureCacheDir(), coverArtPathKey(coverArtId));
  const dirExists = subDir.exists;
  logImageCache(`deleteCachedImage id=${coverArtId} dirExists=${dirExists}`);
  if (!dirExists) {
    // Clean up any orphan DB rows for this cover (e.g. directory was
    // already removed externally), then stop.
    const rows = deleteCachedImagesForCoverArt(coverArtId);
    logImageCache(`deleteCachedImage id=${coverArtId} dir-missing rows-removed=${rows.count}`);
    imageCacheStore.getState().recalculateFromDb();
    return;
  }

  // Delete the on-disk directory first, then the DB rows. Rebuild the
  // store aggregates from SQL at the end.
  let dirDeleted = true;
  try {
    subDir.delete();
  } catch (e) {
    dirDeleted = false;
    logImageCache(
      `deleteCachedImage id=${coverArtId} dir-delete-failed err=${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const rows = deleteCachedImagesForCoverArt(coverArtId);
  logImageCache(
    `deleteCachedImage id=${coverArtId} dir-deleted=${dirDeleted} rows-removed=${rows.count}`,
  );
  imageCacheStore.getState().recalculateFromDb();
}

/**
 * Re-download all size variants for a single coverArtId.
 * Deletes existing files first, then downloads directly — bypasses the
 * global queue so the user-initiated refresh isn't blocked by other
 * in-flight downloads.
 */
export async function refreshCachedImage(
  coverArtId: string,
  source: string = 'auto',
): Promise<void> {
  logImageCache(`refreshCachedImage start source=${source} id=${coverArtId}`);
  await deleteCachedImage(coverArtId);

  // Remove from queue/downloading so no worker races with us
  downloading.delete(coverArtId);
  const idx = downloadQueue.indexOf(coverArtId);
  if (idx !== -1) downloadQueue.splice(idx, 1);

  // Download directly instead of going through the queue
  downloading.add(coverArtId);
  try {
    await downloadAndCacheImage(coverArtId);
  } finally {
    downloading.delete(coverArtId);
    for (const s of IMAGE_SIZES) {
      uriCache.delete(uriCacheKey(coverArtId, s));
      getCachedImageUri(coverArtId, s);
    }
    imageCacheStore.getState().recalculateFromDb();
    resolveWaiters(coverArtId);
    const present = IMAGE_SIZES.filter((s) => getCachedImageUri(coverArtId, s) != null);
    const stillInDb = dbHasCachedImage(coverArtId, SOURCE_SIZE);
    logImageCache(
      `refreshCachedImage end id=${coverArtId} sizes-present=[${present.join(',')}] still-in-db=${stillInDb}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Cache clearing                                                     */
/* ------------------------------------------------------------------ */

/**
 * Delete all cached images and recreate the cache directory.
 * Returns the number of bytes freed — derived from the DB aggregate
 * (cheap single SELECT) rather than the former recursive directory walk.
 */
export async function clearImageCache(): Promise<number> {
  const agg = hydrateImageCacheAggregates();
  const freedBytes = agg.totalBytes;
  const dir = ensureCacheDir();
  try {
    dir.delete();
  } catch {
    /* may fail if already empty */
  }
  cacheDir = null;
  uriCache.clear();
  downloadQueue.length = 0;
  downloading.clear();
  resolveAllWaiters();
  initImageCache();
  clearAllCachedImages();
  imageCacheStore.getState().reset();
  logImageCache(`clearImageCache freed-bytes=${freedBytes}`);
  return freedBytes;
}

/**
 * Wipe every trace of the image cache for logout — on-disk dir, in-memory
 * queue/uriCache/pendingResolvers, DB rows, and the store aggregate state.
 *
 * Differs from {@link clearImageCache} in that it does NOT re-init the
 * cache directory after wiping. The session is over; the next login will
 * re-arm `initImageCache()` via the auth flow. Re-init here would also
 * re-arm the AppState listener `teardownImageCache()` just removed,
 * defeating the point of running them together.
 *
 * Called exclusively from `resetAllStores()`. Synchronous DB cleanup
 * + best-effort filesystem delete; never throws.
 */
export function wipeImageCacheForLogout(): void {
  // teardownImageCache() removes the AppState listener; here we tear down
  // the rest. Order matters: drop in-memory pending work BEFORE deleting
  // the on-disk dir so a worker that wakes mid-delete can't write a tmp
  // file into a subdir we just removed.
  uriCache.clear();
  downloadQueue.length = 0;
  downloading.clear();
  resolveAllWaiters();
  if (cacheDir) {
    try {
      cacheDir.delete();
    } catch {
      /* best-effort — kvStorage cleanup happens regardless */
    }
    cacheDir = null;
  }
  clearAllCachedImages();
  imageCacheStore.getState().reset();
  logImageCache('wipeImageCacheForLogout done');
}

/**
 * Proactively cache cover art for a list of entities (songs, albums, etc.).
 * Deduplicates by coverArt ID and skips entries already in cache.
 */
export function cacheEntityCoverArt(entities: Array<{ coverArt?: string }>): void {
  const seen = new Set<string>();
  for (const entity of entities) {
    if (entity.coverArt && !seen.has(entity.coverArt)) {
      seen.add(entity.coverArt);
      if (!getCachedImageUri(entity.coverArt, 300)) {
        cacheAllSizes(entity.coverArt).catch(() => { /* non-critical */ });
      }
    }
  }
}

/**
 * Snapshot every cached item row's `(type, coverArtId)` for the
 * persistent image-download queue's `refresh-downloads` scope. Broken
 * out so it can be mocked in unit tests without dragging in the entire
 * `musicCacheTables` import surface.
 *
 * Keys off ENTITY IDs (album.id, playlist.id, song.albumId), not the
 * server-supplied `coverArt` field — see src/utils/coverArtId.ts.
 * Same ID scheme that every consumer (CachedImage, childToTrack, etc.)
 * uses, so the recached files match what callers will look up.
 */
function hydrateCachedItemsForRecache(): {
  items: Array<{ type: string; coverArtId: string | null }>;
  /**
   * Per-song cover-art IDs from `cached_songs`. Each song's cover key
   * is its parent album's ID (fallback to song.id for orphans) so
   * multiple tracks in the same album share one cached file.
   */
  songCoverArtIds: string[];
} {
  // Lazy-required: keeps the recache worker testable without forcing
  // every test that touches imageCacheService to mock musicCacheTables.
  const { hydrateCachedItems, hydrateCachedSongs } = require('../store/persistence/musicCacheTables') as {
    hydrateCachedItems: () => Record<string, { itemId: string; type: string }>;
    hydrateCachedSongs: () => Record<string, { id: string; albumId?: string | null }>;
  };
  const items = Object.values(hydrateCachedItems()).map((r) => ({
    type: r.type,
    coverArtId: r.itemId,
  }));
  const songCoverArtIds: string[] = [];
  const seen = new Set<string>();
  for (const s of Object.values(hydrateCachedSongs())) {
    const id = s.albumId ?? s.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    songCoverArtIds.push(id);
  }
  return { items, songCoverArtIds };
}

/* ------------------------------------------------------------------ */
/*  Persistent image-download queue worker                              */
/*  See plans/2026-05-23-image-cache-queue-rework.md.                   */
/* ------------------------------------------------------------------ */

/**
 * Scalar cycle metadata persisted via kvStorage. The queue rows live in
 * SQL; only the cycle's denominator (`total`), identity (`cycleId`), and
 * pause flag survive separately so the UI can show "X / Y" and so the
 * worker can short-circuit when the user has paused. Phase 3 wraps these
 * accessors in `imageDownloadQueueStore` for store-friendly consumption.
 */
const IMAGE_QUEUE_META_KEY = 'substreamer-image-queue-meta';

interface ImageQueueMeta {
  cycleId: string | null;
  cycleScope: ImageDownloadQueueScope | null;
  cycleTotal: number;
  isPaused: boolean;
}

function readImageQueueMeta(): ImageQueueMeta {
  try {
    // kvStorage.getItem is sync in our SQLite-backed impl, but the
    // Zustand StateStorage interface declares it as `string | null |
    // Promise<...>`. Cast to the sync variant we actually have.
    const raw = kvStorage.getItem(IMAGE_QUEUE_META_KEY) as string | null;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ImageQueueMeta>;
      return {
        cycleId: typeof parsed.cycleId === 'string' ? parsed.cycleId : null,
        cycleScope:
          parsed.cycleScope === 'refresh-downloads' || parsed.cycleScope === 'refresh-all'
            ? parsed.cycleScope
            : null,
        cycleTotal: typeof parsed.cycleTotal === 'number' ? parsed.cycleTotal : 0,
        isPaused: parsed.isPaused === true,
      };
    }
  } catch {
    /* fall through to defaults */
  }
  return { cycleId: null, cycleScope: null, cycleTotal: 0, isPaused: false };
}

function writeImageQueueMeta(next: ImageQueueMeta): void {
  try {
    kvStorage.setItem(IMAGE_QUEUE_META_KEY, JSON.stringify(next));
  } catch {
    /* swallow — meta loss only affects UI display, not correctness */
  }
}

export function isImageQueuePaused(): boolean {
  return readImageQueueMeta().isPaused;
}

export function getImageQueueCycle(): {
  cycleId: string | null;
  cycleScope: ImageDownloadQueueScope | null;
  cycleTotal: number;
} {
  const meta = readImageQueueMeta();
  return { cycleId: meta.cycleId, cycleScope: meta.cycleScope, cycleTotal: meta.cycleTotal };
}

/**
 * Compute the cycle's "X / Y" progress on demand from SQL. Anything not
 * 'queued' OR 'downloading' counts as "attempted" (errored rows are
 * attempted-and-failed, not still-in-queue).
 */
export function getImageQueueCycleProgress(): {
  processed: number;
  total: number;
  failed: number;
} {
  const { cycleId, cycleTotal } = readImageQueueMeta();
  if (cycleId === null || cycleTotal === 0) {
    return { processed: 0, total: 0, failed: 0 };
  }
  const remainingInQueue = countImageQueueRowsByCycle(cycleId);
  const errored = countImageQueueRowsByStatus('error');
  // remainingInQueue includes 'queued' + 'downloading' + 'error'. The
  // "processed" UI count is total - (queued + downloading) — errored
  // rows count as attempted. Compute via the SQL we have:
  //   processed = total - (queued + downloading)
  //             = total - (remainingInQueue - error_in_this_cycle)
  // We can compute error_in_this_cycle as a separate count but for now
  // expose it bluntly: failed = countImageQueueRowsByStatus('error') is
  // global across cycles; in practice only one cycle runs at a time so
  // this is accurate.
  const queuedOrDownloading = remainingInQueue - errored;
  const processed = Math.max(0, cycleTotal - Math.max(0, queuedOrDownloading));
  return { processed, total: cycleTotal, failed: errored };
}

/* ----- Queue-change pub/sub for store consumers ----- */

/**
 * Listener pattern that lets `imageDownloadQueueStore` react to queue
 * mutations without depending on the store directly (which would create
 * a circular import — the store imports getter helpers from this file).
 *
 * Mutating queue ops call `notifyImageQueueChange()`. Subscribers do
 * their own derived-state refresh; we don't pass payloads.
 */
type ImageQueueChangeListener = () => void;
const imageQueueListeners = new Set<ImageQueueChangeListener>();

export function subscribeImageQueueChanges(
  fn: ImageQueueChangeListener,
): () => void {
  imageQueueListeners.add(fn);
  return () => { imageQueueListeners.delete(fn); };
}

function notifyImageQueueChange(): void {
  for (const fn of imageQueueListeners) {
    try { fn(); } catch { /* listener errors must not break the worker */ }
  }
}

/* ----- Worker ----- */

/**
 * The currently-running worker promise, or null if no worker is active.
 * Held so re-entrant callers (and test code) can `await processImageQueue()`
 * and reliably wait for the drain to finish — matches the test-ergonomic
 * shape we want without breaking the fire-and-forget call sites.
 */
let imageWorkerPromise: Promise<void> | null = null;

/**
 * Debounced aggregate recalc — replaces the per-image `recalculateFromDb()`
 * call that historically caused the Settings UI flicker. A 750ms window
 * with force-flush at cycle end means a 200-image cycle goes from 200
 * SQL aggregate queries to a handful.
 */
let recalcTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAggregateRecalc(): void {
  if (recalcTimer !== null) clearTimeout(recalcTimer);
  recalcTimer = setTimeout(() => {
    recalcTimer = null;
    imageCacheStore.getState().recalculateFromDb();
  }, 750);
}
function flushAggregateRecalc(): void {
  if (recalcTimer !== null) {
    clearTimeout(recalcTimer);
    recalcTimer = null;
  }
  imageCacheStore.getState().recalculateFromDb();
}

function connectivityAllowsImageWork(): boolean {
  if (offlineModeStore.getState().offlineMode) return false;
  const conn = connectivityStore.getState();
  if (!conn.isServerReachable || !conn.isInternetReachable) return false;
  return true;
}

/**
 * Test seam — the queue worker calls this rather than `downloadAndCacheImage`
 * directly so tests can swap it for a deterministic stub. Production code
 * uses the default (real `downloadAndCacheImage`).
 */
let imageDownloader: (coverArtId: string) => Promise<void> = (id) => downloadAndCacheImage(id);

/** Test-only: replace the downloader. Pass undefined to restore default. */
export function __setImageDownloaderForTest(
  fn: ((coverArtId: string) => Promise<void>) | undefined,
): void {
  imageDownloader = fn ?? ((id) => downloadAndCacheImage(id));
}

async function tryDownloadCover(coverArtId: string): Promise<boolean> {
  try {
    await imageDownloader(coverArtId);
    return true;
  } catch {
    return false;
  }
}

async function processOneImage(row: ImageDownloadQueueRow): Promise<void> {
  markImageDownloading(row.coverArtId);
  // Both scopes are 'refresh-*' so they delete-then-redownload (the
  // existing refresh semantic). No skip-if-cached pre-check here —
  // refresh-all WANTS to replace; refresh-downloads WANTS to pick up
  // the post-Migration-22 canonical IDs.
  try {
    await deleteCachedImage(row.coverArtId);
  } catch {
    /* per-cover delete failure isn't fatal; download will overwrite */
  }

  // Retry-once-inline, matching musicCacheService.ts:1104-1105
  let ok = await tryDownloadCover(row.coverArtId);
  if (!ok) ok = await tryDownloadCover(row.coverArtId);

  if (ok) {
    removeImageFromQueue(row.coverArtId);
    scheduleAggregateRecalc();
    maybeCompleteCycle();
  } else {
    markImageError(row.coverArtId, 'Failed after retry');
    logImageCache(`image-queue: persisted error for id=${row.coverArtId}`);
  }
  notifyImageQueueChange();
}

function maybeCompleteCycle(): void {
  const meta = readImageQueueMeta();
  if (meta.cycleId === null) return;
  const remaining = countImageQueueRowsByCycle(meta.cycleId);
  // Remaining includes errored rows that the user might still retry.
  // We clear the cycle metadata only when EVERY row is gone (success).
  if (remaining === 0) {
    writeImageQueueMeta({ cycleId: null, cycleScope: null, cycleTotal: 0, isPaused: false });
    flushAggregateRecalc();
    logImageCache('image-queue: cycle complete');
  }
}

async function imageWorkerLoop(): Promise<void> {
  while (true) {
    if (readImageQueueMeta().isPaused) return;
    if (!connectivityAllowsImageWork()) return;
    const next = pickNextQueuedImageRow();
    if (!next) return;
    await processOneImage(next);
  }
}

/**
 * Drain the persistent image-download queue. Spawns up to
 * `maxConcurrentImageDownloads` parallel workers (same pattern as
 * `musicCacheService.downloadItem`). Idempotent: a second call while
 * the worker is running is a no-op.
 */
export async function processImageQueue(): Promise<void> {
  if (imageWorkerPromise !== null) {
    // Already running — return the same promise so the caller awaits the
    // existing drain instead of starting a duplicate worker.
    await imageWorkerPromise;
    return;
  }
  if (readImageQueueMeta().isPaused) return;
  if (!connectivityAllowsImageWork()) return;

  const promise = (async () => {
    try {
      const concurrency = Math.max(1, imageCacheStore.getState().maxConcurrentImageDownloads);
      const workers = Array.from({ length: concurrency }, () => imageWorkerLoop());
      await Promise.all(workers);
    } finally {
      flushAggregateRecalc();
    }
  })();
  imageWorkerPromise = promise;
  try {
    await promise;
  } finally {
    imageWorkerPromise = null;
  }
}

/**
 * Reset stalled rows back to 'queued' so they can be re-processed.
 * Mirrors `recoverStalledDownloadsAsync` (music): 'downloading' rows
 * (the previous session died mid-fetch) and 'error' rows both get a
 * fresh shot per session.
 */
export async function recoverStalledImageDownloads(): Promise<void> {
  const reset = resetStalledImageRows();
  if (reset > 0) {
    logImageCache(`image-queue: recovered ${reset} stalled row(s) to queued`);
    notifyImageQueueChange();
  }
}

/**
 * Pause the queue. The worker exits at the next iteration; in-flight
 * rows finish but the loop won't start new ones. `isPaused` is persisted,
 * so kill-while-paused → restart → still paused. Only an explicit
 * `resumeImageQueue()` clears the flag.
 */
export function pauseImageQueue(): void {
  const meta = readImageQueueMeta();
  if (meta.isPaused) return;
  writeImageQueueMeta({ ...meta, isPaused: true });
  logImageCache('image-queue: paused');
  notifyImageQueueChange();
}

export function resumeImageQueue(): void {
  const meta = readImageQueueMeta();
  if (!meta.isPaused) return;
  writeImageQueueMeta({ ...meta, isPaused: false });
  logImageCache('image-queue: resumed');
  notifyImageQueueChange();
  void processImageQueue();
}

/**
 * Drop the current cycle's queue rows and clear the cycle metadata.
 * Any row currently in 'downloading' finishes its in-flight fetch (we
 * don't kill mid-fetch — matches music's `cancelDownload`). The worker
 * exits naturally when there's nothing left.
 */
export function cancelImageRefreshCycle(): void {
  const meta = readImageQueueMeta();
  if (meta.cycleId === null) {
    logImageCache('image-queue: cancel with no active cycle (no-op)');
    return;
  }
  const removed = clearImageQueueByCycle(meta.cycleId);
  writeImageQueueMeta({ cycleId: null, cycleScope: null, cycleTotal: 0, isPaused: false });
  flushAggregateRecalc();
  logImageCache(`image-queue: cancelled cycle ${meta.cycleId}, removed ${removed} row(s)`);
  notifyImageQueueChange();
}

/**
 * Move all 'error' rows in the active cycle back to 'queued' so the
 * worker re-tries them. Mirrors music's `retryDownload`.
 */
export function retryFailedImages(): void {
  const meta = readImageQueueMeta();
  if (meta.cycleId === null) {
    logImageCache('image-queue: retryFailed with no active cycle (no-op)');
    return;
  }
  const reset = resetErrorRowsForCycle(meta.cycleId);
  logImageCache(`image-queue: retryFailed reset ${reset} row(s)`);
  if (reset > 0) {
    notifyImageQueueChange();
    void processImageQueue();
  }
}

/* ----- Cycle starters ----- */

function generateCycleId(): string {
  // Cheap unique-enough id. Avoid `crypto.randomUUID` because the RN
  // runtime may lack it.
  return `cyc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Snapshot every cover-art ID associated with downloaded music
 * (cached_items albums/playlists + per-song covers from cached_songs).
 * Returns the deduped list.
 */
function snapshotDownloadedCoverArtIds(): string[] {
  const { items, songCoverArtIds } = hydrateCachedItemsForRecache();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (!it.coverArtId) continue;
    if (it.type !== 'album' && it.type !== 'playlist') continue;
    if (seen.has(it.coverArtId)) continue;
    seen.add(it.coverArtId);
    out.push(it.coverArtId);
  }
  for (const id of songCoverArtIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function snapshotAllCachedCoverArtIds(): string[] {
  // Distinct cover_art_ids across cached_images (every cover that has at
  // least one variant on disk). Already returned distinct + sorted.
  return getAllCachedCoverArtIds();
}

/**
 * Begin a refresh cycle. Snapshots the relevant cover-art IDs, generates
 * a cycle_id, bulk-inserts the rows, persists cycle metadata, and kicks
 * the worker. Returns the new cycle_id.
 *
 * If a cycle is already active, the call is a no-op and returns its id.
 */
export async function enqueueImageRefreshCycle(
  scope: ImageDownloadQueueScope,
): Promise<string | null> {
  const meta = readImageQueueMeta();
  if (meta.cycleId !== null) {
    logImageCache(`image-queue: cycle already active id=${meta.cycleId}, skipping new ${scope}`);
    return meta.cycleId;
  }
  const ids = scope === 'refresh-downloads'
    ? snapshotDownloadedCoverArtIds()
    : snapshotAllCachedCoverArtIds();
  if (ids.length === 0) {
    logImageCache(`image-queue: ${scope} produced 0 ids, nothing to do`);
    return null;
  }
  const cycleId = generateCycleId();
  const inserted = enqueueImagesBulk(ids, scope, cycleId);
  writeImageQueueMeta({
    cycleId,
    cycleScope: scope,
    cycleTotal: inserted,
    isPaused: false,
  });
  logImageCache(`image-queue: started cycle ${cycleId} scope=${scope} ids=${inserted}`);
  notifyImageQueueChange();
  void processImageQueue();
  return cycleId;
}
