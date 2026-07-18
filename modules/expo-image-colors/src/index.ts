import ExpoImageColorsModule, {
  type Palette,
  type PaletteMode,
} from './ExpoImageColorsModule';

export type { Palette, PaletteMode };

/**
 * Extract a two-colour palette from a local image for theme-appropriate
 * gradient backgrounds. Returns both dark-mode and light-mode variants
 * in one call — the heavy pixel iteration runs once per image.
 *
 * Algorithm (bit-identical on iOS and Android):
 *  1. Decode image into an RGB pixel buffer.
 *  2. Per pixel, convert sRGB → Oklab via the piecewise linearisation and
 *     Björn Ottosson's reference matrices.
 *  3. Reject near-black (Oklab L < 0.10), near-white (L > 0.96), and
 *     near-grey (chroma < 0.04) pixels.
 *  4. Bucket surviving pixels into 24 hue bins × 15°.
 *  5. Primary = the dominant hue: max (count × avgChroma^k) bucket
 *     (population-led, chroma a mild tiebreak; k = 0.5) — the colour that
 *     fills most of the artwork. Secondary = max count bucket with hue ≥ 60°
 *     from the primary, else null (monochromatic image).
 *  6. For each selected bucket, weighted-average linear-RGB → Oklab.
 *  7. Clamp Oklab L into safe lightness bands for text contrast:
 *       dark variant  → [0.22, 0.40], with WCAG Y ≤ 0.18 fallback
 *                       (3:1 vs white icons), hard floor 0.15.
 *       light variant → [0.75, 0.90], with WCAG Y ≥ 0.55 fallback
 *                       (3:1 vs black icons), hard ceiling 0.96.
 *     Chroma is reduced only if the clamp pushes the colour out of sRGB gamut.
 *  8. Oklab → linear RGB → sRGB → `#RRGGBB`.
 *
 * Returns `null` when the image can't be decoded or contains no usable
 * colour. Callers should fall back to theme defaults in that case.
 */
export function getImagePaletteAsync(uri: string): Promise<Palette | null> {
  return ExpoImageColorsModule.getImagePaletteAsync(uri);
}
