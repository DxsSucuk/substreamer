import { create } from 'zustand';

export type OverlayStatus = 'idle' | 'processing' | 'success' | 'error';

const MIN_PROCESSING_MS = 900;

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

  show: (label) => set({ status: 'processing', label, _showedAt: Date.now() }),

  showSuccess: (label) => {
    const elapsed = Date.now() - get()._showedAt;
    const remaining = Math.max(0, MIN_PROCESSING_MS - elapsed);
    setTimeout(() => set({ status: 'success', label }), remaining);
  },

  showError: (label) => {
    const elapsed = Date.now() - get()._showedAt;
    const remaining = Math.max(0, MIN_PROCESSING_MS - elapsed);
    setTimeout(() => set({ status: 'error', label }), remaining);
  },

  hide: () => set({ status: 'idle', label: '' }),
}));

/**
 * Run an async task behind the processing overlay: show `loading`, then on
 * success show `success`, or on throw show `error`. Returns the task's result
 * (or undefined if it threw).
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
  } catch {
    processingOverlayStore.getState().showError(messages.error);
    return undefined;
  }
}
