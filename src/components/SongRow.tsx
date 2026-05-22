import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CachedImage } from './CachedImage';
import { NowPlayingIndicator } from './NowPlayingIndicator';
import { RowMetaLine } from './RowMetaLine';
import { SwipeableRow, type SwipeAction } from './SwipeableRow';
import { useDownloadStatus } from '../hooks/useDownloadStatus';
import { useIsStarred } from '../hooks/useIsStarred';
import { useRating } from '../hooks/useRating';
import { useTheme } from '../hooks/useTheme';
import { addSongToQueue, toggleStar } from '../services/moreOptionsService';
import { type Child } from '../services/subsonicService';
import { addToPlaylistStore } from '../store/addToPlaylistStore';
import { moreOptionsStore } from '../store/moreOptionsStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { playerStore } from '../store/playerStore';
import { formatTrackDuration } from '../utils/formatters';

const COVER_SIZE = 300;

export const SongRow = memo(function SongRow({ song, onPress }: { song: Child; onPress?: () => void }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const starred = useIsStarred('song', song.id);
  const downloadStatus = useDownloadStatus('song', song.id);
  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const rating = useRating(song.id, song.userRating);
  const duration =
    song.duration != null ? formatTrackDuration(song.duration) : '—';
  const isActive = playerStore((s) => s.currentTrack?.id === song.id);

  const handleAddToQueue = useCallback(() => {
    addSongToQueue(song);
  }, [song]);

  const handleToggleStar = useCallback(() => {
    toggleStar('song', song.id);
  }, [song.id]);

  const handleAddToPlaylist = useCallback(() => {
    addToPlaylistStore.getState().showSong(song);
  }, [song]);

  const handleLongPress = useCallback(() => {
    moreOptionsStore.getState().show({ type: 'song', item: song });
  }, [song]);

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
        <View style={styles.coverWrap}>
          <CachedImage coverArtId={song.coverArt} size={COVER_SIZE} style={styles.cover} resizeMode="cover" />
          {isActive && (
            <View style={styles.activeOverlay}>
              <NowPlayingIndicator size={26} color={colors.primary} />
            </View>
          )}
        </View>
        <View style={styles.text}>
          <Text
            style={[
              styles.songName,
              { color: isActive ? colors.primary : colors.textPrimary },
            ]}
            numberOfLines={1}
          >
            {song.title}
          </Text>
          <Text
            style={[
              styles.artistName,
              { color: isActive ? colors.primary : colors.textSecondary },
            ]}
            numberOfLines={1}
          >
            {song.artist ?? t('unknownArtist')}
          </Text>
          <View style={styles.meta}>
            <RowMetaLine
              leading={
                <>
                  <Ionicons name="disc-outline" size={14} color={colors.primary} />
                  <View style={styles.albumTextWrapper}>
                    <Text
                      style={[styles.albumText, { color: colors.textSecondary }]}
                      numberOfLines={1}
                    >
                      {song.album ?? t('unknownAlbum')}
                    </Text>
                  </View>
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
              durationText={duration}
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
    padding: 12,
  },
  coverWrap: {
    width: 56,
    height: 56,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  cover: {
    width: 56,
    height: 56,
    borderRadius: 8,
  },
  activeOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    marginLeft: 12,
  },
  songName: {
    fontSize: 16,
    fontWeight: '600',
  },
  artistName: {
    fontSize: 14,
    marginTop: 2,
  },
  meta: {
    marginTop: 3,
  },
  albumTextWrapper: {
    flex: 1,
    // `minWidth: 0` is essential for the album-name Text to actually
    // ellipsize when long. Without it, flex children refuse to shrink
    // below their content's intrinsic width and the row pushes wider
    // than its parent.
    minWidth: 0,
    marginLeft: 3,
  },
  albumText: {
    fontSize: 12,
  },
});
