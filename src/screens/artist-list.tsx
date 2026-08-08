import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ArtistListView, type ArtistLayout } from '../components/ArtistListView';
import { useFetchOnHydrated } from '../hooks/useFetchOnHydrated';
import { onPullToRefresh } from '../services/dataSyncService';
import {
  artistCursorOf,
  artistListRowToArtistID3,
  countArtists,
  listArtists,
  listArtistsBefore,
  type ArtistListRow,
} from '../db/repository/artists';
import { type Cursor } from '../db/repository/core';
import {
  listAllStarredArtists,
  starredItemOf,
  starredSortKeyOf,
  type StarredItem,
} from '../db/repository/favorites';
import { getDb } from '../store/persistence/db';
import { refreshArtistLibrary } from '../services/normalizedLibrarySync';
import { syncStatusStore } from '../store/syncStatusStore';
import { favoritesStore } from '../store/favoritesStore';
import { type ArtistID3 } from '../services/subsonicService';

const PAGE = 120;
/** Alphabet-scroller letters — all active in keyset mode (the loaded window can't
 *  reveal which letters exist; a tap on an empty letter seeks to the next one). */
const ALL_LETTERS = new Set<string>([
  '#',
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
]);

/**
 * Main artist browse — reads bounded KEYSET pages from the normalized `artists`
 * table. Artists aren't in the bulk library sync; they're fetched on demand
 * (`fetchAllArtists`, which dual-writes the normalized table). On a fresh library
 * the table is empty on first browse, so we trigger the fetch and reload the window
 * when it lands (via the store's `lastFetchedAt`).
 */
function KeysetArtistList({
  layout,
  contentInsetTop,
}: {
  layout: ArtistLayout;
  contentInsetTop: number;
}) {
  const [rows, setRows] = useState<ArtistListRow[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [seekTick, setSeekTick] = useState(0);
  const cursorRef = useRef<Cursor | null>(null); // forward (end)
  const prevCursorRef = useRef<Cursor | null>(null); // backward (start)
  const doneRef = useRef(false);
  const busyRef = useRef(false);

  const loadFirstPage = useCallback(async () => {
    busyRef.current = true;
    try {
      const db = getDb();
      if (!db) return;
      const page = await listArtists(db, { cursor: null, limit: PAGE });
      cursorRef.current = page.nextCursor;
      doneRef.current = !page.nextCursor;
      prevCursorRef.current = page.rows.length > 0 ? artistCursorOf(page.rows[0]) : null;
      setRows(page.rows);
    } finally {
      busyRef.current = false;
      setInitialLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (busyRef.current || doneRef.current) return;
    busyRef.current = true;
    try {
      const db = getDb();
      if (!db) return;
      const page = await listArtists(db, { cursor: cursorRef.current, limit: PAGE });
      cursorRef.current = page.nextCursor;
      if (!page.nextCursor) doneRef.current = true;
      setRows((r) => [...r, ...page.rows]);
    } finally {
      busyRef.current = false;
    }
  }, []);

  const loadPrevious = useCallback(async () => {
    const before = prevCursorRef.current;
    if (busyRef.current || !before) return;
    busyRef.current = true;
    try {
      const db = getDb();
      if (!db) return;
      const page = await listArtistsBefore(db, { before, limit: PAGE });
      prevCursorRef.current = page.prevCursor;
      if (page.rows.length > 0) setRows((r) => [...page.rows, ...r]);
    } finally {
      busyRef.current = false;
    }
  }, []);

  const seekLetter = useCallback(async (letter: string) => {
    busyRef.current = true;
    try {
      const db = getDb();
      if (!db) return;
      const page = await listArtists(db, { letter, limit: PAGE });
      cursorRef.current = page.nextCursor;
      doneRef.current = !page.nextCursor;
      prevCursorRef.current = page.rows.length > 0 ? artistCursorOf(page.rows[0]) : null;
      setRows(page.rows);
      setSeekTick((t) => t + 1); // triggers scroll-to-top in ArtistListView
    } finally {
      busyRef.current = false;
    }
  }, []);

  // Initial window load on mount.
  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  // Fetch-on-browse (once, post-hydration): if the normalized table is empty and
  // nothing is in flight, pull artists from the server (which dual-writes normalized
  // + bumps lastFetchedAt → the reload effect below repaints the window).
  useFetchOnHydrated(syncStatusStore, () => {
    void (async () => {
      const db = getDb();
      if (db && !syncStatusStore.getState().artistLibraryLoading && (await countArtists(db)) === 0) {
        void refreshArtistLibrary();
      }
    })();
  });

  // Reload the window when a fetch lands. Skip the initial (persisted) value so this
  // only fires on a genuine post-mount fetch completion — no loop when the library is
  // legitimately empty (fetch-on-browse already fired once above).
  const lastFetchedAt = syncStatusStore((s) => s.artistLibraryLastFetchedAt);
  const fetchLoading = syncStatusStore((s) => s.artistLibraryLoading);
  const seenFetchRef = useRef(lastFetchedAt);

  // Show the spinner (not the empty placeholder) until we have a DEFINITIVE result:
  // the first keyset read, a server fetch in flight, or a library never fetched yet.
  // The empty placeholder only appears once a fetch has completed and returned nothing.
  const showLoading =
    initialLoading || (rows.length === 0 && (fetchLoading || lastFetchedAt == null));
  useEffect(() => {
    if (lastFetchedAt === seenFetchRef.current) return;
    seenFetchRef.current = lastFetchedAt;
    cursorRef.current = null;
    prevCursorRef.current = null;
    doneRef.current = false;
    void loadFirstPage();
  }, [lastFetchedAt, loadFirstPage]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await onPullToRefresh('artists');
      cursorRef.current = null;
      prevCursorRef.current = null;
      doneRef.current = false;
      await loadFirstPage();
    } finally {
      setRefreshing(false);
    }
  }, [loadFirstPage]);

  return (
    <ArtistListView
      items={rows}
      toArtist={artistListRowToArtistID3}
      layout={layout}
      loading={showLoading}
      showAlphabetScroller
      activeLetters={ALL_LETTERS}
      onEndReached={loadMore}
      onStartReached={loadPrevious}
      onSeekLetter={seekLetter}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      scrollToTopTrigger={`seek:${seekTick}`}
      contentInsetTop={contentInsetTop}
    />
  );
}

/** The favourites filter reads the whole starred artist set from SQL — marked library
 *  rows plus the `favorite_artists` remainder — A–Z on the same stored `sort_title` the
 *  keyset browse orders by, so the filter cannot reorder the list.
 *
 *  There is deliberately NO downloaded branch: artists cannot be downloaded, so the
 *  Downloaded filter hides the Artists segment outright (`library.tsx`) and this
 *  component is never mounted under it. */
function FilteredArtistList({
  layout,
  favoritesOnly,
  contentInsetTop,
}: {
  layout: ArtistLayout;
  favoritesOnly: boolean;
  contentInsetTop: number;
}) {
  const { t } = useTranslation();
  const version = favoritesStore((s) => s.version);

  const [starredArtists, setStarredArtists] = useState<StarredItem<ArtistID3>[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const starredKey = `${version}`;
  // DERIVED, not seeded — see the note in `album-library-list.tsx`. A mount-time seed
  // would leave one empty-and-not-loading frame that flashes the placeholder.
  const starredLoading = favoritesOnly && loadedKey !== starredKey;
  useEffect(() => {
    if (!favoritesOnly) return;
    let alive = true;
    void (async () => {
      const db = getDb();
      const list = db ? await listAllStarredArtists(db, { sortOrder: 'name' }) : [];
      if (alive) {
        setStarredArtists(list);
        setLoadedKey(starredKey);
      }
    })();
    return () => {
      alive = false;
    };
  }, [favoritesOnly, version, starredKey]);

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await onPullToRefresh('artists');
    } finally {
      setRefreshing(false);
    }
  }, []);

  return (
    <ArtistListView
      items={starredArtists}
      toArtist={starredItemOf}
      sortKeyOf={starredSortKeyOf}
      layout={layout}
      loading={starredLoading}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      showAlphabetScroller
      scrollToTopTrigger={`${favoritesOnly}`}
      contentInsetTop={contentInsetTop}
      // Only mounted under the Favourites filter (Downloaded hides the segment entirely,
      // see `library.tsx`), so an empty result here is always the filter's doing.
      emptyMessage={t('noMatchesForFilters')}
      emptySubtitle={t('tryAdjustingFilters')}
    />
  );
}

export function ArtistListScreen({
  layout = 'list',
  favoritesOnly = false,
  contentInsetTop = 0,
}: {
  layout?: ArtistLayout;
  favoritesOnly?: boolean;
  contentInsetTop?: number;
}) {
  return (
    <View style={styles.container}>
      {favoritesOnly ? (
        <FilteredArtistList
          layout={layout}
          favoritesOnly={favoritesOnly}
          contentInsetTop={contentInsetTop}
        />
      ) : (
        <KeysetArtistList layout={layout} contentInsetTop={contentInsetTop} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
