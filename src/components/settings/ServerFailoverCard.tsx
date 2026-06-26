import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';
import { switchToServer } from '../../services/failoverService';
import { authStore } from '../../store/authStore';
import { SettingsSectionTitle } from './SettingsSectionTitle';

export function ServerFailoverCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();

  const serverUrl = authStore((s) => s.serverUrl);
  const secondaryServerUrl = authStore((s) => s.secondaryServerUrl);
  const activeServer = authStore((s) => s.activeServer);

  const handleManualSwitchServer = useCallback(async () => {
    const target = activeServer === 'primary' ? 'secondary' : 'primary';
    await switchToServer(target);
  }, [activeServer]);

  const handleNavigateToServerSettings = useCallback(() => {
    router.push('/settings-server');
  }, [router]);

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('serverFailover')}</SettingsSectionTitle>
      <View style={[settingsStyles.card, settingsStyles.cardPadded, { backgroundColor: colors.card }]}>
        {secondaryServerUrl == null ? (
          <>
            <Text style={[styles.hint, { color: colors.textSecondary, marginBottom: 8 }]}>
              {t('serverFailoverEmptyExplain')}
            </Text>
            <Text style={[styles.hint, { color: colors.textSecondary, marginBottom: 12 }]}>
              {t('serverFailoverEmptySameServerNote')}
            </Text>
            <Pressable
              onPress={handleNavigateToServerSettings}
              style={({ pressed }) => [
                styles.actionButton,
                { borderColor: colors.primary },
                pressed && settingsStyles.pressed,
              ]}
            >
              <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
              <Text style={[styles.actionButtonText, { color: colors.primary }]}>
                {t('addSecondaryUrlAction')}
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={[styles.hint, { color: colors.textSecondary, marginBottom: 12 }]}>
              {t('failoverDetectExplain')}
            </Text>

            <View style={[styles.toggleRow, { borderBottomColor: colors.border }]}>
              <View style={styles.toggleTextWrap}>
                <Text style={[styles.label, { color: colors.textPrimary }]}>
                  {t('activeServerLabel')}
                </Text>
                <Text
                  style={[styles.hint, { color: colors.textSecondary }]}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {activeServer === 'primary' ? t('activeServerPrimary') : t('activeServerSecondary')}
                  {' — '}
                  {serverUrl ?? '—'}
                </Text>
              </View>
            </View>

            <Pressable
              onPress={handleManualSwitchServer}
              style={({ pressed }) => [
                styles.actionButton,
                { borderColor: colors.primary, marginTop: 12 },
                pressed && settingsStyles.pressed,
              ]}
            >
              <Ionicons name="swap-horizontal-outline" size={18} color={colors.primary} />
              <Text style={[styles.actionButtonText, { color: colors.primary }]}>
                {activeServer === 'primary' ? t('switchToSecondary') : t('switchToPrimary')}
              </Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toggleTextWrap: { flex: 1, marginRight: 12 },
  label: { fontSize: 16, fontWeight: '500' },
  hint: { fontSize: 12, marginTop: 4, lineHeight: 16 },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
  },
  actionButtonText: { fontSize: 16, fontWeight: '600' },
});
