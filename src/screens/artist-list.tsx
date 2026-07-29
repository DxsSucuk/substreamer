import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

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
import { getDb } from '../store/persistence/db';
import { albumLibraryStore } from '../store/albumLibraryStore';
import { artistLibraryStore } from '../store/artistLibraryStore';
import { favoritesStore } from '../store/favoritesStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { albumPassesDownloadedFilter } from '../store/persistence/cachedItemHelpers';

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

  const artists = useMemo(() => rows.map(artistListRowToArtistID3), [rows]);

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
  useFetchOnHydrated(artistLibraryStore, () => {
    void (async () => {
      const db = getDb();
      const s = artistLibraryStore.getState();
      if (db && !s.loading && (await countArtists(db)) === 0) void s.fetchAllArtists();
    })();
  });

  // Reload the window when a fetch lands. Skip the initial (persisted) value so this
  // only fires on a genuine post-mount fetch completion — no loop when the library is
  // legitimately empty (fetch-on-browse already fired once above).
  const lastFetchedAt = artistLibraryStore((s) => s.lastFetchedAt);
  const fetchLoading = artistLibraryStore((s) => s.loading);
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
      artists={artists}
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

/** Downloaded/favorites filters still read the in-memory array (small sets; keyset
 *  WHERE-filtering is a follow-up). Unchanged from the pre-cutover screen. */
function FilteredArtistList({
  layout,
  downloadedOnly,
  favoritesOnly,
  contentInsetTop,
}: {
  layout: ArtistLayout;
  downloadedOnly: boolean;
  favoritesOnly: boolean;
  contentInsetTop: number;
}) {
  const artists = artistLibraryStore((s) => s.artists);
  const loading = artistLibraryStore((s) => s.loading);
  const error = artistLibraryStore((s) => s.error);
  const cachedItems = musicCacheStore((s) => s.cachedItems);
  const includePartial = layoutPreferencesStore((s) => s.includePartialInDownloadedFilter);
  const allAlbums = albumLibraryStore((s) => s.albums);
  const starredArtists = favoritesStore((s) => s.artists);

  const filteredArtists = useMemo(() => {
    const starredIds = favoritesOnly ? new Set(starredArtists.map((a) => a.id)) : null;

    let downloadedArtistIds: Set<string> | null = null;
    if (downloadedOnly) {
      downloadedArtistIds = new Set<string>();
      for (const album of allAlbums) {
        if (albumPassesDownloadedFilter(album, cachedItems, includePartial) && album.artistId) {
          downloadedArtistIds.add(album.artistId);
        }
      }
    }

    return artists.filter((artist) => {
      if (downloadedArtistIds && !downloadedArtistIds.has(artist.id)) return false;
      if (starredIds && !starredIds.has(artist.id)) return false;
      return true;
    });
  }, [artists, downloadedOnly, favoritesOnly, cachedItems, allAlbums, starredArtists, includePartial]);

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
      artists={filteredArtists}
      layout={layout}
      loading={loading}
      error={error}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      showAlphabetScroller
      scrollToTopTrigger={`${downloadedOnly}:${favoritesOnly}`}
      contentInsetTop={contentInsetTop}
    />
  );
}

export function ArtistListScreen({
  layout = 'list',
  downloadedOnly = false,
  favoritesOnly = false,
  contentInsetTop = 0,
}: {
  layout?: ArtistLayout;
  downloadedOnly?: boolean;
  favoritesOnly?: boolean;
  contentInsetTop?: number;
}) {
  return (
    <View style={styles.container}>
      {downloadedOnly || favoritesOnly ? (
        <FilteredArtistList
          layout={layout}
          downloadedOnly={downloadedOnly}
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
