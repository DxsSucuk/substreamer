import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

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
  const insets = useSafeAreaInsets();
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
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={settingsStyles.sheetBackdrop} onPress={onClose} />
      <View
        style={[
          settingsStyles.sheet,
          { backgroundColor: colors.card, paddingBottom: Math.max(insets.bottom, 16) },
        ]}
      >
        <View style={[settingsStyles.sheetHandle, { backgroundColor: colors.border }]} />
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t('shareUrl')}</Text>
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          {serverUrl ? t('shareUrlHintWithServer', { serverUrl }) : t('shareUrlHint')}
        </Text>
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
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  hint: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  input: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginHorizontal: 4,
  },
  buttons: { flexDirection: 'row', gap: 8, marginTop: 16, paddingHorizontal: 4 },
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
});
