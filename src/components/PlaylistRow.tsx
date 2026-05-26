import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useRouter } from 'expo-router';
import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CachedImage } from './CachedImage';
import { RowMetaLine } from './RowMetaLine';
import { closeOpenRow, SwipeableRow, type SwipeAction } from './SwipeableRow';
import { ThemedAlert } from './ThemedAlert';
import { useDownloadStatus } from '../hooks/useDownloadStatus';
import { useTheme } from '../hooks/useTheme';
import { useThemedAlert } from '../hooks/useThemedAlert';
import { addPlaylistToQueue } from '../services/moreOptionsService';
import { deleteCachedItem } from '../services/musicCacheService';
import { deletePlaylist, type Playlist } from '../services/subsonicService';
import { moreOptionsStore } from '../store/moreOptionsStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { playlistDetailStore } from '../store/playlistDetailStore';
import { playlistLibraryStore } from '../store/playlistLibraryStore';
import { processingOverlayStore } from '../store/processingOverlayStore';
import { formatCompactDuration } from '../utils/formatters';

const COVER_SIZE = 300;

export const PlaylistRow = memo(function PlaylistRow({ playlist }: { playlist: Playlist }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { alert, alertProps } = useThemedAlert();
  const downloadStatus = useDownloadStatus('playlist', playlist.id);

  const onPress = useCallback(() => {
    router.push(`/playlist/${playlist.id}`);
  }, [playlist.id, router]);

  const handleAddToQueue = useCallback(() => {
    addPlaylistToQueue(playlist);
  }, [playlist]);

  const handleLongPress = useCallback(() => {
    moreOptionsStore.getState().show({ type: 'playlist', item: playlist });
  }, [playlist]);

  const handleDelete = useCallback(() => {
    // Close the swiped row before showing the confirmation so the user can
    // see the alert against an unobstructed list. The 250ms delay matches
    // the SwipeableRow close animation.
    closeOpenRow();
    setTimeout(() => {
      alert(
        t('deletePlaylist'),
        t('deletePlaylistConfirmMessage', { name: playlist.name }),
        [
          { text: t('cancel'), style: 'cancel' },
          {
            text: t('delete'),
            style: 'destructive',
            onPress: async () => {
              processingOverlayStore.getState().show(t('deleting'));
              try {
                const success = await deletePlaylist(playlist.id);
                if (!success) throw new Error('API returned false');

                playlistDetailStore.getState().removePlaylist(playlist.id);
                playlistLibraryStore.getState().removePlaylist(playlist.id);
                if (playlist.id in musicCacheStore.getState().cachedItems) {
                  deleteCachedItem(playlist.id);
                }

                processingOverlayStore.getState().showSuccess(t('playlistDeleted'));
              } catch {
                processingOverlayStore.getState().showError(t('failedToDeletePlaylist'));
              }
            },
          },
        ],
      );
    }, 250);
  }, [playlist, alert, t]);

  const rightActions: SwipeAction[] = useMemo(
    () => [{ icon: 'playlist-play', iconFamily: 'mdi' as const, color: colors.primary, label: t('queue'), onPress: handleAddToQueue }],
    [colors.primary, handleAddToQueue, t],
  );

  const leftActions: SwipeAction[] = useMemo(
    () => [{ icon: 'trash-outline' as const, color: colors.red, label: t('delete'), onPress: handleDelete }],
    [colors.red, handleDelete, t],
  );

  return (
    <>
      <SwipeableRow
        rightActions={rightActions}
        leftActions={leftActions}
        enableFullSwipeRight
        enableFullSwipeLeft
        rowGap={8}
        onLongPress={handleLongPress}
        onPress={onPress}
      >
        <View style={styles.row}>
          <CachedImage coverArtId={playlist.id} size={COVER_SIZE} style={styles.cover} resizeMode="cover" />
          <View style={styles.text}>
            <Text
              style={[styles.playlistName, { color: colors.textPrimary }]}
              numberOfLines={1}
            >
              {playlist.name}
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
                      {t('trackCount', { count: playlist.songCount })}
                    </Text>
                  </>
                }
                slots={['download', 'heart', 'duration']}
                downloadStatus={
                  downloadStatus === 'complete' || downloadStatus === 'partial'
                    ? downloadStatus
                    : 'none'
                }
                durationText={formatCompactDuration(playlist.duration)}
              />
            </View>
          </View>
        </View>
      </SwipeableRow>
      <ThemedAlert {...alertProps} />
    </>
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
  playlistName: {
    fontSize: 16,
    fontWeight: '600',
  },
  meta: {
    marginTop: 10,
  },
  metaText: {
    fontSize: 12,
    marginLeft: 3,
  },
});
