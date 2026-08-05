import { mergeStarredDesc, type StarredEntry } from '../mergeStarredDesc';

const e = (id: string, starred: number): StarredEntry<{ id: string }> => ({
  id,
  starred,
  item: { id },
});

const order = (rows: StarredEntry<{ id: string }>[]) => rows.map((r) => r.id);

describe('mergeStarredDesc', () => {
  it('returns the library half unchanged when the remainder is empty', () => {
    const lib = [e('s3', 300), e('s2', 200), e('s1', 100)];
    expect(order(mergeStarredDesc(lib, []))).toEqual(['s3', 's2', 's1']);
  });

  it('returns the remainder unchanged when the library half is empty', () => {
    const rem = [e('r2', 200), e('r1', 100)];
    expect(order(mergeStarredDesc([], rem))).toEqual(['r2', 'r1']);
  });

  it('is empty when both halves are', () => {
    expect(mergeStarredDesc([], [])).toEqual([]);
  });

  it('interleaves both halves by descending starred', () => {
    const lib = [e('s4', 400), e('s2', 200)];
    const rem = [e('r3', 300), e('r1', 100)];
    expect(order(mergeStarredDesc(lib, rem))).toEqual(['s4', 'r3', 's2', 'r1']);
  });

  it('breaks equal starred values by descending id', () => {
    const lib = [e('b', 100)];
    const rem = [e('c', 100), e('a', 100)];
    expect(order(mergeStarredDesc(lib, rem))).toEqual(['c', 'b', 'a']);
  });

  it('sorts 0 (no server date) last, in both halves', () => {
    const lib = [e('s1', 500), e('s0', 0)];
    const rem = [e('r1', 250), e('r0', 0)];
    expect(order(mergeStarredDesc(lib, rem))).toEqual(['s1', 'r1', 's0', 'r0']);
  });

  it('orders non-ASCII BMP ids the way SQLite BINARY does', () => {
    // "Ä" (U+00C4) > "A" byte-wise and code-unit-wise; both halves agree.
    const lib = [e('Ä', 100)];
    const rem = [e('A', 100)];
    expect(order(mergeStarredDesc(lib, rem))).toEqual(['Ä', 'A']);
  });

  it('does NOT dedup — disjointness is the remainder query\'s job, not the merge\'s', () => {
    // Same id on both sides with DIFFERENT starred values: the copies are non-adjacent,
    // so an adjacent-pair dedup would not have caught it either. The repository test
    // asserts the query never produces this.
    const lib = [e('dup', 900)];
    const rem = [e('dup', 0)];
    expect(order(mergeStarredDesc(lib, rem))).toEqual(['dup', 'dup']);
  });
});
