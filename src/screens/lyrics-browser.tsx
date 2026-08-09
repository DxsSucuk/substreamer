import Ionicons from '@react-native-vector-icons/ionicons/static';
import { FlashList } from '@shopify/flash-list';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { memo, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { BottomChrome } from '../components/BottomChrome';
import { BottomSheet } from '../components/BottomSheet';
import { EmptyState } from '../components/EmptyState';
import { GradientBackground } from '../components/GradientBackground';
import { SwipeableRow, type SwipeAction } from '../components/SwipeableRow';
import { UnsyncedLyricsView } from '../components/UnsyncedLyricsView';
import { useTheme } from '../hooks/useTheme';
import { type LyricsLine } from '../services/subsonicService';
import { lyricsStore } from '../store/lyricsStore';
import { offlineModeStore } from '../store/offlineModeStore';
import {
  listCachedLyrics,
  loadLyrics,
  type CachedLyricsEntry,
} from '../store/persistence/lyricsTable';
import { runWithOverlay } from '../store/processingOverlayStore';
import { defaultCollator } from '../utils/intl';

const ROW_HEIGHT = 72;

/** What the row shows as the song's name — the id is the last resort. */
const displayName = (entry: CachedLyricsEntry): string => entry.title ?? entry.songId;

/* ------------------------------------------------------------------ */
/*  Row                                                                */
/* ------------------------------------------------------------------ */

const LyricsRow = memo(function LyricsRow({
  entry,
  offlineMode,
  onView,
  onDelete,
  onRefresh,
  colors,
}: {
  entry: CachedLyricsEntry;
  offlineMode: boolean;
  onView: (entry: CachedLyricsEntry) => void;
  onDelete: (entry: CachedLyricsEntry) => void;
  onRefresh: (entry: CachedLyricsEntry) => void;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const { t } = useTranslation();

  const handlePress = useCallback(() => onView(entry), [entry, onView]);
  const handleDelete = useCallback(() => onDelete(entry), [entry, onDelete]);
  const handleRefresh = useCallback(() => onRefresh(entry), [entry, onRefresh]);

  // Swiping left→right reveals `rightActions`; swiping right→left reveals `leftActions`
  // (SwipeableRow names each side by where the buttons land, not by the gesture).
  // Delete stays available offline — dropping a cached row is purely local.
  const rightActions: SwipeAction[] = useMemo(
    () => [
      {
        icon: 'trash-outline' as const,
        color: colors.red,
        label: t('delete'),
        onPress: handleDelete,
        removesRow: true,
      },
    ],
    [colors.red, handleDelete, t],
  );

  // Offline the refresh side is withdrawn entirely rather than offered and ignored:
  // an empty array makes SwipeableRow's `hasLeft` false, so the gesture never engages.
  const leftActions: SwipeAction[] = useMemo(
    () =>
      offlineMode
        ? []
        : [
            {
              icon: 'refresh-outline' as const,
              color: colors.primary,
              label: t('refresh'),
              onPress: handleRefresh,
            },
          ],
    [offlineMode, colors.primary, handleRefresh, t],
  );

  return (
    <View style={styles.rowWrapper}>
      <SwipeableRow
        rightActions={rightActions}
        leftActions={leftActions}
        enableFullSwipeRight
        enableFullSwipeLeft={!offlineMode}
        onPress={handlePress}
        borderRadius={12}
      >
        <View style={styles.row}>
          <View style={styles.rowContent}>
            <Text style={[styles.songTitle, { color: colors.textPrimary }]} numberOfLines={1}>
              {displayName(entry)}
            </Text>
            {entry.artist != null && (
              <Text style={[styles.artist, { color: colors.textSecondary }]} numberOfLines={1}>
                {entry.artist}
              </Text>
            )}
            <View style={styles.syncRow}>
              <Ionicons
                name={entry.synced ? 'time-outline' : 'document-text-outline'}
                size={14}
                color={colors.primary}
              />
              <Text style={[styles.syncLabel, { color: colors.textSecondary }]}>
                {entry.synced ? t('lyricsSynced') : t('lyricsUnsynced')}
              </Text>
            </View>
          </View>
        </View>
      </SwipeableRow>
    </View>
  );
});

/* ------------------------------------------------------------------ */
/*  Lyrics sheet                                                       */
/* ------------------------------------------------------------------ */

/**
 * The plain, static rendering for BOTH synced and unsynced entries. The synced view
 * follows the PLAYER's position, and nothing here is playing — it would highlight
 * against an unrelated track.
 */
const CachedLyricsSheet = memo(function CachedLyricsSheet({
  entry,
  onClose,
}: {
  entry: CachedLyricsEntry | null;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [lines, setLines] = useState<LyricsLine[] | null>(null);

  useEffect(() => {
    if (entry === null) {
      setLines(null);
      return;
    }
    let alive = true;
    loadLyrics(entry.songId).then((data) => {
      if (alive) setLines(data?.lines ?? []);
    });
    return () => {
      alive = false;
    };
  }, [entry]);

  return (
    <BottomSheet visible={entry !== null} onClose={onClose} maxHeight="80%" scrollable={false}>
      <View style={styles.sheetHeader}>
        <Text style={[styles.sheetTitle, { color: colors.textPrimary }]} numberOfLines={1}>
          {entry ? displayName(entry) : ''}
        </Text>
        {entry?.artist != null && (
          <Text style={[styles.sheetSubtitle, { color: colors.textSecondary }]} numberOfLines={1}>
            {entry.artist}
          </Text>
        )}
      </View>
      <View style={styles.sheetBody}>
        {lines === null ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : lines.length === 0 ? (
          <Text style={[styles.sheetEmpty, { color: colors.textSecondary }]}>
            {t('lyricsNotAvailable')}
          </Text>
        ) : (
          <UnsyncedLyricsView lines={lines} textColor={colors.textPrimary} />
        )}
      </View>
    </BottomSheet>
  );
});

/* ------------------------------------------------------------------ */
/*  Screen                                                             */
/* ------------------------------------------------------------------ */

export function LyricsBrowserScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const [entries, setEntries] = useState<CachedLyricsEntry[]>([]);
  const [viewing, setViewing] = useState<CachedLyricsEntry | null>(null);

  useEffect(() => {
    let alive = true;
    listCachedLyrics().then((rows) => {
      if (alive) setEntries(rows);
    });
    return () => {
      alive = false;
    };
  }, []);

  const data = useMemo(
    () => [...entries].sort((a, b) => defaultCollator.compare(displayName(a), displayName(b))),
    [entries],
  );

  const handleView = useCallback((entry: CachedLyricsEntry) => setViewing(entry), []);
  const handleCloseSheet = useCallback(() => setViewing(null), []);

  const handleDelete = useCallback(async (entry: CachedLyricsEntry) => {
    setEntries((prev) => prev.filter((e) => e.songId !== entry.songId));
    await lyricsStore.getState().removeLyrics(entry.songId);
  }, []);

  const handleRefresh = useCallback(
    async (entry: CachedLyricsEntry) => {
      const fresh = await runWithOverlay(
        async () => {
          const data = await lyricsStore
            .getState()
            .refreshLyrics(entry.songId, entry.artist ?? undefined, entry.title ?? undefined);
          if (data === null) throw new Error('lyrics refresh returned nothing');
          return data;
        },
        {
          loading: t('refreshingEllipsis'),
          success: t('refreshedSuccessfully'),
          error: t('refreshFailed'),
        },
      );
      if (fresh === undefined) return;
      setEntries((prev) =>
        prev.map((e) => (e.songId === entry.songId ? { ...e, synced: fresh.synced } : e)),
      );
    },
    [t],
  );

  const renderItem = useCallback(
    ({ item }: { item: CachedLyricsEntry }) => (
      <LyricsRow
        entry={item}
        offlineMode={offlineMode}
        onView={handleView}
        onDelete={handleDelete}
        onRefresh={handleRefresh}
        colors={colors}
      />
    ),
    [colors, offlineMode, handleView, handleDelete, handleRefresh],
  );

  const keyExtractor = useCallback((item: CachedLyricsEntry) => item.songId, []);

  const contentContainerStyle = useMemo(
    () => ({ paddingTop: headerHeight + 12, paddingBottom: 32 }),
    [headerHeight],
  );

  return (
    <GradientBackground style={styles.container} scrollable>
      <FlashList
        data={data}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListEmptyComponent={
          <EmptyState
            icon="musical-notes-outline"
            title={t('noCachedLyrics')}
            subtitle={t('cachedLyricsAppearHere')}
          />
        }
        contentContainerStyle={contentContainerStyle}
      />
      <CachedLyricsSheet entry={viewing} onClose={handleCloseSheet} />
      <BottomChrome withSafeAreaPadding />
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  rowWrapper: {
    marginHorizontal: 16,
    marginBottom: 10,
  },
  row: {
    minHeight: ROW_HEIGHT,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    justifyContent: 'center',
  },
  rowContent: {
    gap: 4,
  },
  songTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  artist: {
    fontSize: 13,
  },
  syncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  syncLabel: {
    fontSize: 12,
  },
  sheetHeader: {
    paddingHorizontal: 4,
    marginBottom: 12,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 2,
  },
  sheetSubtitle: {
    fontSize: 14,
  },
  sheetBody: {
    flexShrink: 1,
    minHeight: 200,
  },
  sheetEmpty: {
    fontSize: 15,
    textAlign: 'center',
    paddingVertical: 24,
  },
});
