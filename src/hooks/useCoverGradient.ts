import { useTheme } from './useTheme';
import { useImagePalette } from './useImagePalette';

/** Player hero gradient stops: solid top colour → fade by 60% height. */
const PLAYER_GRADIENT_LOCATIONS: readonly [number, number, ...number[]] = [0, 0.6];

/**
 * Derives the player hero's cover-art gradient colours from the extracted
 * palette: a 2-stop gradient from the top colour (secondary → primary → theme
 * background) to `endColor`. Returns the raw `gradientOpacity` shared value so
 * each player surface animates it its own way (phone/tablet-portrait fade it
 * straight in; landscape folds it into its expand animation).
 */
export function useCoverGradient(coverArtId: string | undefined, endColor: string) {
  const { colors } = useTheme();
  const { primary, secondary, gradientOpacity } = useImagePalette(coverArtId);
  const gradientTopColor = secondary ?? primary ?? colors.background;
  const gradientColors: readonly [string, string, ...string[]] = [gradientTopColor, endColor];
  return { gradientColors, gradientLocations: PLAYER_GRADIENT_LOCATIONS, gradientOpacity };
}
