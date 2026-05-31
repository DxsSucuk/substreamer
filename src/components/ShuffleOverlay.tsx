import Ionicons from "@react-native-vector-icons/ionicons/static";
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';

import { type ThemeColors } from '../constants/theme';
import { absoluteFill } from '../utils/styles';

export interface ShuffleOverlayProps {
  visible: boolean;
  overlayStyle: AnimatedStyle<ViewStyle>;
  spinStyle: AnimatedStyle<ViewStyle>;
  colors: ThemeColors;
}

/** Full-screen "Shuffling…" spin overlay. Drive with `useShuffleOverlay`. */
export const ShuffleOverlay = memo(function ShuffleOverlay({
  visible,
  overlayStyle,
  spinStyle,
  colors,
}: ShuffleOverlayProps) {
  const { t } = useTranslation();

  if (!visible) return null;

  return (
    <Animated.View style={[styles.shuffleOverlay, overlayStyle]} pointerEvents="auto">
      <View style={[styles.shuffleCard, { backgroundColor: colors.card }]}>
        <Animated.View style={spinStyle}>
          <Ionicons name="shuffle" size={32} color={colors.primary} />
        </Animated.View>
        <Text style={[styles.shuffleText, { color: colors.textPrimary }]}>
          {t('shuffling')}
        </Text>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  shuffleOverlay: {
    ...absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  shuffleCard: {
    borderRadius: 16,
    paddingHorizontal: 32,
    paddingVertical: 24,
    alignItems: 'center',
    gap: 12,
  },
  shuffleText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
