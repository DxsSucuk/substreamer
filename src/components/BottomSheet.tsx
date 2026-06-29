import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type DimensionValue,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../hooks/useTheme';

import { absoluteFill } from '../utils/styles';
const BACKDROP_OPACITY = 0.4;
const DISMISS_DISTANCE_RATIO = 0.35;
const DISMISS_VELOCITY = 800;
const DEFAULT_HEIGHT = 600;
/** Gap kept below the status bar so a full-height sheet never butts the top. */
const TOP_GAP = 24;
const ENTRY_SPRING = { damping: 28, stiffness: 160, mass: 0.8 };
const EXIT_DURATION = 250;
const BACKDROP_DURATION = 300;

interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  /**
   * Fires AFTER the native Modal has fully torn down (React unmount + a
   * small RAF buffer for Android's window manager). Use this when you
   * need to chain another Modal on top — opening an Alert immediately
   * after `onClose` runs into Android's "only one Modal at a time"
   * limitation; awaiting `onCloseComplete` instead is reliable without
   * hard-coded timeouts.
   *
   * **When to use:** any sheet whose handlers open a chained Modal in the
   * SAME JSX tree — typically an inline `<ThemedAlert>` or an inline
   * `<BottomSheet>`. Sheets that swap via a global Zustand store
   * (e.g. opening `createShareStore.show(...)` after closing this one)
   * don't need this — React only renders one global sheet at a time so
   * Android never sees two stacked Modals. See `moreOptionsStore.hideAndAwait()`
   * for the canonical await-based pattern.
   */
  onCloseComplete?: () => void;
  closeable?: boolean;
  maxHeight?: DimensionValue;
  /**
   * Wrap children in a vertical ScrollView so tall content scrolls within the
   * sheet instead of overflowing off the top of the screen. Default `true`.
   * Pass `false` for sheets that supply their own scroll container (FlatList /
   * FlashList / ScrollView) — wrapping those would nest scrollables.
   */
  scrollable?: boolean;
  children: React.ReactNode;
}

export function BottomSheet({
  visible,
  onClose,
  onCloseComplete,
  closeable = true,
  maxHeight,
  scrollable = true,
  children,
}: BottomSheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  // Never let the sheet exceed the screen (minus the status bar + a small gap),
  // so tall content can't run off the top. We resolve the caller's maxHeight to
  // a concrete pixel value (percentages relative to the screen height) so the
  // keyboard-avoidance worklet below can shrink it: when the keyboard is up the
  // sheet must fit between the keyboard top and the screen cap, with its inner
  // scroll/list handling the overflow.
  const screenCap = windowHeight - insets.top - TOP_GAP;
  let resolvedMaxHeight = screenCap;
  if (typeof maxHeight === 'number') {
    resolvedMaxHeight = Math.min(maxHeight, screenCap);
  } else if (typeof maxHeight === 'string') {
    const pct = parseFloat(maxHeight);
    if (Number.isFinite(pct)) {
      resolvedMaxHeight = Math.min((pct / 100) * windowHeight, screenCap);
    }
  }

  const [internalVisible, setInternalVisible] = useState(false);
  const isClosing = useRef(false);

  const translateY = useSharedValue(DEFAULT_HEIGHT);
  const backdropOpacity = useSharedValue(0);
  // Shared values so worklet gesture callbacks can read them
  const sheetHeightSV = useSharedValue(DEFAULT_HEIGHT);
  const closeableSV = useSharedValue(closeable);
  // On-screen keyboard height, tracked so the sheet can lift above it.
  const keyboardHeight = useSharedValue(0);

  // Keep closeableSV in sync with prop
  useEffect(() => {
    closeableSV.value = closeable;
  }, [closeable, closeableSV]);

  // Refs so `scheduleCloseComplete` can read the latest callback without
  // re-creating itself (and re-triggering the close useEffect) every render.
  const onCloseCompleteRef = useRef(onCloseComplete);
  useEffect(() => {
    onCloseCompleteRef.current = onCloseComplete;
  }, [onCloseComplete]);

  /**
   * Fire onCloseComplete after the Modal's native window manager has had
   * time to actually dismiss. Sequence:
   *   1. requestAnimationFrame — wait for React to commit the unmount
   *      (the parent already set internalVisible=false; the RAF tick
   *      happens after the next render phase).
   *   2. setTimeout(100) — wait a deterministic 100ms for Android's
   *      window manager to release the dialog window. setTimeout is
   *      used here (not a second RAF) because RAFs on RN-0.85 / Fabric
   *      are gated on native VSYNC + JS-thread availability; with no
   *      pending animation the inner RAF can sit waiting for a frame
   *      that never arrives, which hangs every awaiter on hideAndAwait.
   *      setTimeout fires regardless of render activity.
   */
  const scheduleCloseComplete = useCallback(() => {
    requestAnimationFrame(() => {
      setTimeout(() => {
        onCloseCompleteRef.current?.();
      }, 100);
    });
  }, []);

  const finishClose = useCallback(() => {
    setInternalVisible(false);
    isClosing.current = false;
    onClose();
    scheduleCloseComplete();
  }, [onClose, scheduleCloseComplete]);

  const markClosing = useCallback(() => {
    isClosing.current = true;
  }, []);

  const playEntryAnimation = useCallback(() => {
    const height = sheetHeightSV.value || DEFAULT_HEIGHT;
    translateY.value = height;
    backdropOpacity.value = 0;
    translateY.value = withSpring(0, ENTRY_SPRING);
    backdropOpacity.value = withTiming(BACKDROP_OPACITY, { duration: BACKDROP_DURATION });
  }, [translateY, backdropOpacity, sheetHeightSV]);

  const playExitAnimation = useCallback(() => {
    if (isClosing.current) return;
    isClosing.current = true;

    const height = sheetHeightSV.value || DEFAULT_HEIGHT;
    translateY.value = withTiming(height, { duration: EXIT_DURATION });
    backdropOpacity.value = withTiming(0, { duration: EXIT_DURATION }, (finished) => {
      if (finished) {
        runOnJS(finishClose)();
      }
    });
  }, [translateY, backdropOpacity, sheetHeightSV, finishClose]);

  // visible prop → true: push sheet off-screen before mounting Modal
  useEffect(() => {
    if (visible && !internalVisible) {
      isClosing.current = false;
      translateY.value = sheetHeightSV.value || DEFAULT_HEIGHT;
      backdropOpacity.value = 0;
      setInternalVisible(true);
    }
  }, [visible, internalVisible, translateY, backdropOpacity, sheetHeightSV]);

  // visible prop → false while shown: close immediately (no exit animation).
  // Exit animations only play for user-initiated dismissals (swipe, backdrop tap,
  // back button) which call playExitAnimation directly. Programmatic closes must
  // be instant so the next sheet can mount without two Modals overlapping.
  //
  // U8 (react-native-screens iOS Fabric Yoga SIGABRT, software-mansion/react-native-screens#3786):
  // defer setInternalVisible(false) by one frame. Action handlers commonly call
  // both `setSomeParentState(...)` and `hide()` in the same tick. Tearing down
  // the native Modal in the same frame as the parent re-render races Yoga and
  // crashes on iOS 26 Fabric. Letting the parent commit + paint first then
  // unmounting avoids the collision and is invisible to the user.
  useEffect(() => {
    if (!visible && internalVisible && !isClosing.current) {
      const handle = requestAnimationFrame(() => {
        if (isClosing.current) return;
        translateY.value = 0;
        backdropOpacity.value = 0;
        setInternalVisible(false);
        scheduleCloseComplete();
      });
      return () => cancelAnimationFrame(handle);
    }
  }, [visible, internalVisible, translateY, backdropOpacity, scheduleCloseComplete]);

  // Lift the sheet above the on-screen keyboard. The sheet is pinned to the
  // bottom of a transparent Modal, and nothing moves it out from under the
  // keyboard for us: iOS never resizes for the keyboard, and on Android the
  // Modal is a separate Dialog window that doesn't inherit the activity's
  // adjustResize. So track the keyboard height ourselves and feed it into the
  // sheet's transform + maxHeight (see sheetAnimatedStyle). Only while shown.
  useEffect(() => {
    if (!internalVisible) return undefined;
    // iOS exposes Will* events that animate in lockstep with the keyboard;
    // Android only fires Did*.
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      keyboardHeight.value = withTiming(e.endCoordinates?.height ?? 0, {
        duration: e.duration || 250,
      });
    });
    const hideSub = Keyboard.addListener(hideEvt, (e) => {
      keyboardHeight.value = withTiming(0, { duration: e?.duration || 200 });
    });
    return () => {
      showSub.remove();
      hideSub.remove();
      keyboardHeight.value = 0;
    };
  }, [internalVisible, keyboardHeight]);

  const handleModalShow = useCallback(() => {
    playEntryAnimation();
  }, [playEntryAnimation]);

  const handleBackdropPress = useCallback(() => {
    if (!closeable) return;
    playExitAnimation();
  }, [closeable, playExitAnimation]);

  const handleRequestClose = useCallback(() => {
    if (!closeable) return;
    playExitAnimation();
  }, [closeable, playExitAnimation]);

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    sheetHeightSV.value = e.nativeEvent.layout.height;
  }, [sheetHeightSV]);

  const panGesture = Gesture.Pan()
    .activeOffsetY(10)
    .onUpdate((e) => {
      'worklet';
      if (!closeableSV.value) return;
      const clamped = Math.max(0, e.translationY);
      translateY.value = clamped;

      const height = sheetHeightSV.value || DEFAULT_HEIGHT;
      const progress = 1 - clamped / height;
      backdropOpacity.value = BACKDROP_OPACITY * Math.max(0, Math.min(1, progress));
    })
    .onEnd((e) => {
      'worklet';
      if (!closeableSV.value) return;

      const height = sheetHeightSV.value || DEFAULT_HEIGHT;
      const shouldDismiss =
        e.translationY > height * DISMISS_DISTANCE_RATIO ||
        e.velocityY > DISMISS_VELOCITY;

      if (shouldDismiss) {
        translateY.value = withTiming(height, { duration: EXIT_DURATION });
        backdropOpacity.value = withTiming(0, { duration: EXIT_DURATION }, (finished) => {
          if (finished) {
            runOnJS(finishClose)();
          }
        });
        runOnJS(markClosing)();
      } else {
        translateY.value = withSpring(0, ENTRY_SPRING);
        backdropOpacity.value = withTiming(BACKDROP_OPACITY, { duration: 200 });
      }
    });

  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    // Lift by the keyboard height so the sheet's bottom sits on the keyboard
    // top, and cap the height to the space that leaves above it — the inner
    // ScrollView / FlashList then reflows into the visible area (header stays
    // put, content scrolls) instead of hiding behind the keyboard.
    transform: [{ translateY: translateY.value - keyboardHeight.value }],
    maxHeight: Math.min(resolvedMaxHeight, screenCap - keyboardHeight.value),
  }));

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    // toFixed(4) prevents scientific notation (e.g. 3.5e-8) which
    // Reanimated's color parser cannot handle.
    backgroundColor: `rgba(0,0,0,${backdropOpacity.value.toFixed(4)})`,
  }));

  if (!internalVisible) return null;

  return (
    <Modal
      visible={internalVisible}
      transparent
      animationType="none"
      onShow={handleModalShow}
      onRequestClose={handleRequestClose}
      statusBarTranslucent
    >
      <GestureHandlerRootView style={styles.gestureRoot}>
        {/* Animated backdrop */}
        <Animated.View style={[styles.backdropFill, backdropAnimatedStyle]}>
          <Pressable testID="bottom-sheet-backdrop" style={styles.backdropPressable} onPress={handleBackdropPress} />
        </Animated.View>

        {/* Sheet */}
        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.card,
              paddingBottom: Math.max(insets.bottom, 16),
            },
            sheetAnimatedStyle,
          ]}
          onLayout={handleLayout}
        >
          {/* Handle — gesture scoped here so it doesn't block ScrollView */}
          <GestureDetector gesture={panGesture}>
            <View style={styles.handleContainer}>
              <View style={[styles.handle, { backgroundColor: colors.primary }]} />
            </View>
          </GestureDetector>

          {scrollable ? (
            // flexShrink lets the ScrollView collapse to the available space when
            // the sheet hits its max height (→ content scrolls); when content is
            // short the sheet still sizes to content and nothing scrolls.
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              bounces={false}
              showsVerticalScrollIndicator
            >
              {children}
            </ScrollView>
          ) : (
            children
          )}
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  gestureRoot: {
    flex: 1,
  },
  backdropFill: {
    ...absoluteFill,
    zIndex: 0,
  },
  backdropPressable: {
    flex: 1,
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    zIndex: 1,
    maxWidth: 600,
    alignSelf: 'center',
    width: '100%',
  },
  scroll: {
    flexShrink: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  handleContainer: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
});
