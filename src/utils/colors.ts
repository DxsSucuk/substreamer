/**
 * Hex-colour helpers used by gradient-rendering components.
 *
 * Palette extraction itself now lives in the native `expo-image-colors`
 * module (see `useImagePalette`). These helpers remain for gradient-stop
 * alpha composition and theme-mix blending in `GradientBackground`,
 * `PlayerTabletLandscape`, and friends.
 */

/**
 * Append an alpha channel to a #RRGGBB hex color string.
 * Example: hexWithAlpha('#1D9BF0', 0.15) → '#1D9BF026'
 */
export function hexWithAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  return hex + a.toString(16).padStart(2, '0');
}

/**
 * Mix two #RRGGBB hex colors by a ratio (0 = pure base, 1 = pure blend).
 * Returns an opaque #RRGGBB string — no alpha channel involved.
 */
export function mixHexColors(base: string, blend: string, ratio: number): string {
  const t = Math.max(0, Math.min(1, ratio));
  const br = parseInt(base.slice(1, 3), 16);
  const bg = parseInt(base.slice(3, 5), 16);
  const bb = parseInt(base.slice(5, 7), 16);
  const lr = parseInt(blend.slice(1, 3), 16);
  const lg = parseInt(blend.slice(3, 5), 16);
  const lb = parseInt(blend.slice(5, 7), 16);
  const r = Math.round(br + (lr - br) * t);
  const g = Math.round(bg + (lg - bg) * t);
  const b = Math.round(bb + (lb - bb) * t);
  return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
}
