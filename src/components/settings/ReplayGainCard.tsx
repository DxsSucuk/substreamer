import { useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';
import {
  playbackSettingsStore,
  REPLAY_GAIN_MODES,
  type ReplayGainModeSetting,
} from '../../store/playbackSettingsStore';
import { applyReplayGain } from '../../services/playerService';
import { DropdownRow, type DropdownOption } from './DropdownRow';
import { SettingsSectionTitle } from './SettingsSectionTitle';

const MODE_LABEL_KEY: Record<ReplayGainModeSetting, string> = {
  off: 'replayGainModeOff',
  track: 'replayGainModeTrack',
  album: 'replayGainModeAlbum',
};

/**
 * ReplayGain loudness normalisation — a single off / track / album selector
 * (default off) that maps straight to RNQP's mode. Track evens loudness across
 * a shuffled mix; Album preserves each album's own dynamics.
 */
export function ReplayGainCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const mode = playbackSettingsStore((s) => s.replayGainMode);
  const setMode = playbackSettingsStore((s) => s.setReplayGainMode);

  const modeOptions: DropdownOption<ReplayGainModeSetting>[] = useMemo(
    () => REPLAY_GAIN_MODES.map((m) => ({ value: m, label: t(MODE_LABEL_KEY[m]) })),
    [t],
  );

  const handleModeChange = useCallback(
    (value: ReplayGainModeSetting) => {
      setMode(value);
      void applyReplayGain();
    },
    [setMode],
  );

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('replayGain')}</SettingsSectionTitle>
      <View style={[settingsStyles.card, { backgroundColor: colors.card }]}>
        <DropdownRow
          label={t('replayGainModeLabel')}
          value={mode}
          options={modeOptions}
          onChange={handleModeChange}
          isLast
        />
      </View>
      <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('replayGainHint')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hint: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
    marginHorizontal: 4,
  },
});
