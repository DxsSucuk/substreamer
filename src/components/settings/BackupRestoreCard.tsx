import Ionicons from '@react-native-vector-icons/ionicons/static';
import i18next from 'i18next';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { useThemedAlert } from '../../hooks/useThemedAlert';
import { settingsStyles } from '../../styles/settingsStyles';
import {
  createBackup,
  makeBackupIdentityKey,
  pruneBackups,
} from '../../services/backupService';
import { authStore } from '../../store/authStore';
import { backupStore } from '../../store/backupStore';
import { RestoreBackupSheet } from './RestoreBackupSheet';
import { SettingsSectionTitle } from './SettingsSectionTitle';

export function BackupRestoreCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { alert } = useThemedAlert();

  const autoBackupEnabled = backupStore((s) => s.autoBackupEnabled);
  const serverUrl = authStore((s) => s.serverUrl);
  const primaryServerUrl = authStore((s) => s.primaryServerUrl);
  const username = authStore((s) => s.username);
  // Primary slot: a failover is a different address, not a different server.
  const identityUrl = primaryServerUrl ?? serverUrl;
  const backupIdentityKey = identityUrl && username
    ? makeBackupIdentityKey(identityUrl, username)
    : null;
  const lastBackupTime = backupStore((s) =>
    backupIdentityKey ? s.lastBackupTimes[backupIdentityKey] ?? null : null,
  );

  const [backingUp, setBackingUp] = useState(false);
  const [restoreSheetVisible, setRestoreSheetVisible] = useState(false);

  const handleToggleAutoBackup = useCallback(() => {
    backupStore.getState().setAutoBackupEnabled(!autoBackupEnabled);
  }, [autoBackupEnabled]);

  const handleBackUpNow = useCallback(async () => {
    setBackingUp(true);
    try {
      await createBackup();
      await pruneBackups();
    } catch {
      alert(t('backupFailed'), t('backupFailedMessage'));
    } finally {
      setBackingUp(false);
    }
  }, [alert, t]);

  return (
    <>
      <View style={settingsStyles.section}>
        <SettingsSectionTitle>{t('backupRestore')}</SettingsSectionTitle>
        <View style={[settingsStyles.card, settingsStyles.cardPadded, { backgroundColor: colors.card }]}>
          <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
            <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('autoBackup')}</Text>
            <Switch
              value={autoBackupEnabled}
              onValueChange={handleToggleAutoBackup}
              trackColor={{ false: colors.border, true: colors.primary }}
            />
          </View>
          <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
            <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('lastBackup')}</Text>
            <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
              {lastBackupTime
                ? new Date(lastBackupTime).toLocaleString(i18next.language, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })
                : t('never')}
            </Text>
          </View>
          <View style={styles.buttonRow}>
            <Pressable
              onPress={handleBackUpNow}
              disabled={backingUp}
              style={({ pressed }) => [
                styles.actionButton,
                { backgroundColor: colors.primary },
                pressed && !backingUp && settingsStyles.pressed,
              ]}
            >
              {backingUp ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="cloud-upload-outline" size={18} color="#fff" />
                  <Text style={styles.actionButtonText}>{t('backUp')}</Text>
                </>
              )}
            </Pressable>
            <Pressable
              onPress={() => setRestoreSheetVisible(true)}
              style={({ pressed }) => [
                styles.actionButton,
                { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth },
                pressed && settingsStyles.pressed,
              ]}
            >
              <Ionicons name="cloud-download-outline" size={18} color={colors.textPrimary} />
              <Text style={[styles.actionButtonText, { color: colors.textPrimary }]}>{t('restore')}</Text>
            </Pressable>
          </View>
        </View>
        <Text style={[styles.description, { color: colors.textSecondary }]}>
          {Platform.OS === 'ios' ? t('backupDescriptionIos') : t('backupDescriptionAndroid')}
        </Text>
        <Text style={[styles.description, { color: colors.textSecondary }]}>
          {t('deviceNameLocationHint')}
        </Text>
      </View>

      <RestoreBackupSheet
        visible={restoreSheetVisible}
        onClose={() => setRestoreSheetVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  buttonRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 44,
    borderRadius: 10,
  },
  actionButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  description: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
    marginHorizontal: 4,
  },
});
