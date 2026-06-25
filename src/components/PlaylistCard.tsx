import { useRouter } from 'expo-router';
import { memo, useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { CachedImage } from './CachedImage';
import { DownloadedIcon } from './DownloadedIcon';
import { LongPressable } from './LongPressable';
import { useDownloadStatus } from '../hooks/useDownloadStatus';
import { useTheme } from '../hooks/useTheme';
import { type Playlist } from '../services/subsonicService';
import { moreOptionsStore } from '../store/moreOptionsStore';
import { formatCompactDuration } from '../utils/formatters';

const COVER_SIZE = 300;

export const PlaylistCard = memo(function PlaylistCard({
  playlist,
  width,
}: {
  playlist: Playlist;
  width?: number;
}) {
  const { colors } = useTheme();
  const router = useRouter();
  const downloaded = useDownloadStatus('playlist', playlist.id) === 'complete';

  const onPress = useCallback(() => {
    router.push(`/playlist/${playlist.id}`);
  }, [playlist.id, router]);

  const onLongPress = useCallback(() => {
    moreOptionsStore.getState().show({ type: 'playlist', item: playlist });
  }, [playlist]);

  return (
    <LongPressable onPress={onPress} onLongPress={onLongPress}>
      <View style={[styles.card, { backgroundColor: colors.card }, width != null && { width }]}>
        <View style={styles.imageContainer}>
          <CachedImage
            coverArtId={playlist.coverArt}
            size={COVER_SIZE}
            style={styles.cover}
            resizeMode="cover"
          />
          {downloaded && (
            <View style={styles.indicators}>
              <DownloadedIcon size={14} circleColor={colors.primary} arrowColor="#fff" />
            </View>
          )}
        </View>
        <Text
          style={[styles.playlistName, { color: colors.textPrimary }]}
          numberOfLines={1}
        >
          {playlist.name}
        </Text>
        <View style={styles.meta}>
          <Text style={[styles.metaText, { color: colors.textSecondary }]} numberOfLines={1}>
            {playlist.songCount === 1 ? '1 track' : `${playlist.songCount} tracks`}
          </Text>
          <Text style={[styles.metaText, { color: colors.textSecondary }]}>
            {formatCompactDuration(playlist.duration)}
          </Text>
        </View>
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
  playlistName: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 8,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 3,
  },
  metaText: {
    fontSize: 12,
  },
});
