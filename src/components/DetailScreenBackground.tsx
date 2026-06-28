import { LinearGradient } from 'expo-linear-gradient';
import { useMemo } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import {
  DARK_MIX,
  GRADIENT_LOCATIONS,
  GRADIENT_MIX_CURVE,
  LIGHT_MIX,
} from './GradientBackground';
import { useTheme } from '../hooks/useTheme';
import { SKIP_COLOR_EXTRACTION, useImagePalette } from '../hooks/useImagePalette';
import { mixHexColors } from '../utils/colors';
import { absoluteFill } from '../utils/styles';

/** 2-stop cover gradient: extracted top colour → theme background. */
const DETAIL_GRADIENT_LOCATIONS: readonly [number, number, ...number[]] = [0, 0.5];

/**
 * Shared hero background for the album / artist / playlist detail screens.
 * Renders three layers behind the screen content:
 *   1. an opaque theme-background fill,
 *   2. the animated cover-art gradient (fades in once the palette resolves),
 *   3. on wide / tablet layouts, a theme-tinted top gradient — cover
 *      extraction is skipped there, so layer 2 stays invisible.
 *
 * Drop it as the first child of the screen's `styles.container` view. The
 * gradient extends under the header via the `-insets.top` offset.
 */
export function DetailScreenBackground({
  coverArt,
  isWide,
}: {
  coverArt: string | undefined;
  isWide: boolean;
}) {
  const { theme, colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { primary, secondary, gradientOpacity } = useImagePalette(
    isWide ? SKIP_COLOR_EXTRACTION : coverArt,
  );

  const themeGradientColors = useMemo(() => {
    if (!isWide) return null;
    const peak = theme === 'dark' ? DARK_MIX : LIGHT_MIX;
    return GRADIENT_MIX_CURVE.map((m) =>
      mixHexColors(colors.background, colors.primary, peak * m),
    ) as [string, string, ...string[]];
  }, [isWide, theme, colors.primary, colors.background]);

  const gradientTopColor = secondary ?? primary ?? colors.background;
  const gradientColors: readonly [string, string, ...string[]] = [gradientTopColor, colors.background];

  const gradientAnimatedStyle = useAnimatedStyle(() => ({
    opacity: gradientOpacity.value,
  }));

  const gradientFillStyle = [
    absoluteFill,
    { top: -insets.top, left: 0, right: 0, bottom: 0 },
  ];

  return (
    <>
      <View style={[gradientFillStyle, { backgroundColor: colors.background }]} />
      <Animated.View style={[gradientFillStyle, gradientAnimatedStyle]} pointerEvents="none">
        <LinearGradient
          colors={gradientColors}
          locations={DETAIL_GRADIENT_LOCATIONS}
          style={absoluteFill}
        />
      </Animated.View>
      {themeGradientColors && (
        <LinearGradient
          colors={themeGradientColors}
          locations={[...GRADIENT_LOCATIONS]}
          style={gradientFillStyle}
          pointerEvents="none"
        />
      )}
    </>
  );
}
