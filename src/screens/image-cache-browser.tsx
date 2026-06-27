import Ionicons from "@react-native-vector-icons/ionicons/static";
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { HeaderHeightContext } from "expo-router/react-navigation";
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { CachedImage } from '../components/CachedImage';
import { EmptyState } from '../components/EmptyState';
import { GradientBackground } from '../components/GradientBackground';
import { BottomChrome } from '../components/BottomChrome';
import { SegmentControl, type Segment } from '../components/SegmentControl';
import { settingsStyles } from '../styles/settingsStyles';
import { SwipeableRow, type SwipeAction } from '../components/SwipeableRow';
import { useRefreshControlKey } from '../hooks/useRefreshControlKey';
import { useTransitionComplete } from '../hooks/useTransitionComplete';
import { useTheme } from '../hooks/useTheme';
import { useThemedAlert } from '../hooks/useThemedAlert';
import {
  clearImageCache,
  deleteCachedImage,
  listCachedImages,
  refreshCoverArt,
  type CachedImageEntry,
} from '../services/imageCacheService';
import { offlineModeStore } from '../store/offlineModeStore';

const THUMB_SIZE = 50;

type RowStatus = 'idle' | 'refreshing' | 'success' | 'error' | 'removed';

const CacheRow = memo(function CacheRow({
  entry,
  colors,
  status,
  onRefresh,
  onDelete,
}: {
  entry: CachedImageEntry;
  colors: ReturnType<typeof useTheme>['colors'];
  status: RowStatus;
  onRefresh: (coverArtId: string) => void;
  onDelete: (coverArtId: string) => void;
}) {
  const { t } = useTranslation();
  const offlineMode = offlineModeStore((s) => s.offlineMode);

  const handleDelete = useCallback(() => {
    onDelete(entry.coverArtId);
  }, [entry.coverArtId, onDelete]);

  const handleRefreshAction = useCallback(() => {
    onRefresh(entry.coverArtId);
  }, [entry.coverArtId, onRefresh]);

  const rightActions: SwipeAction[] = useMemo(
    () => [{ icon: 'trash-outline' as const, color: colors.red, label: t('delete'), onPress: handleDelete }],
    [colors.red, handleDelete, t],
  );

  const refreshing = status === 'refreshing';
  const refreshDisabled = offlineMode || refreshing;

  const leftActions: SwipeAction[] = useMemo(
    () => refreshDisabled ? [] : [{ icon: 'refresh-outline' as const, color: colors.primary, label: t('refresh'), onPress: handleRefreshAction }],
    [refreshDisabled, colors.primary, handleRefreshAction, t],
  );

  return (
    <SwipeableRow rightActions={rightActions} leftActions={leftActions} enableFullSwipeRight enableFullSwipeLeft={!refreshDisabled} rowGap={10} borderRadius={12}>
      <View style={styles.row}>
        <CachedImage
          coverArtId={entry.coverArtId}
          size={THUMB_SIZE}
          style={[styles.thumb, { backgroundColor: colors.border }]}
          resizeMode="cover"
        />
        <View style={styles.fileList}>
          <Text
            style={[styles.coverArtId, { color: colors.textPrimary }]}
            numberOfLines={1}
          >
            {entry.coverArtId}
          </Text>
          {!entry.complete && (
            <Pressable
              onPress={handleRefreshAction}
              disabled={refreshDisabled}
              hitSlop={4}
              style={({ pressed }) => [
                styles.repairBadge,
                { backgroundColor: colors.red + '22', borderColor: colors.red },
                refreshDisabled && styles.badgeDisabled,
                pressed && styles.pressed,
              ]}
            >
              {refreshing ? (
                <ActivityIndicator size={12} color={colors.red} />
              ) : (
                <Ionicons name="warning" size={12} color={colors.red} />
              )}
              <Text style={[styles.repairBadgeText, { color: colors.red }]}>
                {refreshing ? t('downloadingEllipsis') : t('incompleteTapToRepair')}
              </Text>
            </Pressable>
          )}
          {entry.files.map((f) => (
            <Text
              key={f.fileName}
              style={[styles.fileName, { color: colors.textSecondary }]}
              numberOfLines={1}
            >
              <Text style={[styles.sizeLabel, { color: colors.textPrimary }]}>
                {f.size}px{' '}
              </Text>
              {f.fileName}
            </Text>
          ))}
          {status === 'success' && (
            <Text style={[styles.statusText, { color: colors.green }]}>
              {t('refreshedSuccessfully')}
            </Text>
          )}
          {status === 'error' && (
            <Text style={[styles.statusText, { color: colors.red }]}>
              {t('refreshFailed')}
            </Text>
          )}
          {status === 'removed' && (
            <Text style={[styles.statusText, { color: colors.textSecondary }]}>
              {t('imageCacheRowRemoved')}
            </Text>
          )}
        </View>
        {refreshing && entry.complete && (
          <ActivityIndicator size="small" color={colors.primary} style={styles.spinner} />
        )}
      </View>
    </SwipeableRow>
  );
});

export function ImageCacheBrowserScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation();
  const { confirm } = useThemedAlert();
  const transitionComplete = useTransitionComplete();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const refreshControlKey = useRefreshControlKey();
  // Route param `filter=incomplete` (passed from the settings-storage
  // warning row) preselects the incomplete segment on mount. Default to
  // `complete` — it's the expected state for the vast majority of covers
  // and makes "incomplete" a meaningful quick-toggle.
  const params = useLocalSearchParams<{ filter?: string }>();
  type BrowserSegment = 'complete' | 'incomplete';
  const initialStatusFilter: BrowserSegment =
    params.filter === 'incomplete' ? 'incomplete' : 'complete';
  const [statusFilter, setStatusFilter] = useState<BrowserSegment>(initialStatusFilter);
  // `allEntries` holds the complete list exactly once; status-filter switches
  // are a pure in-memory filter against it so the UI stays responsive even on
  // libraries with thousands of covers.
  const [allEntries, setAllEntries] = useState<CachedImageEntry[]>([]);
  const [filter, setFilter] = useState('');
  const listRef = useRef<FlashListRef<CachedImageEntry>>(null);

  const handleClearAll = useCallback(() => {
    confirm({
      title: t('clearImageCache'),
      message: t('clearImageCacheConfirmMessage'),
      confirmLabel: t('clearAll'),
      destructive: true,
      onConfirm: async () => {
        await clearImageCache();
        setAllEntries([]);
      },
    });
  }, [confirm, t]);

  useEffect(() => {
    navigation.setOptions({
      headerRight: allEntries.length > 0
        ? () => (
            <Pressable
              onPress={handleClearAll}
              hitSlop={8}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Text style={[styles.clearButton, { color: colors.textPrimary }]}>{t('clear')}</Text>
            </Pressable>
          )
        : undefined,
    });
  }, [navigation, allEntries.length, handleClearAll, colors.textPrimary]);

  const handleFilterChange = useCallback((text: string) => {
    setFilter(text);
    if (text.length === 0) {
      setTimeout(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
      }, 50);
    }
  }, []);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusMap, setStatusMap] = useState<Map<string, RowStatus>>(new Map());
  // Mirror of statusMap for synchronous reads in callbacks (re-entry guard,
  // renderItem) without adding statusMap to their dep arrays.
  const statusMapRef = useRef(statusMap);
  statusMapRef.current = statusMap;

  // Derived list: status-filter switches are instant (no SQL, no re-render
  // of the whole service layer), text-filter runs against the narrowed set.
  const filteredEntries = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const statusFiltered = allEntries.filter((e) =>
      statusFilter === 'complete' ? e.complete : !e.complete,
    );
    if (query.length === 0) return statusFiltered;
    return statusFiltered.filter(
      (e) =>
        e.coverArtId.toLowerCase().includes(query) ||
        e.files.some((f) => f.fileName.toLowerCase().includes(query)),
    );
  }, [allEntries, filter, statusFilter]);

  useEffect(() => {
    if (!transitionComplete) return;
    let cancelled = false;
    // Fetch the full list once — 'all' returns every row, and the
    // complete/incomplete filter is applied in JS above. This keeps
    // segment-toggles responsive even at tens of thousands of rows.
    listCachedImages('all').then((result) => {
      if (!cancelled) {
        setAllEntries(result);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [transitionComplete]);

  const handlePullRefresh = useCallback(async () => {
    setRefreshing(true);
    const result = await listCachedImages('all');
    setAllEntries(result);
    setRefreshing(false);
  }, []);

  const setItemStatus = useCallback((id: string, s: RowStatus) => {
    setStatusMap((prev) => new Map(prev).set(id, s));
  }, []);

  const handleRefresh = useCallback(
    (coverArtId: string) => {
      // Re-entry guard: ignore taps while this row is already refreshing so a
      // user can't fire several overlapping downloads by rapid-tapping.
      if (statusMapRef.current.get(coverArtId) === 'refreshing') return;
      setItemStatus(coverArtId, 'refreshing');
      refreshCoverArt(coverArtId, 'browser')
        .then(() => listCachedImages('all'))
        .then((result) => {
          // If the row purged itself during refresh (404, gated 5xx, or
          // exhausted variant retries), it's gone from the list. Briefly show
          // the 'removed' badge before dropping the row so the action reads as
          // deliberate rather than a flicker.
          const stillPresent = result.some((e) => e.coverArtId === coverArtId);
          if (stillPresent) {
            setAllEntries(result);
            setItemStatus(coverArtId, 'success');
            setTimeout(() => setItemStatus(coverArtId, 'idle'), 1500);
          } else {
            setItemStatus(coverArtId, 'removed');
            setTimeout(() => {
              setAllEntries(result);
              setItemStatus(coverArtId, 'idle');
            }, 1200);
          }
        })
        .catch((err: unknown) => {
          // The connectivity-gated purge inside imageCacheService handles
          // 404s, gated server errors, and exhausted variant retries.
          // Anything surviving to here is a genuine transient problem
          // (offline / server unreachable) — leaving the row in place is
          // correct; the user can retry once connectivity returns.
          // eslint-disable-next-line no-console
          console.warn(
            `[image-cache-browser] refresh failed for ${coverArtId}:`,
            err,
          );
          setItemStatus(coverArtId, 'error');
          setTimeout(() => setItemStatus(coverArtId, 'idle'), 3000);
        });
    },
    [setItemStatus],
  );

  const handleDelete = useCallback(
    (coverArtId: string) => {
      confirm({
        title: t('deleteCachedImage'),
        message: t('deleteCachedImageMessage'),
        confirmLabel: t('delete'),
        destructive: true,
        onConfirm: async () => {
          await deleteCachedImage(coverArtId);
          setAllEntries((prev) =>
            prev.filter((e) => e.coverArtId !== coverArtId),
          );
        },
      });
    },
    [confirm, t],
  );

  const renderItem = useCallback(
    ({ item }: { item: CachedImageEntry }) => (
      <CacheRow
        entry={item}
        colors={colors}
        status={statusMapRef.current.get(item.coverArtId) ?? 'idle'}
        onRefresh={handleRefresh}
        onDelete={handleDelete}
      />
    ),
    [colors, handleRefresh, handleDelete],
  );

  const keyExtractor = useCallback(
    (item: CachedImageEntry) => item.coverArtId,
    [],
  );

  const isFiltered = filter.trim().length > 0;
  const emptyMessage = isFiltered ? t('noMatchingImages') : t('noCachedImages');
  const emptySubtitle = isFiltered ? undefined : t('imagesCachedAutomatically');

  const listEmpty = useMemo(
    () =>
      loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <EmptyState icon="images-outline" title={emptyMessage} subtitle={emptySubtitle} />
      ),
    [loading, emptyMessage, emptySubtitle, colors.primary],
  );

  const filterSegments: ReadonlyArray<Segment<BrowserSegment>> = useMemo(
    () => [
      { key: 'complete', label: t('filterComplete') },
      { key: 'incomplete', label: t('filterIncomplete') },
    ],
    [t],
  );

  const [chromeHeight, setChromeHeight] = useState(0);
  const contentInsetTop = headerHeight + chromeHeight;

  const listContentContainerStyle = useMemo(
    () => ({
      paddingTop: contentInsetTop,
      paddingHorizontal: 16,
      paddingBottom: 32,
      ...((loading || filteredEntries.length === 0) ? { flex: 1 } : undefined),
    }),
    [contentInsetTop, loading, filteredEntries.length],
  );

  return (
    <>
    <GradientBackground style={settingsStyles.container} scrollable>
      <View style={styles.listWrap}>
        <FlashList
          ref={listRef}
          data={loading ? [] : filteredEntries}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          extraData={statusMap}
          refreshControl={
            loading ? undefined : (
              <RefreshControl
                key={refreshControlKey}
                refreshing={refreshing}
                onRefresh={handlePullRefresh}
                tintColor={colors.primary}
                progressViewOffset={contentInsetTop}
              />
            )
          }
          contentContainerStyle={listContentContainerStyle}
          ListEmptyComponent={listEmpty}
        />
      </View>
      <View
        style={[styles.chromeOverlay, { top: headerHeight }]}
        onLayout={(e) => setChromeHeight(e.nativeEvent.layout.height)}
      >
        <View style={[settingsStyles.filterPill, { backgroundColor: colors.inputBg }]}>
          <Ionicons name="search" size={18} color={colors.textSecondary} style={settingsStyles.filterIcon} />
          <TextInput
            style={[settingsStyles.filterInput, { color: colors.textPrimary }]}
            placeholder={t('filterPlaceholder')}
            placeholderTextColor={colors.textSecondary}
            value={filter}
            onChangeText={handleFilterChange}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            editable={!loading}
          />
        </View>
        <SegmentControl
          segments={filterSegments}
          selected={statusFilter}
          onSelect={setStatusFilter}
        />
      </View>
      <BottomChrome withSafeAreaPadding />
    </GradientBackground>
    </>
  );
}

const styles = StyleSheet.create({
  listWrap: {
    flex: 1,
  },
  chromeOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
    gap: 8,
    zIndex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: 8,
  },
  fileList: {
    flex: 1,
    marginLeft: 12,
    gap: 4,
  },
  coverArtId: {
    fontSize: 12,
    fontFamily: 'Courier',
    fontWeight: '600',
    marginBottom: 2,
  },
  fileName: {
    fontSize: 12,
    fontFamily: 'Courier',
  },
  sizeLabel: {
    fontWeight: '600',
    fontSize: 12,
  },
  spinner: {
    marginLeft: 12,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '500',
    marginTop: 2,
  },
  pressed: {
    opacity: 0.6,
  },
  clearButton: {
    fontSize: 16,
    fontWeight: '400',
  },
  repairBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  repairBadgeText: {
    fontSize: 11,
    fontWeight: '500',
  },
  badgeDisabled: {
    opacity: 0.5,
  },
});
