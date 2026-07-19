import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { BottomSheet } from '../BottomSheet';
import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';
import { authStore } from '../../store/authStore';
import { shareSettingsStore } from '../../store/shareSettingsStore';

export function EditShareUrlSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const serverUrl = authStore((s) => s.primaryServerUrl ?? s.serverUrl);
  const shareBaseUrl = shareSettingsStore((s) => s.shareBaseUrl);

  const [input, setInput] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (visible) {
      setInput(shareBaseUrl ?? '');
      setSaved(false);
    }
  }, [visible, shareBaseUrl]);

  const handleSave = useCallback(() => {
    const trimmed = input.trim();
    shareSettingsStore.getState().setShareBaseUrl(trimmed || null);
    setSaved(true);
    setTimeout(onClose, 500);
  }, [input, onClose]);

  const handleReset = useCallback(() => {
    shareSettingsStore.getState().setShareBaseUrl(null);
    setInput('');
    setSaved(true);
    setTimeout(onClose, 500);
  }, [onClose]);

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t('shareUrl')}</Text>
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          {serverUrl ? t('shareUrlHintWithServer', { serverUrl }) : t('shareUrlHint')}
        </Text>
      </View>
      <View style={styles.form}>
        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBg, color: colors.textPrimary, borderColor: colors.border }]}
          value={input}
          onChangeText={setInput}
          placeholder={serverUrl ?? 'https://your-server.com'}
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          onSubmitEditing={handleSave}
          autoFocus
        />
        <View style={styles.buttons}>
          <Pressable
            onPress={handleReset}
            style={({ pressed }) => [
              styles.button,
              styles.resetButton,
              { borderColor: colors.border },
              pressed && settingsStyles.pressed,
            ]}
          >
            <Text style={[styles.resetText, { color: colors.textPrimary }]}>
              {t('resetToDefault')}
            </Text>
          </Pressable>
          <Pressable
            onPress={handleSave}
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: colors.primary },
              pressed && settingsStyles.pressed,
            ]}
          >
            <Text style={styles.buttonText}>{saved ? t('saved') : t('save')}</Text>
          </Pressable>
        </View>
        <Pressable onPress={onClose} style={styles.cancelButton}>
          <Text style={[styles.cancelButtonText, { color: colors.primary }]}>{t('cancel')}</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 4, marginBottom: 16 },
  title: { fontSize: 18, fontWeight: '700', marginBottom: 6 },
  hint: { fontSize: 13, lineHeight: 18 },
  form: { paddingHorizontal: 4 },
  input: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  buttons: { flexDirection: 'row', gap: 8, marginTop: 16 },
  button: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    paddingVertical: 12,
  },
  resetButton: { borderWidth: StyleSheet.hairlineWidth },
  resetText: { fontSize: 16, fontWeight: '500' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  cancelButton: { alignItems: 'center', paddingVertical: 12, marginTop: 4, marginBottom: 4 },
  cancelButtonText: { fontSize: 16, fontWeight: '500' },
});
