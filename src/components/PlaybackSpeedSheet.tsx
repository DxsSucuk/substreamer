/**
 * PlaybackSpeedSheet — bottom-sheet picker for playback speed (+ a pitch
 * correction selector, currently hidden), opened from the player's
 * PlaybackRateButton.
 *
 * Speed: every supported rate (slowest → fastest) as a wrapping grid of pills
 * so all options stay visible at once; the current rate is highlighted and
 * tapping another applies it immediately (the sheet stays open so the user can
 * keep adjusting).
 *
 * Pitch correction (None / Voice / Music): UI is gated off via
 * SHOW_PITCH_CORRECTION until the audio-processing backing is wired up — the
 * store setting + selector code stay in place ready to re-enable (see
 * plans/playback-rate-pitch-correction.md).
 */

import { memo, useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { BottomSheet } from './BottomSheet';
import { useTheme } from '../hooks/useTheme';
import { applyPlaybackRate } from '../services/playerService';
import {
  PITCH_CORRECTION_MODES,
  PLAYBACK_RATES,
  playbackSettingsStore,
  type PitchCorrection,
  type PlaybackRate,
} from '../store/playbackSettingsStore';
import { selectionAsync } from '../utils/haptics';

/**
 * Hide the pitch-correction selector until the audio-processing backing is
 * implemented. Flip to `true` once the player honours the setting.
 */
const SHOW_PITCH_CORRECTION = false;

/** Compact rate label: 1 → "1x", 0.75 → ".75x", 1.25 → "1.25x". */
function formatRate(rate: number): string {
  if (Number.isInteger(rate)) return `${rate}x`;
  if (rate < 1) return `${rate.toString().replace('0.', '.')}x`;
  return `${rate}x`;
}

const PITCH_LABEL_KEYS: Record<PitchCorrection, string> = {
  none: 'pitchCorrectionNone',
  voice: 'pitchCorrectionVoice',
  music: 'pitchCorrectionMusic',
};

interface Props {
  visible: boolean;
  onClose: () => void;
}

export const PlaybackSpeedSheet = memo(function PlaybackSpeedSheet({ visible, onClose }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const playbackRate = playbackSettingsStore((s) => s.playbackRate);
  const pitchCorrection = playbackSettingsStore((s) => s.pitchCorrection);
  const setPitchCorrection = playbackSettingsStore((s) => s.setPitchCorrection);

  const handleSelectRate = useCallback((rate: PlaybackRate) => {
    selectionAsync();
    void applyPlaybackRate(rate);
  }, []);

  const handleSelectPitch = useCallback(
    (mode: PitchCorrection) => {
      selectionAsync();
      setPitchCorrection(mode);
    },
    [setPitchCorrection],
  );

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="55%" scrollable={false}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{t('playbackSpeed')}</Text>

      <View style={styles.speedGrid}>
        {PLAYBACK_RATES.map((rate) => {
          const active = rate === playbackRate;
          return (
            <Pressable
              key={rate}
              onPress={() => handleSelectRate(rate)}
              style={({ pressed }) => [
                styles.pill,
                { backgroundColor: active ? colors.primary : colors.inputBg },
                pressed && styles.pillPressed,
              ]}
            >
              <Text
                style={[styles.pillLabel, { color: active ? '#fff' : colors.textSecondary }]}
                allowFontScaling={false}
                numberOfLines={1}
              >
                {formatRate(rate)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {SHOW_PITCH_CORRECTION && (
        <>
          <Text style={[styles.sectionLabel, { color: colors.label }]}>
            {t('pitchCorrection')}
          </Text>
          <View style={styles.pitchRow}>
            {PITCH_CORRECTION_MODES.map((mode) => {
              const active = mode === pitchCorrection;
              return (
                <Pressable
                  key={mode}
                  onPress={() => handleSelectPitch(mode)}
                  style={({ pressed }) => [
                    styles.pill,
                    styles.pitchPill,
                    { backgroundColor: active ? colors.primary : colors.inputBg },
                    pressed && styles.pillPressed,
                  ]}
                >
                  <Text
                    style={[styles.pillLabel, { color: active ? '#fff' : colors.textSecondary }]}
                  >
                    {t(PITCH_LABEL_KEYS[mode])}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}
    </BottomSheet>
  );
});

const styles = StyleSheet.create({
  title: { fontSize: 18, fontWeight: '700', paddingHorizontal: 4, marginBottom: 14 },
  speedGrid: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 4,
    paddingBottom: 4,
  },
  pill: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 2,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillPressed: { opacity: 0.7 },
  pillLabel: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 4,
    marginTop: 24,
    marginBottom: 10,
  },
  pitchRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 4 },
  pitchPill: { flex: 1 },
});
