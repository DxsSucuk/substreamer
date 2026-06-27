import Ionicons from '@react-native-vector-icons/ionicons/static';
import i18next from 'i18next';
import { useCallback, useEffect } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { useThemedAlert } from '../../hooks/useThemedAlert';
import { settingsStyles } from '../../styles/settingsStyles';
import {
  fetchScanStatus,
  startScan as startLibraryScan,
} from '../../services/scanService';
import { canUserScan, isAdminRoleUnknown, supports } from '../../services/serverCapabilityService';
import { scanStatusStore } from '../../store/scanStatusStore';
import { InfoRow } from '../InfoRow';
import { SettingsSectionTitle } from './SettingsSectionTitle';

/**
 * Only renders for users whose account has the scan privilege. Returns null
 * otherwise to keep the surrounding screen layout clean.
 */
export function LibraryScanCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { confirm } = useThemedAlert();

  const scanScanning = scanStatusStore((s) => s.scanning);
  const scanCount = scanStatusStore((s) => s.count);
  const scanLastScan = scanStatusStore((s) => s.lastScan);
  const scanFolderCount = scanStatusStore((s) => s.folderCount);
  const scanLoading = scanStatusStore((s) => s.loading);

  const canScan = canUserScan();
  const canFullScan = canUserScan() && supports('fullScan');
  const showScanHint = isAdminRoleUnknown();

  useEffect(() => {
    fetchScanStatus();
  }, []);

  const handleStartScan = useCallback(() => {
    startLibraryScan();
  }, []);

  const handleFullScan = useCallback(() => {
    confirm({
      title: t('fullScan'),
      message: t('fullScanConfirmMessage'),
      confirmLabel: t('start'),
      onConfirm: () => startLibraryScan(true),
    });
  }, [confirm, t]);

  if (!canScan) return null;

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('libraryScan')}</SettingsSectionTitle>
      <View style={[settingsStyles.card, settingsStyles.cardPadded, { backgroundColor: colors.card }]}>
        <InfoRow
          label={t('status')}
          value={
            scanScanning
              ? scanCount > 0
                ? t('scanningWithCount', { count: scanCount.toLocaleString(i18next.language) })
                : t('scanning')
              : t('idle')
          }
          labelColor={colors.textPrimary}
          valueColor={scanScanning ? colors.primary : colors.textSecondary}
          borderColor={colors.border}
        />
        {scanCount > 0 && (
          <InfoRow
            label={t('trackCount')}
            value={scanCount.toLocaleString(i18next.language)}
            labelColor={colors.textPrimary}
            valueColor={colors.textSecondary}
            borderColor={colors.border}
          />
        )}
        {scanLastScan != null && (
          <InfoRow
            label={t('lastScan')}
            value={new Date(scanLastScan).toLocaleString(i18next.language)}
            labelColor={colors.textPrimary}
            valueColor={colors.textSecondary}
            borderColor={colors.border}
          />
        )}
        {scanFolderCount != null && (
          <InfoRow
            label={t('mediaFolders')}
            value={String(scanFolderCount)}
            labelColor={colors.textPrimary}
            valueColor={colors.textSecondary}
            borderColor={colors.border}
          />
        )}
        <View style={styles.buttons}>
          <Pressable
            onPress={handleStartScan}
            disabled={scanScanning || scanLoading}
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: colors.primary },
              pressed && settingsStyles.pressed,
              (scanScanning || scanLoading) && settingsStyles.disabled,
            ]}
          >
            {scanLoading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name="refresh-outline" size={18} color="#fff" />
            )}
            <Text style={styles.buttonText}>{t('quickScan')}</Text>
          </Pressable>
          {canFullScan && (
            <Pressable
              onPress={handleFullScan}
              disabled={scanScanning || scanLoading}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: colors.primary },
                pressed && settingsStyles.pressed,
                (scanScanning || scanLoading) && settingsStyles.disabled,
              ]}
            >
              {scanLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="search-outline" size={18} color="#fff" />
              )}
              <Text style={styles.buttonText}>{t('fullScan')}</Text>
            </Pressable>
          )}
        </View>
        {showScanHint && (
          <Text style={[styles.hint, { color: colors.textSecondary }]}>
            {t('scanRequiresAdminHint')}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', marginTop: 12, gap: 8 },
  button: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    paddingVertical: 10,
    gap: 8,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  hint: { fontSize: 12, marginTop: 8, lineHeight: 16 },
});
