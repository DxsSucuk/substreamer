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
 * upcoming tracks to keep ready; the on-disk budget is fixed and managed by the
 * engine, so it's shown as a plain size figure rather than a limit bar. Track
 * count is the real utilization lever (the engine only prefetches the window).
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

  const readyFraction = count > 0 ? Math.min(1, status.tracksFullyCached / count) : 0;

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
            <Text style={[styles.toggleHint, { color: colors.textSecondary }]}>
              {t('lookaheadCacheHint')}
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

        {/* Cache size (plain figure — budget is fixed/engine-managed) */}
        <View style={[settingsStyles.infoRow, { borderBottomColor: colors.border }]}>
          <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>
            {t('cacheSize')}
          </Text>
          <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
            {formatBytes(status.currentSizeMb * 1024 * 1024)}
          </Text>
        </View>

        {/* Tracks ready out of the limit */}
        {enabled && (
          <View style={styles.readyBlock}>
            <View style={styles.readyRow}>
              <Text style={[settingsStyles.infoLabel, { color: colors.textPrimary }]}>
                {t('cacheTracksReady')}
              </Text>
              <Text style={[settingsStyles.infoValue, { color: colors.textSecondary }]}>
                {t('cacheTracksReadyValue', { ready: status.tracksFullyCached, total: count })}
              </Text>
            </View>
            <View style={[styles.readyTrack, { backgroundColor: colors.inputBg }]}>
              <View
                style={[
                  styles.readyFill,
                  { backgroundColor: colors.primary, width: `${readyFraction * 100}%` },
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
  toggleText: { flex: 1, gap: 2 },
  toggleLabel: { fontSize: 16, fontWeight: '500' },
  toggleHint: { fontSize: 12 },
  readyBlock: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'transparent',
    gap: 8,
  },
  readyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  readyTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  readyFill: {
    height: '100%',
    borderRadius: 3,
  },
});
