import ExpoScrollToTopModule from './ExpoScrollToTopModule';

/**
 * Intercept the iOS status-bar tap BEFORE it scrolls.
 *
 * React Native only reports the tap once UIKit has finished animating
 * (`onScrollToTop` comes from `scrollViewDidScrollToTop:`), which is too late for a
 * windowed list: the animation has already flown through every row it holds loaded, and
 * the recycler cannot draw them fast enough. This module answers UIKit's
 * `scrollViewShouldScrollToTop:` instead, so the scroll never starts and the list can
 * reset itself directly.
 *
 * Android has no such convention; the native side is a no-op there.
 */

/**
 * Arm or disarm interception. While armed, the status-bar tap is declined and
 * {@link addStatusBarTapListener} fires instead of anything scrolling.
 *
 * It is GLOBAL: arm only while a list that handles the tap itself is on screen, and
 * disarm as soon as it is not, or taps meant for other scroll views are swallowed too.
 */
export function setArmed(armed: boolean): void {
  ExpoScrollToTopModule.setArmed(armed);
}

/** Whether the interception is actually in place (false on Android, and on any iOS build
 *  where the RN internals it hooks have moved). Callers should fall back to normal
 *  scroll-to-top when this is false. */
export function isSupported(): boolean {
  return ExpoScrollToTopModule.isSupported();
}

/** Subscribe to declined status-bar taps. Returns an unsubscribe function. */
export function addStatusBarTapListener(listener: () => void): () => void {
  const subscription = ExpoScrollToTopModule.addListener('onStatusBarTap', listener);
  return () => subscription.remove();
}
