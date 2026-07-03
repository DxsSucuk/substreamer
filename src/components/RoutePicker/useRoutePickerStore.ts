import { create } from 'zustand';

/**
 * Cross-screen mount controller for the audio route picker. The sheet mounts
 * once at the root `_layout`; any screen (the player CastButton today) calls
 * `open()` to surface it. Keeping the open state out of any single screen lets
 * the sheet survive tab switches + per-screen unmount.
 */
interface RoutePickerState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useRoutePickerStore = create<RoutePickerState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
