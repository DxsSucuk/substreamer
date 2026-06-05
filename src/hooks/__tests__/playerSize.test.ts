import {
  getPlayerSize,
  SMALL_HEIGHT,
  TINY_HEIGHT,
  SMALL_WIDTH,
  TINY_WIDTH,
} from '../playerSize';

describe('getPlayerSize', () => {
  it('uses the regular tier on tall screens (full sizes, secondary row shown)', () => {
    const m = getPlayerSize(700);
    expect(m.showSecondaryRow).toBe(true);
    expect(m.playButton).toBe(64);
    expect(m.heroFloor).toBe(120);
  });

  it('compacts on small screens but keeps the secondary row', () => {
    const m = getPlayerSize(420);
    expect(m.showSecondaryRow).toBe(true);
    expect(m.playButton).toBeLessThan(64);
    expect(m.heroFloor).toBeLessThan(120);
  });

  it('drops the secondary row on the tiny tier and shrinks the most', () => {
    const m = getPlayerSize(340);
    expect(m.showSecondaryRow).toBe(false);
    expect(m.playButton).toBeLessThanOrEqual(48);
    expect(m.heroFloor).toBeLessThanOrEqual(64);
  });

  it('breakpoints: >= SMALL_HEIGHT regular, >= TINY_HEIGHT small, below tiny', () => {
    expect(getPlayerSize(SMALL_HEIGHT).playButton).toBe(64); // regular at the boundary
    expect(getPlayerSize(SMALL_HEIGHT - 1).showSecondaryRow).toBe(true); // small
    expect(getPlayerSize(SMALL_HEIGHT - 1).playButton).toBeLessThan(64);
    expect(getPlayerSize(TINY_HEIGHT).showSecondaryRow).toBe(true); // small at the boundary
    expect(getPlayerSize(TINY_HEIGHT - 1).showSecondaryRow).toBe(false); // tiny
  });

  it('every tier keeps a tappable play button (>= 44dp touch target)', () => {
    for (const h of [700, 420, 340, 200]) {
      expect(getPlayerSize(h).playButton).toBeGreaterThanOrEqual(44);
    }
  });

  it('defaults to unconstrained width (height-only callers keep behaviour)', () => {
    expect(getPlayerSize(700).showSecondaryRow).toBe(true);
    expect(getPlayerSize(700)).toEqual(getPlayerSize(700, Infinity));
  });

  it('a narrow width drops a tier even on a tall screen', () => {
    // Tall enough for regular by height, but narrow enough to compact.
    expect(getPlayerSize(700, SMALL_WIDTH - 1).playButton).toBeLessThan(64);
    expect(getPlayerSize(700, SMALL_WIDTH - 1).showSecondaryRow).toBe(true);
  });

  it('an 800×480-style device (tall but narrow) drops the secondary row', () => {
    // Portrait width below the tiny breakpoint forces the tiny tier regardless
    // of the ample vertical budget — issue #90's exact device.
    const m = getPlayerSize(700, TINY_WIDTH - 1);
    expect(m.showSecondaryRow).toBe(false);
    expect(m.playButton).toBeLessThanOrEqual(48);
  });

  it('uses the MOST constrained of height and width', () => {
    // Tiny height wins even on a wide screen, and vice versa.
    expect(getPlayerSize(TINY_HEIGHT - 1, 1000).showSecondaryRow).toBe(false);
    expect(getPlayerSize(1000, TINY_WIDTH - 1).showSecondaryRow).toBe(false);
    // Both comfortable → regular.
    expect(getPlayerSize(SMALL_HEIGHT, SMALL_WIDTH).showSecondaryRow).toBe(true);
    expect(getPlayerSize(SMALL_HEIGHT, SMALL_WIDTH).playButton).toBe(64);
  });
});
