import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { type StyleProp, Text, type TextStyle } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { formatCompactDuration } from '../utils/formatters';

function formatNumber(v: number): string {
  return v.toLocaleString();
}

/**
 * Format a number of seconds for the My Listening card. Auto-scales to
 * the largest meaningful unit so the value always fits in its column:
 *
 *   <1h   → "Xm"
 *   <24h  → "Xh Ym"
 *   ≥24h  → "Xd Yh"      (drops minutes — noise at this scale)
 *
 * The day-tier switch keeps "107h 10m" from wrapping the column on
 * heavy listeners; the same value renders as "4d 11h" instead.
 */
const EXIT_DURATION = 200;
const ENTER_DURATION = 400;
const SLIDE_DISTANCE = 10;

export const AnimatedNumber = memo(function AnimatedNumber({
  value,
  style,
  format = 'number',
  suffix,
}: {
  value: number;
  style?: StyleProp<TextStyle>;
  format?: 'number' | 'duration';
  suffix?: string;
}) {
  const formatter = format === 'duration' ? formatCompactDuration : formatNumber;
  const [displayText, setDisplayText] = useState(() => formatter(value));
  const translateY = useSharedValue(0);
  const opacity = useSharedValue(1);
  const isFirstRender = useRef(true);

  const enterWithNewValue = useCallback(
    (v: number) => {
      setDisplayText(formatter(v));
      translateY.value = -SLIDE_DISTANCE;
      opacity.value = 0;
      translateY.value = withTiming(0, {
        duration: ENTER_DURATION,
        easing: Easing.out(Easing.cubic),
      });
      opacity.value = withTiming(1, { duration: ENTER_DURATION });
    },
    [formatter, translateY, opacity]
  );

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    translateY.value = withTiming(SLIDE_DISTANCE, { duration: EXIT_DURATION });
    opacity.value = withTiming(0, { duration: EXIT_DURATION }, (finished) => {
      if (finished) {
        runOnJS(enterWithNewValue)(value);
      }
    });
  }, [value, translateY, opacity, enterWithNewValue]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={animatedStyle}>
      <Text style={style}>{displayText}{suffix}</Text>
    </Animated.View>
  );
});
