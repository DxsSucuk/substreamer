import * as librarySort from '../librarySort';

const { byTitle } = librarySort;

describe('byTitle', () => {
  it('orders by title', () => {
    expect([{ title: 'Zulu' }, { title: 'Alpha' }].sort(byTitle).map((s) => s.title)).toEqual([
      'Alpha',
      'Zulu',
    ]);
  });

  it('treats a missing title as empty rather than throwing', () => {
    expect([{ title: 'Alpha' }, {}].sort(byTitle).map((s) => s.title)).toEqual([undefined, 'Alpha']);
    expect(byTitle({}, {})).toBe(0);
  });
});

/**
 * The deliverable of step 3b: album/artist/playlist ordering exists ONCE, in SQL. A
 * second implementation here is what let the filtered lists order differently from
 * browse over the same data, so its absence is the property worth asserting.
 */
describe('the JS album/artist/playlist comparators', () => {
  it('are gone — ordering lives in SQL, on the stored sort keys', () => {
    expect(Object.keys(librarySort)).toEqual(['byTitle']);
  });
});
