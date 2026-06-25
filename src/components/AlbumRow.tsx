import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useRouter } from 'expo-router';
import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CachedImage } from './CachedImage';
import { RowMetaLine } from './RowMetaLine';
import { SwipeableRow, type SwipeAction } from './SwipeableRow';
import { useDownloadStatus } from '../hooks/useDownloadStatus';
import { useIsStarred } from '../hooks/useIsStarred';
import { useRating } from '../hooks/useRating';
import { useTheme } from '../hooks/useTheme';
import { addAlbumToQueue, toggleStar } from '../services/moreOptionsService';
import { type AlbumID3 } from '../services/subsonicService';
import { addToPlaylistStore } from '../store/addToPlaylistStore';
import { moreOptionsStore } from '../store/moreOptionsStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { formatCompactDuration } from '../utils/formatters';

const COVER_SIZE = 300;

export const AlbumRow = memo(function AlbumRow({ album }: { album: AlbumID3 }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const starred = useIsStarred('album', album.id);
  const downloadStatus = useDownloadStatus('album', album.id);
  const rating = useRating(album.id, album.userRating);
  const offlineMode = offlineModeStore((s) => s.offlineMode);

  const onPress = useCallback(() => {
    router.push(`/album/${album.id}`);
  }, [album.id, router]);

  const handleAddToQueue = useCallback(() => {
    addAlbumToQueue(album);
  }, [album]);

  const handleToggleStar = useCallback(() => {
    toggleStar('album', album.id);
  }, [album.id]);

  const handleAddToPlaylist = useCallback(() => {
    addToPlaylistStore.getState().showAlbum(album);
  }, [album]);

  const handleLongPress = useCallback(() => {
    moreOptionsStore.getState().show({ type: 'album', item: album });
  }, [album]);

  const rightActions: SwipeAction[] = useMemo(
    () => [{ icon: 'playlist-play', iconFamily: 'mdi' as const, color: colors.primary, label: t('queue'), onPress: handleAddToQueue }],
    [colors.primary, handleAddToQueue, t],
  );

  const leftActions: SwipeAction[] = useMemo(
    () =>
      offlineMode
        ? []
        : [
            {
              icon: 'playlist-plus',
              iconFamily: 'mdi' as const,
              color: colors.primary,
              label: t('playlist'),
              onPress: handleAddToPlaylist,
            },
            {
              icon: starred ? 'heart' : 'heart-outline',
              color: colors.red,
              label: starred ? t('remove') : t('add'),
              onPress: handleToggleStar,
            },
          ],
    [starred, colors.red, colors.primary, handleToggleStar, handleAddToPlaylist, offlineMode, t],
  );

  return (
    <SwipeableRow
      rightActions={rightActions}
      leftActions={leftActions}
      enableFullSwipeRight
      enableFullSwipeLeft={!offlineMode}
      rowGap={8}
      onLongPress={handleLongPress}
      onPress={onPress}
    >
      <View style={styles.row}>
        <CachedImage coverArtId={album.coverArt} size={COVER_SIZE} style={styles.cover} resizeMode="cover" />
        <View style={styles.text}>
          <View style={styles.titleRow}>
            <Text
              style={[styles.albumName, { color: colors.textPrimary }]}
              numberOfLines={1}
            >
              {album.name}
            </Text>
            {album.year != null && album.year > 0 && (
              <Text style={[styles.year, { color: colors.textSecondary }]}>
                ({album.year})
              </Text>
            )}
          </View>
          <Text
            style={[styles.artistName, { color: colors.textSecondary }]}
            numberOfLines={1}
          >
            {album.artist ?? t('unknownArtist')}
          </Text>
          <View style={styles.meta}>
            <RowMetaLine
              leading={
                <>
                  <Ionicons name="musical-notes-outline" size={14} color={colors.primary} />
                  <Text
                    style={[styles.metaText, { color: colors.textSecondary }]}
                    numberOfLines={1}
                  >
                    {t('trackCount', { count: album.songCount })}
                  </Text>
                </>
              }
              slots={['rating', 'download', 'heart', 'duration']}
              rating={rating}
              starred={starred}
              downloadStatus={
                downloadStatus === 'complete' || downloadStatus === 'partial'
                  ? downloadStatus
                  : 'none'
              }
              durationText={formatCompactDuration(album.duration)}
            />
          </View>
        </View>
      </View>
    </SwipeableRow>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  cover: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  text: {
    flex: 1,
    marginLeft: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  albumName: {
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
  },
  year: {
    fontSize: 14,
    marginLeft: 6,
  },
  artistName: {
    fontSize: 14,
    marginTop: 2,
  },
  meta: {
    marginTop: 3,
  },
  metaText: {
    fontSize: 12,
    marginLeft: 3,
  },
});
