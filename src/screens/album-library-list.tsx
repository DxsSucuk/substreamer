import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AlbumListView, type AlbumLayout } from '../components/AlbumListView';
import { onPullToRefresh } from '../services/dataSyncService';
import { albumLibraryStore } from '../store/albumLibraryStore';
import { favoritesStore } from '../store/favoritesStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { albumPassesDownloadedFilter } from '../store/persistence/cachedItemHelpers';

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
  const albums = albumLibraryStore((s) => s.albums);
  const loading = albumLibraryStore((s) => s.loading);
  const error = albumLibraryStore((s) => s.error);
  const hasHydrated = albumLibraryStore((s) => s.hasHydrated);

  const cachedItems = musicCacheStore((s) => s.cachedItems);
  const starredAlbums = favoritesStore((s) => s.albums);
  const includePartial = layoutPreferencesStore((s) => s.includePartialInDownloadedFilter);

  // Fetch only once the row-backed store has hydrated, so an async-hydration
  // empty window can't trigger a spurious full-library fetch when the
  // `library_albums` rows exist. Fallback trigger only — the primary fetch is
  // driven by dataSyncService's startup gate; `fetchAllAlbums` dedups via its
  // own `loading` guard.
  useEffect(() => {
    if (!hasHydrated) return;
    const s = albumLibraryStore.getState();
    if (s.albums.length === 0 && !s.loading) void s.fetchAllAlbums();
  }, [hasHydrated]);

  const filteredAlbums = useMemo(() => {
    if (!downloadedOnly && !favoritesOnly) return albums;

    const starredIds = favoritesOnly
      ? new Set(starredAlbums.map((a) => a.id))
      : null;

    return albums.filter((album) => {
      if (downloadedOnly && !albumPassesDownloadedFilter(album, cachedItems, includePartial)) {
        return false;
      }
      if (starredIds && !starredIds.has(album.id)) return false;
      return true;
    });
  }, [albums, downloadedOnly, favoritesOnly, cachedItems, starredAlbums, includePartial]);

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
    <View style={styles.container}>
      <AlbumListView
        albums={filteredAlbums}
        layout={layout}
        loading={loading}
        error={error}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        showAlphabetScroller
        scrollToTopTrigger={`${downloadedOnly}:${favoritesOnly}`}
        contentInsetTop={contentInsetTop}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
