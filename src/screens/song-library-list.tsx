import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SongListView, type SongLayout } from '../components/SongListView';
import { useAllSongsByTitle } from '../hooks/useAllSongsByTitle';
import { playTrack } from '../services/playerService';
import { songIndexStore } from '../store/songIndexStore';
import type { Child } from '../services/subsonicService';

export function SongLibraryListScreen({
  layout = 'list',
  downloadedOnly = false,
  favoritesOnly = false,
  contentInsetTop = 0,
}: {
  layout?: SongLayout;
  downloadedOnly?: boolean;
  favoritesOnly?: boolean;
  contentInsetTop?: number;
}) {
  const { t } = useTranslation();
  const { songs, refresh } = useAllSongsByTitle({
    downloadedOnly,
    favoritesOnly,
  });
  const hasHydrated = songIndexStore((s) => s.hasHydrated);

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const handleSongPress = useCallback((song: Child) => {
    playTrack(song, [song]);
  }, []);

  const emptyMessage = downloadedOnly
    ? t('noDownloadedSongs')
    : favoritesOnly
      ? t('noFavoriteSongs')
      : t('noSongsFound');
  const emptySubtitle = downloadedOnly || favoritesOnly
    ? t('tryAdjustingFilters')
    : t('songLibraryEmptyHint');

  return (
    <View style={styles.container}>
      <SongListView
        songs={songs}
        layout={layout}
        loading={!hasHydrated}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        onSongPress={handleSongPress}
        showAlphabetScroller
        scrollToTopTrigger={`${downloadedOnly}:${favoritesOnly}`}
        contentInsetTop={contentInsetTop}
        emptyMessage={emptyMessage}
        emptySubtitle={emptySubtitle}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
