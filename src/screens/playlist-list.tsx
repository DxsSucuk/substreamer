import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { PlaylistListView, type PlaylistLayout } from '../components/PlaylistListView';
import { useFetchOnHydrated } from '../hooks/useFetchOnHydrated';
import { onPullToRefresh } from '../services/dataSyncService';
import {
  countPlaylists,
  listPlaylists,
  listPlaylistsBefore,
  playlistCursorOf,
  playlistListRowToPlaylist,
  type PlaylistListRow,
} from '../db/repository/playlists';
import { type Cursor } from '../db/repository/core';
import { listDownloadedPlaylistsAsPlaylist } from '../db/repository/downloads';
import { getDb } from '../store/persistence/db';
import { musicCacheStore } from '../store/musicCacheStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { refreshPlaylistLibrary } from '../services/normalizedLibrarySync';
import { syncStatusStore } from '../store/syncStatusStore';
import { serverInfoStore } from '../store/serverInfoStore';
import { sortPlaylistsByName } from '../utils/librarySort';
import { type IoniconsName } from '../utils/iconNames';
import type { Playlist } from '../services/subsonicService';

const PAGE = 120;
/** Alphabet-scroller letters — all active in keyset mode (the loaded window can't
 *  reveal which letters exist; a tap on an empty letter seeks to the next one). */
const ALL_LETTERS = new Set<string>([
  '#',
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
]);

interface EmptyProps {
  emptyIcon?: IoniconsName;
  emptyMessage?: string;
  emptySubtitle?: string;
}

/**
 * Main playlist browse — reads bounded KEYSET pages from the normalized `playlists`
 * table. Playlists fetch on demand (`refreshPlaylistLibrary`);
 * on a fresh library the table is empty on first browse, so we trigger the fetch and
 * reload the window when it lands (via the store's `lastFetchedAt`).
 */
function KeysetPlaylistList({
  layout,
  contentInsetTop,
  emptyProps,
}: {
  layout: PlaylistLayout;
  contentInsetTop: number;
  emptyProps: EmptyProps;
}) {
  const [rows, setRows] = useState<PlaylistListRow[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [seekTick, setSeekTick] = useState(0);
  const cursorRef = useRef<Cursor | null>(null); // forward (end)
  const prevCursorRef = useRef<Cursor | null>(null); // backward (start)
  const doneRef = useRef(false);
  const busyRef = useRef(false);

  const playlists = useMemo(() => rows.map(playlistListRowToPlaylist), [rows]);

  const loadFirstPage = useCallback(async () => {
    busyRef.current = true;
    try {
      const db = getDb();
      if (!db) return;
      const page = await listPlaylists(db, { cursor: null, limit: PAGE });
      cursorRef.current = page.nextCursor;
      doneRef.current = !page.nextCursor;
      prevCursorRef.current = page.rows.length > 0 ? playlistCursorOf(page.rows[0]) : null;
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
      const page = await listPlaylists(db, { cursor: cursorRef.current, limit: PAGE });
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
      const page = await listPlaylistsBefore(db, { before, limit: PAGE });
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
      const page = await listPlaylists(db, { letter, limit: PAGE });
      cursorRef.current = page.nextCursor;
      doneRef.current = !page.nextCursor;
      prevCursorRef.current = page.rows.length > 0 ? playlistCursorOf(page.rows[0]) : null;
      setRows(page.rows);
      setSeekTick((t) => t + 1); // triggers scroll-to-top in PlaylistListView
    } finally {
      busyRef.current = false;
    }
  }, []);

  // Initial window load on mount.
  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  // Fetch-on-browse (once, post-hydration): if the normalized table is empty and
  // nothing is in flight, pull playlists from the server (which dual-writes normalized
  // + bumps lastFetchedAt → the reload effect below repaints the window).
  useFetchOnHydrated(syncStatusStore, () => {
    void (async () => {
      const db = getDb();
      if (db && !syncStatusStore.getState().playlistLibraryLoading && (await countPlaylists(db)) === 0) {
        void refreshPlaylistLibrary();
      }
    })();
  });

  // Reload the window when a fetch lands. Skip the initial (persisted) value so this
  // only fires on a genuine post-mount fetch completion.
  const lastFetchedAt = syncStatusStore((s) => s.playlistLibraryLastFetchedAt);
  const fetchLoading = syncStatusStore((s) => s.playlistLibraryLoading);
  const seenFetchRef = useRef(lastFetchedAt);
  useEffect(() => {
    if (lastFetchedAt === seenFetchRef.current) return;
    seenFetchRef.current = lastFetchedAt;
    cursorRef.current = null;
    prevCursorRef.current = null;
    doneRef.current = false;
    void loadFirstPage();
  }, [lastFetchedAt, loadFirstPage]);

  // Spinner (not empty placeholder) until we have a DEFINITIVE result: the first
  // keyset read, a fetch in flight, or a library never fetched yet.
  const showLoading =
    initialLoading || (rows.length === 0 && (fetchLoading || lastFetchedAt == null));

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await onPullToRefresh('playlists');
      cursorRef.current = null;
      prevCursorRef.current = null;
      doneRef.current = false;
      await loadFirstPage();
    } finally {
      setRefreshing(false);
    }
  }, [loadFirstPage]);

  return (
    <PlaylistListView
      playlists={playlists}
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
      {...emptyProps}
    />
  );
}

/** Downloaded filter reads the BOUNDED download tables straight from SQL
 *  (`cached_items` ⋈ `cached_playlists`, never-reaped and offline-safe), not the paged
 *  library. No partial gate: playlists download atomically. */
function FilteredPlaylistList({
  layout,
  contentInsetTop,
  emptyProps,
}: {
  layout: PlaylistLayout;
  contentInsetTop: number;
  emptyProps: EmptyProps;
}) {
  // `revision` is the download tables' change signal: SQL has no Zustand subscription, so
  // without it a download completing under the user leaves this list silently stale.
  const revision = musicCacheStore((s) => s.revision);

  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);
  // DERIVED, not seeded — see the note in `album-library-list.tsx`. The read is
  // asynchronous, so a mount-time seed leaves one empty-and-not-loading frame that
  // flashes the "no playlists" placeholder.
  const loading = loadedRevision !== revision;
  useEffect(() => {
    let alive = true;
    void (async () => {
      const db = getDb();
      const list = db ? await listDownloadedPlaylistsAsPlaylist(db) : [];
      if (alive) {
        setPlaylists(list);
        setLoadedRevision(revision);
      }
    })();
    return () => {
      alive = false;
    };
  }, [revision]);

  const filteredPlaylists = useMemo(() => {
    const articles = serverInfoStore.getState().ignoredArticles ?? undefined;
    return sortPlaylistsByName(playlists, articles);
  }, [playlists]);

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await onPullToRefresh('playlists');
    } finally {
      setRefreshing(false);
    }
  }, []);

  return (
    <PlaylistListView
      playlists={filteredPlaylists}
      layout={layout}
      loading={loading}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      showAlphabetScroller
      scrollToTopTrigger="downloaded"
      contentInsetTop={contentInsetTop}
      {...emptyProps}
    />
  );
}

export function PlaylistListScreen({
  layout = 'list',
  downloadedOnly = false,
  contentInsetTop = 0,
}: {
  layout?: PlaylistLayout;
  downloadedOnly?: boolean;
  contentInsetTop?: number;
}) {
  const { t } = useTranslation();
  const offlineMode = offlineModeStore((s) => s.offlineMode);

  const emptyProps: EmptyProps = offlineMode
    ? {
        emptyIcon: 'cloud-offline-outline',
        emptyMessage: t('noDownloadedPlaylists'),
        emptySubtitle: t('noDownloadedPlaylistsSubtitle'),
      }
    : {};

  return (
    <View style={styles.container}>
      {downloadedOnly ? (
        <FilteredPlaylistList
          layout={layout}
          contentInsetTop={contentInsetTop}
          emptyProps={emptyProps}
        />
      ) : (
        <KeysetPlaylistList
          layout={layout}
          contentInsetTop={contentInsetTop}
          emptyProps={emptyProps}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
