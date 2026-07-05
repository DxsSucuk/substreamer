/**
 * EqualizerBands — a clean, reusable 10-band bipolar EQ slider grid.
 *
 * Each band is a vertical lane with a 0 dB centerline; the fill grows UP for a
 * boost and DOWN for a cut, so the row of bars is the EQ curve at a glance. Drag
 * anywhere on a lane to set that band's gain (clamped to ±12 dB). The knob +
 * fill are driven by a Reanimated shared value on the UI thread for smooth 60fps
 * dragging; `onBandChange` fires with the live value so callers can update the
 * engine + persist. Controlled by `gains`; external changes (preset apply) sync
 * back to the sliders while they're idle.
 */
import { memo, useCallback, useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {
  EQ_BAND_FREQUENCIES_HZ,
  EQ_GAIN_MAX_DB,
  EQ_GAIN_MIN_DB,
} from 'react-native-queue-player';

import { useTheme } from '../hooks/useTheme';
import { selectionAsync } from '../utils/haptics';

const TRACK_HEIGHT = 150;
const KNOB_SIZE = 16;
const USABLE = TRACK_HEIGHT - KNOB_SIZE;
const GAIN_SPAN = EQ_GAIN_MAX_DB - EQ_GAIN_MIN_DB;

export interface EqualizerBandsProps {
  /** Current gain (dB) per band; length = EQ_BAND_FREQUENCIES_HZ.length. */
  gains: number[];
  /** Dim + disable interaction when the EQ is off. */
  enabled: boolean;
  /** Fires with the live gain as a band is dragged. */
  onBandChange: (index: number, gainDb: number) => void;
}

function formatHz(hz: number): string {
  return hz >= 1000 ? `${Math.round(hz / 1000)}k` : `${Math.round(hz)}`;
}
function formatDb(db: number): string {
  const r = Math.round(db);
  return `${r > 0 ? '+' : ''}${r}`;
}

export const EqualizerBands = memo(function EqualizerBands({
  gains,
  enabled,
  onBandChange,
}: EqualizerBandsProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.row, !enabled && styles.dimmed]} pointerEvents={enabled ? 'auto' : 'none'}>
      {EQ_BAND_FREQUENCIES_HZ.map((hz, i) => (
        <View key={hz} style={styles.column}>
          <BandSlider
            index={i}
            gainDb={gains[i] ?? 0}
            onChange={onBandChange}
            colors={colors}
          />
          <Text style={[styles.freqLabel, { color: colors.textSecondary }]} numberOfLines={1}>
            {formatHz(hz)}
          </Text>
        </View>
      ))}
    </View>
  );
});

/** Map a gain (dB) to the knob's top offset within the track. */
function gainToTop(gainDb: number): number {
  'worklet';
  const ratio = (gainDb - EQ_GAIN_MIN_DB) / GAIN_SPAN; // 0..1 (bottom..top)
  return (1 - ratio) * USABLE;
}

const BandSlider = memo(function BandSlider({
  index,
  gainDb,
  onChange,
  colors,
}: {
  index: number;
  gainDb: number;
  onChange: (index: number, gainDb: number) => void;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const gain = useSharedValue(gainDb);
  const startGain = useSharedValue(0);
  const active = useSharedValue(0);
  const draggingRef = useRef(false);

  // Sync from the prop when the value changes externally (preset apply/reset)
  // and we're not mid-drag — animate for a nice morph.
  useEffect(() => {
    if (!draggingRef.current) gain.value = withTiming(gainDb, { duration: 140 });
  }, [gainDb, gain]);

  const setDragging = useCallback((v: boolean) => {
    draggingRef.current = v;
  }, []);

  const pan = Gesture.Pan()
    .activeOffsetY([-3, 3])
    .failOffsetX([-16, 16])
    .onBegin(() => {
      startGain.value = gain.value;
      active.value = withTiming(1, { duration: 120 });
      runOnJS(setDragging)(true);
      runOnJS(selectionAsync)();
    })
    .onUpdate((e) => {
      const dyDb = -(e.translationY / USABLE) * GAIN_SPAN;
      const next = Math.max(EQ_GAIN_MIN_DB, Math.min(EQ_GAIN_MAX_DB, startGain.value + dyDb));
      gain.value = next;
      runOnJS(onChange)(index, next);
    })
    .onFinalize(() => {
      active.value = withTiming(0, { duration: 160 });
      runOnJS(setDragging)(false);
    });

  const knobStyle = useAnimatedStyle(() => ({
    top: gainToTop(gain.value),
    transform: [{ scale: 1 + active.value * 0.25 }],
  }));

  // Bipolar fill: from the 0 dB centerline to the knob.
  const fillStyle = useAnimatedStyle(() => {
    const knobCenter = gainToTop(gain.value) + KNOB_SIZE / 2;
    const center = TRACK_HEIGHT / 2;
    return {
      top: Math.min(center, knobCenter),
      height: Math.abs(center - knobCenter),
    };
  });

  const labelStyle = useAnimatedStyle(() => ({ opacity: active.value }));

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.trackWrap} testID={`eq-band-${index}`}>
        <View style={[styles.track, { backgroundColor: colors.inputBg }]}>
          <View style={[styles.centerLine, { backgroundColor: colors.border }]} />
          <Animated.View style={[styles.fill, { backgroundColor: colors.primary }, fillStyle]} />
          <Animated.View
            style={[styles.knob, { backgroundColor: colors.primary, borderColor: colors.card }, knobStyle]}
          />
        </View>
        <Animated.Text style={[styles.dbLabel, { color: colors.textPrimary }, labelStyle]}>
          {formatDb(gainDb)}
        </Animated.Text>
      </View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4 },
  dimmed: { opacity: 0.4 },
  column: { alignItems: 'center', flex: 1 },
  trackWrap: { alignItems: 'center', width: 34, height: TRACK_HEIGHT + 16 },
  track: {
    width: 6,
    height: TRACK_HEIGHT,
    borderRadius: 3,
    overflow: 'visible',
  },
  centerLine: {
    position: 'absolute',
    top: TRACK_HEIGHT / 2,
    left: -4,
    right: -4,
    height: StyleSheet.hairlineWidth,
  },
  fill: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderRadius: 3,
  },
  knob: {
    position: 'absolute',
    left: (6 - KNOB_SIZE) / 2,
    width: KNOB_SIZE,
    height: KNOB_SIZE,
    borderRadius: KNOB_SIZE / 2,
    borderWidth: 2,
  },
  dbLabel: {
    position: 'absolute',
    top: -2,
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  freqLabel: { fontSize: 10, marginTop: 4, fontVariant: ['tabular-nums'] },
});
