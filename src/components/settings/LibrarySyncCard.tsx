import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useCallback } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { useThemedAlert } from '../../hooks/useThemedAlert';
import { settingsStyles } from '../../styles/settingsStyles';
import { cancelAllSyncs, forceFullResync, resumeSync } from '../../services/dataSyncService';
import { albumLibraryStore } from '../../store/albumLibraryStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { songIndexStore } from '../../store/songIndexStore';
import { syncStatusStore } from '../../store/syncStatusStore';
import { OfflineNotice } from './OfflineNotice';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { formatShortDateTime } from '../../utils/dateFormat';
import type { IoniconsName } from '../../utils/iconNames';

export function LibrarySyncCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { confirm } = useThemedAlert();

  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const librarySize = albumLibraryStore((s) => s.albums.length);
  const libraryLastFetchedAt = syncStatusStore((s) => s.librarySyncLastFetchedAt);
  const songIndexSize = songIndexStore((s) => s.totalCount);
  const librarySyncPhase = syncStatusStore((s) => s.librarySyncPhase);
  const songSyncPhase = syncStatusStore((s) => s.detailSyncPhase);
  const librarySyncComplete = syncStatusStore((s) => s.librarySyncComplete);
  const songSyncComplete = syncStatusStore((s) => s.songSyncComplete);

  // A sync is actively running when either the album-list fetch or the song
  // fetch is in progress.
  const isSyncing = librarySyncPhase === 'fetching' || songSyncPhase === 'syncing';
  const fullyComplete = librarySyncComplete && songSyncComplete;
  // Started but neither running nor finished (e.g. paused, or interrupted).
  const isPaused = !isSyncing && !fullyComplete && librarySize > 0;
  const showSync = !isSyncing && !isPaused;

  const stageText =
    librarySyncPhase === 'fetching'
      ? t('fetchingAlbumList')
      : songSyncPhase === 'syncing'
        ? t('fetchingSongs')
        : null;

  const handleForceResync = useCallback(() => {
    if (offlineMode) return;
    confirm({
      title: t('syncLibrary'),
      message: t('syncLibraryDescription'),
      confirmLabel: t('syncNow'),
      onConfirm: () => { void forceFullResync(); },
    });
  }, [confirm, offlineMode, t]);

  const handlePause = useCallback(() => {
    cancelAllSyncs('user-cancel');
  }, []);

  const handleResume = useCallback(() => {
    if (offlineMode) return;
    void resumeSync();
  }, [offlineMode]);

  // Restart is the "unstick" recovery: cancel the in-flight sync, clear, and
  // re-run from scratch. No confirm — the user chose it during an active sync.
  const handleRestart = useCallback(() => {
    if (offlineMode) return;
    void forceFullResync();
  }, [offlineMode]);

  const secondaryButton = (
    onPress: () => void,
    icon: IoniconsName,
    label: string,
    key: string,
  ) => (
    <Pressable
      key={key}
      onPress={onPress}
      disabled={offlineMode && key !== 'pause'}
      style={({ pressed }) => [
        settingsStyles.actionRowButton,
        { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth },
        pressed && settingsStyles.pressed,
        offlineMode && key !== 'pause' && settingsStyles.disabled,
      ]}
    >
      <Ionicons name={icon} size={18} color={colors.textPrimary} />
      <Text style={[settingsStyles.actionRowButtonText, { color: colors.textPrimary }]}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('librarySync')}</SettingsSectionTitle>
      <View style={[settingsStyles.card, settingsStyles.cardPadded, { backgroundColor: colors.card }]}>
        <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
          <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('albums')}</Text>
          <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>{librarySize}</Text>
        </View>
        <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
          <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('songs')}</Text>
          <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>{songIndexSize}</Text>
        </View>
        <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
          <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('lastFetched')}</Text>
          <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
            {formatShortDateTime(libraryLastFetchedAt ? new Date(libraryLastFetchedAt) : null)}
          </Text>
        </View>

        {isSyncing && stageText != null && (
          <View style={styles.statusRow}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={[styles.statusText, { color: colors.textSecondary }]}>{stageText}</Text>
          </View>
        )}

        <View style={settingsStyles.actionRow}>
          {showSync && (
            <Pressable
              onPress={handleForceResync}
              disabled={offlineMode}
              style={({ pressed }) => [
                settingsStyles.actionRowButton,
                { backgroundColor: colors.primary },
                pressed && !offlineMode && settingsStyles.pressed,
                offlineMode && settingsStyles.disabled,
              ]}
            >
              <Ionicons name="refresh-circle-outline" size={18} color="#fff" />
              <Text style={[settingsStyles.actionRowButtonText, { color: '#fff' }]}>{t('syncLibrary')}</Text>
            </Pressable>
          )}
          {isSyncing && secondaryButton(handlePause, 'pause-circle-outline', t('pauseSync'), 'pause')}
          {isPaused && secondaryButton(handleResume, 'play-circle-outline', t('resumeSync'), 'resume')}
          {(isSyncing || isPaused) &&
            secondaryButton(handleRestart, 'refresh-circle-outline', t('restartSync'), 'restart')}
        </View>
        {offlineMode && <OfflineNotice text={t('syncLibraryOfflineNotice')} />}
        <Text style={[settingsStyles.sectionHint, { color: colors.textSecondary }]}>
          {t('syncLibraryDescription')}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
