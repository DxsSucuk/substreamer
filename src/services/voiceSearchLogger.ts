/**
 * Voice-search diagnostic logger.
 *
 * Mirrors {@link ./imageCacheLogger.ts}: a single `logVoiceSearch(message)`
 * helper that's a no-op unless `voice-search-diagnostics-enabled` exists in
 * `Paths.document`. The user-facing toggle lives in Settings → Logging → Voice
 * Search Diagnostics.
 *
 * Captures the raw voice request + resolution outcome on-device (console.* is
 * stripped in release). Own log file, not the native remote-control log, so JS
 * writes can't clobber native appends.
 */

import { File, Paths } from 'expo-file-system';

/** Empty file that gates logging — created/deleted by `voiceSearchDiagnosticsStore`. */
export const VOICE_SEARCH_DIAG_FLAG_FILE = 'voice-search-diagnostics-enabled';
/** Active log file written by {@link logVoiceSearch}; shareable via Settings. */
export const VOICE_SEARCH_DIAG_LOG_FILE = 'voice-search-diagnostics.log';
/** Rotated log retained from the previous {@link MAX_LOG_BYTES}-cap rotation. */
export const VOICE_SEARCH_DIAG_OLD_LOG_FILE = 'voice-search-diagnostics.old.log';
const MAX_LOG_BYTES = 256 * 1024;

let writeQueue: Promise<void> = Promise.resolve();

export function logVoiceSearch(message: string): void {
  writeQueue = writeQueue.then(async () => {
    try {
      const flagFile = new File(Paths.document, VOICE_SEARCH_DIAG_FLAG_FILE);
      if (!flagFile.exists) return;
      const logFile = new File(Paths.document, VOICE_SEARCH_DIAG_LOG_FILE);
      const line = `[${new Date().toISOString()}] ${message}\n`;
      let existing = logFile.exists ? await logFile.text() : '';
      if (existing.length + line.length > MAX_LOG_BYTES) {
        const oldLog = new File(Paths.document, VOICE_SEARCH_DIAG_OLD_LOG_FILE);
        if (oldLog.exists) {
          try { oldLog.delete(); } catch { /* best-effort */ }
        }
        try {
          logFile.write(existing);
          logFile.move(oldLog);
        } catch { /* best-effort: rotation failure just clears existing */ }
        existing = '';
      }
      logFile.write(existing + line);
    } catch { /* best-effort: disk full or permission denied is non-critical */ }
  });
}
