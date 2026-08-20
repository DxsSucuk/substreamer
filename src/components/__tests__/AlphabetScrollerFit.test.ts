import { fitStrip } from '../AlphabetScroller';

const ALL = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** What `resolveLetterFromY` does, so a fit can be checked against the real mapping. */
const letterAtOffset = (relativeY: number, stripHeight: number, letters: string[]): string => {
  const clamped = Math.max(0, Math.min(relativeY, stripHeight));
  return letters[Math.min(Math.floor((clamped / stripHeight) * letters.length), letters.length - 1)];
};

describe('fitStrip', () => {
  it('keeps the full-size strip when there is room for it', () => {
    const { letters, lineHeight } = fitStrip(600, ALL);
    expect(letters).toEqual(ALL);
    expect(lineHeight).toBe(20);
  });

  it('never renders a strip taller than its container', () => {
    // The bug: 27 letters x 20pt is a fixed 540pt, so a shorter container centred it and
    // let both ends spill off screen. Every height a phone can produce must fit.
    for (let h = 60; h <= 900; h += 7) {
      const { letters, lineHeight } = fitStrip(h, ALL);
      expect(letters.length * lineHeight).toBeLessThanOrEqual(h);
    }
  });

  it('keeps every letter reachable at the size the container forces', () => {
    // The end letters were the casualties: the mapping divides by the whole strip
    // height, so anything hanging off the container could never be resolved.
    const { letters, lineHeight } = fitStrip(418, ALL);
    const stripHeight = letters.length * lineHeight;
    const reached = new Set(
      Array.from({ length: stripHeight }, (_, y) => letterAtOffset(y, stripHeight, letters)),
    );
    expect(reached.size).toBe(letters.length);
    expect(letterAtOffset(0, stripHeight, letters)).toBe('#');
    expect(letterAtOffset(stripHeight, stripHeight, letters)).toBe('Z');
  });

  it('thins the strip rather than overflowing when even 12pt will not fit', () => {
    // Landscape phone: 27 letters need 324pt at the smallest legible size.
    const { letters, lineHeight } = fitStrip(200, ALL);
    expect(letters.length).toBeLessThan(ALL.length);
    expect(letters.length * lineHeight).toBeLessThanOrEqual(200);
    // Both ends survive the thinning — they are the ones users reach for.
    expect(letters[0]).toBe('#');
    expect(letters[letters.length - 1]).toBe('Z');
  });

  it('leaves a short filtered letter set alone', () => {
    // The Downloaded/Favourites lists derive a small subset from their items; it already
    // fits, so the fit must not shrink it.
    const few = ['A', 'D', 'M'];
    expect(fitStrip(418, few)).toEqual({ letters: few, lineHeight: 20 });
  });

  it('holds the full size until the container has been measured', () => {
    expect(fitStrip(0, ALL)).toEqual({ letters: ALL, lineHeight: 20 });
  });
});
