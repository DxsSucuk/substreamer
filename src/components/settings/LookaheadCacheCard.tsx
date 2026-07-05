import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useLookaheadCache } from 'react-native-queue-player';

import { useTheme } from '../../hooks/useTheme';
import { useThemedAlert } from '../../hooks/useThemedAlert';
import { applyLookaheadCacheConfig, clearLookaheadCache } from '../../services/playerService';
import {
  playbackSettingsStore,
  LOOKAHEAD_COUNTS,
  type LookaheadCount,
} from '../../store/playbackSettingsStore';
import { settingsStyles } from '../../styles/settingsStyles';
import { formatBytes } from '../../utils/formatters';
import { DropdownRow, type DropdownOption } from './DropdownRow';
import { SettingsSectionTitle } from './SettingsSectionTitle';

/**
 * Lookahead-cache controls. The user turns caching on/off and picks how many
 * upcoming tracks to keep ready; the on-disk budget is fixed and engine-managed.
 * The usage bar shows how much of that budget is currently used — driven live by
 * RNQP's `onCacheStatusChange` (via `useLookaheadCache`), so it updates as tracks
 * are cached or evicted.
 */
export function LookaheadCacheCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { confirm } = useThemedAlert();

  const enabled = playbackSettingsStore((s) => s.lookaheadEnabled);
  const count = playbackSettingsStore((s) => s.lookaheadCount);
  const setEnabled = playbackSettingsStore((s) => s.setLookaheadEnabled);
  const setCount = playbackSettingsStore((s) => s.setLookaheadCount);

  const { status } = useLookaheadCache();

  const countOptions: DropdownOption<LookaheadCount>[] = useMemo(
    () => LOOKAHEAD_COUNTS.map((v) => ({ value: v, label: t('cacheTracksValue', { count: v }) })),
    [t],
  );

  const handleToggle = useCallback(
    (value: boolean) => {
      setEnabled(value);
      void applyLookaheadCacheConfig();
    },
    [setEnabled],
  );

  const handleCountChange = useCallback(
    (value: LookaheadCount) => {
      setCount(value);
      void applyLookaheadCacheConfig();
    },
    [setCount],
  );

  const handleClear = useCallback(() => {
    confirm({
      title: t('clearCacheTitle'),
      message: t('clearCacheMessage'),
      confirmLabel: t('clearCacheConfirm'),
      destructive: true,
      onConfirm: () => {
        void clearLookaheadCache();
      },
    });
  }, [confirm, t]);

  const usedFraction =
    status.maxSizeMb > 0 ? Math.min(1, status.currentSizeMb / status.maxSizeMb) : 0;
  const showUsage = enabled || status.currentSizeMb > 0;

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('lookaheadCache')}</SettingsSectionTitle>
      <View style={[settingsStyles.card, { backgroundColor: colors.card }]}>
        {/* Enable */}
        <View style={[styles.toggleRow, { borderBottomColor: colors.border }]}>
          <View style={styles.toggleText}>
            <Text style={[styles.toggleLabel, { color: colors.textPrimary }]}>
              {t('lookaheadCacheEnable')}
            </Text>
          </View>
          <Switch
            testID="lookahead-toggle"
            value={enabled}
            onValueChange={handleToggle}
            trackColor={{ false: colors.border, true: colors.primary }}
          />
        </View>

        {enabled && (
          <DropdownRow
            label={t('lookaheadCacheCount')}
            value={count}
            options={countOptions}
            onChange={handleCountChange}
          />
        )}

        {/* Space used out of the fixed budget (live via onCacheStatusChange) */}
        {showUsage && (
          <View style={styles.usageBlock}>
            <View style={styles.usageRow}>
              <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>
                {t('cacheUsed')}
              </Text>
              <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
                {t('cacheUsedValue', {
                  used: formatBytes(status.currentSizeMb * 1024 * 1024),
                  total: formatBytes(status.maxSizeMb * 1024 * 1024),
                })}
              </Text>
            </View>
            <View style={[styles.usageTrack, { backgroundColor: colors.inputBg }]}>
              <View
                style={[
                  styles.usageFill,
                  { backgroundColor: colors.primary, width: `${usedFraction * 100}%` },
                ]}
              />
            </View>
          </View>
        )}

        {/* Clear */}
        <View style={settingsStyles.actionRow}>
          <Pressable
            onPress={handleClear}
            disabled={status.currentSizeMb <= 0}
            style={({ pressed }) => [
              settingsStyles.actionRowButton,
              { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth },
              pressed && settingsStyles.pressed,
              status.currentSizeMb <= 0 && settingsStyles.disabled,
            ]}
          >
            <Ionicons name="trash-outline" size={18} color={colors.textPrimary} />
            <Text style={[settingsStyles.actionRowButtonText, { color: colors.textPrimary }]}>
              {t('clearCache')}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toggleText: { flex: 1 },
  toggleLabel: { fontSize: 16, fontWeight: '500' },
  usageBlock: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'transparent',
    gap: 8,
  },
  usageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  usageTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  usageFill: {
    height: '100%',
    borderRadius: 3,
  },
});
