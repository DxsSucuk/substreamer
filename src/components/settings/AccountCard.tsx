import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { useThemedAlert } from '../../hooks/useThemedAlert';
import { settingsStyles } from '../../styles/settingsStyles';
import { clearImageCache } from '../../services/imageCacheService';
import { clearMusicCache } from '../../services/musicCacheService';
import { clearQueue } from '../../services/playerService';
import { stopPolling } from '../../services/scanService';
import { clearAllNativeTrust } from '../../services/sslTrustService';
import { clearApiCache, login } from '../../services/subsonicService';
import { authStore } from '../../store/authStore';
import { deviceIdentityStore } from '../../store/deviceIdentityStore';
import { resetAllStores } from '../../store/resetAllStores';
import { serverInfoStore } from '../../store/serverInfoStore';
import { ChangePasswordSheet } from './ChangePasswordSheet';
import { EditDeviceNameSheet } from './EditDeviceNameSheet';
import { SettingsSectionTitle } from './SettingsSectionTitle';

export function AccountCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { alert } = useThemedAlert();
  const router = useRouter();

  const username = authStore((s) => s.username);
  const password = authStore((s) => s.password);
  const legacyAuth = authStore((s) => s.legacyAuth);
  const deviceLabel = deviceIdentityStore((s) => s.deviceLabel);
  const adminRole = serverInfoStore((s) => s.adminRole);
  const shareRole = serverInfoStore((s) => s.shareRole);

  const [passwordVisible, setPasswordVisible] = useState(false);
  const [changePasswordVisible, setChangePasswordVisible] = useState(false);
  const [deviceNameSheetVisible, setDeviceNameSheetVisible] = useState(false);
  // Optimistic position of the legacy-auth switch while a candidate value is
  // being verified against the server; null when not verifying. Bound as the
  // switch value so it shows the attempted position, then reverts on failure.
  const [pendingLegacyAuth, setPendingLegacyAuth] = useState<boolean | null>(null);
  const [verifyingLegacyAuth, setVerifyingLegacyAuth] = useState(false);

  // Switch the auth scheme, but verify it works against the server BEFORE
  // committing — otherwise a wrong choice silently breaks every request and the
  // only fix is a full logout/login. On success: persist + drop the caches
  // (keyed on legacyAuth) so they rebuild. On failure: revert + surface why.
  const handleToggleLegacyAuth = useCallback(
    async (next: boolean) => {
      const auth = authStore.getState();
      if (!auth.serverUrl || !auth.username || !auth.password) return;
      setPendingLegacyAuth(next);
      setVerifyingLegacyAuth(true);
      const result = await login(auth.serverUrl, auth.username, auth.password, next);
      setVerifyingLegacyAuth(false);
      setPendingLegacyAuth(null);
      if (result.success) {
        authStore.getState().setLegacyAuth(next);
        clearApiCache();
        alert(t('legacyAuthentication'), t('legacyAuthVerified'));
      } else {
        alert(t('error'), result.error || t('legacyAuthValidationFailed'));
      }
    },
    [alert, t],
  );

  const handleLogout = useCallback(async () => {
    clearQueue();
    stopPolling();
    clearApiCache();
    // Clear the NATIVE trust store + stop the proxy BEFORE resetting JS state /
    // navigating to login. The native store is what the URLProtocol swizzle /
    // OkHttp actually enforce; awaiting here (rather than fire-and-forget) means
    // a self-signed re-login re-prompts instead of racing a still-trusted cert.
    await clearAllNativeTrust();
    resetAllStores();
    clearImageCache();
    clearMusicCache();
    router.replace('/login');
  }, [router]);

  const maskedPassword = password ? '•'.repeat(password.length) : '';

  return (
    <>
      <View style={settingsStyles.section}>
        <SettingsSectionTitle>{t('account')}</SettingsSectionTitle>
        <View style={[settingsStyles.card, settingsStyles.cardPadded, { backgroundColor: colors.card }]}>
          <View style={[styles.fieldRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.fieldLabel, { color: colors.textPrimary }]}>{t('username')}</Text>
            <Text style={[styles.fieldValue, { color: colors.textSecondary }]}>{username ?? '—'}</Text>
          </View>
          <View style={[styles.fieldRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.fieldLabel, { color: colors.textPrimary }]}>{t('password')}</Text>
            <View style={styles.passwordValue}>
              <Text style={[styles.fieldValue, { color: colors.textSecondary }]}>
                {password ? (passwordVisible ? password : maskedPassword) : '—'}
              </Text>
              {password ? (
                <Pressable
                  onPress={() => setPasswordVisible((v) => !v)}
                  hitSlop={8}
                  style={({ pressed }) => pressed && settingsStyles.pressed}
                >
                  <Ionicons
                    name={passwordVisible ? 'eye-off-outline' : 'eye-outline'}
                    size={20}
                    color={colors.textSecondary}
                  />
                </Pressable>
              ) : null}
            </View>
          </View>
          <View style={[styles.fieldRow, { borderBottomColor: colors.border }]}>
            <View style={styles.legacyLabelWrap}>
              <Text style={[styles.fieldLabel, { color: colors.textPrimary }]}>{t('legacyAuthentication')}</Text>
              <Text style={[styles.legacyHint, { color: colors.textSecondary }]}>
                {t('legacyAuthenticationHint')}
              </Text>
            </View>
            <View style={styles.legacyRight}>
              {verifyingLegacyAuth ? <ActivityIndicator size="small" color={colors.textSecondary} /> : null}
              <Switch
                value={pendingLegacyAuth ?? legacyAuth}
                onValueChange={handleToggleLegacyAuth}
                disabled={verifyingLegacyAuth}
              />
            </View>
          </View>
          <View style={[styles.fieldRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.fieldLabel, { color: colors.textPrimary }]}>{t('adminRole')}</Text>
            <Text style={[styles.fieldValue, { color: colors.textSecondary }]}>
              {adminRole === true ? t('yes') : adminRole === false ? t('no') : t('unknown')}
            </Text>
          </View>
          <View style={[styles.fieldRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.fieldLabel, { color: colors.textPrimary }]}>{t('shareRole')}</Text>
            <Text style={[styles.fieldValue, { color: colors.textSecondary }]}>
              {shareRole === true ? t('yes') : shareRole === false ? t('no') : t('unknown')}
            </Text>
          </View>
          <Pressable
            onPress={() => setDeviceNameSheetVisible(true)}
            style={({ pressed }) => [
              styles.fieldRow,
              pressed && settingsStyles.pressed,
            ]}
          >
            <Text style={[styles.fieldLabel, { color: colors.textPrimary }]}>{t('deviceName')}</Text>
            <View style={styles.rightValue}>
              <Text style={[styles.fieldValue, { color: colors.textSecondary }]} numberOfLines={1}>
                {deviceLabel}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
            </View>
          </Pressable>
          <Pressable
            onPress={() => setChangePasswordVisible(true)}
            style={({ pressed }) => [
              styles.changePasswordButton,
              { backgroundColor: colors.primary },
              pressed && settingsStyles.pressed,
            ]}
          >
            <Ionicons name="key-outline" size={18} color="#fff" />
            <Text style={styles.changePasswordButtonText}>{t('changePassword')}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.logoutButton,
              { borderColor: colors.red },
              pressed && settingsStyles.pressed,
            ]}
            onPress={handleLogout}
          >
            <Text style={[styles.logoutButtonText, { color: colors.red }]}>{t('logOut')}</Text>
          </Pressable>
        </View>
      </View>

      <ChangePasswordSheet
        visible={changePasswordVisible}
        onClose={() => setChangePasswordVisible(false)}
      />
      <EditDeviceNameSheet
        visible={deviceNameSheetVisible}
        onClose={() => setDeviceNameSheetVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  fieldRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'transparent',
  },
  fieldLabel: { fontSize: 16, flex: 1 },
  fieldValue: { fontSize: 16, fontWeight: '500' },
  legacyLabelWrap: { flex: 1, marginRight: 12 },
  legacyHint: { fontSize: 12, marginTop: 2 },
  legacyRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  passwordValue: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rightValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    justifyContent: 'flex-end',
  },
  changePasswordButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    paddingVertical: 10,
    marginTop: 12,
  },
  changePasswordButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  logoutButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  logoutButtonText: { fontSize: 16, fontWeight: '600' },
});
