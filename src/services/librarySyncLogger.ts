/**
 * Library-sync diagnostic logger.
 *
 * Same user-facing contract as the other diagnostic logs (flag file gate, active
 * log + one rotation, toggle in Settings → Logging), but a different write
 * strategy, because a large-library sync emits orders of magnitude more lines
 * than the image cache does:
 *
 *   - The enabled flag is cached in memory. `logImageCache` stats the flag file
 *     on every call from inside its promise chain; at a page-per-line over a
 *     200k-album library that is a sync FS hit on the JS thread per call.
 *     Callers here take a run-local snapshot via {@link readLibrarySyncLogFlag}
 *     and pass nothing further — a disabled logger returns before touching the
 *     queue.
 *   - Lines are buffered and appended, never read-modify-written. The other
 *     loggers read the whole file and rewrite it per line, which at these
 *     volumes would move hundreds of MB.
 *   - Flush happens on a short timer, on demand, and must be called when the
 *     app backgrounds — an OS kill mid-sync is exactly the case this log exists
 *     to explain, and it is not a thrown error.
 */

import { File, Paths } from 'expo-file-system';

/** Filename of the empty file that gates diagnostic logging. Created and
 *  deleted by `librarySyncDiagnosticsStore.setEnabled()`. */
export const LIBRARY_SYNC_DIAG_FLAG_FILE = 'library-sync-diagnostics-enabled';
/** Active log file. Inspectable + shareable via Settings → Logging. */
export const LIBRARY_SYNC_DIAG_LOG_FILE = 'library-sync-diagnostics.log';
/** Rotated log retained from the previous {@link MAX_LOG_BYTES}-cap rotation. */
export const LIBRARY_SYNC_DIAG_OLD_LOG_FILE = 'library-sync-diagnostics.old.log';
/** ~35k lines at typical length — a whole large-library run at page granularity.
 *  The image cache's 512KB would rotate a 200k-album album phase out of the
 *  active log before the run finished. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 2000;

let enabled = false;
let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Re-read the flag file and cache the result. Called by the diagnostics store
 * and once at the start of a sync run — the only point that catches "enabled in
 * a previous session, Logging screen never opened".
 *
 * Returns the value so a run can snapshot it rather than re-reading the shared
 * cache mid-run, which the store could change underneath it.
 */
export function readLibrarySyncLogFlag(): boolean {
  try {
    enabled = new File(Paths.document, LIBRARY_SYNC_DIAG_FLAG_FILE).exists;
  } catch {
    enabled = false;
  }
  return enabled;
}

/** Set the cached flag directly, for the store's own synchronous toggle. */
export function setLibrarySyncLogFlag(next: boolean): void {
  enabled = next;
  if (!next) {
    buffer = [];
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }
}

export function logLibrarySync(message: string): void {
  if (!enabled) return;
  buffer.push(`[${new Date().toISOString()}] ${message}\n`);
  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushLibrarySyncLog();
    }, FLUSH_INTERVAL_MS);
  }
}

/**
 * Write buffered lines out. Serialised through one promise chain so a timer
 * flush and a background flush can't interleave.
 */
export function flushLibrarySyncLog(): Promise<void> {
  if (buffer.length === 0) return writeQueue;
  const pending = buffer.join('');
  buffer = [];
  writeQueue = writeQueue.then(async () => {
    try {
      const logFile = new File(Paths.document, LIBRARY_SYNC_DIAG_LOG_FILE);
      if (logFile.exists && logFile.size + pending.length > MAX_LOG_BYTES) {
        const oldLog = new File(Paths.document, LIBRARY_SYNC_DIAG_OLD_LOG_FILE);
        if (oldLog.exists) {
          try { oldLog.delete(); } catch { /* best-effort */ }
        }
        try { logFile.move(oldLog); } catch { /* best-effort */ }
      }
      if (!logFile.exists) logFile.create({ intermediates: true });
      logFile.write(pending, { append: true });
    } catch { /* best-effort: disk full or permission denied is non-critical */ }
  });
  return writeQueue;
}
