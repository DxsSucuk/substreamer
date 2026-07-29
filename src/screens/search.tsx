import { useRouter } from 'expo-router';
import { useIsFocused } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { AlbumRow } from '../components/AlbumRow';
import { EmptyState } from '../components/EmptyState';
import { ArtistRow } from '../components/ArtistRow';
import { RecentSearches } from '../components/RecentSearches';
import { SongRow } from '../components/SongRow';
import { useTheme } from '../hooks/useTheme';
import { getLocalTrackUri } from '../services/musicCacheService';
import { playTrack } from '../services/playerService';
import { minDelay } from '../utils/stringHelpers';
import {
  type AlbumID3,
  type ArtistID3,
  type Child,
} from '../services/subsonicService';
import { favoritesStore } from '../store/favoritesStore';
import { filterBarStore } from '../store/filterBarStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { albumPassesDownloadedFilter } from '../store/persistence/cachedItemHelpers';
import { offlineModeStore } from '../store/offlineModeStore';
import { recentSearchStore } from '../store/recentSearchStore';
import { searchStore } from '../store/searchStore';

/* ------------------------------------------------------------------ */
/*  Section data types                                                */
/* ------------------------------------------------------------------ */

type SectionItem =
  | { type: 'artist'; data: ArtistID3 }
  | { type: 'album'; data: AlbumID3 }
  | { type: 'song'; data: Child };

interface ResultSection {
  titleKey: string;
  data: SectionItem[];
}

/* ------------------------------------------------------------------ */
/*  SearchScreen                                                      */
/* ------------------------------------------------------------------ */

export function SearchScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const isFocused = useIsFocused();
  const headerHeight = searchStore((s) => s.headerHeight);
  const recentSearches = recentSearchStore((s) => s.recentSearches);

  const query = searchStore((s) => s.query);
  const results = searchStore((s) => s.results);
  const loading = searchStore((s) => s.loading);
  const performSearch = searchStore((s) => s.performSearch);
  const offlineMode = offlineModeStore((s) => s.offlineMode);

  useEffect(() => {
    if (!isFocused) return;
    const store = filterBarStore.getState();
    store.setLayoutToggle(null);
    store.setDownloadButtonConfig(null);
    store.setHideDownloaded(false);
    store.setHideFavorites(false);
  }, [isFocused]);

  // Re-run the active search when offline/online mode flips. `searchLibrary` routes
  // on the mode (offline = downloaded-only, no artists; online = full library +
  // server), so a stale result set from the other mode must be replaced without the
  // user having to re-type. Skip the mount pass (didModeMount) and empty queries.
  const didModeMount = useRef(false);
  useEffect(() => {
    if (!didModeMount.current) {
      didModeMount.current = true;
      return;
    }
    if (searchStore.getState().query.trim()) void performSearch();
  }, [offlineMode, performSearch]);

  const downloadedOnly = filterBarStore((s) => s.downloadedOnly);
  const favoritesOnly = filterBarStore((s) => s.favoritesOnly);
  const cachedItems = musicCacheStore((s) => s.cachedItems);
  const includePartial = layoutPreferencesStore((s) => s.includePartialInDownloadedFilter);
  const starredSongs = favoritesStore((s) => s.songs);
  const starredAlbums = favoritesStore((s) => s.albums);
  const starredArtists = favoritesStore((s) => s.artists);

  const filtered = useMemo(() => {
    let artists = results.artists;
    let albums = results.albums;
    let songs = results.songs;

    if (downloadedOnly) {
      albums = albums.filter((a) => albumPassesDownloadedFilter(a, cachedItems, includePartial));
      songs = songs.filter((s) => getLocalTrackUri(s.id) !== null);
      const downloadedArtistIds = new Set<string>();
      for (const album of albums) {
        if (album.artistId) downloadedArtistIds.add(album.artistId);
      }
      artists = artists.filter((a) => downloadedArtistIds.has(a.id));
    }

    if (favoritesOnly) {
      const starredSongIds = new Set(starredSongs.map((s) => s.id));
      const starredAlbumIds = new Set(starredAlbums.map((a) => a.id));
      const starredArtistIds = new Set(starredArtists.map((a) => a.id));
      artists = artists.filter((a) => starredArtistIds.has(a.id));
      albums = albums.filter((a) => starredAlbumIds.has(a.id));
      songs = songs.filter((s) => starredSongIds.has(s.id));
    }

    return { artists, albums, songs };
  }, [
    results,
    downloadedOnly,
    favoritesOnly,
    cachedItems,
    includePartial,
    starredSongs,
    starredAlbums,
    starredArtists,
  ]);

  const hasResults =
    filtered.artists.length > 0 ||
    filtered.albums.length > 0 ||
    filtered.songs.length > 0;

  const sections: ResultSection[] = useMemo(() => {
    const result: ResultSection[] = [];
    if (filtered.artists.length > 0) {
      result.push({
        titleKey: 'artists',
        data: filtered.artists.map((a) => ({ type: 'artist' as const, data: a })),
      });
    }
    if (filtered.albums.length > 0) {
      result.push({
        titleKey: 'albums',
        data: filtered.albums.map((a) => ({ type: 'album' as const, data: a })),
      });
    }
    if (filtered.songs.length > 0) {
      result.push({
        titleKey: 'songs',
        data: filtered.songs.map((s) => ({ type: 'song' as const, data: s })),
      });
    }
    return result;
  }, [filtered]);

  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (!query.trim()) return;
    setRefreshing(true);
    const delay = minDelay();
    await performSearch();
    await delay;
    setRefreshing(false);
  }, [query, performSearch]);

  const renderItem = useCallback(
    ({ item }: { item: SectionItem }) => {
      // Tapping a result is the "this search led somewhere" signal — record the
      // live query (read lazily so these closures don't churn per keystroke),
      // then perform the row's normal action.
      const recordCurrent = () =>
        recentSearchStore.getState().record(searchStore.getState().query);
      switch (item.type) {
        case 'artist':
          return (
            <ArtistRow
              artist={item.data}
              onPress={() => {
                recordCurrent();
                router.push(`/artist/${item.data.id}`);
              }}
            />
          );
        case 'album':
          return (
            <AlbumRow
              album={item.data}
              onPress={() => {
                recordCurrent();
                router.push(`/album/${item.data.id}`);
              }}
            />
          );
        case 'song':
          return (
            <SongRow
              song={item.data}
              onPress={() => {
                recordCurrent();
                playTrack(item.data, [item.data]);
              }}
            />
          );
      }
    },
    [router]
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: ResultSection }) => (
      <Text style={[styles.sectionTitle, { color: colors.label }]}>
        {t(section.titleKey)}
      </Text>
    ),
    [colors.label, t]
  );

  const keyExtractor = useCallback(
    (item: SectionItem, index: number) => `${item.type}-${item.data.id}-${index}`,
    []
  );

  // Empty box: show recent-searches history when present, otherwise the
  // original placeholder (offline-aware).
  if (!query.trim()) {
    if (recentSearches.length > 0) {
      return <RecentSearches paddingTop={headerHeight} />;
    }
    return (
      <View style={[styles.container, { paddingTop: headerHeight }]}>
        <EmptyState
          icon="search-outline"
          title={offlineMode ? t('searchDownloadedMusic') : t('searchForMusic')}
          subtitle={offlineMode ? t('findDownloadedMusic') : t('findMusic')}
        />
      </View>
    );
  }

  // Query present, a search/refresh in flight with nothing to show yet — a spinner
  // instead of a blank screen (covers the first search AND an offline↔online switch
  // that has no prior results). Was: blank until results popped in.
  if (loading && !hasResults) {
    return (
      <View style={[styles.container, { paddingTop: headerHeight }]}>
        <View style={styles.loadingCentered}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
            {t('searching')}
          </Text>
        </View>
      </View>
    );
  }

  // Query present, no results, not mid-search: no-results placeholder.
  if (!hasResults && !loading) {
    return (
      <View style={[styles.container, { paddingTop: headerHeight }]}>
        <EmptyState
          icon="search-outline"
          title={t('noResultsFound')}
          subtitle={t('noResultsFor', { query })}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* A refresh in flight while previous results stay visible — e.g. flipping
          offline↔online, or a new keystroke. A top strip so the user sees the
          results are being updated rather than the screen sitting silently. */}
      {loading && (
        <View
          style={[
            styles.loadingStrip,
            {
              top: headerHeight,
              backgroundColor: colors.background,
              borderBottomColor: colors.border,
            },
          ]}
        >
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.loadingStripText, { color: colors.textSecondary }]}>
            {t('searching')}
          </Text>
        </View>
      )}
      <SectionList
        sections={sections}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        keyExtractor={keyExtractor}
        contentContainerStyle={[styles.listContent, { paddingTop: headerHeight + 16 }]}
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      />
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
  listContent: {
    padding: 16,
    paddingBottom: 32,
  },
  loadingCentered: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadingText: {
    fontSize: 14,
  },
  loadingStrip: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  loadingStripText: {
    fontSize: 13,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 16,
    marginLeft: 4,
  },
});
