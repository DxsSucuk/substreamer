import { useCallback, useMemo } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';
import {
  layoutPreferencesStore,
  type ListLength,
} from '../../store/layoutPreferencesStore';
import { albumListsStore } from '../../store/albumListsStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { processingOverlayStore } from '../../store/processingOverlayStore';
import { DropdownRow, type DropdownOption } from './DropdownRow';
import { SettingsSectionTitle } from './SettingsSectionTitle';

const OPTION_KEYS: { value: ListLength; labelKey: string }[] = [
  { value: 20, labelKey: 'listLength20' },
  { value: 30, labelKey: 'listLength30' },
  { value: 50, labelKey: 'listLength50' },
  { value: 100, labelKey: 'listLength100' },
];

export function ListLengthCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const value = layoutPreferencesStore((s) => s.listLength);
  const setListLength = layoutPreferencesStore((s) => s.setListLength);

  const options: DropdownOption<ListLength>[] = useMemo(
    () => OPTION_KEYS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
    [t],
  );

  const handleChange = useCallback(
    async (next: ListLength) => {
      setListLength(next);
      if (offlineModeStore.getState().offlineMode) {
        Alert.alert(t('offlineListLengthTitle'), t('offlineListLengthMessage'));
        return;
      }
      processingOverlayStore.getState().show(t('updatingCachedLists'));
      try {
        // Artist top songs are NOT bulk-refreshed: the stored `list_length` no longer
        // matches, so each artist re-fetches on next open, for artists actually visited.
        await albumListsStore.getState().refreshAll();
        processingOverlayStore.getState().showSuccess(t('cachedListsUpdated'));
      } catch {
        processingOverlayStore.getState().showError(t('cachedListsUpdateFailed'));
      }
    },
    [setListLength, t],
  );

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('listLength')}</SettingsSectionTitle>
      <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('listLengthHint')}</Text>
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
