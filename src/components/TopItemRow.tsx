import { memo, useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withDelay, withTiming } from 'react-native-reanimated';

import { CachedImage } from './CachedImage';
import { type ThemeColors } from '../constants/theme';

const THUMBNAIL_SIZE = 44;

interface TopItemRowProps {
  rank: number;
  title: string;
  subtitle?: string;
  count: number;
  maxCount: number;
  coverArtId?: string;
  colors: ThemeColors;
  /** Initials shown when no coverArt (e.g. for artists). */
  initials?: string;
  index: number;
  /** Tap handler. When omitted, the row is non-interactive (no press feedback). */
  onPress?: () => void;
}

export const TopItemRow = memo(function TopItemRow({
  rank,
  title,
  subtitle,
  count,
  maxCount,
  coverArtId,
  colors,
  initials,
  index,
  onPress,
}: TopItemRowProps) {
  const barWidth = useSharedValue(0);
  const proportion = maxCount > 0 ? count / maxCount : 0;

  useEffect(() => {
    barWidth.value = withDelay(index * 60, withTiming(proportion * 100, { duration: 600 }));
  }, [barWidth, proportion, index]);

  const barStyle = useAnimatedStyle(() => ({
    width: `${barWidth.value}%` as unknown as number,
  }));

  const content = (
    <>
      <Text style={[styles.rank, { color: colors.textSecondary }]}>{rank}</Text>

      {initials ? (
        <View style={[styles.initialCircle, { backgroundColor: colors.primary + '20' }]}>
          <Text style={[styles.initialText, { color: colors.primary }]}>{initials}</Text>
        </View>
      ) : (
        // Always hand the image to CachedImage, even with no id yet: it owns the cache
        // check, the download, the branded placeholder and the re-render when art
        // lands. Gating on `coverArtId` rendered nothing at all for a row whose art
        // resolves late, so covers only appeared on an unrelated re-render.
        <CachedImage
          coverArtId={coverArtId}
          size={150}
          style={styles.thumbnail}
          resizeMode="cover"
        />
      )}

      <View style={styles.info}>
        <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        <View style={[styles.barTrack, { backgroundColor: colors.border }]}>
          <Animated.View style={[styles.barFill, { backgroundColor: colors.primary }, barStyle]} />
        </View>
      </View>

      <Text style={[styles.count, { color: colors.textSecondary }]}>{count}</Text>
    </>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.row,
          { borderBottomColor: colors.border },
          pressed && { opacity: 0.6 },
        ]}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      {content}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  rank: {
    width: 20,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  thumbnail: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
    borderRadius: 8,
  },
  initialCircle: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
    borderRadius: THUMBNAIL_SIZE / 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  initialText: {
    fontSize: 16,
    fontWeight: '700',
  },
  info: {
    flex: 1,
    gap: 4,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 12,
    fontWeight: '400',
  },
  barTrack: {
    height: 4,
    borderRadius: 2,
    marginTop: 4,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 2,
  },
  count: {
    fontSize: 14,
    fontWeight: '600',
    minWidth: 28,
    textAlign: 'right',
  },
});
