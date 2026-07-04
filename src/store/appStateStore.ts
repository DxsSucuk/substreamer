/**
 * Single source of truth for whether the app is foreground-active.
 *
 * Backgrounded audio playback keeps native progress events firing (~2–4 Hz),
 * and unpaused animations/timers keep the JS + UI threads busy off-screen —
 * which prevents the CPU from quiescing and overheats the device. Consumers
 * gate that work on `isActive`: services read `appStateStore.getState().isActive`
 * (and `.subscribe`), components use the `useAppActive()` hook.
 *
 * One app-lifetime `AppState` listener is installed here on first import, so the
 * flag is correct in both React and headless/service contexts without wiring a
 * listener into every consumer. `inactive` (iOS transient: app switcher, call,
 * Control Center) counts as not-active — it's brief and pausing then is safe.
 */
import { AppState } from 'react-native';
import { create } from 'zustand';

interface AppStateStoreState {
  /** True while the app is foreground-active (`AppState === 'active'`). */
  isActive: boolean;
}

export const appStateStore = create<AppStateStoreState>(() => ({
  // Boot-safe: the app is foreground at launch, and `currentState` can briefly
  // read 'unknown' before the first 'change'. Default active unless *known*
  // backgrounded, so we never wrongly gate off foreground work at startup.
  isActive: AppState.currentState !== 'background',
}));

AppState.addEventListener('change', (status) => {
  appStateStore.setState({ isActive: status === 'active' });
});
