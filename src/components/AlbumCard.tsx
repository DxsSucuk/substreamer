import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useRouter } from 'expo-router';
import { memo, useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CachedImage } from './CachedImage';
import { DownloadedIcon } from './DownloadedIcon';
import { LongPressable } from './LongPressable';
import { CompactRatingBadge } from './StarRating';
import { useDownloadStatus } from '../hooks/useDownloadStatus';
import { useIsStarred } from '../hooks/useIsStarred';
import { useRating } from '../hooks/useRating';
import { useTheme } from '../hooks/useTheme';
import { type AlbumID3 } from '../services/subsonicService';
import { moreOptionsStore } from '../store/moreOptionsStore';

const COVER_SIZE = 300;

export const AlbumCard = memo(function AlbumCard({
  album,
  width,
}: {
  album: AlbumID3;
  width?: number;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const starred = useIsStarred('album', album.id);
  const downloadStatus = useDownloadStatus('album', album.id);
  const downloaded = downloadStatus === 'complete';
  const partial = downloadStatus === 'partial';
  const rating = useRating(album.id, album.userRating);

  const onPress = useCallback(() => {
    router.push(`/album/${album.id}`);
  }, [album.id, router]);

  const onLongPress = useCallback(() => {
    moreOptionsStore.getState().show({ type: 'album', item: album });
  }, [album]);

  return (
    <LongPressable onPress={onPress} onLongPress={onLongPress}>
      <View style={[styles.card, { backgroundColor: colors.card }, width != null && { width }]}>
        <View style={styles.imageContainer}>
          <CachedImage
            coverArtId={album.coverArt}
            size={COVER_SIZE}
            style={styles.cover}
            resizeMode="cover"
          />
          {(downloaded || partial || starred) && (
            <View style={styles.indicators}>
              {downloaded && <DownloadedIcon size={14} circleColor={colors.primary} arrowColor="#fff" />}
              {partial && <DownloadedIcon size={14} circleColor={colors.partialDownload} arrowColor="#fff" />}
              {starred && <Ionicons name="heart" size={14} color={colors.red} />}
            </View>
          )}
          {rating > 0 && (
            <View style={styles.ratingOverlay}>
              <CompactRatingBadge rating={rating} size={11} iconColor={colors.primary} />
            </View>
          )}
        </View>
        <Text
          style={[styles.albumName, { color: colors.textPrimary }]}
          numberOfLines={1}
        >
          {album.name}
        </Text>
        <Text
          style={[styles.artistName, { color: colors.textSecondary }]}
          numberOfLines={1}
        >
          {album.artist ?? t('unknownArtist')}
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
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  indicators: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    flexDirection: 'row',
    gap: 4,
  },
  albumName: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 8,
  },
  artistName: {
    fontSize: 12,
    marginTop: 2,
  },
  ratingOverlay: {
    position: 'absolute',
    bottom: 4,
    left: 4,
  },
});
