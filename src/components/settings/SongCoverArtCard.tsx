import { useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';
import {
  layoutPreferencesStore,
  type SongCoverArtMode,
} from '../../store/layoutPreferencesStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { enqueueImageRefreshCycle } from '../../services/imageCacheService';
import { fireAndForget } from '../../utils/fireAndForget';
import { DropdownRow, type DropdownOption } from './DropdownRow';
import { SettingsSectionTitle } from './SettingsSectionTitle';

const OPTION_KEYS: { value: SongCoverArtMode; labelKey: string }[] = [
  { value: 'album', labelKey: 'songCoverArtAlbum' },
  { value: 'perTrack', labelKey: 'songCoverArtPerTrack' },
];

export function SongCoverArtCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const value = layoutPreferencesStore((s) => s.songCoverArtMode);
  const setSongCoverArtMode = layoutPreferencesStore((s) => s.setSongCoverArtMode);

  const options: DropdownOption<SongCoverArtMode>[] = useMemo(
    () => OPTION_KEYS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
    [t],
  );

  const handleChange = useCallback(
    (next: SongCoverArtMode) => {
      if (next === value) return;
      setSongCoverArtMode(next);
      // The resolved cover for every downloaded track changes with the mode, so
      // the new mode's covers may not be on disk yet. Re-warm downloaded covers
      // (mode-aware snapshot) so they survive offline. Best-effort, online only.
      if (!offlineModeStore.getState().offlineMode) {
        fireAndForget(enqueueImageRefreshCycle('refresh-downloads'), 'songCoverArtMode-recache');
      }
    },
    [setSongCoverArtMode, value],
  );

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('songCoverArt')}</SettingsSectionTitle>
      <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('songCoverArtHint')}</Text>
      <View style={[settingsStyles.card, { backgroundColor: colors.card }]}>
        <DropdownRow value={value} options={options} onChange={handleChange} isLast />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hint: {
    fontSize: 12,
    marginBottom: 8,
    marginLeft: 4,
  },
});
