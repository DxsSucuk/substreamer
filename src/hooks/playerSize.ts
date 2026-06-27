/**
 * Height- AND width-tiered sizing for the phone Now Playing screen.
 *
 * Very small Android devices (e.g. an 800×480 MP3 player — issue #90) don't have
 * room for the full-size player: the fixed control rows + tab bar get pushed
 * behind the system nav bar, and on a narrow portrait width the control rows
 * overflow off both edges. Rather than scroll, we compact the layout in tiers —
 * smaller art floor, controls, fonts, paddings and tighter horizontal layout —
 * and on the smallest tier we drop the optional secondary controls row entirely
 * so the essential transport controls always stay on screen.
 *
 * The tier is the MOST CONSTRAINED of two budgets:
 *  - `availableHeight`: window height minus the top/bottom safe-area insets and
 *    the header bar (the vertical space the player content itself gets).
 *  - `availableWidth`: the window width (drives horizontal overflow + whether
 *    the side controls fit alongside the transport cluster).
 * A 800×480 device has ample height in portrait but a narrow width, so width is
 * what forces it onto the compact tiers — height alone would miss it.
 */
interface PlayerSize {
  /** Minimum cover-art size; the art shrinks to fill but never below this. */
  heroFloor: number;
  heroPadBottom: number;
  titleFont: number;
  artistFont: number;
  infoMarginBottom: number;
  progressMarginBottom: number;
  controlsPadV: number;
  /** Play/pause circle diameter. */
  playButton: number;
  /** Play/pause glyph size inside the circle. */
  playIcon: number;
  /** Prev/next glyph size. */
  transportIcon: number;
  /** Shuffle/repeat glyph size. */
  sideIcon: number;
  /** Width of the centre transport cluster (prev/play/next). Clamped to the
   *  available width by the consumer so the side controls never overflow. */
  transportWidth: number;
  /** Width of the secondary-row centre cluster (skip/rate). */
  secondaryCenterWidth: number;
  /** Secondary row (sleep / skip-interval / rate / bookmark) — hidden on tiny. */
  showSecondaryRow: boolean;
  /** Estimate of the non-hero fixed content height, fed to the art-fit calc. */
  reserved: number;
}

const REGULAR: PlayerSize = {
  heroFloor: 120, heroPadBottom: 24, titleFont: 22, artistFont: 16,
  infoMarginBottom: 16, progressMarginBottom: 8, controlsPadV: 8,
  playButton: 64, playIcon: 32, transportIcon: 32, sideIcon: 28,
  transportWidth: 248, secondaryCenterWidth: 248,
  showSecondaryRow: true, reserved: 342,
};

const SMALL: PlayerSize = {
  heroFloor: 92, heroPadBottom: 14, titleFont: 19, artistFont: 14,
  infoMarginBottom: 10, progressMarginBottom: 6, controlsPadV: 5,
  playButton: 56, playIcon: 28, transportIcon: 28, sideIcon: 26,
  transportWidth: 220, secondaryCenterWidth: 220,
  showSecondaryRow: true, reserved: 300,
};

const TINY: PlayerSize = {
  heroFloor: 64, heroPadBottom: 8, titleFont: 17, artistFont: 13,
  infoMarginBottom: 6, progressMarginBottom: 4, controlsPadV: 3,
  playButton: 48, playIcon: 24, transportIcon: 26, sideIcon: 24,
  transportWidth: 188, secondaryCenterWidth: 188,
  showSecondaryRow: false, reserved: 224,
};

/** Tiers ordered least → most constrained; index used to pick the worst case. */
const TIERS = [REGULAR, SMALL, TINY];

/** Content-budget breakpoints (dp) below which we step down a tier. */
export const SMALL_HEIGHT = 480;
export const TINY_HEIGHT = 380;
/** Portrait-width breakpoints (dp) below which we step down a tier. */
export const SMALL_WIDTH = 400;
export const TINY_WIDTH = 360;

function heightTier(availableHeight: number): number {
  if (availableHeight < TINY_HEIGHT) return 2;
  if (availableHeight < SMALL_HEIGHT) return 1;
  return 0;
}

function widthTier(availableWidth: number): number {
  if (availableWidth < TINY_WIDTH) return 2;
  if (availableWidth < SMALL_WIDTH) return 1;
  return 0;
}

/**
 * Pick the player size tier for a given content-height budget and portrait
 * width (dp). The tier is the most constrained of the two — a screen that is
 * short OR narrow drops a tier; below the tiny breakpoint on either axis we drop
 * the secondary controls row. `availableWidth` defaults to "unconstrained" so
 * existing height-only callers/tests keep their behaviour.
 */
export function getPlayerSize(
  availableHeight: number,
  availableWidth = Number.POSITIVE_INFINITY,
): PlayerSize {
  return TIERS[Math.max(heightTier(availableHeight), widthTier(availableWidth))];
}
