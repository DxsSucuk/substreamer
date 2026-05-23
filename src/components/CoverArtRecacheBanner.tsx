/**
 * Pill-style notification banner for the post-Migration-22 cover-art
 * recache pass. Shares the visual language of `LibrarySyncBanner` and
 * `StorageFullBanner` — a dark capsule centered below the header,
 * rendered via the priority ladder in `BannerStack`.
 *
 * Original implementation styled this as a `DownloadBanner`-shaped full-
 * width bar rendered inside `BottomChrome`. That was the wrong family —
 * cover-art recache is a transient library-data signal, not a download.
 * Moved to the top-of-tabs banner stack to match the library-sync
 * progress banner.
 */

import Ionicons from '@react-native-vector-icons/ionicons/static';
import { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { coverArtRecacheStore } from '../store/coverArtRecacheStore';

const CAPSULE_HEIGHT = 44;
const CAPSULE_BORDER_RADIUS = CAPSULE_HEIGHT / 2;
export const BANNER_HEIGHT = CAPSULE_HEIGHT + 8;

const SPRING_CONFIG = { damping: 14, stiffness: 200, mass: 0.8 };
const EXPAND_MS = 300;
const COLLAPSE_MS = 280;
const SHRINK_MS = 300;
const SHRINK_EASING = Easing.in(Easing.cubic);
const LAYOUT_EASING = Easing.inOut(Easing.cubic);

const ACCENT_BLUE = '#1D9BF0';

export const CoverArtRecacheBanner = memo(function CoverArtRecacheBanner() {
  const { t } = useTranslation();
  const status = coverArtRecacheStore((s) => s.status);
  const total = coverArtRecacheStore((s) => s.total);
  const processed = coverArtRecacheStore((s) => s.processed);

  const visible = status === 'running' && total > 0;

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

  const label = t('coverArtRecacheBannerLabel', 'Updating cover art');
  const countText = `${processed} / ${total}`;

  return (
    <Animated.View style={[styles.outer, containerStyle]}>
      <View style={styles.pillContainer}>
        <Animated.View style={[styles.capsule, capsuleStyle]}>
          <Ionicons name="sync" size={16} color={ACCENT_BLUE} />
          <Text style={styles.label} numberOfLines={1}>
            {label} {countText}
          </Text>
        </Animated.View>
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
