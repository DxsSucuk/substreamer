import Ionicons from "@react-native-vector-icons/ionicons/static";
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
import { useSongCoverArt } from '../hooks/useSongCoverArt';
import { useTheme } from '../hooks/useTheme';
import { type Child } from '../services/subsonicService';
import { playTrack } from '../services/playerService';
import { moreOptionsStore } from '../store/moreOptionsStore';

const COVER_SIZE = 300;

export const SongCard = memo(function SongCard({
  song,
  width,
  onPress,
  songs,
}: {
  song: Child;
  width?: number;
  /** Overrides the default `playTrack(song, songs ?? [song])` tap behaviour. */
  onPress?: () => void;
  /** Queue context for the default tap behaviour. Defaults to `[song]`. */
  songs?: Child[];
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const starred = useIsStarred('song', song.id);
  const downloaded = useDownloadStatus('song', song.id) === 'complete';
  const rating = useRating(song.id, song.userRating);
  const songCoverArtId = useSongCoverArt(song);

  const onLongPress = useCallback(() => {
    moreOptionsStore.getState().show({ type: 'song', item: song });
  }, [song]);

  // Derive the tap action from props so this memoized card doesn't re-render
  // when the parent passes a fresh inline closure on every render.
  const playFromContext = useCallback(() => {
    playTrack(song, songs ?? [song]);
  }, [song, songs]);
  const handlePress = onPress ?? playFromContext;

  return (
    <LongPressable onPress={handlePress} onLongPress={onLongPress}>
      <View style={[styles.card, { backgroundColor: colors.card }, width != null && { width }]}>
        <View style={styles.imageContainer}>
          <CachedImage
            coverArtId={songCoverArtId}
            size={COVER_SIZE}
            style={styles.cover}
            resizeMode="cover"
          />
          {(downloaded || starred) && (
            <View style={styles.indicators}>
              {downloaded && <DownloadedIcon size={14} circleColor={colors.primary} arrowColor="#fff" />}
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
          style={[styles.songName, { color: colors.textPrimary }]}
          numberOfLines={1}
        >
          {song.title}
        </Text>
        <Text
          style={[styles.artistName, { color: colors.textSecondary }]}
          numberOfLines={1}
        >
          {song.artist ?? t('unknownArtist')}
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
  songName: {
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
