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
  listArtistsByIds,
  type ArtistListRow,
} from '../db/repository/artists';
import { type Cursor } from '../db/repository/core';
import { getDb } from '../store/persistence/db';
import { artistLibraryStore } from '../store/artistLibraryStore';
import { favoritesStore } from '../store/favoritesStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { serverInfoStore } from '../store/serverInfoStore';
import { downloadedAlbumsFromCache } from '../store/persistence/cachedItemHelpers';
import { sortArtistsByName } from '../utils/librarySort';
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

/** Downloaded/favorites filters read BOUNDED sources — favorites from `favoritesStore`;
 *  downloaded = the artists who own a downloaded album (derived from the never-reaped
 *  `cached_items` envelopes) hydrated from the normalized `artists` table for full art +
 *  album counts (with an album-derived fallback so a downloaded artist never vanishes). */
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
  const cachedItems = musicCacheStore((s) => s.cachedItems);
  const includePartial = layoutPreferencesStore((s) => s.includePartialInDownloadedFilter);
  const starredArtists = favoritesStore((s) => s.artists);

  // Downloaded albums (bounded, self-cached) → the set of artist ids that own one, plus a
  // minimal album-derived artist per id (name from the album) for the offline fallback.
  const { downloadedArtistIds, fallbackById } = useMemo(() => {
    const ids = new Set<string>();
    const fb = new Map<string, ArtistID3>();
    if (!downloadedOnly) return { downloadedArtistIds: null as Set<string> | null, fallbackById: fb };
    for (const album of downloadedAlbumsFromCache(cachedItems, includePartial)) {
      if (!album.artistId) continue;
      ids.add(album.artistId);
      if (!fb.has(album.artistId)) {
        fb.set(album.artistId, { id: album.artistId, name: album.artist ?? '', albumCount: 0 } as ArtistID3);
      }
    }
    return { downloadedArtistIds: ids, fallbackById: fb };
  }, [downloadedOnly, cachedItems, includePartial]);

  // Downloaded-only case: hydrate the full artist rows from the normalized table (favorites
  // already carry full objects). Async, with the album-derived fallback for any missing id.
  const [hydrated, setHydrated] = useState<ArtistID3[]>([]);
  useEffect(() => {
    if (favoritesOnly || !downloadedOnly) return;
    const ids = [...(downloadedArtistIds ?? [])];
    if (ids.length === 0) {
      setHydrated([]);
      return;
    }
    const fallback = (): ArtistID3[] => ids.map((id) => fallbackById.get(id)!).filter(Boolean);
    const db = getDb();
    if (!db) {
      setHydrated(fallback());
      return;
    }
    let alive = true;
    listArtistsByIds(db, ids)
      .then((rows) => {
        if (!alive) return;
        const byId = new Map(rows.map((r) => [r.id, artistListRowToArtistID3(r)]));
        setHydrated(ids.map((id) => byId.get(id) ?? fallbackById.get(id)!).filter(Boolean));
      })
      .catch(() => {
        if (alive) setHydrated(fallback());
      });
    return () => {
      alive = false;
    };
  }, [favoritesOnly, downloadedOnly, downloadedArtistIds, fallbackById]);

  const filteredArtists = useMemo(() => {
    const articles = serverInfoStore.getState().ignoredArticles ?? undefined;
    const list = favoritesOnly
      ? downloadedOnly && downloadedArtistIds
        ? starredArtists.filter((a) => downloadedArtistIds.has(a.id))
        : starredArtists
      : hydrated;
    return sortArtistsByName(list, articles);
  }, [favoritesOnly, downloadedOnly, downloadedArtistIds, starredArtists, hydrated]);

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
      loading={false}
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
