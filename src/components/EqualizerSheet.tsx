/**
 * EqualizerSheet — the equalizer control surface (enable toggle, preset
 * dropdown, the reusable EqualizerBands grid, reset, and custom-preset
 * save/delete). Opened from the player and from Sound & Playback settings via
 * the same sheet, so the whole EQ UI lives in one place.
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { isBuiltinPreset } from 'react-native-queue-player';

import { BottomSheet } from './BottomSheet';
import { EqualizerBands } from './EqualizerBands';
import { DropdownRow, type DropdownOption } from './settings/DropdownRow';
import { useTheme } from '../hooks/useTheme';
import {
  applyEqualizerPreset,
  deleteEqualizerPreset,
  getEqualizerPresets,
  resetEqualizer,
  saveEqualizerPreset,
  setEqualizerBandGain,
  setEqualizerEnabled,
} from '../services/playerService';
import { equalizerSettingsStore, EQ_CUSTOM_PRESET_LABEL } from '../store/equalizerSettingsStore';
import { selectionAsync } from '../utils/haptics';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export const EqualizerSheet = memo(function EqualizerSheet({ visible, onClose }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  const enabled = equalizerSettingsStore((s) => s.enabled);
  const gains = equalizerSettingsStore((s) => s.gains);
  const presetName = equalizerSettingsStore((s) => s.presetName);

  const [presets, setPresets] = useState<ReturnType<typeof getEqualizerPresets>>([]);
  const [saveName, setSaveName] = useState('');
  const refreshPresets = useCallback(() => setPresets(getEqualizerPresets()), []);

  // Read the preset list lazily when the sheet opens (they can change between
  // opens via save/delete), so the always-mounted-but-hidden sheet does no
  // native work while closed.
  useEffect(() => {
    if (visible) refreshPresets();
  }, [visible, refreshPresets]);

  const isCustomActive = presetName === EQ_CUSTOM_PRESET_LABEL;
  const selectedIsDeletable =
    !isCustomActive && presets.length > 0 && !isBuiltinPreset(presets, presetName);

  const presetOptions: DropdownOption<string>[] = useMemo(() => {
    const opts = presets.map((p) => ({
      value: p.name,
      label: p.builtin ? p.name : `${p.name} ★`,
    }));
    if (isCustomActive) opts.push({ value: EQ_CUSTOM_PRESET_LABEL, label: t('equalizerCustom') });
    return opts;
  }, [presets, isCustomActive, t]);

  const handlePreset = useCallback((name: string) => {
    if (name === EQ_CUSTOM_PRESET_LABEL) return;
    selectionAsync();
    void applyEqualizerPreset(name);
  }, []);

  const handleBand = useCallback((index: number, gainDb: number) => {
    void setEqualizerBandGain(index, gainDb);
  }, []);

  const handleReset = useCallback(() => {
    selectionAsync();
    void resetEqualizer();
  }, []);

  const trimmedName = saveName.trim();
  const saveDisabled = trimmedName === '' || isBuiltinPreset(presets, trimmedName);
  const handleSave = useCallback(() => {
    if (saveDisabled) return;
    void saveEqualizerPreset(trimmedName).then(() => {
      setSaveName('');
      refreshPresets();
    });
  }, [saveDisabled, trimmedName, refreshPresets]);

  const handleDelete = useCallback(() => {
    void deleteEqualizerPreset(presetName).then(refreshPresets);
  }, [presetName, refreshPresets]);

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="80%">
      <Text style={[styles.title, { color: colors.textPrimary }]}>{t('equalizer')}</Text>

      <View style={styles.headerRow}>
        <View style={styles.toggleWrap}>
          <Text style={[styles.toggleLabel, { color: colors.textPrimary }]}>{t('equalizerEnable')}</Text>
          <Switch
            testID="eq-enabled-toggle"
            value={enabled}
            onValueChange={(v) => void setEqualizerEnabled(v)}
            trackColor={{ false: colors.border, true: colors.primary }}
          />
        </View>
        <Pressable
          onPress={handleReset}
          style={({ pressed }) => [styles.resetBtn, { borderColor: colors.border }, pressed && styles.pressed]}
        >
          <Text style={[styles.resetBtnText, { color: colors.textPrimary }]}>{t('equalizerReset')}</Text>
        </Pressable>
      </View>

      <View style={[styles.presetCard, { backgroundColor: colors.card }]}>
        <DropdownRow
          label={t('equalizerPreset')}
          value={presetName}
          options={presetOptions}
          onChange={handlePreset}
          isLast
        />
      </View>

      <EqualizerBands gains={gains} enabled={enabled} onBandChange={handleBand} />

      {isCustomActive && (
        <View style={styles.saveRow}>
          <TextInput
            style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.inputBg, borderColor: colors.border }]}
            value={saveName}
            onChangeText={setSaveName}
            placeholder={t('equalizerPresetNamePlaceholder')}
            placeholderTextColor={colors.textSecondary}
            returnKeyType="done"
            onSubmitEditing={handleSave}
          />
          <Pressable
            onPress={handleSave}
            disabled={saveDisabled}
            style={({ pressed }) => [
              styles.saveBtn,
              { backgroundColor: colors.primary },
              pressed && styles.pressed,
              saveDisabled && styles.disabled,
            ]}
          >
            <Text style={styles.saveBtnText}>{t('equalizerSave')}</Text>
          </Pressable>
        </View>
      )}

      {selectedIsDeletable && (
        <Pressable
          onPress={handleDelete}
          style={({ pressed }) => [styles.deleteBtn, pressed && styles.pressed]}
        >
          <Text style={[styles.deleteBtnText, { color: '#ff453a' }]}>
            {t('equalizerDeletePreset', { name: presetName })}
          </Text>
        </Pressable>
      )}
    </BottomSheet>
  );
});

const styles = StyleSheet.create({
  title: { fontSize: 18, fontWeight: '700', paddingHorizontal: 4, marginBottom: 14 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginBottom: 12,
  },
  toggleWrap: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggleLabel: { fontSize: 16, fontWeight: '600' },
  resetBtn: { borderWidth: 1, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 14 },
  resetBtnText: { fontSize: 13, fontWeight: '600' },
  presetCard: { borderRadius: 12, marginBottom: 18, overflow: 'hidden' },
  saveRow: { flexDirection: 'row', gap: 8, marginTop: 18, paddingHorizontal: 4 },
  input: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  saveBtn: { borderRadius: 10, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  deleteBtn: { marginTop: 14, alignItems: 'center', paddingVertical: 8 },
  deleteBtnText: { fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 },
});
