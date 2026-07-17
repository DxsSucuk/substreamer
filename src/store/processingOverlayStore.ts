import { create } from 'zustand';

export type OverlayStatus = 'idle' | 'processing' | 'success' | 'error';

/** Floor so a fast op still flashes the overlay long enough to read. */
const MIN_PROCESSING_MS = 900;
/**
 * Last-resort watchdog: if a task never resolves (`showSuccess`/`showError`
 * never called), force the overlay down so a hung op can't block the UI
 * forever. Set well above any legitimate op / network timeout so it never
 * rips out a working request.
 */
const WATCHDOG_MS = 60000;

// Timers live at module scope (not store state — they aren't serialisable and
// must survive `setState`). A single delay timer + a single watchdog; both are
// cleared on every state transition so overlapping ops can't fire stale state.
let delayTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  if (delayTimer) {
    clearTimeout(delayTimer);
    delayTimer = null;
  }
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

export interface ProcessingOverlayState {
  status: OverlayStatus;
  label: string;
  /** Timestamp when `show()` was called — used to enforce minimum processing duration. */
  _showedAt: number;

  show: (label: string) => void;
  showSuccess: (label: string) => void;
  showError: (label: string) => void;
  hide: () => void;
}

export const processingOverlayStore = create<ProcessingOverlayState>()((set, get) => ({
  status: 'idle',
  label: '',
  _showedAt: 0,

  show: (label) => {
    clearTimers();
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      if (get().status !== 'processing') return;
      // eslint-disable-next-line no-console
      console.warn('[processingOverlay] watchdog force-hide — task never resolved');
      get().hide();
    }, WATCHDOG_MS);
    set({ status: 'processing', label, _showedAt: Date.now() });
  },

  showSuccess: (label) => {
    const remaining = Math.max(0, MIN_PROCESSING_MS - (Date.now() - get()._showedAt));
    clearTimers();
    delayTimer = setTimeout(() => {
      delayTimer = null;
      // Skip if the overlay was hidden/reset while we waited — never re-show a
      // result for a dismissed op.
      if (get().status !== 'processing') return;
      set({ status: 'success', label });
    }, remaining);
  },

  showError: (label) => {
    const remaining = Math.max(0, MIN_PROCESSING_MS - (Date.now() - get()._showedAt));
    clearTimers();
    delayTimer = setTimeout(() => {
      delayTimer = null;
      if (get().status !== 'processing') return;
      set({ status: 'error', label });
    }, remaining);
  },

  hide: () => {
    clearTimers();
    set({ status: 'idle', label: '' });
  },
}));

/**
 * Run an async task behind the processing overlay: show `loading`, then on
 * success show `success`, or on throw show `error`. Returns the task's result
 * (or undefined if it threw). Not serialised — overlapping calls are last-op-wins.
 */
export async function runWithOverlay<T>(
  task: () => Promise<T>,
  messages: { loading: string; success: string; error: string },
): Promise<T | undefined> {
  processingOverlayStore.getState().show(messages.loading);
  try {
    const result = await task();
    processingOverlayStore.getState().showSuccess(messages.success);
    return result;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[processingOverlay] task failed:', e);
    processingOverlayStore.getState().showError(messages.error);
    return undefined;
  }
}
