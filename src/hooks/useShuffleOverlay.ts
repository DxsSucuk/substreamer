import { useCallback, useState } from 'react';
import { type ViewStyle } from 'react-native';
import {
  Easing,
  cancelAnimation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { shuffleQueue } from '../services/playerService';

/**
 * Owns the shuffle action plus its full-screen "Shuffling…" spin overlay.
 * Pair with the `<ShuffleOverlay />` component, passing the returned
 * `overlayStyle`/`spinStyle` and gating render on `shuffling`.
 */
export function useShuffleOverlay() {
  const [shuffling, setShuffling] = useState(false);
  const overlayOpacity = useSharedValue(0);
  const spinAnim = useSharedValue(0);

  const overlayStyle = useAnimatedStyle<ViewStyle>(() => ({
    opacity: overlayOpacity.value,
  }));

  const spinStyle = useAnimatedStyle<ViewStyle>(() => ({
    transform: [{ rotate: `${interpolate(spinAnim.value, [0, 1], [0, 360])}deg` }],
  }));

  const handleShuffle = useCallback(async () => {
    if (shuffling) return;
    setShuffling(true);
    spinAnim.value = 0;

    overlayOpacity.value = withTiming(1, { duration: 250 });
    spinAnim.value = withRepeat(
      withTiming(1, { duration: 800, easing: Easing.linear }),
      -1,
    );

    const MIN_DISPLAY = 2000;
    await Promise.all([
      shuffleQueue(),
      new Promise<void>((r) => setTimeout(r, MIN_DISPLAY)),
    ]);

    cancelAnimation(spinAnim);
    overlayOpacity.value = withTiming(0, { duration: 300 }, (finished) => {
      if (finished) runOnJS(setShuffling)(false);
    });
  }, [shuffling, overlayOpacity, spinAnim]);

  return { shuffling, handleShuffle, overlayStyle, spinStyle };
}
