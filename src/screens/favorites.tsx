import { useIsFocused } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useTranslation } from 'react-i18next';

import { AlbumListView } from '../components/AlbumListView';
import { DownloadButton } from '../components/DownloadButton';
import { EmptyState } from '../components/EmptyState';
import { ArtistListView } from '../components/ArtistListView';
import { SegmentControl } from '../components/SegmentControl';
import { SongListView } from '../components/SongListView';
import { useTheme } from '../hooks/useTheme';
import { shuffleArray } from '../utils/arrayHelpers';
import { formatCompactDuration } from '../utils/formatters';
import { playTrack } from '../services/playerService';
import { onPullToRefresh } from '../services/dataSyncService';
import {
  STARRED_SONGS_ITEM_ID,
  enqueueStarredSongsDownload,
  deleteStarredSongsDownload,
  getLocalTrackUri,
} from '../services/musicCacheService';
import { filterBarStore } from '../store/filterBarStore';
import { offlineModeStore } from '../store/offlineModeStore';
import {
  layoutPreferencesStore,
  type ItemLayout,
} from '../store/layoutPreferencesStore';
import { favoritesStore } from '../store/favoritesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { albumPassesDownloadedFilter } from '../store/persistence/cachedItemHelpers';
import { searchStore } from '../store/searchStore';

type FavoritesSegment = 'songs' | 'albums' | 'artists';

const SEGMENT_KEYS = [
  { key: 'songs', labelKey: 'songs' },
  { key: 'albums', labelKey: 'albums' },
  { key: 'artists', labelKey: 'artists' },
] as const;

/* ------------------------------------------------------------------ */
/*  FavoritesScreen                                                   */
/* ------------------------------------------------------------------ */

export function FavoritesScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const isFocused = useIsFocused();
  const headerHeight = searchStore((s) => s.headerHeight);
  const [activeSegment, setActiveSegment] = useState<FavoritesSegment>('songs');

  const segments = useMemo(
    () => SEGMENT_KEYS.map((s) => ({ key: s.key, label: t(s.labelKey) })),
    [t],
  );

  /* ---- Store: favorites data ---- */
  const songs = favoritesStore((s) => s.songs);
  const albums = favoritesStore((s) => s.albums);
  const artists = favoritesStore((s) => s.artists);
  const loading = favoritesStore((s) => s.loading);
  const error = favoritesStore((s) => s.error);
  const fetchStarred = favoritesStore((s) => s.fetchStarred);

  /* ---- Store: layout preferences ---- */
  const favSongLayout = layoutPreferencesStore((s) => s.favSongLayout);
  const favAlbumLayout = layoutPreferencesStore((s) => s.favAlbumLayout);
  const favArtistLayout = layoutPreferencesStore((s) => s.favArtistLayout);
  const setFavSongLayout = layoutPreferencesStore((s) => s.setFavSongLayout);
  const setFavAlbumLayout = layoutPreferencesStore((s) => s.setFavAlbumLayout);
  const setFavArtistLayout = layoutPreferencesStore((s) => s.setFavArtistLayout);

  const toggleSongLayout = useCallback(() => {
    setFavSongLayout(favSongLayout === 'list' ? 'grid' : 'list');
  }, [favSongLayout, setFavSongLayout]);

  const toggleAlbumLayout = useCallback(() => {
    setFavAlbumLayout(favAlbumLayout === 'list' ? 'grid' : 'list');
  }, [favAlbumLayout, setFavAlbumLayout]);

  const toggleArtistLayout = useCallback(() => {
    setFavArtistLayout(favArtistLayout === 'list' ? 'grid' : 'list');
  }, [favArtistLayout, setFavArtistLayout]);

  /* ---- Auto-fetch on mount ---- */
  useEffect(() => {
    if (songs.length === 0 && albums.length === 0 && artists.length === 0 && !loading) {
      fetchStarred();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- Filter state ---- */
  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const downloadedOnly = filterBarStore((s) => s.downloadedOnly);
  const cachedItems = musicCacheStore((s) => s.cachedItems);
  const includePartial = layoutPreferencesStore((s) => s.includePartialInDownloadedFilter);
  const starredSongsDownloaded = STARRED_SONGS_ITEM_ID in cachedItems;

  /* ---- Configure filter bar ---- */
  const handleDownloadStarred = useCallback(() => {
    enqueueStarredSongsDownload();
  }, []);

  const handleDeleteStarred = useCallback(() => {
    deleteStarredSongsDownload();
  }, []);

  useEffect(() => {
    if (!isFocused) return;

    const layoutMap: Record<FavoritesSegment, { layout: ItemLayout; toggle: () => void }> = {
      songs: { layout: favSongLayout, toggle: toggleSongLayout },
      albums: { layout: favAlbumLayout, toggle: toggleAlbumLayout },
      artists: { layout: favArtistLayout, toggle: toggleArtistLayout },
    };

    const current = layoutMap[activeSegment];
    const store = filterBarStore.getState();
    store.setLayoutToggle({
      layout: current.layout,
      onToggle: current.toggle,
    });
    store.setHideDownloaded(activeSegment === 'artists');
    store.setHideFavorites(false);
    store.setDownloadButtonConfig(null);
  }, [
    isFocused,
    activeSegment,
    favSongLayout,
    favAlbumLayout,
    favArtistLayout,
    toggleSongLayout,
    toggleAlbumLayout,
    toggleArtistLayout,
  ]);

  const filteredSongs = useMemo(() => {
    if (!downloadedOnly) return songs;
    if (!starredSongsDownloaded) return [];
    return songs.filter((s) => getLocalTrackUri(s.id) !== null);
  }, [songs, downloadedOnly, starredSongsDownloaded, cachedItems]);

  const filteredAlbums = useMemo(() => {
    if (!downloadedOnly) return albums;
    return albums.filter((a) => albumPassesDownloadedFilter(a, cachedItems, includePartial));
  }, [albums, downloadedOnly, cachedItems, includePartial]);

  const filteredArtists = useMemo(() => {
    if (!downloadedOnly) return artists;
    const downloadedArtistIds = new Set<string>();
    for (const album of albums) {
      if (albumPassesDownloadedFilter(album, cachedItems, includePartial) && album.artistId) {
        downloadedArtistIds.add(album.artistId);
      }
    }
    return artists.filter((a) => downloadedArtistIds.has(a.id));
  }, [artists, albums, downloadedOnly, cachedItems, includePartial]);

  /* ---- Pull-to-refresh ---- */
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await onPullToRefresh('favorites');
    } finally {
      setRefreshing(false);
    }
  }, []);

  const segmentHeight = 52;
  const contentInsetTop = headerHeight + segmentHeight;

  const totalDuration = useMemo(
    () => filteredSongs.reduce((sum, s) => sum + (s.duration ?? 0), 0),
    [filteredSongs],
  );

  const songsActionBar = useMemo(() => {
    if (filteredSongs.length === 0) return null;
    return (
      <View style={styles.actionBar}>
        {(!offlineMode || starredSongsDownloaded) && (
          <DownloadButton
            itemId={STARRED_SONGS_ITEM_ID}
            type="playlist"
            size={30}
            onDownload={handleDownloadStarred}
            onDelete={handleDeleteStarred}
          />
        )}
        <View style={styles.meta}>
          <View style={styles.metaLine}>
            <Ionicons name="musical-notes-outline" size={14} color={colors.primary} />
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>
              {t('songCount', { count: filteredSongs.length })}
            </Text>
          </View>
          <View style={styles.metaLine}>
            <Ionicons name="time-outline" size={14} color={colors.primary} />
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>
              {formatCompactDuration(totalDuration)}
            </Text>
          </View>
        </View>
        <View style={styles.actionButtons}>
          {filteredSongs.length > 1 && (
            <Pressable
              onPress={() => {
                const shuffled = shuffleArray(filteredSongs);
                playTrack(shuffled[0], shuffled);
              }}
              style={({ pressed }) => [
                styles.shufflePlayButton,
                pressed && styles.buttonPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('shufflePlay')}
            >
              <Ionicons name="shuffle" size={18} color="#000" />
            </Pressable>
          )}
          <Pressable
            onPress={() => playTrack(filteredSongs[0], filteredSongs)}
            style={({ pressed }) => [
              styles.playAllButton,
              { backgroundColor: colors.primary },
              pressed && styles.buttonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={t('playAll')}
          >
            <Ionicons name="play" size={28} color="#fff" style={styles.playAllIcon} />
          </Pressable>
        </View>
      </View>
    );
  }, [filteredSongs, totalDuration, colors, offlineMode, starredSongsDownloaded, handleDownloadStarred, handleDeleteStarred]);

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {activeSegment === 'songs' && (
          <SongListView
            songs={filteredSongs}
            layout={favSongLayout}
            loading={loading}
            error={error}
            onRefresh={handleRefresh}
            refreshing={refreshing}
            emptyMessage={starredSongsDownloaded === false && offlineMode
              ? t('notAvailableOffline')
              : t('noFavoriteSongsYet')}
            emptySubtitle={starredSongsDownloaded === false && offlineMode
              ? t('downloadFavoriteSongsOffline')
              : t('starSongsHint')}
            emptyIcon={starredSongsDownloaded === false && offlineMode
              ? 'cloud-offline-outline'
              : 'heart-outline'}
            scrollToTopTrigger={`${downloadedOnly}`}
            contentInsetTop={contentInsetTop}
            listHeaderExtra={songsActionBar}
          />
        )}
        {activeSegment === 'albums' && (
          <AlbumListView
            albums={filteredAlbums}
            layout={favAlbumLayout}
            loading={loading}
            error={error}
            onRefresh={handleRefresh}
            refreshing={refreshing}
            emptyMessage={t('noFavoriteAlbumsYet')}
            emptySubtitle={t('starAlbumsHint')}
            emptyIcon="heart-outline"
            scrollToTopTrigger={`${downloadedOnly}`}
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
            <ArtistListView
              artists={filteredArtists}
              layout={favArtistLayout}
              loading={loading}
              error={error}
              onRefresh={handleRefresh}
              refreshing={refreshing}
              emptyMessage={t('noFavoriteArtistsYet')}
              emptySubtitle={t('starArtistsHint')}
              emptyIcon="heart-outline"
              scrollToTopTrigger={`${downloadedOnly}`}
              contentInsetTop={contentInsetTop}
            />
          )
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
  actionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: -8,
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  meta: {
    flex: 1,
    gap: 4,
  },
  metaLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaText: {
    fontSize: 14,
    marginLeft: 4,
  },
  actionButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  shufflePlayButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  playAllButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playAllIcon: {
    marginLeft: 3,
  },
  buttonPressed: {
    opacity: 0.7,
  },
});
