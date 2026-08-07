import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useCallback, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSharedValue } from 'react-native-reanimated';

import { useGridColumns, getGridItemPadding, GRID_GAP, LIST_PADDING } from '../hooks/useGridColumns';
import { useRefreshControlKey } from '../hooks/useRefreshControlKey';
import { useTheme } from '../hooks/useTheme';
import type { Playlist } from '../services/subsonicService';
import { getSortFirstLetter } from '../utils/sortHelpers';
import { serverInfoStore } from '../store/serverInfoStore';
import { EmptyState } from './EmptyState';
import { type IoniconsName } from '../utils/iconNames';
import { InsetRefreshSpacer } from './InsetRefreshSpacer';
import { PlaylistCard } from './PlaylistCard';
import { PlaylistRow } from './PlaylistRow';
import { closeOpenRow } from './SwipeableRow';
import { AlphabetScroller } from './AlphabetScroller';

export type PlaylistLayout = 'list' | 'grid';

/* ------------------------------------------------------------------ */
/*  Per-row adapters                                                   */
/* ------------------------------------------------------------------ */

/**
 * One rendered row, converted. The conversion is memoised on the item object, so
 * appending a page converts the appended rows only — the accumulated array is never
 * re-mapped, and the screen holds no second array of envelopes.
 */
function PlaylistListItem<T>({
  item,
  toPlaylist,
}: {
  item: T;
  toPlaylist: (item: T) => Playlist;
}) {
  const playlist = useMemo(() => toPlaylist(item), [item, toPlaylist]);
  return <PlaylistRow playlist={playlist} />;
}

function PlaylistGridItem<T>({
  item,
  toPlaylist,
  index,
  columns,
}: {
  item: T;
  toPlaylist: (item: T) => Playlist;
  index: number;
  columns: number;
}) {
  const playlist = useMemo(() => toPlaylist(item), [item, toPlaylist]);
  const { paddingLeft, paddingRight } = getGridItemPadding(index, columns, GRID_GAP);
  return (
    <View style={{ flex: 1, paddingLeft, paddingRight, marginBottom: GRID_GAP }}>
      <PlaylistCard playlist={playlist} />
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  PlaylistListView                                                  */
/* ------------------------------------------------------------------ */

export interface PlaylistListViewProps<T extends { id: string }> {
  /** The items to display — whatever the screen holds: SQL browse rows, envelopes. */
  items: T[];
  /** Adapts one item to the `Playlist` the row and card components take. Must be
   *  stable across renders (module-level, or memoised at the consumer). */
  toPlaylist: (item: T) => Playlist;
  /** Display layout: row list or grid of cards */
  layout?: PlaylistLayout;
  /** Whether data is currently loading */
  loading?: boolean;
  /** Error message to display, if any */
  error?: string | null;
  /** Called when the user pulls to refresh */
  onRefresh?: () => void;
  /** Whether a refresh is in progress (pull-to-refresh spinner) */
  refreshing?: boolean;
  /** Show the A-Z alphabet scroller on the right */
  showAlphabetScroller?: boolean;
  /** Custom empty-state message */
  emptyMessage?: string;
  /** Custom empty-state subtitle */
  emptySubtitle?: string;
  /** Ionicons icon name for the empty state */
  emptyIcon?: IoniconsName;
  /** When this value changes, the list scrolls to the top */
  scrollToTopTrigger?: string;
  /** Extra top padding so content starts below a floating header but scrolls behind it */
  contentInsetTop?: number;
  // ── Keyset paging (bounded window from the normalized DB). Optional: array-based
  //    consumers omit these. ──
  /** Near the end → load + append the next keyset page. */
  onEndReached?: () => void;
  /** Near the top → load + prepend the previous keyset page (after an A-Z jump). */
  onStartReached?: () => void;
  /** A-Z tap seeks via the DB (replace the window) instead of scrolling the array. */
  onSeekLetter?: (letter: string) => void;
  /** The full set of active alphabet letters — the loaded window can't reveal them
   *  all, so the screen supplies it. Falls back to computing from `items`. */
  activeLetters?: Set<string>;
}

export function PlaylistListView<T extends { id: string }>({
  items,
  toPlaylist,
  layout = 'list',
  loading = false,
  error = null,
  onRefresh,
  refreshing = false,
  showAlphabetScroller = false,
  emptyMessage,
  emptySubtitle,
  emptyIcon = 'list-outline',
  scrollToTopTrigger,
  contentInsetTop = 0,
  onEndReached,
  onStartReached,
  onSeekLetter,
  activeLetters: activeLettersProp,
}: PlaylistListViewProps<T>) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const resolvedEmptyMessage = emptyMessage ?? t('noPlaylists');
  const resolvedEmptySubtitle = emptySubtitle ?? t('playlistsEmptySubtitle');
  const gridColumns = useGridColumns();
  const listRef = useRef<FlashListRef<T>>(null);
  const scrollY = useSharedValue(0);
  const refreshControlKey = useRefreshControlKey();

  const handleScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      scrollY.value = e.nativeEvent.contentOffset.y;
    },
    [scrollY],
  );

  const listKey = scrollToTopTrigger ? `${layout}:${scrollToTopTrigger}` : layout;

  const renderListItem = useCallback(
    ({ item }: { item: T }) => <PlaylistListItem item={item} toPlaylist={toPlaylist} />,
    [toPlaylist]
  );

  const renderGridItem = useCallback(
    ({ item, index }: { item: T; index: number }) => (
      <PlaylistGridItem item={item} toPlaylist={toPlaylist} index={index} columns={gridColumns} />
    ),
    [gridColumns, toPlaylist]
  );

  const keyExtractor = useCallback((item: T) => item.id, []);

  const EmptyComponent = useMemo(
    () => (
      <EmptyState
        icon={emptyIcon}
        title={resolvedEmptyMessage}
        subtitle={resolvedEmptySubtitle}
      />
    ),
    [emptyIcon, resolvedEmptyMessage, resolvedEmptySubtitle]
  );

  /* ---- Alphabet scroller support ---- */
  const scrollerVisible = showAlphabetScroller && items.length > 0;
  const ignoredArticles = serverInfoStore((s) => s.ignoredArticles);

  const getLetter = useCallback(
    (item: T): string =>
      getSortFirstLetter(toPlaylist(item).name, undefined, ignoredArticles ?? undefined),
    [ignoredArticles, toPlaylist],
  );

  // In keyset mode the window can't reveal every letter, so the screen supplies the full
  // active set — and this whole-array pass would be discarded, so it is skipped.
  const computedLetters = useMemo(() => {
    if (activeLettersProp || !scrollerVisible) return new Set<string>();
    return new Set(items.map((item) => getLetter(item)));
  }, [activeLettersProp, items, scrollerVisible, getLetter]);
  const activeLetters = activeLettersProp ?? computedLetters;

  const handleLetterChange = useCallback(
    (letter: string) => {
      // Keyset mode: seek via the DB (screen replaces the window). Array mode:
      // scroll to the matching index within the loaded array.
      if (onSeekLetter) {
        onSeekLetter(letter);
        return;
      }
      const idx = items.findIndex((item) => {
        const first = getLetter(item);
        if (letter === '#') return first === '#';
        return first === letter;
      });
      if (idx >= 0) {
        listRef.current?.scrollToIndex({ index: idx, animated: false });
      }
    },
    [items, getLetter, onSeekLetter],
  );

  if (loading && items.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error && items.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.errorText, { color: colors.textSecondary }]}>
          {error}
        </Text>
      </View>
    );
  }

  const isGrid = layout === 'grid';

  return (
    <View style={styles.wrapper}>
      <FlashList
        ref={listRef}
        key={listKey}
        data={items}
        renderItem={isGrid ? renderGridItem : renderListItem}
        keyExtractor={keyExtractor}
        onScrollBeginDrag={closeOpenRow}
        numColumns={isGrid ? gridColumns : 1}
        contentContainerStyle={[
          styles.listContent,
          isGrid && styles.listContentGrid,
          scrollerVisible && styles.listContentWithScroller,
          items.length === 0 && styles.emptyListContent,
        ]}
        onScroll={contentInsetTop > 0 && Platform.OS === 'ios' ? handleScroll : undefined}
        scrollEventThrottle={contentInsetTop > 0 && Platform.OS === 'ios' ? 16 : undefined}
        ListHeaderComponent={
          contentInsetTop > 0 ? (
            Platform.OS === 'ios' ? (
              <InsetRefreshSpacer
                height={contentInsetTop}
                refreshing={refreshing}
                scrollY={scrollY}
                color={colors.primary}
              />
            ) : (
              <View style={{ height: contentInsetTop }} />
            )
          ) : undefined
        }
        refreshControl={
          onRefresh ? (
            <RefreshControl
              key={refreshControlKey}
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={contentInsetTop > 0 ? 'transparent' : colors.primary}
              colors={[colors.primary]}
              progressViewOffset={contentInsetTop}
            />
          ) : undefined
        }
        drawDistance={300}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.6}
        onStartReached={onStartReached}
        onStartReachedThreshold={0.6}
        ListEmptyComponent={EmptyComponent}
      />
      {scrollerVisible && (
        <AlphabetScroller
          activeLetters={activeLetters}
          onLetterChange={handleLetterChange}
          topInset={contentInsetTop}
        />
      )}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                            */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    paddingVertical: LIST_PADDING,
    paddingBottom: 32,
  },
  listContentGrid: {
    paddingHorizontal: LIST_PADDING,
  },
  listContentWithScroller: {
    paddingRight: LIST_PADDING + 20,
  },
  emptyListContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    fontSize: 16,
  },
});
