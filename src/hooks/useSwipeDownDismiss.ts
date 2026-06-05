import { useCallback } from 'react';
import { Platform } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

/** Drag distance (px) past which release dismisses the screen. */
const DISMISS_DISTANCE = 120;
/** Downward fling velocity (px/s) that dismisses regardless of distance. */
const DISMISS_VELOCITY = 1000;
/** Downward movement (px) before the pan claims the touch — keeps taps and the
 *  horizontal progress slider working. */
const ACTIVATE_OFFSET = 12;
/** Spring-back duration when the drag is released below the threshold. */
const RESET_MS = 180;

/**
 * Android-only swipe-down-to-dismiss for the player screens.
 *
 * iOS already gets a native vertical dismiss gesture from react-native-screens
 * (`gestureDirection: 'vertical'` → its `swipeDirection`, which is `@platform
 * ios`). On Android that prop is a no-op — the only native dismiss gesture is
 * the horizontal system back — so we add a manual downward pan that drags the
 * screen and pops the route once it passes a distance/velocity threshold.
 *
 * `dragStyle` goes on the screen's outer `Animated.View` so the whole screen
 * follows the finger. `makeGesture(enabled)` is a factory so each NON-scrollable
 * region (the player view, the tablet's top section) can host its own detector
 * while scrollable regions keep scrolling — no gesture/scroll arbitration needed.
 */
export function useSwipeDownDismiss(onClose: () => void) {
  const translateY = useSharedValue(0);
  const dragStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const makeGesture = useCallback(
    (enabled: boolean) =>
      Gesture.Pan()
        .enabled(Platform.OS === 'android' && enabled)
        // Only claim clear downward drags; upward fails so any nested scroll
        // (and the horizontal slider) is never stolen.
        .activeOffsetY([ACTIVATE_OFFSET, Number.MAX_SAFE_INTEGER])
        .failOffsetY(-ACTIVATE_OFFSET)
        .onUpdate((e) => {
          translateY.value = Math.max(0, e.translationY);
        })
        .onEnd((e) => {
          if (e.translationY > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) {
            runOnJS(onClose)();
          } else {
            translateY.value = withTiming(0, { duration: RESET_MS });
          }
        }),
    [translateY, onClose],
  );

  return { dragStyle, makeGesture };
}
