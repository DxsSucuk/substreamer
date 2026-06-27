import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { useThemedAlert } from '../../hooks/useThemedAlert';
import { settingsStyles } from '../../styles/settingsStyles';
import { clearImageCache } from '../../services/imageCacheService';
import { clearMusicCache } from '../../services/musicCacheService';
import { clearQueue } from '../../services/playerService';
import { checkStorageLimit } from '../../services/storageService';
import { albumDetailStore } from '../../store/albumDetailStore';
import { artistDetailStore } from '../../store/artistDetailStore';
import { imageCacheStore } from '../../store/imageCacheStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import { playlistDetailStore } from '../../store/playlistDetailStore';
import { formatBytes } from '../../utils/formatters';

export function DangerousActionsCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { confirm } = useThemedAlert();
  const [expanded, setExpanded] = useState(false);
  const chevronRotation = useSharedValue(0);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevronRotation.value}deg` }],
  }));

  const totalBytes = imageCacheStore((s) => s.totalBytes);
  const musicCacheBytes = musicCacheStore((s) => s.totalBytes);
  const cachedAlbumCount = albumDetailStore((s) => Object.keys(s.albums).length);
  const cachedArtistCount = artistDetailStore((s) => Object.keys(s.artists).length);
  const cachedPlaylistCount = playlistDetailStore((s) => Object.keys(s.playlists).length);
  const totalMetadataCount = cachedAlbumCount + cachedArtistCount + cachedPlaylistCount;

  const handleToggle = useCallback(() => {
    setExpanded((prev) => {
      chevronRotation.value = withTiming(prev ? 0 : 90, { duration: 200 });
      return !prev;
    });
  }, [chevronRotation]);

  const handleClearImageCache = useCallback(() => {
    confirm({
      title: t('clearImageCache'),
      message: t('clearImageCacheMessage', { size: formatBytes(totalBytes) }),
      confirmLabel: t('clear'),
      destructive: true,
      onConfirm: async () => {
        await clearImageCache();
        checkStorageLimit();
      },
    });
  }, [confirm, t, totalBytes]);

  const handleClearMusicCache = useCallback(() => {
    confirm({
      title: t('clearDownloadedMusic'),
      message: t('clearDownloadedMusicMessage', { size: formatBytes(musicCacheBytes) }),
      confirmLabel: t('clear'),
      destructive: true,
      onConfirm: async () => {
        await clearQueue();
        await clearMusicCache();
        checkStorageLimit();
      },
    });
  }, [confirm, t, musicCacheBytes]);

  const handleClearMetadataCache = useCallback(() => {
    confirm({
      title: t('clearMetadataCache'),
      message: t('clearMetadataCacheMessage', { count: totalMetadataCount }),
      confirmLabel: t('clear'),
      destructive: true,
      onConfirm: () => {
        albumDetailStore.getState().clearAlbums();
        artistDetailStore.getState().clearArtists();
        playlistDetailStore.getState().clearPlaylists();
      },
    });
  }, [confirm, t, totalMetadataCount]);

  const handleClearAll = useCallback(() => {
    confirm({
      title: t('clearAllData'),
      message: t('clearAllDataMessage'),
      confirmLabel: t('clearEverything'),
      destructive: true,
      onConfirm: async () => {
        await clearQueue();
        await clearMusicCache();
        await clearImageCache();
        albumDetailStore.getState().clearAlbums();
        artistDetailStore.getState().clearArtists();
        playlistDetailStore.getState().clearPlaylists();
        checkStorageLimit();
      },
    });
  }, [confirm, t]);

  return (
    <View style={settingsStyles.section}>
      <Pressable
        onPress={handleToggle}
        style={({ pressed }) => [styles.header, pressed && settingsStyles.pressed]}
      >
        <Text style={[settingsStyles.sectionTitle, styles.title, { color: colors.red }]}>
          {t('dangerous')}
        </Text>
        <Animated.View style={chevronStyle}>
          <Ionicons name="chevron-forward" size={16} color={colors.red} />
        </Animated.View>
      </Pressable>
      {expanded && (
        <View style={[settingsStyles.card, settingsStyles.cardPadded, { backgroundColor: colors.card }]}>
          <Pressable
            onPress={handleClearImageCache}
            style={({ pressed }) => [
              styles.button,
              { borderColor: colors.red },
              pressed && settingsStyles.pressed,
            ]}
          >
            <Ionicons name="warning" size={18} color={colors.red} />
            <Text style={[styles.buttonText, { color: colors.red }]}>{t('clearImageCache')}</Text>
          </Pressable>
          <Pressable
            onPress={handleClearMusicCache}
            style={({ pressed }) => [
              styles.button,
              { borderColor: colors.red },
              pressed && settingsStyles.pressed,
            ]}
          >
            <Ionicons name="warning" size={18} color={colors.red} />
            <Text style={[styles.buttonText, { color: colors.red }]}>{t('clearDownloadedMusic')}</Text>
          </Pressable>
          <Pressable
            onPress={handleClearMetadataCache}
            style={({ pressed }) => [
              styles.button,
              { borderColor: colors.red },
              pressed && settingsStyles.pressed,
            ]}
          >
            <Ionicons name="warning" size={18} color={colors.red} />
            <Text style={[styles.buttonText, { color: colors.red }]}>{t('clearMetadataCache')}</Text>
          </Pressable>
          <Pressable
            onPress={handleClearAll}
            style={({ pressed }) => [
              styles.button,
              { borderColor: colors.red },
              pressed && settingsStyles.pressed,
            ]}
          >
            <Ionicons name="warning" size={18} color={colors.red} />
            <Text style={[styles.buttonText, { color: colors.red }]}>{t('clearAllData')}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  title: { marginBottom: 0, marginLeft: 0 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 8,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
