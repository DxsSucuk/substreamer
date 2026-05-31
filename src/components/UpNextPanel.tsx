import Ionicons from "@react-native-vector-icons/ionicons/static";
import MaterialCommunityIcons from "@react-native-vector-icons/material-design-icons/static";
import { FlashList } from '@shopify/flash-list';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureDetector, type PanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AlbumInfoContent } from './AlbumInfoContent';
import { LyricsContent } from './LyricsContent';
import { QueueItemRow } from './QueueItemRow';
import { closeOpenRow } from './SwipeableRow';
import { type ThemeColors } from '../constants/theme';
import { usePlayerAlbumInfo } from '../hooks/usePlayerAlbumInfo';
import { usePlayerLyrics } from '../hooks/usePlayerLyrics';
import { type Child } from '../services/subsonicService';
import { sanitizeBiographyText } from '../utils/formatters';

type PanelMode = 'queue' | 'info' | 'lyrics';

export interface UpNextPanelProps {
  /** Visible height of the panel in px (parent-owned, driven by the drag). */
  panelHeight: SharedValue<number>;
  /** Full (maximum) panel height — the panel slides within this fixed height. */
  maxHeight: number;
  /** Pan gesture (owned by the parent) attached to the drag handle. */
  panGesture: PanGesture;
  currentTrack: Child;
  queue: Child[];
  currentTrackIndex: number;
  colors: ThemeColors;
  /** Muted-primary variant for the active queue row highlight. */
  queueColors: ThemeColors;
  offlineMode: boolean;
  onQueueItemPress: (index: number) => void;
  onQueueItemLongPress: (track: Child) => void;
  onShareQueue: () => void;
  onClearQueue: () => void;
}

/**
 * Inline draggable "Up Next" panel for the tablet-portrait player. Hosts the
 * Queue / Album Info / Lyrics views with a toggle, sliding between detents via
 * `panelHeight`. Deliberately in-tree (NOT a Modal) so the global
 * MoreOptionsSheet can open over it without stacking two native modals.
 */
export const UpNextPanel = memo(function UpNextPanel({
  panelHeight,
  maxHeight,
  panGesture,
  currentTrack,
  queue,
  currentTrackIndex,
  colors,
  queueColors,
  offlineMode,
  onQueueItemPress,
  onQueueItemLongPress,
  onShareQueue,
  onClearQueue,
}: UpNextPanelProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<PanelMode>('queue');

  // Info/Lyrics are hidden offline — fall back to the queue if they vanish.
  useEffect(() => {
    if (offlineMode && mode !== 'queue') setMode('queue');
  }, [offlineMode, mode]);

  // Album info — only fetch while the info view is actually showing.
  const albumId = currentTrack.albumId ?? null;
  const {
    entry: albumInfoEntry,
    loading: albumInfoLoading,
    error: albumInfoError,
    refreshing: albumInfoRefreshing,
    handleRetry: handleRetryAlbumInfo,
    handleRefresh: handleRefreshAlbumInfo,
  } = usePlayerAlbumInfo(albumId, currentTrack.artist, currentTrack.album, {
    enabled: mode === 'info',
  });

  const sanitizedNotes = useMemo(() => {
    const serverNotes = albumInfoEntry?.albumInfo.notes;
    if (serverNotes) {
      const sanitized = sanitizeBiographyText(serverNotes);
      if (sanitized) return sanitized;
    }
    return albumInfoEntry?.enrichedNotes ?? null;
  }, [albumInfoEntry?.albumInfo.notes, albumInfoEntry?.enrichedNotes]);

  const notesAttributionUrl = albumInfoEntry?.enrichedNotesUrl ?? null;

  const trackId = currentTrack.id;
  const {
    entry: lyricsEntry,
    loading: lyricsLoading,
    error: lyricsError,
    handleRetry: handleRetryLyrics,
  } = usePlayerLyrics(trackId, currentTrack.artist, currentTrack.title);

  const renderQueueItem = useCallback(
    ({ item, index }: { item: Child; index: number }) => (
      <QueueItemRow
        track={item}
        index={index}
        isActive={index === currentTrackIndex}
        colors={queueColors}
        onPress={onQueueItemPress}
        onLongPress={onQueueItemLongPress}
      />
    ),
    [currentTrackIndex, queueColors, onQueueItemPress, onQueueItemLongPress],
  );

  const keyExtractor = useCallback(
    (item: Child, index: number) => `${item.id}-${index}`,
    [],
  );

  const slideStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateY: maxHeight - panelHeight.value }],
    }),
    [maxHeight],
  );

  const listContentStyle = useMemo(
    () => ({ paddingBottom: insets.bottom + 16 }),
    [insets.bottom],
  );

  return (
    <Animated.View
      style={[
        styles.panel,
        { height: maxHeight, backgroundColor: colors.background, borderColor: colors.border },
        slideStyle,
      ]}
    >
      <GestureDetector gesture={panGesture}>
        <View style={styles.header}>
          <View style={[styles.grabber, { backgroundColor: colors.textSecondary }]} />
          <View style={styles.toggleRow}>
            <View style={styles.toggleButtons}>
              <Pressable
                onPress={() => setMode('queue')}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('showQueue')}
                style={({ pressed }) => [styles.toggleButton, pressed && styles.pressed]}
              >
                <MaterialCommunityIcons
                  name="playlist-music"
                  size={22}
                  color={mode === 'queue' ? colors.primary : colors.textSecondary}
                />
              </Pressable>
              {!offlineMode && (
                <Pressable
                  onPress={() => setMode('info')}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('showAlbumInfo')}
                  style={({ pressed }) => [styles.toggleButton, pressed && styles.pressed]}
                >
                  <MaterialCommunityIcons
                    name="information-outline"
                    size={22}
                    color={mode === 'info' ? colors.primary : colors.textSecondary}
                  />
                </Pressable>
              )}
              {!offlineMode && (
                <Pressable
                  onPress={() => setMode('lyrics')}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('showLyrics')}
                  style={({ pressed }) => [styles.toggleButton, pressed && styles.pressed]}
                >
                  <MaterialCommunityIcons
                    name="comment-quote-outline"
                    size={22}
                    color={mode === 'lyrics' ? colors.primary : colors.textSecondary}
                  />
                </Pressable>
              )}
            </View>
            {mode === 'queue' && queue.length > 0 && (
              <View style={styles.queueActions}>
                <Pressable
                  onPress={onShareQueue}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('shareQueue')}
                  style={({ pressed }) => [styles.queueActionButton, pressed && styles.pressed]}
                >
                  <Ionicons name="share-outline" size={18} color={colors.textPrimary} />
                </Pressable>
                <Pressable
                  onPress={onClearQueue}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('clearQueue')}
                  style={({ pressed }) => [styles.queueActionButton, pressed && styles.pressed]}
                >
                  <Text style={[styles.clearButtonText, { color: colors.textPrimary }]}>
                    {t('clear')}
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      </GestureDetector>

      <View style={styles.body}>
        {mode === 'queue' ? (
          <FlashList
            data={queue}
            renderItem={renderQueueItem}
            keyExtractor={keyExtractor}
            onScrollBeginDrag={closeOpenRow}
            drawDistance={300}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={listContentStyle}
          />
        ) : mode === 'info' ? (
          <AlbumInfoContent
            track={currentTrack}
            albumInfo={albumInfoEntry?.albumInfo ?? null}
            overrideMbid={albumInfoEntry?.overrideMbid ?? null}
            sanitizedNotes={sanitizedNotes}
            notesAttributionUrl={notesAttributionUrl}
            albumInfoLoading={albumInfoLoading}
            albumInfoError={albumInfoError}
            onRetry={handleRetryAlbumInfo}
            refreshing={albumInfoRefreshing}
            onRefresh={handleRefreshAlbumInfo}
            colors={colors}
          />
        ) : (
          <View style={styles.lyricsContainer}>
            <LyricsContent
              key={trackId}
              trackId={trackId}
              lyricsData={lyricsEntry}
              lyricsLoading={lyricsLoading}
              lyricsError={lyricsError}
              onRetry={handleRetryLyrics}
              durationSec={currentTrack.duration ?? null}
              colors={colors}
            />
          </View>
        )}
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 16,
  },
  header: {
    paddingTop: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    opacity: 0.4,
    marginBottom: 12,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleButtons: {
    flexDirection: 'row',
    gap: 16,
  },
  toggleButton: {
    padding: 4,
  },
  queueActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  queueActionButton: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  clearButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  body: {
    flex: 1,
  },
  lyricsContainer: {
    flex: 1,
  },
  pressed: {
    opacity: 0.6,
  },
});
