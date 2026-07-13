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
  clearPendingScrobbles,
  deletePendingScrobble,
  hydratePendingScrobblesAsync,
  insertPendingScrobble,
  replaceAllPendingScrobbles,
} from '../pendingScrobbleTable';

/** Minimal InternalDb fake that records rows in a Map keyed by id. */
function makeFakeDb() {
  const rows = new Map<string, { id: string; song_json: string; time: number }>();

  const runSync = (sql: string, params: readonly unknown[] = []): void => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('INSERT OR IGNORE INTO pending_scrobble_events')) {
      const [id, song_json, time] = params as [string, string, number];
      if (!rows.has(id)) {
        rows.set(id, { id, song_json, time });
      }
    } else if (s.startsWith('DELETE FROM pending_scrobble_events WHERE id =')) {
      const [id] = params as [string];
      rows.delete(id);
    } else if (s.startsWith('DELETE FROM pending_scrobble_events')) {
      rows.clear();
    } else {
      throw new Error(`unhandled SQL in fake: ${s}`);
    }
  };

  const getFirstSync = <T,>(sql: string): T | undefined => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('COUNT(*) AS c FROM pending_scrobble_events')) {
      return { c: rows.size } as T;
    }
    return undefined;
  };

  const getAllSync = <T,>(sql: string): T[] => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT id, song_json, time FROM pending_scrobble_events')) {
      // Mimic ORDER BY time ASC so hydrate-order assertions are meaningful.
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
    withTransactionAsync: async (fn: () => Promise<void>) => {
      await fn();
    },
  };
}

function makePending(overrides?: Record<string, any>): any {
  return {
    id: 'p-1',
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

describe('pendingScrobbleTable — insert + hydrate', () => {
  it('insertPendingScrobble + hydratePendingScrobblesAsync round-trip preserves fields', async () => {
    const s = makePending();
    await insertPendingScrobble(s);

    const restored = await hydratePendingScrobblesAsync();
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe('p-1');
    expect(restored[0].time).toBe(1_700_000_000_000);
    expect(restored[0].song.id).toBe('s1');
    expect(restored[0].song.title).toBe('Song One');
    expect(restored[0].song.artist).toBe('Artist');
  });

  it('insertPendingScrobble is INSERT OR IGNORE — duplicate ids are silently skipped', async () => {
    await insertPendingScrobble(makePending({ id: 'dup', time: 1 }));
    await insertPendingScrobble(makePending({ id: 'dup', time: 999, song: { id: 's2', title: 'Different' } }));

    expect((await hydratePendingScrobblesAsync()).length).toBe(1);
    const restored = await hydratePendingScrobblesAsync();
    expect(restored[0].time).toBe(1);
    expect(restored[0].song.id).toBe('s1');
  });

  it('insertPendingScrobble skips records missing id / song.id / song.title', async () => {
    await insertPendingScrobble(makePending({ id: '' }));
    await insertPendingScrobble(makePending({ id: 'bad-song-id', song: { id: '', title: 'x' } }));
    await insertPendingScrobble(makePending({ id: 'no-title', song: { id: 's1', title: '' } }));
    await insertPendingScrobble(makePending({ id: 'null-song', song: null }));

    expect((await hydratePendingScrobblesAsync()).length).toBe(0);
  });

  it('hydratePendingScrobblesAsync returns rows in time-ascending order', async () => {
    await insertPendingScrobble(makePending({ id: 'a', time: 300 }));
    await insertPendingScrobble(makePending({ id: 'b', time: 100 }));
    await insertPendingScrobble(makePending({ id: 'c', time: 200 }));

    const restored = await hydratePendingScrobblesAsync();
    expect(restored.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('hydratePendingScrobblesAsync returns empty when table is empty', async () => {
    expect(await hydratePendingScrobblesAsync()).toEqual([]);
  });

  it('hydratePendingScrobblesAsync skips unparseable song_json rows', async () => {
    fakeDb.rows.set('good', {
      id: 'good',
      song_json: JSON.stringify({ id: 's1', title: 'OK' }),
      time: 1,
    });
    fakeDb.rows.set('bad', { id: 'bad', song_json: '{not valid', time: 2 });

    const restored = await hydratePendingScrobblesAsync();
    expect(restored.map((s) => s.id)).toEqual(['good']);
  });

  it('hydratePendingScrobblesAsync filters rows whose decoded song is invalid', async () => {
    fakeDb.rows.set('missing-song-id', {
      id: 'missing-song-id',
      song_json: JSON.stringify({ title: 'no id' }),
      time: 1,
    });
    fakeDb.rows.set('missing-title', {
      id: 'missing-title',
      song_json: JSON.stringify({ id: 's1' }),
      time: 2,
    });
    fakeDb.rows.set('null-decoded', { id: 'null-decoded', song_json: 'null', time: 3 });
    fakeDb.rows.set('ok', {
      id: 'ok',
      song_json: JSON.stringify({ id: 's9', title: 'Valid' }),
      time: 4,
    });

    const restored = await hydratePendingScrobblesAsync();
    expect(restored.map((s) => s.id)).toEqual(['ok']);
  });
});

describe('pendingScrobbleTable — deletePendingScrobble', () => {
  it('removes a single row by id', async () => {
    await insertPendingScrobble(makePending({ id: 'a' }));
    await insertPendingScrobble(makePending({ id: 'b' }));
    await insertPendingScrobble(makePending({ id: 'c' }));
    expect((await hydratePendingScrobblesAsync()).length).toBe(3);

    await deletePendingScrobble('b');
    const restored = await hydratePendingScrobblesAsync();
    expect(restored.map((s) => s.id).sort()).toEqual(['a', 'c']);
  });

  it('is a no-op for ids that do not exist', async () => {
    await insertPendingScrobble(makePending({ id: 'a' }));
    await deletePendingScrobble('missing');
    expect((await hydratePendingScrobblesAsync()).length).toBe(1);
  });

  it('skips empty-string ids', async () => {
    await insertPendingScrobble(makePending({ id: 'a' }));
    await deletePendingScrobble('');
    expect((await hydratePendingScrobblesAsync()).length).toBe(1);
  });
});

describe('pendingScrobbleTable — replaceAllPendingScrobbles', () => {
  it('wipes existing rows and inserts the new set', async () => {
    await insertPendingScrobble(makePending({ id: 'old-1' }));
    await insertPendingScrobble(makePending({ id: 'old-2' }));
    expect((await hydratePendingScrobblesAsync()).length).toBe(2);

    await replaceAllPendingScrobbles([
      makePending({ id: 'new-1', time: 5 }),
      makePending({ id: 'new-2', time: 10 }),
    ]);

    expect((await hydratePendingScrobblesAsync()).length).toBe(2);
    const restored = await hydratePendingScrobblesAsync();
    expect(restored.map((s) => s.id).sort()).toEqual(['new-1', 'new-2']);
  });

  it('drops invalid / duplicate records before inserting', async () => {
    await replaceAllPendingScrobbles([
      makePending({ id: 'ok' }),
      makePending({ id: 'ok' }),
      makePending({ id: '' }),
      makePending({ id: 'bad-song', song: { id: '', title: 'x' } }),
      makePending({ id: 'no-title', song: { id: 's1', title: '' } }),
      makePending({ id: 'null-song', song: null }),
    ] as any);

    expect((await hydratePendingScrobblesAsync()).length).toBe(1);
    const restored = await hydratePendingScrobblesAsync();
    expect(restored[0].id).toBe('ok');
  });

  it('replaceAllPendingScrobbles with empty array clears the table', async () => {
    await insertPendingScrobble(makePending({ id: 'a' }));
    await replaceAllPendingScrobbles([]);
    expect((await hydratePendingScrobblesAsync()).length).toBe(0);
  });
});

describe('pendingScrobbleTable — clearPendingScrobbles', () => {
  it('wipes the table', async () => {
    await insertPendingScrobble(makePending({ id: 'a' }));
    await insertPendingScrobble(makePending({ id: 'b' }));
    await clearPendingScrobbles();
    expect((await hydratePendingScrobblesAsync()).length).toBe(0);
    expect(await hydratePendingScrobblesAsync()).toEqual([]);
  });

  it('is safe to call on an empty table', async () => {
    await expect(clearPendingScrobbles()).resolves.toBeUndefined();
    expect((await hydratePendingScrobblesAsync()).length).toBe(0);
  });
});

describe('pendingScrobbleTable — disabled db path', () => {
  beforeEach(() => {
    __setDbForTests(null);
  });

  it('all mutations are no-ops when db is unavailable', async () => {
    await insertPendingScrobble(makePending());
    await deletePendingScrobble('p-1');
    await replaceAllPendingScrobbles([makePending()]);
    await clearPendingScrobbles();
    expect((await hydratePendingScrobblesAsync()).length).toBe(0);
    expect(await hydratePendingScrobblesAsync()).toEqual([]);
  });
});

describe('pendingScrobbleTable — db throws (error swallow path)', () => {
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
    withTransactionAsync() {
      return Promise.reject(new Error('boom'));
    },
  };

  beforeEach(() => {
    __setDbForTests(throwingDb as any);
  });

  it('mutations swallow errors and do not propagate', async () => {
    await expect(insertPendingScrobble(makePending())).resolves.toBeUndefined();
    await expect(deletePendingScrobble('x')).resolves.toBeUndefined();
    await expect(replaceAllPendingScrobbles([makePending()])).resolves.toBeUndefined();
    await expect(clearPendingScrobbles()).resolves.toBeUndefined();
  });

  it('reads return safe defaults on DB error', async () => {
    expect((await hydratePendingScrobblesAsync()).length).toBe(0);
    expect(await hydratePendingScrobblesAsync()).toEqual([]);
  });
});
