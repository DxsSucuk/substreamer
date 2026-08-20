import { create } from 'zustand';

interface OverlayState {
  /** How many overlays are currently covering the screen. A count, not a flag: sheets can
   *  stack, and one closing must not clear another that is still up. */
  count: number;
  open: () => void;
  close: () => void;
}

/**
 * Tracks whether something is covering the screen — the search results overlay, any bottom
 * sheet — so screen-level input that belongs to the content underneath can be ignored
 * while it is.
 *
 * The iOS status-bar tap is the case this exists for. It is a screen-level gesture with no
 * notion of what is on top, so without this a tap meant for an overlay reaches the list
 * behind it and scrolls something the user cannot see.
 */
export const overlayStore = create<OverlayState>()((set) => ({
  count: 0,
  open: () => set((s) => ({ count: s.count + 1 })),
  close: () => set((s) => ({ count: Math.max(0, s.count - 1) })),
}));

/** True when anything is covering the screen. Reads without subscribing — callers are
 *  event handlers, not renders. */
export function isOverlayOpen(): boolean {
  return overlayStore.getState().count > 0;
}
