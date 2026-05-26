import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useCallback, useMemo, useRef, type ReactNode } from 'react';
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
import { AlphabetScroller } from './AlphabetScroller';
import { EmptyState } from './EmptyState';
import { InsetRefreshSpacer } from './InsetRefreshSpacer';
import { playTrack } from '../services/playerService';
import type { Child } from '../services/subsonicService';
import { SongCard } from './SongCard';
import { closeOpenRow } from './SwipeableRow';
import { TrackRow } from './TrackRow';

/** First letter of `title` upper-cased and bucketed into A–Z or '#'. */
function songLetter(song: Child): string {
  const ch = (song.title ?? '').charAt(0).toUpperCase();
  return /[A-Z]/.test(ch) ? ch : '#';
}

export type SongLayout = 'list' | 'grid';

/* ------------------------------------------------------------------ */
/*  SongListView                                                      */
/* ------------------------------------------------------------------ */

export interface SongListViewProps {
  /** The list of songs to display */
  songs: Child[];
  /** Display layout: row list or grid of cards */
  layout?: SongLayout;
  /** Whether data is currently loading */
  loading?: boolean;
  /** Error message to display, if any */
  error?: string | null;
  /** Called when the user pulls to refresh */
  onRefresh?: () => void;
  /** Whether a refresh is in progress (pull-to-refresh spinner) */
  refreshing?: boolean;
  /** Custom empty-state message */
  emptyMessage?: string;
  /** Custom empty-state subtitle */
  emptySubtitle?: string;
  /** Optional Ionicons icon name for empty state */
  emptyIcon?: string;
  /** When this value changes, the list scrolls to the top */
  scrollToTopTrigger?: string;
  /** Extra top padding so content starts below a floating header but scrolls behind it */
  contentInsetTop?: number;
  /** Extra content rendered after the inset spacer in the list header */
  listHeaderExtra?: ReactNode;
  /** Render the A–Z alphabet scroller on the right edge (list layout only) */
  showAlphabetScroller?: boolean;
  /** Tap handler override. Defaults to `playTrack(song, songs)`. */
  onSongPress?: (song: Child) => void;
}

export function SongListView({
  songs,
  layout = 'list',
  loading = false,
  error = null,
  onRefresh,
  refreshing = false,
  emptyMessage,
  emptySubtitle,
  emptyIcon,
  scrollToTopTrigger,
  contentInsetTop = 0,
  listHeaderExtra,
  showAlphabetScroller = false,
  onSongPress,
}: SongListViewProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const resolvedEmptyMessage = emptyMessage ?? t('noSongsFound');
  const resolvedEmptySubtitle = emptySubtitle ?? t('tryAdjustingFilters');
  const gridColumns = useGridColumns();
  const scrollY = useSharedValue(0);
  const refreshControlKey = useRefreshControlKey();
  const listRef = useRef<FlashListRef<Child>>(null);

  const handleScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      scrollY.value = e.nativeEvent.contentOffset.y;
    },
    [scrollY],
  );

  const listKey = scrollToTopTrigger ? `${layout}:${scrollToTopTrigger}` : layout;

  const handleSongPress = useCallback(
    (song: Child) => {
      if (onSongPress) onSongPress(song);
      else playTrack(song, songs);
    },
    [onSongPress, songs],
  );

  const renderListItem = useCallback(
    ({ item }: { item: Child }) => (
      <TrackRow
        track={item}
        colors={colors}
        onPress={() => handleSongPress(item)}
        showCoverArt
        showAlbumName
      />
    ),
    [colors, handleSongPress]
  );

  const renderGridItem = useCallback(
    ({ item, index }: { item: Child; index: number }) => {
      const { paddingLeft, paddingRight } = getGridItemPadding(index, gridColumns, GRID_GAP);
      return (
        <View
          style={{
            flex: 1,
            paddingLeft,
            paddingRight,
            marginBottom: GRID_GAP,
          }}
        >
          <SongCard song={item} onPress={() => handleSongPress(item)} />
        </View>
      );
    },
    [handleSongPress, gridColumns]
  );

  /* ---- Alphabet scroller support ---- */
  const scrollerVisible = showAlphabetScroller && songs.length > 0;

  const activeLetters = useMemo(() => {
    if (!scrollerVisible) return new Set<string>();
    return new Set(songs.map(songLetter));
  }, [songs, scrollerVisible]);

  const handleLetterChange = useCallback(
    (letter: string) => {
      const idx = songs.findIndex((s) => songLetter(s) === letter);
      if (idx >= 0) {
        listRef.current?.scrollToIndex({ index: idx, animated: false });
      }
    },
    [songs],
  );

  const keyExtractor = useCallback((item: Child) => item.id, []);

  const EmptyComponent = useMemo(
    () => (
      <EmptyState
        icon={(emptyIcon as any) ?? 'musical-notes-outline'}
        title={resolvedEmptyMessage}
        subtitle={resolvedEmptySubtitle}
      />
    ),
    [emptyIcon, resolvedEmptyMessage, resolvedEmptySubtitle]
  );

  if (loading && songs.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error && songs.length === 0) {
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
        data={songs}
        renderItem={isGrid ? renderGridItem : renderListItem}
        keyExtractor={keyExtractor}
        onScrollBeginDrag={closeOpenRow}
        numColumns={isGrid ? gridColumns : 1}
        contentContainerStyle={[
          styles.listContent,
          isGrid && styles.listContentGrid,
          scrollerVisible && styles.listContentWithScroller,
          songs.length === 0 && styles.emptyListContent,
        ]}
        onScroll={contentInsetTop > 0 && Platform.OS === 'ios' ? handleScroll : undefined}
        scrollEventThrottle={contentInsetTop > 0 && Platform.OS === 'ios' ? 16 : undefined}
        ListHeaderComponent={
          contentInsetTop > 0 || listHeaderExtra ? (
            <>
              {contentInsetTop > 0 && (
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
              )}
              {listHeaderExtra}
            </>
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
