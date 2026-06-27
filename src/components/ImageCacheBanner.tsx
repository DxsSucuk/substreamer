/**
 * Pill-style notification banner for the persistent image-cache refresh
 * cycle. Shows progress while a cycle is running (or paused). Renamed
 * from `CoverArtRecacheBanner` when the Migration-22 single-shot recache
 * was replaced with the queueable, pause/resume/cancel-able refresh in
 * Phase 3 of the image-cache queue rework.
 *
 * Visual language matches `LibrarySyncBanner` / `StorageFullBanner` —
 * dark capsule centred below the header, rendered via the priority
 * ladder in `BannerStack`.
 */

import Ionicons from '@react-native-vector-icons/ionicons/static';
import { memo, useEffect, useRef } from 'react';
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

import { dismissImageCacheErrorBanner } from '../services/imageCacheService';
import { imageDownloadQueueStore } from '../store/imageDownloadQueueStore';

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
const ERROR_RED = '#FF453A';

export const ImageCacheBanner = memo(function ImageCacheBanner() {
  const { t } = useTranslation();
  const cycleId = imageDownloadQueueStore((s) => s.cycleId);
  const cycleTotal = imageDownloadQueueStore((s) => s.cycleTotal);
  const cycleProcessed = imageDownloadQueueStore((s) => s.cycleProcessed);
  const cycleFailed = imageDownloadQueueStore((s) => s.cycleFailed);
  const isPaused = imageDownloadQueueStore((s) => s.isPaused);
  const phase = imageDownloadQueueStore((s) => s.phase);

  const isError = phase === 'error';
  // 'dismissed' keeps the cycle alive (so retry still works) but hides the banner.
  const visible = cycleId !== null && cycleTotal > 0 && phase !== 'dismissed';

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

  if (!visible) return null;

  const progressLabel = isPaused
    ? t('imageCacheBannerPausedLabel', 'Paused')
    : t('imageCacheBannerRunningLabel', 'Refreshing covers');
  const countText = `${cycleProcessed} / ${cycleTotal}`;
  const errorLabel = t('imageCacheBannerErrorLabel', {
    count: cycleFailed,
    defaultValue: "{{count}} covers couldn't be refreshed",
  });

  return (
    <Animated.View style={[styles.outer, containerStyle]}>
      <View style={styles.pillContainer}>
        {/* In the error phase the whole pill is a tap-to-dismiss control. */}
        <Pressable onPress={() => dismissImageCacheErrorBanner()} disabled={!isError}>
          <Animated.View style={[styles.capsule, capsuleStyle]}>
            <Ionicons
              name={isError ? 'alert-circle' : isPaused ? 'pause' : 'sync'}
              size={16}
              color={isError ? ERROR_RED : ACCENT_BLUE}
            />
            <Text style={styles.label} numberOfLines={1}>
              {isError ? errorLabel : `${progressLabel} ${countText}`}
            </Text>
            {isError ? (
              <Ionicons name="close" size={15} color="rgba(255, 255, 255, 0.55)" />
            ) : null}
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
    paddingHorizontal: 20,
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
});
