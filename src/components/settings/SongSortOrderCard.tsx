import { useMemo } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';
import {
  layoutPreferencesStore,
  type SongSortOrder,
} from '../../store/layoutPreferencesStore';
import { DropdownRow, type DropdownOption } from './DropdownRow';
import { SettingsSectionTitle } from './SettingsSectionTitle';

const OPTION_KEYS: { value: SongSortOrder; labelKey: string }[] = [
  { value: 'title', labelKey: 'sortSongTitle' },
  { value: 'artist', labelKey: 'sortArtistName' },
];

export function SongSortOrderCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const value = layoutPreferencesStore((s) => s.songSortOrder);
  const setValue = layoutPreferencesStore((s) => s.setSongSortOrder);

  const options: DropdownOption<SongSortOrder>[] = useMemo(
    () => OPTION_KEYS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
    [t],
  );

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('songSortOrder')}</SettingsSectionTitle>
      <View style={[settingsStyles.card, { backgroundColor: colors.card }]}>
        <DropdownRow value={value} options={options} onChange={setValue} isLast />
      </View>
    </View>
  );
}
