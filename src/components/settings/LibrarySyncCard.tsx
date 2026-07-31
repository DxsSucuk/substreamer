import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';
import { cancelAllSyncs, forceFullResync, resumeSync } from '../../services/dataSyncService';
import { countAlbums } from '../../db/repository/albums';
import { countSongs } from '../../db/repository/songs';
import { getDb } from '../../store/persistence/db';
import { offlineModeStore } from '../../store/offlineModeStore';
import { syncStatusStore } from '../../store/syncStatusStore';
import { OfflineNotice } from './OfflineNotice';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { formatShortDateTime } from '../../utils/dateFormat';
import type { IoniconsName } from '../../utils/iconNames';

export function LibrarySyncCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const libraryLastFetchedAt = syncStatusStore((s) => s.librarySyncLastFetchedAt);
  const librarySyncPhase = syncStatusStore((s) => s.librarySyncPhase);
  const songSyncPhase = syncStatusStore((s) => s.detailSyncPhase);
  const librarySyncComplete = syncStatusStore((s) => s.librarySyncComplete);
  const songSyncComplete = syncStatusStore((s) => s.songSyncComplete);
  const migPhase = syncStatusStore((s) => s.normalizedMigrationPhase);
  const migDone = syncStatusStore((s) => s.normalizedMigrationDone);
  const migTotal = syncStatusStore((s) => s.normalizedMigrationTotal);
  const albumsProcessed = syncStatusStore((s) => s.detailSyncCompleted);
  const albumsTotal = syncStatusStore((s) => s.detailSyncTotal);
  const songSyncFinalizing = syncStatusStore((s) => s.songSyncFinalizing);
  // Which transport the run is actually using. `songSyncStrategy` wins because the
  // song phase can fall back to the per-album walk at runtime even on a search3 server.
  const songSyncStrategy = syncStatusStore((s) => s.songSyncStrategy);
  const syncStrategy = syncStatusStore((s) => s.syncStrategy);
  const transport = songSyncStrategy ?? syncStrategy;

  // One-time blob→normalized migration progress (bar + % + counts on the card).
  const isMigrating = migPhase === 'migrating';
  const migPct = migTotal > 0 ? Math.min(100, Math.floor((migDone / migTotal) * 100)) : 0;

  // Song-sync progress = albums-whose-songs-we-have / total-albums.
  const songSyncPct = albumsTotal > 0 ? Math.min(100, Math.floor((albumsProcessed / albumsTotal) * 100)) : 0;

  // Counts reflect the NORMALIZED model (the target-state sync's output), refreshed
  // as the sync progresses. Null until the first query resolves (shown as 0).
  const [normAlbums, setNormAlbums] = useState<number | null>(null);
  const [normSongs, setNormSongs] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const db = getDb();
    if (!db) return undefined;
    void (async () => {
      try {
        const [a, s] = await Promise.all([countAlbums(db), countSongs(db)]);
        if (!cancelled) {
          setNormAlbums(a);
          setNormSongs(s);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [albumsProcessed, albumsTotal, songSyncComplete, librarySyncComplete]);
  const displayAlbums = normAlbums ?? 0;
  const displaySongs = normSongs ?? 0;

  // A sync is actively running when either the album-list fetch or the song
  // fetch is in progress.
  const isSyncing = librarySyncPhase === 'fetching' || songSyncPhase === 'syncing';
  const fullyComplete = librarySyncComplete && songSyncComplete;
  // Started but neither running nor finished (e.g. paused, or interrupted).
  const isPaused = !isSyncing && !fullyComplete && displayAlbums > 0;
  const showSync = !isSyncing && !isPaused;

  const stageText =
    librarySyncPhase === 'fetching'
      ? t('fetchingAlbumList')
      : songSyncPhase === 'syncing'
        ? t('fetchingSongs')
        : null;

  // No confirm: the resync overwrites rows in place rather than dropping them, so
  // nothing is destroyed, the library stays browsable throughout, and Pause is right
  // there. The card hint below carries what the dialog used to say.
  const handleForceResync = useCallback(() => {
    if (offlineMode) return;
    void forceFullResync();
  }, [offlineMode]);

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
          <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>{displayAlbums}</Text>
        </View>
        <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
          <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('songs')}</Text>
          <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>{displaySongs}</Text>
        </View>
        <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
          <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('lastFetched')}</Text>
          <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
            {formatShortDateTime(libraryLastFetchedAt ? new Date(libraryLastFetchedAt) : null)}
          </Text>
        </View>

        {isMigrating && (
          <View style={styles.progressBlock}>
            <View style={styles.statusRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.statusText, { color: colors.textSecondary, flex: 1 }]}>
                {t('upgradingLibraryCard')}
              </Text>
              <Text style={[styles.statusPct, { color: colors.textPrimary }]}>{migPct}%</Text>
            </View>
            <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
              <View style={[styles.progressFill, { backgroundColor: colors.primary, width: `${migPct}%` }]} />
            </View>
          </View>
        )}

        {!isMigrating && isSyncing && (albumsTotal > 0 || songSyncFinalizing) && (
          <View style={styles.progressBlock}>
            <View style={styles.statusRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.statusText, { color: colors.textSecondary, flex: 1 }]}>
                {songSyncFinalizing ? t('finalizingLibrary') : stageText}
              </Text>
              <Text style={[styles.statusPct, { color: colors.textPrimary }]}>
                {songSyncFinalizing ? 100 : songSyncPct}%
              </Text>
            </View>
            <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
              <View
                style={[
                  styles.progressFill,
                  { backgroundColor: colors.primary, width: `${songSyncFinalizing ? 100 : songSyncPct}%` },
                ]}
              />
            </View>
            <Text style={[styles.progressCounts, { color: colors.textSecondary }]}>
              {albumsProcessed} / {albumsTotal}
            </Text>
            {transport && (
              <View style={styles.transportRow}>
                <Ionicons
                  name={transport === 'basic' ? 'albums-outline' : 'flash-outline'}
                  size={12}
                  color={colors.textSecondary}
                />
                <Text style={[styles.transportText, { color: colors.textSecondary }]}>
                  {transport === 'basic' ? t('syncTransportBasic') : t('syncTransportFast')}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Indeterminate fallback (e.g. the album-LIST fetch, before songs). */}
        {!isMigrating && isSyncing && albumsTotal === 0 && !songSyncFinalizing && stageText != null && (
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
  progressBlock: {
    paddingBottom: 8,
  },
  statusPct: {
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  progressCounts: {
    fontSize: 12,
    marginTop: 6,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  transportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: 4,
  },
  transportText: {
    fontSize: 11,
  },
});
