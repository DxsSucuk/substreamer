import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { syncStatusStore, type DetailSyncPhase } from '../store/syncStatusStore';

import type { IoniconsName } from '../utils/iconNames';
const CAPSULE_HEIGHT = 44;
const CAPSULE_BORDER_RADIUS = CAPSULE_HEIGHT / 2;
const BANNER_HEIGHT = CAPSULE_HEIGHT + 8;

const SPRING_CONFIG = { damping: 14, stiffness: 200, mass: 0.8 };
const EXPAND_MS = 300;
const COLLAPSE_MS = 280;
const SHRINK_MS = 300;
const SHRINK_EASING = Easing.in(Easing.cubic);
const LAYOUT_EASING = Easing.inOut(Easing.cubic);

const ACCENT_BLUE = '#1D9BF0';
const WARNING_AMBER = '#FF9500';
const ERROR_RED = '#FF453A';

/** Hide the banner entirely for tiny libraries where the walk finishes in seconds. */
const MIN_TOTAL_TO_SHOW = 50;

interface Variant {
  icon: IoniconsName;
  iconColor: string;
  label: string;
  tappable: boolean;
}

function getVariant(
  phase: DetailSyncPhase,
  completed: number,
  total: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): Variant | null {
  if (phase === 'syncing') {
    return {
      icon: 'sync',
      iconColor: ACCENT_BLUE,
      label: `${t('syncingLibrary')} ${completed} / ${total}`,
      tappable: true,
    };
  }
  if (phase === 'paused-offline') {
    return {
      icon: 'cloud-offline',
      iconColor: WARNING_AMBER,
      label: t('syncPausedOffline'),
      tappable: false,
    };
  }
  if (phase === 'paused-auth-error' || phase === 'paused-metered' || phase === 'error') {
    return {
      icon: 'alert-circle',
      iconColor: ERROR_RED,
      label: t('syncErrorTap'),
      tappable: true,
    };
  }
  return null;
}

export const LibrarySyncBanner = memo(function LibrarySyncBanner() {
  const { t } = useTranslation();
  const router = useRouter();
  const phase = syncStatusStore((s) => s.detailSyncPhase);
  const total = syncStatusStore((s) => s.detailSyncTotal);
  const completed = syncStatusStore((s) => s.detailSyncCompleted);
  const bannerDismissedAt = syncStatusStore((s) => s.bannerDismissedAt);

  const suppressed = bannerDismissedAt != null;
  const tinyLibrary = total > 0 && total < MIN_TOTAL_TO_SHOW;
  const variant = getVariant(phase, completed, total, t);
  const visible = variant != null && !suppressed && !tinyLibrary;

  const prevVisible = useRef(visible);

  const heightValue = useSharedValue(visible ? BANNER_HEIGHT : 0);
  const capsuleScale = useSharedValue(visible ? 1 : 0);
  const capsuleOpacity = useSharedValue(visible ? 1 : 0);

  useEffect(() => {
    if (visible && !prevVisible.current) {
      heightValue.value = withTiming(BANNER_HEIGHT, { duration: EXPAND_MS, easing: LAYOUT_EASING });
      capsuleOpacity.value = withDelay(80, withTiming(1, { duration: 150 }));
      capsuleScale.value = withDelay(80, withSpring(1, SPRING_CONFIG));
    } else if (!visible && prevVisible.current) {
      capsuleScale.value = withTiming(0, { duration: SHRINK_MS, easing: SHRINK_EASING });
      capsuleOpacity.value = withTiming(0, { duration: SHRINK_MS - 50 });
      heightValue.value = withDelay(
        SHRINK_MS - 80,
        withTiming(0, { duration: COLLAPSE_MS, easing: LAYOUT_EASING }),
      );
    }
    prevVisible.current = visible;
  }, [visible, heightValue, capsuleScale, capsuleOpacity]);

  const containerStyle = useAnimatedStyle(() => ({
    height: heightValue.value,
  }));

  const capsuleStyle = useAnimatedStyle(() => ({
    opacity: capsuleOpacity.value,
    transform: [
      { scaleX: capsuleScale.value },
      { scaleY: capsuleScale.value },
    ],
  }));

  const handlePress = useCallback(() => {
    if (variant?.tappable) {
      router.push('/settings-library-data');
    }
  }, [router, variant]);

  const handleDismiss = useCallback(() => {
    syncStatusStore.getState().setBannerDismissedAt(Date.now());
  }, []);

  if (!visible || !variant) return null;
  const renderVariant = variant;

  return (
    <Animated.View style={[styles.outer, containerStyle]}>
      <View style={styles.pillContainer}>
        <Pressable onPress={handlePress} disabled={!renderVariant.tappable}>
          <Animated.View style={[styles.capsule, capsuleStyle]}>
            <Ionicons name={renderVariant.icon} size={16} color={renderVariant.iconColor} />
            <Text style={styles.label} numberOfLines={1}>
              {renderVariant.label}
            </Text>
            <Pressable
              onPress={handleDismiss}
              hitSlop={8}
              style={styles.dismissHit}
              accessibilityLabel={t('dismiss')}
            >
              <Ionicons name="close" size={14} color="#fff" />
            </Pressable>
          </Animated.View>
        </Pressable>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  outer: {
    overflow: 'hidden',
  },
  pillContainer: {
    height: BANNER_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.78)',
    borderRadius: CAPSULE_BORDER_RADIUS,
    height: CAPSULE_HEIGHT,
    paddingLeft: 20,
    paddingRight: 12,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 8,
  },
  label: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  dismissHit: {
    padding: 4,
    borderRadius: 12,
  },
});
