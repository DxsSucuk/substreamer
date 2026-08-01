import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { BottomSheet } from '../BottomSheet';
import { useTheme } from '../../hooks/useTheme';
import { useThemedAlert } from '../../hooks/useThemedAlert';
import { settingsStyles } from '../../styles/settingsStyles';
import { changePassword, clearApiCache, ensureCoverArtAuth } from '../../services/subsonicService';
import { authStore } from '../../store/authStore';

export function ChangePasswordSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { alert } = useThemedAlert();
  const username = authStore((s) => s.username);
  const password = authStore((s) => s.password);

  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Set only on a successful change so the confirmation alert fires from
  // onCloseComplete — after this sheet's Modal has fully torn down. Opening the
  // alert directly after onClose() would stack two Modals (Android shows one at
  // a time). Cancel / failure leave this false so no alert appears.
  const succeededRef = useRef(false);

  useEffect(() => {
    if (visible) {
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
      setError(null);
      succeededRef.current = false;
    }
  }, [visible]);

  const handleSave = useCallback(async () => {
    if (!username) return;
    if (currentPw !== password) {
      setError(t('currentPasswordIncorrect'));
      return;
    }
    if (!newPw.trim()) {
      setError(t('newPasswordRequired'));
      return;
    }
    if (newPw === currentPw) {
      setError(t('newPasswordMustDiffer'));
      return;
    }
    if (newPw !== confirmPw) {
      setError(t('passwordsDoNotMatch'));
      return;
    }
    setLoading(true);
    setError(null);
    const success = await changePassword(username, newPw);
    setLoading(false);
    if (success) {
      // Password only — `setSession` would also rewrite `primaryServerUrl` from the
      // ACTIVE url, silently destroying the other address while failed over.
      authStore.getState().setPassword(newPw);
      clearApiCache();
      // The caches key on url|username|legacyAuth, so clearing is what makes the new
      // password take effect; re-mint the cover-art token the clear just dropped.
      void ensureCoverArtAuth();
      succeededRef.current = true;
      onClose();
    } else {
      setError(t('failedToChangePassword'));
    }
  }, [username, password, currentPw, newPw, confirmPw, t, onClose]);

  const handleCloseComplete = useCallback(() => {
    if (succeededRef.current) {
      succeededRef.current = false;
      alert(t('passwordChanged'), t('passwordChangedMessage'));
    }
  }, [alert, t]);

  return (
    <BottomSheet visible={visible} onClose={onClose} onCloseComplete={handleCloseComplete}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t('changePassword')}</Text>
      </View>
      <View style={styles.form}>
        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBg, color: colors.textPrimary, borderColor: colors.border }]}
          placeholder={t('currentPassword')}
          placeholderTextColor={colors.textSecondary}
          secureTextEntry
          value={currentPw}
          onChangeText={(v) => { setCurrentPw(v); setError(null); }}
          autoFocus
          editable={!loading}
        />
        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBg, color: colors.textPrimary, borderColor: colors.border }]}
          placeholder={t('newPassword')}
          placeholderTextColor={colors.textSecondary}
          secureTextEntry
          value={newPw}
          onChangeText={(v) => { setNewPw(v); setError(null); }}
          editable={!loading}
        />
        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBg, color: colors.textPrimary, borderColor: colors.border }]}
          placeholder={t('confirmNewPassword')}
          placeholderTextColor={colors.textSecondary}
          secureTextEntry
          value={confirmPw}
          onChangeText={(v) => { setConfirmPw(v); setError(null); }}
          editable={!loading}
          returnKeyType="done"
          onSubmitEditing={handleSave}
        />
        {error && (
          <Text style={[styles.error, { color: colors.red }]}>{error}</Text>
        )}
        <Pressable
          onPress={handleSave}
          disabled={loading}
          style={({ pressed }) => [
            styles.saveButton,
            { backgroundColor: colors.primary },
            pressed && settingsStyles.pressed,
            loading && settingsStyles.disabled,
          ]}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.saveButtonText}>{t('save')}</Text>
          )}
        </Pressable>
        <Pressable onPress={onClose} disabled={loading} style={styles.cancelButton}>
          <Text style={[styles.cancelButtonText, { color: colors.primary }]}>{t('cancel')}</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 4, marginBottom: 16 },
  title: { fontSize: 18, fontWeight: '700' },
  form: { paddingHorizontal: 4 },
  input: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 10,
  },
  error: { fontSize: 12, marginBottom: 4, textAlign: 'center' },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 10,
    marginBottom: 8,
  },
  saveButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  cancelButton: { alignItems: 'center', paddingVertical: 12, marginBottom: 4 },
  cancelButtonText: { fontSize: 16, fontWeight: '500' },
});
