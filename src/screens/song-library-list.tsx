import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SongListView, type SongLayout } from '../components/SongListView';
import { useAllSongsByTitle } from '../hooks/useAllSongsByTitle';
import { onPullToRefresh } from '../services/dataSyncService';
import { playTrack } from '../services/playerService';
import {
  listSongs,
  listSongsBefore,
  songCursorOf,
  songListRowToChild,
  type SongListRow,
} from '../db/repository/songs';
import { type Cursor } from '../db/repository/core';
import {
  downloadedSongRowToChild,
  downloadedSongSortKey,
  type DownloadedSongRow,
} from '../db/repository/downloads';
import {
  listAllStarredSongs,
  starredItemOf,
  starredSortKeyOf,
  type StarredItem,
} from '../db/repository/favorites';
import { getDb } from '../store/persistence/db';
import { favoritesStore } from '../store/favoritesStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import type { Child } from '../services/subsonicService';

const PAGE = 120;
/** Alphabet-scroller letters — all active in keyset mode (the loaded window can't
 *  reveal which letters exist; a tap on an empty letter seeks to the next one). */
const ALL_LETTERS = new Set<string>([
  '#',
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
]);

/** Play just the tapped song (a bounded keyset window can't be the whole queue). */
const handleSongPress = (song: Child): void => {
  void playTrack(song, [song]);
};

/**
 * Main song browse — reads bounded KEYSET pages from the normalized `songs` table
 * (never loads the whole library into memory). Honors the song sort setting (song
 * title / artist name); A-Z tap seeks via the DB; scrolling pages both directions.
 */
function KeysetSongList({
  layout,
  contentInsetTop,
}: {
  layout: SongLayout;
  contentInsetTop: number;
}) {
  const [rows, setRows] = useState<SongListRow[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [seekTick, setSeekTick] = useState(0);
  const cursorRef = useRef<Cursor | null>(null); // forward (end)
  const prevCursorRef = useRef<Cursor | null>(null); // backward (start)
  const doneRef = useRef(false);
  const busyRef = useRef(false);
  const sortOrder = layoutPreferencesStore((s) => s.songSortOrder);

  const loadFirstPage = useCallback(async () => {
    busyRef.current = true;
    try {
      const db = getDb();
      if (!db) return;
      const page = await listSongs(db, { cursor: null, limit: PAGE, sortOrder });
      cursorRef.current = page.nextCursor;
      doneRef.current = !page.nextCursor;
      prevCursorRef.current = page.rows.length > 0 ? songCursorOf(page.rows[0], sortOrder) : null;
      setRows(page.rows);
    } finally {
      busyRef.current = false;
      setInitialLoading(false);
    }
  }, [sortOrder]);

  const loadMore = useCallback(async () => {
    if (busyRef.current || doneRef.current) return;
    busyRef.current = true;
    try {
      const db = getDb();
      if (!db) return;
      const page = await listSongs(db, { cursor: cursorRef.current, limit: PAGE, sortOrder });
      cursorRef.current = page.nextCursor;
      if (!page.nextCursor) doneRef.current = true;
      setRows((r) => [...r, ...page.rows]);
    } finally {
      busyRef.current = false;
    }
  }, [sortOrder]);

  const loadPrevious = useCallback(async () => {
    const before = prevCursorRef.current;
    if (busyRef.current || !before) return;
    busyRef.current = true;
    try {
      const db = getDb();
      if (!db) return;
      const page = await listSongsBefore(db, { before, limit: PAGE, sortOrder });
      prevCursorRef.current = page.prevCursor;
      if (page.rows.length > 0) setRows((r) => [...page.rows, ...r]);
    } finally {
      busyRef.current = false;
    }
  }, [sortOrder]);

  const seekLetter = useCallback(
    async (letter: string) => {
      busyRef.current = true;
      try {
        const db = getDb();
        if (!db) return;
        const page = await listSongs(db, { letter, limit: PAGE, sortOrder });
        cursorRef.current = page.nextCursor;
        doneRef.current = !page.nextCursor;
        prevCursorRef.current = page.rows.length > 0 ? songCursorOf(page.rows[0], sortOrder) : null;
        setRows(page.rows);
        setSeekTick((t) => t + 1); // triggers scroll-to-top in SongListView
      } finally {
        busyRef.current = false;
      }
    },
    [sortOrder],
  );

  // (Re)load from the top on mount and whenever the sort order changes.
  useEffect(() => {
    cursorRef.current = null;
    prevCursorRef.current = null;
    doneRef.current = false;
    setInitialLoading(true);
    void loadFirstPage();
  }, [loadFirstPage]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await onPullToRefresh('songs');
      await loadFirstPage();
    } finally {
      setRefreshing(false);
    }
  }, [loadFirstPage]);

  return (
    <SongListView
      items={rows}
      toSong={songListRowToChild}
      layout={layout}
      loading={initialLoading}
      showAlphabetScroller
      activeLetters={ALL_LETTERS}
      onEndReached={loadMore}
      onStartReached={loadPrevious}
      onSeekLetter={seekLetter}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      onSongPress={handleSongPress}
      scrollToTopTrigger={`${sortOrder}:${seekTick}`}
      contentInsetTop={contentInsetTop}
    />
  );
}

/** Downloaded/favorites filters read BOUNDED sources — favourites straight from SQL
 *  (marked library rows + the `favorite_*` remainder), downloaded from the never-reaped
 *  `cached_songs` set. Both come back ORDERED by the same stored `sort_*` keys the main
 *  list's keyset uses, under the same song sort order, so a filter can never reorder the
 *  list; the Favourites TAB is recency-ordered, this filter is the Songs tab with a
 *  predicate. */
function FilteredSongList({
  layout,
  downloadedOnly,
  favoritesOnly,
  contentInsetTop,
}: {
  layout: SongLayout;
  downloadedOnly: boolean;
  favoritesOnly: boolean;
  contentInsetTop: number;
}) {
  const { t } = useTranslation();
  const { rows: downloadedRows, refresh, loading } = useAllSongsByTitle({
    downloadedOnly: downloadedOnly && !favoritesOnly,
  });
  const version = favoritesStore((s) => s.version);
  const sortOrder = layoutPreferencesStore((s) => s.songSortOrder);
  const [starred, setStarred] = useState<StarredItem<Child>[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  // `sortOrder` is part of the key because the ORDER BY is now the DB's: changing the
  // preference has to re-read, not re-sort what we hold.
  const starredKey = `${downloadedOnly}:${version}:${sortOrder}`;
  // DERIVED, not seeded — see the note in `album-library-list.tsx`. A mount-time seed
  // misses the case where Favourites is switched on while Downloaded is already on.
  const starredLoading = favoritesOnly && loadedKey !== starredKey;
  useEffect(() => {
    if (!favoritesOnly) return;
    let alive = true;
    void (async () => {
      const db = getDb();
      const list = db ? await listAllStarredSongs(db, { downloadedOnly, sortOrder }) : [];
      if (alive) {
        setStarred(list);
        setLoadedKey(starredKey);
      }
    })();
    return () => {
      alive = false;
    };
  }, [favoritesOnly, downloadedOnly, version, sortOrder, starredKey]);

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  // The key the DOWNLOADED read ordered by, so the scroller letters on it rather than
  // re-deriving one from the envelope. Memoised: a fresh arrow per render would recompute
  // the whole letter set every time.
  const downloadedSortKeyOf = useCallback(
    (r: DownloadedSongRow) => downloadedSongSortKey(r, sortOrder),
    [sortOrder],
  );

  const viewProps = {
    layout,
    onRefresh: handleRefresh,
    refreshing,
    onSongPress: handleSongPress,
    showAlphabetScroller: true,
    scrollToTopTrigger: `${downloadedOnly}:${favoritesOnly}`,
    contentInsetTop,
    // This component only exists under a filter, so an empty result here always means
    // "the filter removed everything" — never "your library is empty". The unfiltered
    // list (`KeysetSongList`) keeps the "No songs found" copy.
    emptyMessage: t('noMatchesForFilters'),
    emptySubtitle: t('tryAdjustingFilters'),
  };

  // Both branches render the same component in the same slot, so switching filters
  // updates the instance rather than remounting it — which is what the derived loading
  // flags above depend on.
  return favoritesOnly ? (
    <SongListView
      items={starred}
      toSong={starredItemOf}
      sortKeyOf={starredSortKeyOf}
      loading={starredLoading}
      {...viewProps}
    />
  ) : (
    <SongListView
      items={downloadedRows}
      toSong={downloadedSongRowToChild}
      sortKeyOf={downloadedSortKeyOf}
      loading={loading}
      {...viewProps}
    />
  );
}

export function SongLibraryListScreen({
  layout = 'list',
  downloadedOnly = false,
  favoritesOnly = false,
  contentInsetTop = 0,
}: {
  layout?: SongLayout;
  downloadedOnly?: boolean;
  favoritesOnly?: boolean;
  contentInsetTop?: number;
}) {
  return (
    <View style={styles.container}>
      {downloadedOnly || favoritesOnly ? (
        <FilteredSongList
          layout={layout}
          downloadedOnly={downloadedOnly}
          favoritesOnly={favoritesOnly}
          contentInsetTop={contentInsetTop}
        />
      ) : (
        <KeysetSongList layout={layout} contentInsetTop={contentInsetTop} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
