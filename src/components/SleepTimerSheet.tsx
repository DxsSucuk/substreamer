import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { BottomSheet } from './BottomSheet';
import { useTheme } from '../hooks/useTheme';
import { sleepTimerStore } from '../store/sleepTimerStore';
import { clearSleepTimer, setSleepTimer, setSleepTimerToTrackEnd } from '../services/playerService';

interface TimerOption {
  labelKey: string;
  seconds: number;
}

const TIMER_OPTIONS: TimerOption[] = [
  { labelKey: 'sleepTimer15', seconds: 15 * 60 },
  { labelKey: 'sleepTimer30', seconds: 30 * 60 },
  { labelKey: 'sleepTimer45', seconds: 45 * 60 },
  { labelKey: 'sleepTimer60', seconds: 60 * 60 },
];

export function SleepTimerSheet() {
  const visible = sleepTimerStore((s) => s.sheetVisible);
  const endTime = sleepTimerStore((s) => s.endTime);
  const endOfTrack = sleepTimerStore((s) => s.endOfTrack);
  const hideSheet = sleepTimerStore((s) => s.hideSheet);

  const { colors } = useTheme();
  const { t } = useTranslation();

  const isActive = endTime != null || endOfTrack;

  const handleClose = useCallback(() => {
    hideSheet();
  }, [hideSheet]);

  const handleSetTimer = useCallback(
    (seconds: number) => {
      setSleepTimer(seconds);
      hideSheet();
    },
    [hideSheet],
  );

  const handleEndOfTrack = useCallback(() => {
    setSleepTimerToTrackEnd();
    hideSheet();
  }, [hideSheet]);

  const handleCancel = useCallback(() => {
    clearSleepTimer();
    hideSheet();
  }, [hideSheet]);

  const dynamicStyles = useMemo(
    () =>
      StyleSheet.create({
        title: { color: colors.textPrimary },
        optionText: { color: colors.textPrimary },
        cancelText: { color: colors.red },
        border: { borderBottomColor: colors.border },
      }),
    [colors],
  );

  return (
    <BottomSheet visible={visible} onClose={handleClose}>
      <View style={styles.content}>
        <Text style={[styles.title, dynamicStyles.title]}>{t('sleepTimer')}</Text>

        {TIMER_OPTIONS.map((opt, index) => (
          <Pressable
            key={opt.seconds}
            onPress={() => handleSetTimer(opt.seconds)}
            style={({ pressed }) => [
              styles.option,
              index < TIMER_OPTIONS.length - 1 && dynamicStyles.border,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.optionText, dynamicStyles.optionText]}>{t(opt.labelKey)}</Text>
            <Ionicons name="time-outline" size={20} color={colors.textSecondary} />
          </Pressable>
        ))}

        <Pressable
          onPress={handleEndOfTrack}
          style={({ pressed }) => [
            styles.option,
            dynamicStyles.border,
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.optionText, dynamicStyles.optionText]}>
            {t('sleepTimerEndOfTrack')}
          </Text>
          <Ionicons name="musical-note-outline" size={20} color={colors.textSecondary} />
        </Pressable>

        {isActive && (
          <Pressable
            onPress={handleCancel}
            style={({ pressed }) => [styles.option, pressed && styles.pressed]}
          >
            <Text style={[styles.optionText, dynamicStyles.cancelText]}>
              {t('sleepTimerCancel')}
            </Text>
            <Ionicons name="close-circle-outline" size={20} color={colors.red} />
          </Pressable>
        )}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optionText: {
    fontSize: 16,
  },
  pressed: {
    opacity: 0.6,
  },
});
