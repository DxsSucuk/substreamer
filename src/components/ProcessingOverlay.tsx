import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '../hooks/useTheme';
import { absoluteFill } from '../utils/styles';
import {
  processingOverlayStore,
  type OverlayStatus,
} from '../store/processingOverlayStore';

const FADE_MS = 250;
const SUCCESS_DISPLAY_MS = 1200;
const ERROR_DISPLAY_MS = 2000;
/** Extra time past the fade before unmounting, so the exit animation finishes. */
const UNMOUNT_BUFFER_MS = 80;

export function ProcessingOverlay() {
  const status = processingOverlayStore((s) => s.status);
  const label = processingOverlayStore((s) => s.label);
  const hide = processingOverlayStore((s) => s.hide);
  const { colors } = useTheme();

  const shown = status !== 'idle';

  // Stay mounted through the fade-out, then unmount deterministically via a JS
  // timer (in the effect) — never via the Reanimated completion callback, which
  // can stall on Fabric and leave the card stuck on screen.
  const [mounted, setMounted] = useState(shown);

  // Retain the last real content so the fade-out never renders the empty `idle`
  // card (idle has no spinner/icon/label). The card always shows a spinner or a
  // result until it is fully gone.
  const lastContent = useRef<{ status: OverlayStatus; label: string }>({
    status: 'processing',
    label: '',
  });
  if (shown) lastContent.current = { status, label };
  const display = shown ? { status, label } : lastContent.current;

  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.9);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasShown = useRef(false);

  useEffect(() => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
    // Clearing here cancels a pending unmount when a new op re-shows within the
    // fade window (so a rapid idle→processing isn't unmounted mid-show).
    if (unmountTimer.current) {
      clearTimeout(unmountTimer.current);
      unmountTimer.current = null;
    }

    if (shown) {
      setMounted(true);
      // Clean entrance from 0 — reset only on the real not-shown→shown
      // transition so a `processing→success` change doesn't re-fade, and a
      // previously-stalled value can't leak in.
      if (!wasShown.current) {
        opacity.value = 0;
        scale.value = 0.9;
      }
      wasShown.current = true;
      opacity.value = withTiming(1, { duration: FADE_MS });
      scale.value = withTiming(1, { duration: FADE_MS });

      if (status === 'success' || status === 'error') {
        const delay = status === 'success' ? SUCCESS_DISPLAY_MS : ERROR_DISPLAY_MS;
        dismissTimer.current = setTimeout(() => hide(), delay);
      }
    } else {
      wasShown.current = false;
      opacity.value = withTiming(0, { duration: FADE_MS });
      scale.value = withTiming(0.9, { duration: FADE_MS });
      // Deterministic unmount, independent of the fade completing.
      unmountTimer.current = setTimeout(
        () => setMounted(false),
        FADE_MS + UNMOUNT_BUFFER_MS,
      );
    }

    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      if (unmountTimer.current) clearTimeout(unmountTimer.current);
    };
  }, [shown, status, hide, opacity, scale]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const cardStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  if (!mounted) return null;

  const icon = getIcon(display.status);

  return (
    <Animated.View
      testID="processingOverlayBackdrop"
      style={[styles.backdrop, backdropStyle]}
      // Blocking is driven by React `status`, not the animated value: the instant
      // the op ends (idle) touches pass through even if the fade stalls, so a
      // stuck fade can never trap the UI.
      pointerEvents={shown ? 'auto' : 'none'}
    >
      <Animated.View style={[styles.card, { backgroundColor: colors.card }, cardStyle]}>
        {display.status === 'processing' ? (
          <ActivityIndicator size="large" color={colors.textPrimary} />
        ) : icon ? (
          <Ionicons
            name={icon.name}
            size={40}
            color={display.status === 'error' ? colors.red : colors.primary}
          />
        ) : null}
        {display.label ? (
          <Animated.Text style={[styles.label, { color: colors.textPrimary }]}>
            {display.label}
          </Animated.Text>
        ) : null}
      </Animated.View>
    </Animated.View>
  );
}

function getIcon(status: OverlayStatus) {
  switch (status) {
    case 'success':
      return { name: 'checkmark-circle' as const };
    case 'error':
      return { name: 'close-circle' as const };
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  backdrop: {
    ...absoluteFill,
    zIndex: 9999,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  card: {
    borderRadius: 16,
    paddingHorizontal: 36,
    paddingVertical: 28,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    minWidth: 140,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 10,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
});
