// Minimal expo-sqlite mock so persistence/db.ts module init succeeds on import;
// each test swaps in a richer fake via __setDbForTests.
jest.mock('expo-sqlite', () => ({
  openDatabaseSync: () => ({
    getFirstSync: () => undefined,
    getAllSync: () => [],
    runSync: () => {},
    execSync: () => {},
    withTransactionSync: (fn: () => void) => fn(),
  }),
}));

import { __setDbForTests } from '../db';
import {
  querySongCandidates,
  queryAlbumCandidates,
  hasLocalLibraryRows,
} from '../searchIndexQueries';

interface Call {
  sql: string;
  params: readonly unknown[];
}

/** Fake InternalDb whose getAllAsync returns a canned row set per tier, keyed
 *  off recognizable fragments of the SQL, and records every call. The exact tier
 *  and the prefix tier both return row `a` so dedup can be asserted. */
function makeFakeDb(calls: Call[], titleCol = 'norm_title') {
  const rj = (id: string, title: string) => ({ id, raw_json: JSON.stringify({ id, title }) });
  return {
    getAllAsync: async (sql: string, params: readonly unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (s.includes('dmeta_')) return [rj('c', 'Phonetic')]; // phonetic tier
      if (s.includes(' OR ')) return [rj('d', 'Infix')]; // infix tier (title OR artist)
      if (s.includes('LIKE ?')) return [rj('a', 'Dup'), rj('b', 'Prefix')]; // prefix (a duplicates exact)
      if (s.includes(`${titleCol} = ?`)) return [rj('a', 'Exact')]; // exact tier
      return [];
    },
    getFirstAsync: async () => undefined,
    withTransactionAsync: async (fn: () => Promise<void>) => fn(),
    runAsync: async () => ({ changes: 0, lastInsertRowId: 0 }),
  } as any;
}

afterEach(() => __setDbForTests(null));

describe('querySongCandidates', () => {
  it('runs all four tiers, dedups by id in tier-priority order, and parses envelopes', async () => {
    const calls: Call[] = [];
    __setDbForTests(makeFakeDb(calls));
    const out = await querySongCandidates('test song', ['test', 'song'], ['TST', 'SNK']);
    // exact(a) → prefix(a dup, b) → infix(d) → phonetic(c)
    expect(out.map((c) => c.id)).toEqual(['a', 'b', 'd', 'c']);
    expect(out[0].title).toBe('Exact'); // first-seen wins for a
    expect(calls).toHaveLength(4);
  });

  it('skips the phonetic tier when there are no non-empty dmeta tokens (non-Latin input)', async () => {
    const calls: Call[] = [];
    __setDbForTests(makeFakeDb(calls));
    await querySongCandidates('テスト', ['テスト'], []); // empty dmeta → no phonetic query
    expect(calls.some((c) => c.sql.includes('dmeta_'))).toBe(false);
  });

  it('empty normalized query issues no queries and returns []', async () => {
    const calls: Call[] = [];
    __setDbForTests(makeFakeDb(calls));
    expect(await querySongCandidates('', [], [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('returns [] when the db is unavailable', async () => {
    __setDbForTests(null);
    expect(await querySongCandidates('x', ['x'], ['X'])).toEqual([]);
  });

  it('caps each tier with a LIMIT clause', async () => {
    const calls: Call[] = [];
    __setDbForTests(makeFakeDb(calls));
    await querySongCandidates('test', ['test'], ['TST']);
    expect(calls.every((c) => /LIMIT \d+/.test(c.sql))).toBe(true);
  });
});

describe('queryAlbumCandidates', () => {
  it('runs the analogous album tiers over norm_name/dmeta_name', async () => {
    const calls: Call[] = [];
    __setDbForTests(makeFakeDb(calls, 'norm_name'));
    const out = await queryAlbumCandidates('greatest hits', ['greatest', 'hits'], ['KRTST']);
    expect(out.map((a) => a.id)).toEqual(['a', 'b', 'd', 'c']);
    expect(calls.every((c) => c.sql.includes('library_albums'))).toBe(true);
  });
});

describe('hasLocalLibraryRows', () => {
  it('true when song_index has a row', async () => {
    __setDbForTests({ getFirstAsync: async () => ({ x: 1 }) } as any);
    expect(await hasLocalLibraryRows()).toBe(true);
  });

  it('false when song_index is empty', async () => {
    __setDbForTests({ getFirstAsync: async () => null } as any);
    expect(await hasLocalLibraryRows()).toBe(false);
  });

  it('false when the db is unavailable', async () => {
    __setDbForTests(null);
    expect(await hasLocalLibraryRows()).toBe(false);
  });
});
