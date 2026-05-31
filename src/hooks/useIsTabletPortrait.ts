import { useWindowDimensions } from 'react-native';

/**
 * True when the device is a tablet (smallest screen dimension ≥ 600dp, matching
 * the `IS_TABLET` rule in app/_layout.tsx) currently held in portrait. Used to
 * route the /player screen to the tablet-portrait layout; phones and
 * tablet-landscape are unaffected.
 */
export function useIsTabletPortrait(): boolean {
  const { width, height } = useWindowDimensions();
  return height >= width && Math.min(width, height) >= 600;
}
