import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

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
import { downloadedAlbumSortKey, listDownloadedAlbums } from '../db/repository/downloads';
import {
  listAllStarredAlbums,
  starredItemOf,
  starredSortKeyOf,
  type StarredItem,
} from '../db/repository/favorites';
import { getDb } from '../store/persistence/db';
import { favoritesStore } from '../store/favoritesStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import type { AlbumID3 } from '../services/subsonicService';

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
  // Bumped by every load that REPLACES the window (first page, letter seek, top seek).
  // A paging load that was already in flight when one of those ran must not write its
  // rows or cursors afterwards — it belongs to a window that no longer exists.
  const loadGenRef = useRef(0);
  // Whether the loaded window begins at the START of the library. `prevCursorRef` cannot
  // answer this: after the first page it holds row 0's own cursor, which is non-null and
  // looks identical to a window that starts mid-library after a letter seek.
  const atLibraryStartRef = useRef(true);
  // Held across the whole prepend -> scroll -> trim transition. `busyRef` cannot do this
  // job: every pager clears it in its own `finally`, so an in-flight load would drop the
  // guard part-way through.
  const transitionRef = useRef(false);
  // Respects the user's album-list sort setting: 'artist' (default) groups by
  // artist then title; 'title' is a flat A-Z by album title.
  const sortOrder = layoutPreferencesStore((s) => s.albumSortOrder);

  const loadFirstPage = useCallback(async () => {
    const gen = (loadGenRef.current += 1);
    busyRef.current = true;
    try {
      const db = getDb();
      if (!db) return;
      const page = await listAlbums(db, { cursor: null, limit: PAGE, sortOrder });
      // A newer load superseded this one — its rows belong to a window that is gone.
      if (gen !== loadGenRef.current) return;
      atLibraryStartRef.current = true;
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
    if (transitionRef.current) return;
    if (busyRef.current || doneRef.current) return;
    const gen = loadGenRef.current;
    busyRef.current = true;
    try {
      const db = getDb();
      if (!db) return;
      const page = await listAlbums(db, { cursor: cursorRef.current, limit: PAGE, sortOrder });
      if (gen !== loadGenRef.current) return false;
      cursorRef.current = page.nextCursor;
      if (!page.nextCursor) doneRef.current = true;
      setRows((r) => [...r, ...page.rows]);
    } finally {
      busyRef.current = false;
    }
  }, [sortOrder]);

  const loadPrevious = useCallback(async () => {
    const before = prevCursorRef.current;
    if (transitionRef.current) return;
    if (busyRef.current || !before) return;
    const gen = loadGenRef.current;
    busyRef.current = true;
    try {
      const db = getDb();
      if (!db) return;
      const page = await listAlbumsBefore(db, { before, limit: PAGE, sortOrder });
      if (gen !== loadGenRef.current) return;
      prevCursorRef.current = page.prevCursor;
      if (page.prevCursor === null) atLibraryStartRef.current = true;
      if (page.rows.length > 0) setRows((r) => [...page.rows, ...r]);
    } finally {
      busyRef.current = false;
    }
  }, [sortOrder]);

  const seekLetter = useCallback(
    async (letter: string) => {
      const gen = (loadGenRef.current += 1);
      busyRef.current = true;
      try {
        const db = getDb();
        if (!db) return;
        const page = await listAlbums(db, { letter, limit: PAGE, sortOrder });
        // A newer seek superseded this one — same reasoning.
        if (gen !== loadGenRef.current) return;
        atLibraryStartRef.current = false;
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

  // iOS status-bar tap, delivered by `StatusBarTapTarget` — the list itself declines it,
  // so nothing has scrolled when we get here. Reset to the first page exactly the way a
  // letter seek does: replace the window, bump the tick. No traversal to flash through.
  const seekTop = useCallback(async (): Promise<boolean> => {
    // Already showing the first page: there is no window to replace, so report that and
    // let the list scroll itself — otherwise the tap does nothing at all.
    if (atLibraryStartRef.current || transitionRef.current) return false;
    transitionRef.current = true;
    try {
      const db = getDb();
      if (!db) return false;
      const gen = (loadGenRef.current += 1);
      const page = await listAlbums(db, { cursor: null, limit: PAGE, sortOrder });
      // A newer load superseded this one; it has already moved the list.
      if (gen !== loadGenRef.current) return true;
      cursorRef.current = page.nextCursor;
      doneRef.current = !page.nextCursor;
      prevCursorRef.current = page.rows.length > 0 ? albumCursorOf(page.rows[0], sortOrder) : null;
      atLibraryStartRef.current = true;
      setRows(page.rows);
      setSeekTick((t) => t + 1);
      return true;
    } finally {
      transitionRef.current = false;
    }
  }, [sortOrder]);

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
      items={rows}
      toAlbum={albumListRowToAlbumID3}
      layout={layout}
      loading={initialLoading}
      showAlphabetScroller
      activeLetters={ALL_LETTERS}
      onEndReached={loadMore}
      onStartReached={loadPrevious}
      onSeekLetter={seekLetter}
      onScrollToTop={seekTop}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      scrollToTopTrigger={`${sortOrder}:${seekTick}`}
      contentInsetTop={contentInsetTop}
    />
  );
}

/** Downloaded/favorites filters read BOUNDED sources straight from SQL — favourites from
 *  the marked library rows plus the `favorite_albums` remainder, downloaded from the
 *  `cached_items` ⋈ `cached_albums` download tables (never-reaped, offline-safe) — never
 *  the (paged) library table. Both come back ORDERED by the same stored `sort_*` keys the
 *  main list's keyset uses, so a filter can never reorder the list. */
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
  const { t } = useTranslation();
  // `revision` is the download tables' change signal: SQL has no Zustand subscription, so
  // without it a download completing under the user leaves this list silently stale.
  const revision = musicCacheStore((s) => s.revision);
  const version = favoritesStore((s) => s.version);
  const includePartial = layoutPreferencesStore((s) => s.includePartialInDownloadedFilter);
  const sortOrder = layoutPreferencesStore((s) => s.albumSortOrder);

  const [starredAlbums, setStarredAlbums] = useState<StarredItem<AlbumID3>[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  // `sortOrder` is part of the key because the ORDER BY is now the DB's: changing the
  // preference has to re-read, not re-sort what we hold.
  const starredKey = `${downloadedOnly}:${includePartial}:${version}:${sortOrder}`;
  // DERIVED, never seeded: "the rows we hold aren't the rows this filter asks for".
  // A `useState(favoritesOnly)` seed only runs on mount, and this component stays
  // mounted when Favourites is switched on over an already-on Downloaded — that frame
  // renders empty-and-not-loading and flashes the "no albums found" placeholder.
  const starredLoading = favoritesOnly && loadedKey !== starredKey;
  useEffect(() => {
    if (!favoritesOnly) return;
    let alive = true;
    void (async () => {
      const db = getDb();
      const list = db
        ? await listAllStarredAlbums(db, { downloadedOnly, includePartial, sortOrder })
        : [];
      if (alive) {
        setStarredAlbums(list);
        setLoadedKey(starredKey);
      }
    })();
    return () => {
      alive = false;
    };
  }, [favoritesOnly, downloadedOnly, includePartial, version, sortOrder, starredKey]);

  const [downloadedRows, setDownloadedRows] = useState<AlbumListRow[]>([]);
  const [downloadedLoadedKey, setDownloadedLoadedKey] = useState<string | null>(null);
  const downloadedKey = `${includePartial}:${revision}:${sortOrder}`;
  // DERIVED for the same reason as `starredLoading` above: the read is asynchronous, so a
  // mount-time seed leaves one empty-and-not-loading frame on the way in AND on every
  // Favourites toggle-off, both of which flash "No albums found".
  const downloadedLoading = !favoritesOnly && downloadedLoadedKey !== downloadedKey;
  useEffect(() => {
    if (favoritesOnly) return;
    let alive = true;
    void (async () => {
      const db = getDb();
      const list = db ? await listDownloadedAlbums(db, { includePartial, sortOrder }) : [];
      if (alive) {
        setDownloadedRows(list);
        setDownloadedLoadedKey(downloadedKey);
      }
    })();
    return () => {
      alive = false;
    };
  }, [favoritesOnly, includePartial, revision, sortOrder, downloadedKey]);

  const [refreshing, setRefreshing] = useState(false);
  // The source the branch on screen reads: starred albums come from `getStarred2`
  // (whatever else is filtered on top), downloaded ones from the album library.
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await onPullToRefresh(favoritesOnly ? 'favorites' : 'albums');
    } finally {
      setRefreshing(false);
    }
  }, [favoritesOnly]);

  // The key the DOWNLOADED read ordered by, so the scroller letters on it rather than
  // re-deriving one from the envelope. Memoised: a fresh arrow per render would recompute
  // the whole letter set every time.
  const downloadedSortKeyOf = useCallback(
    (r: AlbumListRow) => downloadedAlbumSortKey(r, sortOrder),
    [sortOrder],
  );

  const viewProps = {
    layout,
    loading: starredLoading || downloadedLoading,
    onRefresh: handleRefresh,
    refreshing,
    showAlphabetScroller: true,
    scrollToTopTrigger: `${downloadedOnly}:${favoritesOnly}`,
    contentInsetTop,
    // This component only exists under a filter, so an empty result here always means
    // "the filter removed everything" — never "your library is empty". The unfiltered
    // list (`KeysetAlbumList`) keeps the "No albums found" copy.
    emptyMessage: t('noMatchesForFilters'),
    emptySubtitle: t('tryAdjustingFilters'),
  };

  // Both branches render the same component in the same slot, so switching filters
  // updates the instance rather than remounting it — which is what the derived loading
  // flags above depend on.
  return favoritesOnly ? (
    <AlbumListView
      items={starredAlbums}
      toAlbum={starredItemOf}
      sortKeyOf={starredSortKeyOf}
      {...viewProps}
    />
  ) : (
    <AlbumListView
      items={downloadedRows}
      toAlbum={albumListRowToAlbumID3}
      sortKeyOf={downloadedSortKeyOf}
      {...viewProps}
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
