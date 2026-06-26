import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';
import { canUserShare } from '../../services/serverCapabilityService';
import { authStore } from '../../store/authStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { shareSettingsStore } from '../../store/shareSettingsStore';
import { sharesStore } from '../../store/sharesStore';
import { EditShareUrlSheet } from './EditShareUrlSheet';
import { SettingsSectionTitle } from './SettingsSectionTitle';

/**
 * Renders nothing when the user is offline or the server doesn't support
 * shares. The visibility gate is intentional — same behaviour as the
 * pre-decomposition `showShares` conditional.
 */
export function SharesCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();

  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const showShares = !offlineMode && canUserShare();

  const primaryServerUrl = authStore((s) => s.primaryServerUrl ?? s.serverUrl);
  const shareBaseUrl = shareSettingsStore((s) => s.shareBaseUrl);
  const shares = sharesStore((s) => s.shares ?? []);
  const shareCount = shares.length;
  const expiredShareCount = useMemo(() => {
    const now = Date.now();
    return shares.filter((s) => {
      if (!s.expires) return false;
      const d = typeof s.expires === 'string' ? new Date(s.expires) : s.expires;
      return d.getTime() < now;
    }).length;
  }, [shares]);

  const [sheetVisible, setSheetVisible] = useState(false);

  if (!showShares) return null;

  return (
    <>
      <View style={settingsStyles.section}>
        <SettingsSectionTitle>{t('shares')}</SettingsSectionTitle>
        <View style={[settingsStyles.card, settingsStyles.cardPadded, { backgroundColor: colors.card }]}>
          <Pressable
            onPress={() => setSheetVisible(true)}
            style={({ pressed }) => [
              settingsStyles.infoRow,
              { borderBottomColor: colors.border },
              pressed && settingsStyles.pressed,
            ]}
          >
            <View style={styles.urlRow}>
              <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('shareUrl')}</Text>
              <Text style={[styles.urlValue, { color: colors.textSecondary }]} numberOfLines={1}>
                {shareBaseUrl || primaryServerUrl || '—'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
          </Pressable>
          <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
            <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('activeShares')}</Text>
            <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
              {shareCount}
            </Text>
          </View>
          <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
            <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>{t('expiredShares')}</Text>
            <Text style={[settingsStyles.infoValue, { color: expiredShareCount > 0 ? colors.red : colors.textSecondary }]}>
              {expiredShareCount}
            </Text>
          </View>
          <Pressable
            onPress={() => router.push('/share-browser')}
            style={({ pressed }) => [
              settingsStyles.navRow,
              { borderTopColor: colors.border },
              pressed && settingsStyles.pressed,
            ]}
          >
            <View style={settingsStyles.navRowLeft}>
              <Ionicons name="share-social-outline" size={18} color={colors.textPrimary} />
              <Text style={[settingsStyles.navRowText, { color: colors.textPrimary }]}>
                {t('browseShares')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>

      <EditShareUrlSheet visible={sheetVisible} onClose={() => setSheetVisible(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  urlRow: { flex: 1, marginRight: 8 },
  urlValue: { fontSize: 12, marginTop: 2 },
});
