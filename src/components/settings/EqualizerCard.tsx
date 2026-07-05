import MaterialCommunityIcons from '@react-native-vector-icons/material-design-icons/static';
import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';
import { equalizerSettingsStore } from '../../store/equalizerSettingsStore';
import { EqualizerSheet } from '../EqualizerSheet';
import { SettingsSectionTitle } from './SettingsSectionTitle';

/**
 * Equalizer entry point in Sound & Playback settings — a single row that opens
 * the shared EqualizerSheet (the same sheet the player button opens), so the EQ
 * UI has one home. Shows the current preset when enabled, or "Off".
 */
export function EqualizerCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const enabled = equalizerSettingsStore((s) => s.enabled);
  const presetName = equalizerSettingsStore((s) => s.presetName);
  const [sheetVisible, setSheetVisible] = useState(false);

  const open = useCallback(() => setSheetVisible(true), []);
  const close = useCallback(() => setSheetVisible(false), []);

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('equalizer')}</SettingsSectionTitle>
      <View style={[settingsStyles.card, { backgroundColor: colors.card }]}>
        <Pressable
          onPress={open}
          style={({ pressed }) => [styles.row, pressed && settingsStyles.pressed]}
        >
          <View style={styles.left}>
            <MaterialCommunityIcons
              name="tune-vertical"
              size={22}
              color={enabled ? colors.primary : colors.textSecondary}
            />
            <Text style={[styles.label, { color: colors.textPrimary }]}>{t('equalizer')}</Text>
          </View>
          <View style={styles.right}>
            <Text style={[styles.value, { color: colors.textSecondary }]} numberOfLines={1}>
              {enabled ? presetName : t('equalizerOff')}
            </Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </View>
        </Pressable>
      </View>

      <EqualizerSheet visible={sheetVisible} onClose={close} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  left: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { fontSize: 16 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, marginLeft: 12 },
  value: { fontSize: 15, flexShrink: 1 },
});
