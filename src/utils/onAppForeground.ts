import { AppState, type NativeEventSubscription } from 'react-native';

/**
 * Subscribe to app-foreground transitions. `fn` fires whenever AppState
 * becomes 'active'. Returns the subscription so callers can `.remove()` it
 * on teardown.
 */
export function onAppForeground(fn: () => void): NativeEventSubscription {
  return AppState.addEventListener('change', (next) => {
    if (next === 'active') fn();
  });
}
