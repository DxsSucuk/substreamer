import { appStateStore } from '../store/appStateStore';

/** Subscribe to whether the app is foreground-active. See `appStateStore`. */
export function useAppActive(): boolean {
  return appStateStore((s) => s.isActive);
}
