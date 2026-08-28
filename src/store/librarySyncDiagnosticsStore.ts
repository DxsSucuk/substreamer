import { File, Paths } from 'expo-file-system';
import { create } from 'zustand';

import {
  LIBRARY_SYNC_DIAG_FLAG_FILE as FLAG_FILE_NAME,
  LIBRARY_SYNC_DIAG_LOG_FILE as LOG_FILE_NAME,
  LIBRARY_SYNC_DIAG_OLD_LOG_FILE as OLD_LOG_FILE_NAME,
  flushLibrarySyncLog,
  readLibrarySyncLogFlag,
  setLibrarySyncLogFlag,
} from '../services/librarySyncLogger';

interface LibrarySyncDiagnosticsState {
  enabled: boolean;
  logFileSize: number | null;
  setEnabled: (enabled: boolean) => Promise<void>;
  resetLog: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

export const librarySyncDiagnosticsStore = create<LibrarySyncDiagnosticsState>()((set) => ({
  enabled: false,
  logFileSize: null,

  setEnabled: async (enabled: boolean) => {
    const flagFile = new File(Paths.document, FLAG_FILE_NAME);
    try {
      if (enabled) {
        flagFile.write('');
      } else {
        // Flush first: turning logging off should keep what was already captured.
        await flushLibrarySyncLog();
        if (flagFile.exists) flagFile.delete();
      }
      // Update the logger's cached flag synchronously so a run already in flight
      // starts or stops logging now rather than on the next process.
      setLibrarySyncLogFlag(enabled);
      set({ enabled });
    } catch { /* best-effort: flag file I/O failure is non-critical */ }
  },

  resetLog: async () => {
    try {
      await flushLibrarySyncLog();
      const logFile = new File(Paths.document, LOG_FILE_NAME);
      const oldLogFile = new File(Paths.document, OLD_LOG_FILE_NAME);
      if (logFile.exists) logFile.delete();
      if (oldLogFile.exists) oldLogFile.delete();
      set({ logFileSize: null });
    } catch { /* best-effort */ }
  },

  refreshStatus: async () => {
    try {
      await flushLibrarySyncLog();
      const logFile = new File(Paths.document, LOG_FILE_NAME);
      const enabled = readLibrarySyncLogFlag();
      let logFileSize: number | null = null;
      if (logFile.exists) {
        logFileSize = logFile.size ?? null;
      }
      set({ enabled, logFileSize });
    } catch { /* best-effort */ }
  },
}));
