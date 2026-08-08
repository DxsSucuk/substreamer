// Mock expo-sqlite with a minimal no-op DB so `persistence/db.ts`'s
// module-scope init succeeds on import. Individual tests override the
// shared handle via `db.__setDbForTests` with a richer fake.
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
  clearScrobbles,
  countScrobbles,
  hydrateScrobblesAsync,
  insertScrobble,
  replaceAllScrobbles,
} from '../scrobbleTable';

/** Minimal InternalDb fake that records rows in a Map keyed by id. */
function makeFakeDb() {
  const rows = new Map<string, { id: string; song_json: string; time: number }>();

  const runSync = (sql: string, params: readonly unknown[] = []): void => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('INSERT OR IGNORE INTO scrobble_events')) {
      const [id, song_json, time] = params as [string, string, number];
      if (!rows.has(id)) {
        rows.set(id, { id, song_json, time });
      }
    } else if (s.startsWith('DELETE FROM scrobble_events')) {
      rows.clear();
    } else {
      throw new Error(`unhandled SQL in fake: ${s}`);
    }
  };

  const getFirstSync = <T,>(sql: string): T | undefined => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('COUNT(*) AS c FROM scrobble_events')) {
      return { c: rows.size } as T;
    }
    return undefined;
  };

  const getAllSync = <T,>(sql: string): T[] => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT id, song_json, time FROM scrobble_events')) {
      // Mimic ORDER BY time ASC so hydrate order assertions are meaningful.
      return Array.from(rows.values()).sort((a, b) => a.time - b.time) as T[];
    }
    return [];
  };

  return {
    rows,
    getFirstSync,
    getAllSync,
    runSync,
    execSync: () => {},
    withTransactionSync: (fn: () => void) => fn(),
    // Async delegates — the write API is async now.
    runAsync: (sql: string, params?: readonly unknown[]) => Promise.resolve(runSync(sql, params) as any),
    getFirstAsync: <T,>(sql: string) => Promise.resolve(getFirstSync<T>(sql)),
    getAllAsync: <T,>(sql: string) => Promise.resolve(getAllSync<T>(sql)),
    runAtomicBatchAsync: async (commands: ReadonlyArray<readonly [string, readonly unknown[]]>) => {
      for (const [sql, params] of commands) runSync(sql, params);
    },
  };
}

function makeScrobble(overrides?: Record<string, any>): any {
  return {
    id: 'sc-1',
    song: { id: 's1', title: 'Song One', artist: 'Artist', duration: 180 },
    time: 1_700_000_000_000,
    ...overrides,
  };
}

let fakeDb: ReturnType<typeof makeFakeDb>;

beforeEach(() => {
  fakeDb = makeFakeDb();
  __setDbForTests(fakeDb as any);
});

afterEach(() => {
  __setDbForTests(null);
});

describe('scrobbleTable — insert + hydrate', () => {
  it('insertScrobble + hydrateScrobblesAsync round-trip preserves fields', async () => {
    const s = makeScrobble();
    await insertScrobble(s);

    const restored = await hydrateScrobblesAsync();
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe('sc-1');
    expect(restored[0].time).toBe(1_700_000_000_000);
    expect(restored[0].song.id).toBe('s1');
    expect(restored[0].song.title).toBe('Song One');
    expect(restored[0].song.artist).toBe('Artist');
  });

  it('insertScrobble is INSERT OR IGNORE — duplicate ids are silently skipped', async () => {
    await insertScrobble(makeScrobble({ id: 'dup', time: 1 }));
    await insertScrobble(makeScrobble({ id: 'dup', time: 999, song: { id: 's2', title: 'Different' } }));

    expect(await countScrobbles()).toBe(1);
    const restored = await hydrateScrobblesAsync();
    // First insert wins (INSERT OR IGNORE) — neither time nor song should change.
    expect(restored[0].time).toBe(1);
    expect(restored[0].song.id).toBe('s1');
  });

  it('insertScrobble skips records missing id / song.id / song.title', async () => {
    await insertScrobble(makeScrobble({ id: '' }));
    await insertScrobble(makeScrobble({ id: 'bad-song-id', song: { id: '', title: 'x' } }));
    await insertScrobble(makeScrobble({ id: 'no-title', song: { id: 's1', title: '' } }));
    await insertScrobble(makeScrobble({ id: 'null-song', song: null }));

    expect(await countScrobbles()).toBe(0);
  });
});

describe('scrobbleTable — replaceAllScrobbles', () => {
  it('wipes existing rows and inserts the new set', async () => {
    await insertScrobble(makeScrobble({ id: 'old-1' }));
    await insertScrobble(makeScrobble({ id: 'old-2' }));
    expect(await countScrobbles()).toBe(2);

    await replaceAllScrobbles([
      makeScrobble({ id: 'new-1', time: 5 }),
      makeScrobble({ id: 'new-2', time: 10 }),
    ]);

    expect(await countScrobbles()).toBe(2);
    const restored = await hydrateScrobblesAsync();
    expect(restored.map((s) => s.id).sort()).toEqual(['new-1', 'new-2']);
  });

  it('drops invalid / duplicate records before inserting', async () => {
    await replaceAllScrobbles([
      makeScrobble({ id: 'ok' }),
      makeScrobble({ id: 'ok' }),
      makeScrobble({ id: '' }),
      makeScrobble({ id: 'bad-song', song: { id: '', title: 'x' } }),
      makeScrobble({ id: 'no-title', song: { id: 's1', title: '' } }),
      makeScrobble({ id: 'null-song', song: null }),
    ] as any);

    expect(await countScrobbles()).toBe(1);
    const restored = await hydrateScrobblesAsync();
    expect(restored[0].id).toBe('ok');
  });

  it('replaceAllScrobbles with empty array clears the table', async () => {
    await insertScrobble(makeScrobble({ id: 'a' }));
    await replaceAllScrobbles([]);
    expect(await countScrobbles()).toBe(0);
  });
});

describe('scrobbleTable — clearScrobbles', () => {
  it('wipes the table', async () => {
    await insertScrobble(makeScrobble({ id: 'a' }));
    await insertScrobble(makeScrobble({ id: 'b' }));
    await clearScrobbles();
    expect(await countScrobbles()).toBe(0);
    expect(await hydrateScrobblesAsync()).toEqual([]);
  });

  it('is safe to call on an empty table', async () => {
    await expect(clearScrobbles()).resolves.toBeUndefined();
    expect(await countScrobbles()).toBe(0);
  });
});

describe('scrobbleTable — disabled db (healthy=false path)', () => {
  beforeEach(() => {
    __setDbForTests(null);
  });

  it('all mutations are no-ops when db is unavailable', async () => {
    await insertScrobble(makeScrobble());
    await replaceAllScrobbles([makeScrobble()]);
    await clearScrobbles();
    expect(await countScrobbles()).toBe(0);
    expect(await hydrateScrobblesAsync()).toEqual([]);
  });
});

describe('scrobbleTable — db throws (error swallow path)', () => {
  const throwingDb = {
    getFirstSync() {
      throw new Error('boom');
    },
    getAllSync() {
      throw new Error('boom');
    },
    runSync() {
      throw new Error('boom');
    },
    execSync() {
      throw new Error('boom');
    },
    withTransactionSync() {
      throw new Error('boom');
    },
    getFirstAsync() {
      return Promise.reject(new Error('boom'));
    },
    getAllAsync() {
      return Promise.reject(new Error('boom'));
    },
    runAsync() {
      return Promise.reject(new Error('boom'));
    },
    runAtomicBatchAsync() {
      return Promise.reject(new Error('boom'));
    },
  };

  beforeEach(() => {
    __setDbForTests(throwingDb as any);
  });

  it('mutations swallow errors and do not propagate', async () => {
    await expect(insertScrobble(makeScrobble())).resolves.toBeUndefined();
    await expect(replaceAllScrobbles([makeScrobble()])).resolves.toBeUndefined();
    await expect(clearScrobbles()).resolves.toBeUndefined();
  });

  it('reads return safe defaults on DB error', async () => {
    expect(await countScrobbles()).toBe(0);
    expect(await hydrateScrobblesAsync()).toEqual([]);
  });
});
