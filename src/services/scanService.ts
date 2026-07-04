import { appStateStore } from '../store/appStateStore';
import { scanStatusStore } from '../store/scanStatusStore';
import {
  getScanStatus as apiGetScanStatus,
  startScan as apiStartScan,
} from './subsonicService';

const POLL_INTERVAL_MS = 2000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
/** True when polling was stopped because the app backgrounded (vs. scan done),
 *  so it can resume on foreground if the scan is still running. */
let pausedForBackground = false;

// Pause the 2s status poll (a network request each tick) while backgrounded;
// resume on foreground if a scan is still in progress.
appStateStore.subscribe((state, prev) => {
  if (state.isActive === prev.isActive) return;
  if (!state.isActive) {
    if (pollTimer != null) {
      stopPolling();
      pausedForBackground = true;
    }
  } else if (pausedForBackground) {
    pausedForBackground = false;
    if (scanStatusStore.getState().scanning) startPolling();
  }
});

/**
 * Hook invoked when a scan transitions from scanning:true to scanning:false.
 * Registered by `dataSyncService` at module load to avoid making scanService
 * import the full orchestration dependency graph.
 */
let onScanCompletedHook: (() => void) | null = null;
export function registerScanCompletedHook(hook: (() => void) | null): void {
  onScanCompletedHook = hook;
}

/**
 * Start polling the server for scan status updates.
 * No-ops if already polling.
 */
export function startPolling(): void {
  if (pollTimer != null) return;
  pollTimer = setInterval(async () => {
    const result = await apiGetScanStatus();
    if (result) {
      scanStatusStore.getState().setScanStatus(result);
      if (!result.scanning) {
        // Scan transition — notify the data sync service so Phase-4+ can
        // hook incremental change detection here.
        onScanCompletedHook?.();
        stopPolling();
      }
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the polling interval.
 */
export function stopPolling(): void {
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Fetch the current scan status from the server and update the store.
 * Automatically starts polling if a scan is in progress.
 */
export async function fetchScanStatus(): Promise<void> {
  const store = scanStatusStore.getState();
  store.setLoading(true);
  const result = await apiGetScanStatus();
  if (result) {
    store.setScanStatus(result);
    if (result.scanning) {
      startPolling();
    } else {
      stopPolling();
    }
  } else {
    store.setError('Failed to fetch scan status');
  }
  store.setLoading(false);
}

/**
 * Start a library scan on the server and begin polling for progress.
 * @param fullScan Only supported by Navidrome – performs a full scan instead of incremental.
 */
export async function startScan(fullScan?: boolean): Promise<void> {
  const store = scanStatusStore.getState();
  store.setLoading(true);
  const result = await apiStartScan(fullScan);
  if (result) {
    store.setScanStatus(result);
    if (result.scanning) {
      startPolling();
    }
  } else {
    store.setError('Failed to start scan');
  }
  store.setLoading(false);
}
