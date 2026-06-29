import { create } from 'zustand';

import { type ServerSlot } from './authStore';

export type BannerState = 'hidden' | 'unreachable' | 'reconnected' | 'ssl-error';

/**
 * Failover detect-and-confirm state, evaluated when the ACTIVE server is
 * unreachable (set by `failoverService.evaluateServerDownPrompt`):
 *   - a `ServerSlot` → the OTHER slot is reachable; the `unreachable` banner
 *     becomes a tappable "switch to {slot}" offer.
 *   - `'both-down'`  → the other slot is configured but also unreachable; show a
 *     "both servers unavailable" message (not tappable).
 *   - `null`         → nothing to offer (single server, or active server is fine).
 * Cleared on switch and when the active server recovers.
 */
export type FailoverPrompt = ServerSlot | 'both-down';

export interface ConnectivityState {
  hasConnection: boolean;
  isServerReachable: boolean;
  bannerState: BannerState;
  failoverPrompt: FailoverPrompt | null;

  setHasConnection: (reachable: boolean) => void;
  setServerReachable: (reachable: boolean) => void;
  setBannerState: (state: BannerState) => void;
  setFailoverPrompt: (prompt: FailoverPrompt) => void;
  clearFailoverPrompt: () => void;
}

export const connectivityStore = create<ConnectivityState>()((set) => ({
  hasConnection: true,
  isServerReachable: true,
  bannerState: 'hidden',
  failoverPrompt: null,

  setHasConnection: (reachable) => set({ hasConnection: reachable }),
  setServerReachable: (reachable) => set({ isServerReachable: reachable }),
  setBannerState: (bannerState) => set({ bannerState }),
  setFailoverPrompt: (failoverPrompt) => set({ failoverPrompt }),
  clearFailoverPrompt: () => set({ failoverPrompt: null }),
}));
