/**
 * Shared TrackRow component used by album-detail and playlist-detail screens.
 *
 * Displays a single track with an optional track number, title, optional artist
 * subtitle, starred indicator, user rating, and duration.
 *
 * Supports swipe-right to add to queue, swipe-left to toggle favorite,
 * and long-press to open the more options sheet.
 */

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
import { addSongToQueue, toggleStar } from '../services/moreOptionsService';
import { addToPlaylistStore } from '../store/addToPlaylistStore';
import { moreOptionsStore } from '../store/moreOptionsStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { playerStore } from '../store/playerStore';
import { formatTrackDuration } from '../utils/formatters';

import type { ThemeColors } from '../constants/theme';
import type { Child } from '../services/subsonicService';

const COVER_SIZE = 300;

export interface TrackRowProps {
  track: Child;
  /** Formatted track number label, e.g. "3. " or "1. ". Omit to hide the number. */
  trackNumber?: string;
  colors: ThemeColors;
  /** Called when the row is tapped to start playback. */
  onPress?: () => void;
  /** Show the album cover art thumbnail at the left of the row. */
  showCoverArt?: boolean;
  /** Show the album name with a disc icon below the artist name. */
  showAlbumName?: boolean;
}

export const TrackRow = memo(function TrackRow({ track, trackNumber, colors, onPress, showCoverArt, showAlbumName }: TrackRowProps) {
  const { t } = useTranslation();
  const duration = track.duration != null ? formatTrackDuration(track.duration) : '—';
  const starred = useIsStarred('song', track.id);
  const downloadStatus = useDownloadStatus('song', track.id);
  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const rating = useRating(track.id, track.userRating);
  // Per-row "is this the currently-playing track" subscription. Returns a
  // stable boolean per track, so non-active rows only re-render when
  // currentTrack changes to/from this row (not on every track change).
  const isActive = playerStore((s) => s.currentTrack?.id === track.id);
  // In offline mode, tracks that aren't fully cached can't play and shouldn't
  // accept any interaction — tapping them today silently routes to the first
  // playable track (via playerService.buildPlayableQueue) which is confusing
  // because the row gives no signal that it's inert. Songs report 'complete'
  // exactly when getLocalTrackUri(id) is non-null, matching the predicate
  // playerService.childToTrack uses to filter the offline queue.
  const isOfflineUnplayable = offlineMode && downloadStatus !== 'complete';

  const handleAddToQueue = useCallback(() => {
    addSongToQueue(track);
  }, [track]);

  const handleToggleStar = useCallback(() => {
    toggleStar('song', track.id);
  }, [track.id]);

  const handleAddToPlaylist = useCallback(() => {
    addToPlaylistStore.getState().showSong(track);
  }, [track]);

  const handleLongPress = useCallback(() => {
    moreOptionsStore.getState().show({ type: 'song', item: track });
  }, [track]);

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
      restingBackgroundColor="transparent"
      onLongPress={handleLongPress}
      onPress={onPress}
      disabled={isOfflineUnplayable}
    >
      <View
        style={[
          styles.trackRow,
          { borderBottomColor: colors.border },
          isOfflineUnplayable && styles.trackRowDisabled,
        ]}
        accessibilityState={isOfflineUnplayable ? { disabled: true } : undefined}
      >
        {/* Leading slot: cover (if showCoverArt) OR track number — and on
            the active row, the now-playing indicator replaces the track
            number outright or overlays the cover. */}
        {showCoverArt ? (
          <View style={styles.coverWrap}>
            <CachedImage
              coverArtId={track.coverArt}
              size={COVER_SIZE}
              style={styles.cover}
              resizeMode="cover"
            />
            {isActive && (
              <View style={styles.activeOverlay}>
                <NowPlayingIndicator size={26} color={colors.primary} />
              </View>
            )}
          </View>
        ) : isActive ? (
          <View style={styles.numberIndicator}>
            <NowPlayingIndicator size={20} color={colors.primary} />
          </View>
        ) : trackNumber != null ? (
          <Text style={[styles.trackNum, { color: colors.textSecondary }]}>
            {trackNumber}
          </Text>
        ) : null}
        <View style={styles.trackInfo}>
          {/* Line 1: title fills, duration pinned to the right edge. */}
          <View style={styles.line}>
            <Text
              style={[
                styles.trackTitle,
                { color: isActive ? colors.primary : colors.textPrimary },
              ]}
              numberOfLines={1}
            >
              {track.title}
            </Text>
            <RowMetaLine
              slots={['duration']}
              durationText={duration}
              durationFontSize={14}
              durationColor={isActive ? colors.primary : undefined}
            />
          </View>
          {/* Line 2: artist fills, status icons pinned to the right edge. */}
          <View style={[styles.line, styles.artistLine]}>
            <Text
              style={[
                styles.trackArtist,
                { color: isActive ? colors.primary : colors.textSecondary },
              ]}
              numberOfLines={1}
            >
              {track.artist ?? t('unknownArtist')}
            </Text>
            <RowMetaLine
              slots={['rating', 'download', 'heart']}
              rating={rating}
              starred={starred}
              downloadStatus={
                downloadStatus === 'complete' || downloadStatus === 'partial'
                  ? downloadStatus
                  : 'none'
              }
            />
          </View>
          {showAlbumName && (
            <View style={styles.metaAlbum}>
              <Ionicons name="disc-outline" size={14} color={colors.primary} />
              <View style={styles.albumTextWrapper}>
                <Text
                  style={[styles.albumText, { color: colors.textSecondary }]}
                  numberOfLines={1}
                >
                  {track.album ?? t('unknownAlbum')}
                </Text>
              </View>
            </View>
          )}
        </View>
      </View>
    </SwipeableRow>
  );
});

const styles = StyleSheet.create({
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 80,
    paddingVertical: 12,
    // Matches the `info` block padding (16) on album-detail /
    // playlist-detail so the first column of the row lines up with the
    // title / "by owner" / song-count text above. The outer
    // trackItemWrap on those screens intentionally has no horizontal
    // padding now, so this is the single source of truth.
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  trackRowDisabled: {
    opacity: 0.4,
  },
  trackNum: {
    fontSize: 14,
    minWidth: 28,
  },
  // Width matches `trackNum.minWidth` so swapping the indicator in for
  // the position number doesn't shift the title column.
  numberIndicator: {
    minWidth: 28,
    alignItems: 'flex-start',
  },
  coverWrap: {
    width: 48,
    height: 48,
    marginRight: 12,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: 'rgba(128,128,128,0.12)',
  },
  cover: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: 'rgba(128,128,128,0.12)',
  },
  activeOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackInfo: {
    flex: 1,
    minWidth: 0,
  },
  // Each text line splits into a left-flexed text + a right-pinned
  // RowMetaLine block. The text gets `flex: 1` + numberOfLines={1} so
  // it truncates instead of pushing the trailing block off-screen.
  line: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  artistLine: {
    marginTop: 2,
  },
  trackTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 16,
    fontWeight: '600',
  },
  trackArtist: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
  },
  metaAlbum: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 3,
    minWidth: 0,
  },
  albumTextWrapper: {
    flex: 1,
    marginLeft: 3,
  },
  albumText: {
    fontSize: 12,
  },
});
