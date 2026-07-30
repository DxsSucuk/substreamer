import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AlbumListView, type AlbumLayout } from '../components/AlbumListView';
import { onPullToRefresh } from '../services/dataSyncService';
import {
  albumCursorOf,
  albumListRowToAlbumID3,
  listAlbums,
  listAlbumsBefore,
  type AlbumListRow,
} from '../db/repository/albums';
import { type Cursor } from '../db/repository/core';
import { getDb } from '../store/persistence/db';
import { favoritesStore } from '../store/favoritesStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { serverInfoStore } from '../store/serverInfoStore';
import {
  albumPassesDownloadedFilter,
  downloadedAlbumsFromCache,
} from '../store/persistence/cachedItemHelpers';
import { sortAlbumsByPreference } from '../utils/librarySort';

const PAGE = 120;
/** Alphabet-scroller letters — all active in keyset mode (the loaded window can't
 *  reveal which letters exist; a tap on an empty letter seeks to the next one). */
const ALL_LETTERS = new Set<string>([
  '#',
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
]);

/**
 * Main album browse — reads bounded KEYSET pages from the normalized `albums`
 * table (never loads the whole library into memory). A-Z tap seeks via the DB;
 * scrolling up/down pages both directions.
 */
function KeysetAlbumList({ layout, contentInsetTop }: { layout: AlbumLayout; contentInsetTop: number }) {
  const [rows, setRows] = useState<AlbumListRow[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [seekTick, setSeekTick] = useState(0);
  const cursorRef = useRef<Cursor | null>(null); // forward (end)
  const prevCursorRef = useRef<Cursor | null>(null); // backward (start)
  const doneRef = useRef(false);
  const busyRef = useRef(false);
  // Respects the user's album-list sort setting: 'artist' (default) groups by
  // artist then title; 'title' is a flat A-Z by album title.
  const sortOrder = layoutPreferencesStore((s) => s.albumSortOrder);

  const albums = useMemo(() => rows.map(albumListRowToAlbumID3), [rows]);

  const loadFirstPage = useCallback(async () => {
    busyRef.current = true;
    try {
      const db = getDb();
      if (!db) return;
      const page = await listAlbums(db, { cursor: null, limit: PAGE, sortOrder });
      cursorRef.current = page.nextCursor;
      doneRef.current = !page.nextCursor;
      prevCursorRef.current = page.rows.length > 0 ? albumCursorOf(page.rows[0], sortOrder) : null;
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
      const page = await listAlbums(db, { cursor: cursorRef.current, limit: PAGE, sortOrder });
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
      const page = await listAlbumsBefore(db, { before, limit: PAGE, sortOrder });
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
        const page = await listAlbums(db, { letter, limit: PAGE, sortOrder });
        cursorRef.current = page.nextCursor;
        doneRef.current = !page.nextCursor;
        prevCursorRef.current = page.rows.length > 0 ? albumCursorOf(page.rows[0], sortOrder) : null;
        setRows(page.rows);
        setSeekTick((t) => t + 1); // triggers scroll-to-top in AlbumListView
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
      await onPullToRefresh('albums');
      // Reload the window from the DB (data is written by the normalized sync).
      await loadFirstPage();
    } finally {
      setRefreshing(false);
    }
  }, [loadFirstPage]);

  return (
    <AlbumListView
      albums={albums}
      layout={layout}
      loading={initialLoading}
      showAlphabetScroller
      activeLetters={ALL_LETTERS}
      onEndReached={loadMore}
      onStartReached={loadPrevious}
      onSeekLetter={seekLetter}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      scrollToTopTrigger={`${sortOrder}:${seekTick}`}
      contentInsetTop={contentInsetTop}
    />
  );
}

/** Downloaded/favorites filters read BOUNDED stores — favorites from `favoritesStore`,
 *  downloaded rebuilt from each `cached_items` self-cached envelope (never-reaped, offline-
 *  safe) — never the (paged) library table. Sorted to match the main list's A-Z scroller. */
function FilteredAlbumList({
  layout,
  downloadedOnly,
  favoritesOnly,
  contentInsetTop,
}: {
  layout: AlbumLayout;
  downloadedOnly: boolean;
  favoritesOnly: boolean;
  contentInsetTop: number;
}) {
  const cachedItems = musicCacheStore((s) => s.cachedItems);
  const starredAlbums = favoritesStore((s) => s.albums);
  const includePartial = layoutPreferencesStore((s) => s.includePartialInDownloadedFilter);
  const sortOrder = layoutPreferencesStore((s) => s.albumSortOrder);

  const filteredAlbums = useMemo(() => {
    const articles = serverInfoStore.getState().ignoredArticles ?? undefined;
    const list = favoritesOnly
      ? downloadedOnly
        ? starredAlbums.filter((a) => albumPassesDownloadedFilter(a, cachedItems, includePartial))
        : starredAlbums
      : downloadedAlbumsFromCache(cachedItems, includePartial);
    return sortAlbumsByPreference(list, sortOrder, articles);
  }, [downloadedOnly, favoritesOnly, cachedItems, starredAlbums, includePartial, sortOrder]);

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await onPullToRefresh('albums');
    } finally {
      setRefreshing(false);
    }
  }, []);

  return (
    <AlbumListView
      albums={filteredAlbums}
      layout={layout}
      loading={false}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      showAlphabetScroller
      scrollToTopTrigger={`${downloadedOnly}:${favoritesOnly}`}
      contentInsetTop={contentInsetTop}
    />
  );
}

export function AlbumLibraryListScreen({
  layout = 'list',
  downloadedOnly = false,
  favoritesOnly = false,
  contentInsetTop = 0,
}: {
  layout?: AlbumLayout;
  downloadedOnly?: boolean;
  favoritesOnly?: boolean;
  contentInsetTop?: number;
}) {
  return (
    <View style={styles.container}>
      {downloadedOnly || favoritesOnly ? (
        <FilteredAlbumList
          layout={layout}
          downloadedOnly={downloadedOnly}
          favoritesOnly={favoritesOnly}
          contentInsetTop={contentInsetTop}
        />
      ) : (
        <KeysetAlbumList layout={layout} contentInsetTop={contentInsetTop} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
