import { useIsFocused } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '../components/EmptyState';
import { SegmentControl } from '../components/SegmentControl';
import { filterBarStore } from '../store/filterBarStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { searchStore } from '../store/searchStore';
import {
  layoutPreferencesStore,
  type ItemLayout,
} from '../store/layoutPreferencesStore';
import { AlbumLibraryListScreen } from './album-library-list';
import { ArtistListScreen } from './artist-list';
import { PlaylistListScreen } from './playlist-list';
import { SongLibraryListScreen } from './song-library-list';

type LibrarySegment = 'albums' | 'artists' | 'playlists' | 'songs';

const SEGMENT_KEYS = [
  { key: 'songs', labelKey: 'songs' },
  { key: 'albums', labelKey: 'albums' },
  { key: 'artists', labelKey: 'artists' },
  { key: 'playlists', labelKey: 'playlists' },
] as const;

/* ------------------------------------------------------------------ */
/*  LibraryScreen                                                     */
/* ------------------------------------------------------------------ */

export function LibraryScreen() {
  const { t } = useTranslation();
  const isFocused = useIsFocused();
  const headerHeight = searchStore((s) => s.headerHeight);
  const [activeSegment, setActiveSegment] = useState<LibrarySegment>('albums');

  const segments = useMemo(
    () => SEGMENT_KEYS.map((s) => ({ key: s.key, label: t(s.labelKey) })),
    [t],
  );

  const albumLayout = layoutPreferencesStore((s) => s.albumLayout);
  const artistLayout = layoutPreferencesStore((s) => s.artistLayout);
  const playlistLayout = layoutPreferencesStore((s) => s.playlistLayout);
  const songLayout = layoutPreferencesStore((s) => s.songLayout);
  const setAlbumLayout = layoutPreferencesStore((s) => s.setAlbumLayout);
  const setArtistLayout = layoutPreferencesStore((s) => s.setArtistLayout);
  const setPlaylistLayout = layoutPreferencesStore((s) => s.setPlaylistLayout);
  const setSongLayout = layoutPreferencesStore((s) => s.setSongLayout);

  const toggleAlbumLayout = useCallback(() => {
    setAlbumLayout(albumLayout === 'list' ? 'grid' : 'list');
  }, [albumLayout, setAlbumLayout]);

  const toggleArtistLayout = useCallback(() => {
    setArtistLayout(artistLayout === 'list' ? 'grid' : 'list');
  }, [artistLayout, setArtistLayout]);

  const togglePlaylistLayout = useCallback(() => {
    setPlaylistLayout(playlistLayout === 'list' ? 'grid' : 'list');
  }, [playlistLayout, setPlaylistLayout]);

  const toggleSongLayout = useCallback(() => {
    setSongLayout(songLayout === 'list' ? 'grid' : 'list');
  }, [songLayout, setSongLayout]);

  useEffect(() => {
    if (!isFocused) return;

    const layoutMap: Record<LibrarySegment, { layout: ItemLayout; toggle: () => void }> = {
      albums: { layout: albumLayout, toggle: toggleAlbumLayout },
      artists: { layout: artistLayout, toggle: toggleArtistLayout },
      playlists: { layout: playlistLayout, toggle: togglePlaylistLayout },
      songs: { layout: songLayout, toggle: toggleSongLayout },
    };

    const current = layoutMap[activeSegment];
    const store = filterBarStore.getState();
    store.setLayoutToggle({
      layout: current.layout,
      onToggle: current.toggle,
    });
    store.setDownloadButtonConfig(null);
    store.setHideDownloaded(activeSegment === 'artists');
    store.setHideFavorites(activeSegment === 'playlists');
  }, [
    isFocused,
    activeSegment,
    albumLayout,
    artistLayout,
    playlistLayout,
    songLayout,
    toggleAlbumLayout,
    toggleArtistLayout,
    togglePlaylistLayout,
    toggleSongLayout,
  ]);

  const downloadedOnly = filterBarStore((s) => s.downloadedOnly);
  const favoritesOnly = filterBarStore((s) => s.favoritesOnly);
  const offlineMode = offlineModeStore((s) => s.offlineMode);

  const segmentHeight = 52;
  const contentInsetTop = headerHeight + segmentHeight;

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {activeSegment === 'albums' && (
          <AlbumLibraryListScreen
            layout={albumLayout}
            downloadedOnly={downloadedOnly}
            favoritesOnly={favoritesOnly}
            contentInsetTop={contentInsetTop}
          />
        )}
        {activeSegment === 'artists' && (
          offlineMode ? (
            <View style={[styles.emptyContainer, { paddingTop: contentInsetTop }]}>
              <EmptyState
                icon="cloud-offline-outline"
                title={t('notAvailableOffline')}
                subtitle={t('artistsNotAvailableOffline')}
              />
            </View>
          ) : (
            <ArtistListScreen
              layout={artistLayout}
              downloadedOnly={downloadedOnly}
              favoritesOnly={favoritesOnly}
              contentInsetTop={contentInsetTop}
            />
          )
        )}
        {activeSegment === 'playlists' && (
          <PlaylistListScreen
            layout={playlistLayout}
            downloadedOnly={downloadedOnly}
            contentInsetTop={contentInsetTop}
          />
        )}
        {activeSegment === 'songs' && (
          <SongLibraryListScreen
            layout={songLayout}
            downloadedOnly={downloadedOnly}
            favoritesOnly={favoritesOnly}
            contentInsetTop={contentInsetTop}
          />
        )}
      </View>
      <View style={[styles.segmentOverlay, { top: headerHeight }]}>
        <SegmentControl segments={segments} selected={activeSegment} onSelect={setActiveSegment} />
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                            */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  segmentOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 1,
  },
});
