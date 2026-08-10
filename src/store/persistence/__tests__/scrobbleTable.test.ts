/**
 * `scrobble_events` writes, read back through `hydrateScrobblesAsync`, against REAL
 * SQL on the better-sqlite3-backed op-SQLite substitute.
 *
 * Uses the substitute, not a hand-rolled fake: a fake storing `(id, song_json, time)`
 * and matching statements by SQL prefix cannot represent the 37 typed columns the
 * readers reconstruct from — any SELECT-list change makes it return `[]` and fail
 * like a logic bug.
 *
 * Per AGENTS.md §11 the substitute proves SQL semantics, never concurrency.
 */
import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  clearScrobbles,
  countScrobbles,
  hydrateScrobblesAsync,
  insertScrobble,
  replaceAllScrobbles,
} from '../scrobbleTable';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite substitute failed to open');
const realDb: InternalDb = handle;

function makeScrobble(overrides?: Record<string, any>): any {
  return {
    id: 'sc-1',
    song: { id: 's1', title: 'Song One', artist: 'Artist', duration: 180 },
    time: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  __setDbForTests(realDb);
  realDb.runSync('DELETE FROM scrobble_events;');
});

afterEach(() => {
  __setDbForTests(realDb);
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
    expect(restored[0].song.duration).toBe(180);
  });

  it('insertScrobble is INSERT OR IGNORE — duplicate ids are silently skipped', async () => {
    await insertScrobble(makeScrobble({ id: 'dup', time: 1 }));
    await insertScrobble(
      makeScrobble({ id: 'dup', time: 999, song: { id: 's2', title: 'Different' } }),
    );

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
    await insertScrobble(makeScrobble({ id: 'b', song: { id: 's2', title: 'Song Two' } }));
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
