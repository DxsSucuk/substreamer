import Ionicons from '@react-native-vector-icons/ionicons/static';
import i18next from 'i18next';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { useThemedAlert } from '../../hooks/useThemedAlert';
import { settingsStyles } from '../../styles/settingsStyles';
import { cancelAllSyncs, forceFullResync, runFullAlbumDetailSync } from '../../services/dataSyncService';
import { albumDetailStore } from '../../store/albumDetailStore';
import { albumLibraryStore } from '../../store/albumLibraryStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { songIndexStore } from '../../store/songIndexStore';
import { syncStatusStore } from '../../store/syncStatusStore';
import { OfflineNotice } from './OfflineNotice';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { formatShortDateTime } from '../../utils/dateFormat';

export function LibrarySyncCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { confirm } = useThemedAlert();

  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const librarySize = albumLibraryStore((s) => s.albums.length);
  const libraryLastFetchedAt = albumLibraryStore((s) => s.lastFetchedAt);
  const detailCacheSize = albumDetailStore((s) => Object.keys(s.albums).length);
  const songIndexSize = songIndexStore((s) => s.totalCount);
  const syncPhase = syncStatusStore((s) => s.detailSyncPhase);

  const handleForceResync = useCallback(() => {
    if (offlineMode) return;
    confirm({
      title: t('syncLibrary'),
      message: t('syncLibraryDescription'),
      confirmLabel: t('syncNow'),
      onConfirm: () => { void forceFullResync(); },
    });
  }, [confirm, offlineMode, t]);

  const handleCancelRunningSync = useCallback(() => {
    cancelAllSyncs('user-cancel');
  }, []);

  const handleResumeSync = useCallback(() => {
    if (offlineMode) return;
    void runFullAlbumDetailSync();
  }, [offlineMode]);

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('librarySync')}</SettingsSectionTitle>
      <View style={[settingsStyles.card, settingsStyles.cardPadded, { backgroundColor: colors.card }]}>
        <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
          <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('syncedAlbums')}</Text>
          <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
            {detailCacheSize} / {librarySize}
          </Text>
        </View>
        <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
          <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('syncedSongs')}</Text>
          <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>{songIndexSize}</Text>
        </View>
        <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
          <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('pendingSync')}</Text>
          <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
            {Math.max(0, librarySize - detailCacheSize)}
          </Text>
        </View>
        <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
          <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('lastFetched')}</Text>
          <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
            {formatShortDateTime(libraryLastFetchedAt ? new Date(libraryLastFetchedAt) : null)}
          </Text>
        </View>
        <View style={settingsStyles.actionRow}>
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
            <Text style={[settingsStyles.actionRowButtonText, { color: '#fff' }]}>
              {t('syncLibrary')}
            </Text>
          </Pressable>
          {syncPhase === 'syncing' && (
            <Pressable
              onPress={handleCancelRunningSync}
              style={({ pressed }) => [
                settingsStyles.actionRowButton,
                { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth },
                pressed && settingsStyles.pressed,
              ]}
            >
              <Ionicons name="stop-circle-outline" size={18} color={colors.textPrimary} />
              <Text style={[settingsStyles.actionRowButtonText, { color: colors.textPrimary }]}>
                {t('pauseSync')}
              </Text>
            </Pressable>
          )}
          {syncPhase === 'idle' && librarySize > 0 && detailCacheSize < librarySize && (
            <Pressable
              onPress={handleResumeSync}
              disabled={offlineMode}
              style={({ pressed }) => [
                settingsStyles.actionRowButton,
                { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth },
                pressed && !offlineMode && settingsStyles.pressed,
                offlineMode && settingsStyles.disabled,
              ]}
            >
              <Ionicons name="play-circle-outline" size={18} color={colors.textPrimary} />
              <Text style={[settingsStyles.actionRowButtonText, { color: colors.textPrimary }]}>
                {t('resumeSync')}
              </Text>
            </Pressable>
          )}
        </View>
        {offlineMode && <OfflineNotice text={t('syncLibraryOfflineNotice')} />}
        <Text style={[settingsStyles.sectionHint, { color: colors.textSecondary }]}>
          {t('syncLibraryDescription')}
        </Text>
      </View>
    </View>
  );
}
