import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useRouter } from 'expo-router';
import { memo, useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { CachedImage } from './CachedImage';
import { LongPressable } from './LongPressable';
import { CompactRatingBadge } from './StarRating';
import { useIsStarred } from '../hooks/useIsStarred';
import { useRating } from '../hooks/useRating';
import { useTheme } from '../hooks/useTheme';
import { type ArtistID3 } from '../services/subsonicService';
import { moreOptionsStore } from '../store/moreOptionsStore';

const COVER_SIZE = 300;

export const ArtistCard = memo(function ArtistCard({
  artist,
  width,
}: {
  artist: ArtistID3;
  width?: number;
}) {
  const { colors } = useTheme();
  const router = useRouter();
  const starred = useIsStarred('artist', artist.id);
  const rating = useRating(artist.id, artist.userRating);

  const onPress = useCallback(() => {
    router.push(`/artist/${artist.id}`);
  }, [artist.id, router]);

  const onLongPress = useCallback(() => {
    moreOptionsStore.getState().show({ type: 'artist', item: artist });
  }, [artist]);

  return (
    <LongPressable onPress={onPress} onLongPress={onLongPress}>
      <View style={[styles.card, { backgroundColor: colors.card }, width != null && { width }]}>
        <View style={styles.imageContainer}>
          <CachedImage
            coverArtId={artist.coverArt}
            size={COVER_SIZE}
            style={styles.cover}
            resizeMode="cover"
          />
          {starred && (
            <View style={styles.indicators}>
              <Ionicons name="heart" size={14} color={colors.red} />
            </View>
          )}
          {rating > 0 && (
            <View style={styles.ratingOverlay}>
              <CompactRatingBadge rating={rating} size={11} iconColor={colors.primary} />
            </View>
          )}
        </View>
        <Text
          style={[styles.artistName, { color: colors.textPrimary }]}
          numberOfLines={1}
        >
          {artist.name}
        </Text>
        <Text
          style={[styles.albumCount, { color: colors.textSecondary }]}
          numberOfLines={1}
        >
          {artist.albumCount === 1
            ? '1 album'
            : `${artist.albumCount} albums`}
        </Text>
      </View>
    </LongPressable>
  );
});

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    padding: 8,
  },
  imageContainer: {
    aspectRatio: 1,
  },
  cover: {
    width: '100%',
    height: '100%',
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  indicators: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    flexDirection: 'row',
    gap: 4,
  },
  artistName: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 8,
  },
  albumCount: {
    fontSize: 12,
    marginTop: 2,
  },
  ratingOverlay: {
    position: 'absolute',
    bottom: 4,
    left: 4,
  },
});
