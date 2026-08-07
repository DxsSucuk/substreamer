import { useIsFocused } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useTranslation } from 'react-i18next';

import { DownloadButton } from '../components/DownloadButton';
import { EmptyState } from '../components/EmptyState';
import { SegmentControl } from '../components/SegmentControl';
import { StarredAlbumList } from '../components/StarredAlbumList';
import { StarredArtistList } from '../components/StarredArtistList';
import { StarredSongList } from '../components/StarredSongList';
import { useTheme } from '../hooks/useTheme';
import { shuffleArray } from '../utils/arrayHelpers';
import { formatCompactDuration } from '../utils/formatters';
import { playTrack } from '../services/playerService';
import { onPullToRefresh } from '../services/dataSyncService';
import {
  STARRED_SONGS_ITEM_ID,
  enqueueStarredSongsDownload,
  deleteStarredSongsDownload,
} from '../services/musicCacheService';
import { listAllStarredSongs, starredSongTotals } from '../db/repository/favorites';
import { isItemDownloaded } from '../db/repository/downloads';
import { getDb } from '../store/persistence/db';
import { filterBarStore } from '../store/filterBarStore';
import { offlineModeStore } from '../store/offlineModeStore';
import {
  layoutPreferencesStore,
  type ItemLayout,
} from '../store/layoutPreferencesStore';
import { favoritesStore } from '../store/favoritesStore';
import { musicCacheStore } from '../store/musicCacheStore';
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

  /* ---- Store: favorites membership (the lists themselves read SQL) ---- */
  const loading = favoritesStore((s) => s.loading);
  const error = favoritesStore((s) => s.error);
  const version = favoritesStore((s) => s.version);
  const hydrated = favoritesStore((s) => s.hydrated);

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

  /* ---- Auto-fetch on mount (after the SQL read lands) ---- */
  // Gate the empty-check on `hydrated` so a user with favourites in SQL isn't
  // re-fetched before the membership sets are read.
  const fetchedRef = useRef(false);
  useEffect(() => {
    if (!hydrated || fetchedRef.current) return;
    const s = favoritesStore.getState();
    if (s.songIds.size === 0 && s.albumIds.size === 0 && s.artistIds.size === 0 && !s.loading) {
      fetchedRef.current = true;
      void s.fetchStarred();
    }
  }, [hydrated]);

  /* ---- Filter state ---- */
  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const downloadedOnly = filterBarStore((s) => s.downloadedOnly);
  const includePartial = layoutPreferencesStore((s) => s.includePartialInDownloadedFilter);
  // `revision` is the download tables' change signal: the probe below is SQL, and SQL has
  // no Zustand subscription, so without it downloading (or deleting) the starred aggregate
  // never reaches this screen.
  const revision = musicCacheStore((s) => s.revision);

  // Is the `__starred__` aggregate itself downloaded? `null` means NOT YET KNOWN — a third
  // state, distinct from "known absent", because the answer decides whether the songs
  // segment renders at all, whether its list is filtered, and which empty-state copy it
  // shows, and each of those is wrong for a frame if unknown is collapsed into `false`.
  // A re-read deliberately keeps the previous answer rather than reverting to `null` —
  // the same trade `search.tsx` makes.
  const [starredSongsDownloaded, setStarredSongsDownloaded] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const db = getDb();
      const downloaded = db ? await isItemDownloaded(db, STARRED_SONGS_ITEM_ID) : false;
      if (alive) setStarredSongsDownloaded(downloaded);
    })();
    return () => {
      alive = false;
    };
  }, [revision]);
  const starredDownloadedUnknown = starredSongsDownloaded === null;

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

  // The songs segment keeps the pre-existing quirk that its downloaded filter also
  // requires the `__starred__` aggregate to exist; albums/artists never had that gate.
  //
  // The unknown state resolves DIFFERENTLY per line, and each direction is the safe one:
  //  - the FILTER treats unknown as downloaded, so the list stays filtered. Falling through
  //    unfiltered would flash music that is not on the device — the one failure a Downloaded
  //    filter must not have.
  //  - SUPPRESSION and the OFFLINE COPY treat unknown as "not yet"; both replace the whole
  //    segment with an empty state, and rendering "download your favourites" over a list
  //    that is about to appear is the opposite mistake.
  const songsDownloadedOnly = downloadedOnly && starredSongsDownloaded !== false;
  const songsSuppressed = downloadedOnly && starredSongsDownloaded === false;
  // Empty-state copy, three states, most specific first:
  //  1. offline with the aggregate missing → "download your favourites" (explains the
  //     mode, not the chip, so it outranks the generic filter message);
  //  2. the Downloaded chip on → the list was emptied BY THE FILTER, not because the
  //     user has starred nothing. `downloadedOnly` is the only filter consulted: the
  //     Favourites chip is hidden on this route (`FilterBar`) and the starred lists
  //     never apply it, so a value left over from the Library tab must not count;
  //  3. otherwise → the plain "star some songs" hint.
  const songsOfflineEmpty = starredSongsDownloaded === false && offlineMode;
  const songsEmptyMessage = songsOfflineEmpty
    ? t('notAvailableOffline')
    : downloadedOnly
      ? t('noMatchesForFilters')
      : t('noFavoriteSongsYet');
  const songsEmptySubtitle = songsOfflineEmpty
    ? t('downloadFavoriteSongsOffline')
    : downloadedOnly
      ? t('tryAdjustingFilters')
      : t('starSongsHint');
  const songsEmptyIcon = songsOfflineEmpty ? 'cloud-offline-outline' : 'heart-outline';

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

  // Count + duration as two SQL aggregates over the favourites set — never a whole-set
  // read, and never a JSON parse of the remainder (`favorite_songs.duration` is a
  // column for exactly this).
  const [totals, setTotals] = useState({ count: 0, duration: 0 });
  useEffect(() => {
    let alive = true;
    void (async () => {
      const db = getDb();
      if (!db || songsSuppressed) {
        if (alive) setTotals({ count: 0, duration: 0 });
        return;
      }
      const t = await starredSongTotals(db, {
        downloadedOnly: songsDownloadedOnly,
        includePartial,
      });
      if (alive) setTotals(t);
    })();
    return () => {
      alive = false;
    };
  }, [songsDownloadedOnly, songsSuppressed, includePartial, revision, version]);

  // Play All / Shuffle All / tap-to-play all queue the WHOLE favourites list, fetched
  // at press time — the player queue is `Child[]` by construction.
  const playAll = useCallback(
    (shuffle: boolean) => {
      void (async () => {
        const db = getDb();
        if (!db) return;
        const list = await listAllStarredSongs(db, {
          downloadedOnly: songsDownloadedOnly,
          includePartial,
        });
        if (list.length === 0) return;
        const queue = shuffle ? shuffleArray(list) : list;
        void playTrack(queue[0], queue);
      })();
    },
    [songsDownloadedOnly, includePartial],
  );

  const songsActionBar = useMemo(() => {
    if (totals.count === 0) return null;
    return (
      <View style={styles.actionBar}>
        {(!offlineMode || starredSongsDownloaded === true) && (
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
              {t('songCount', { count: totals.count })}
            </Text>
          </View>
          <View style={styles.metaLine}>
            <Ionicons name="time-outline" size={14} color={colors.primary} />
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>
              {formatCompactDuration(totals.duration)}
            </Text>
          </View>
        </View>
        <View style={styles.actionButtons}>
          {totals.count > 1 && (
            <Pressable
              onPress={() => playAll(true)}
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
            onPress={() => playAll(false)}
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
  }, [totals, playAll, colors, t, offlineMode, starredSongsDownloaded, handleDownloadStarred, handleDeleteStarred]);

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {activeSegment === 'songs' && (
          songsSuppressed ? (
            <View style={[styles.emptyContainer, { paddingTop: contentInsetTop }]}>
              <EmptyState
                icon={songsEmptyIcon}
                title={songsEmptyMessage}
                subtitle={songsEmptySubtitle}
              />
            </View>
          ) : (
            <StarredSongList
              layout={favSongLayout}
              downloadedOnly={songsDownloadedOnly}
              includePartial={includePartial}
              // Hold the list on `loading` until the probe answers, so an empty result can
              // never render its empty state with copy chosen from the unknown state.
              // `SongListView` only draws a spinner when the list is EMPTY, so a populated
              // list is untouched.
              loading={loading || starredDownloadedUnknown}
              error={error}
              onRefresh={handleRefresh}
              refreshing={refreshing}
              emptyMessage={songsEmptyMessage}
              emptySubtitle={songsEmptySubtitle}
              emptyIcon={songsEmptyIcon}
              contentInsetTop={contentInsetTop}
              listHeaderExtra={songsActionBar}
            />
          )
        )}
        {activeSegment === 'albums' && (
          <StarredAlbumList
            layout={favAlbumLayout}
            downloadedOnly={downloadedOnly}
            includePartial={includePartial}
            loading={loading}
            error={error}
            onRefresh={handleRefresh}
            refreshing={refreshing}
            // Same rule as the songs segment: with the Downloaded chip on, an empty list
            // means the filter emptied it, not that nothing is starred. (Artists take no
            // filter copy — Downloaded replaces that segment outright, below.)
            emptyMessage={downloadedOnly ? t('noMatchesForFilters') : t('noFavoriteAlbumsYet')}
            emptySubtitle={downloadedOnly ? t('tryAdjustingFilters') : t('starAlbumsHint')}
            emptyIcon="heart-outline"
            contentInsetTop={contentInsetTop}
          />
        )}
        {activeSegment === 'artists' && (
          // See `library.tsx` — artists aren't downloadable, so the Downloaded
          // filter hides them; only the copy depends on `offlineMode`.
          downloadedOnly ? (
            <View style={[styles.emptyContainer, { paddingTop: contentInsetTop }]}>
              <EmptyState
                icon={offlineMode ? 'cloud-offline-outline' : 'cloud-download-outline'}
                title={offlineMode ? t('notAvailableOffline') : t('artistsNotDownloadable')}
                subtitle={
                  offlineMode ? t('artistsNotAvailableOffline') : t('artistsNotDownloadableHint')
                }
              />
            </View>
          ) : (
            <StarredArtistList
              layout={favArtistLayout}
              loading={loading}
              error={error}
              onRefresh={handleRefresh}
              refreshing={refreshing}
              emptyMessage={t('noFavoriteArtistsYet')}
              emptySubtitle={t('starArtistsHint')}
              emptyIcon="heart-outline"
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
