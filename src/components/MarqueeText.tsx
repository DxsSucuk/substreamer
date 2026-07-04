/**
 * MarqueeText – a text component that auto-scrolls back and forth
 * when its content is too wide for the container.
 *
 * If the text fits, it renders as a normal single-line `<Text>`.
 * When it overflows, a ping-pong translateX animation reveals the
 * full content with pauses at each end.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  type LayoutChangeEvent,
  ScrollView,
  StyleSheet,
  Text,
  type TextProps,
  View,
} from 'react-native';

import { useAppActive } from '../hooks/useAppActive';

export interface MarqueeTextProps extends TextProps {
  /** Scroll speed in pixels per second. @default 40 */
  speed?: number;
  /** Pause duration at each end in milliseconds. @default 1500 */
  pauseDuration?: number;
  /** Delay before the first scroll begins in milliseconds. @default 2000 */
  initialDelay?: number;
}

export const MarqueeText = memo(function MarqueeText({
  children,
  style,
  speed = 40,
  pauseDuration = 1500,
  initialDelay = 2000,
  ...rest
}: MarqueeTextProps) {
  const [containerWidth, setContainerWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const translateX = useRef(new Animated.Value(0)).current;
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  // Pause the scroll loop while backgrounded — an off-screen Animated.loop keeps
  // the choreographer / compositing awake and prevents the CPU from idling.
  const isActive = useAppActive();

  const shouldScroll = textWidth > 0 && containerWidth > 0 && textWidth > containerWidth;
  const scrollDistance = shouldScroll ? textWidth - containerWidth : 0;

  const handleContainerLayout = useCallback((e: LayoutChangeEvent) => {
    setContainerWidth(e.nativeEvent.layout.width);
  }, []);

  const handleTextLayout = useCallback((e: LayoutChangeEvent) => {
    setTextWidth(e.nativeEvent.layout.width);
  }, []);

  // Stable key that changes whenever the text content changes.
  const childrenKey = typeof children === 'string' ? children : JSON.stringify(children);

  // Detect stale textWidth during content transitions. When the title
  // changes, textWidth still holds the previous title's measurement for
  // one render. If the new title is longer, the stale width is too
  // narrow and the text wraps briefly, causing a visible layout jump.
  // Using 10000 during the transition prevents wrapping; the container's
  // overflow:'hidden' keeps the visual result identical.
  const prevKeyRef = useRef(childrenKey);
  const isStale = prevKeyRef.current !== childrenKey;

  // Snap back to the start position when content changes.
  // NOTE: do NOT reset textWidth here – onLayout fires before this
  // effect and would be clobbered, preventing the animation from
  // ever starting on subsequent tracks.
  useEffect(() => {
    prevKeyRef.current = childrenKey;
    translateX.setValue(0);
  }, [childrenKey, translateX]);

  // Run the ping-pong animation.
  // Include childrenKey so the animation restarts for every new track,
  // even if shouldScroll / scrollDistance happen to be identical.
  useEffect(() => {
    if (!shouldScroll || !isActive) {
      translateX.setValue(0);
      return;
    }

    const scrollDuration = (scrollDistance / speed) * 1000;

    const loop = Animated.loop(
      Animated.sequence([
        // Initial pause
        Animated.delay(initialDelay),
        // Scroll left to reveal end
        Animated.timing(translateX, {
          toValue: -scrollDistance,
          duration: scrollDuration,
          useNativeDriver: true,
        }),
        // Pause at the end
        Animated.delay(pauseDuration),
        // Scroll back to start
        Animated.timing(translateX, {
          toValue: 0,
          duration: scrollDuration,
          useNativeDriver: true,
        }),
        // Pause at the start before repeating
        Animated.delay(pauseDuration),
      ]),
    );

    animationRef.current = loop;
    loop.start();

    return () => {
      loop.stop();
      animationRef.current = null;
    };
  }, [shouldScroll, isActive, scrollDistance, speed, pauseDuration, initialDelay, translateX, childrenKey]);

  const innerWidth = (textWidth > 0 && !isStale) ? textWidth : 10000;

  return (
    <View style={styles.container} onLayout={handleContainerLayout} pointerEvents="none">
      {/*
        The inner Animated.View is always set wide enough for the full
        text so it never wraps. The outer container clips via
        overflow: 'hidden'. numberOfLines={1} prevents Android from
        inflating the container height when the inner view is wider
        than the clipping container (a documented Yoga/Android quirk).
      */}
      <Animated.View
        style={[
          { width: innerWidth },
          shouldScroll ? { transform: [{ translateX }] } : undefined,
        ]}
      >
        <Text {...rest} numberOfLines={1} style={style}>
          {children}
        </Text>
      </Animated.View>

      {/*
        Hidden text for measuring the full, unwrapped width.
        A horizontal ScrollView provides unbounded width so the text
        never wraps on any platform – unlike an absolutely-positioned
        wide View, which Android can still constrain.
      */}
      <ScrollView
        horizontal
        scrollEnabled={false}
        style={styles.hiddenScroll}
        pointerEvents="none"
      >
        <Text
          key={childrenKey}
          {...rest}
          style={[style, styles.hiddenText]}
          onLayout={handleTextLayout}
        >
          {children}
        </Text>
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  hiddenScroll: {
    position: 'absolute',
    opacity: 0,
  },
  hiddenText: {
    alignSelf: 'flex-start',
  },
});
