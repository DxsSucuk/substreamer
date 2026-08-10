/**
 * `download_queue.queue_position` against REAL SQL.
 *
 * The slot is now unique (`idx_download_queue_position_unique`) and assigned by
 * SQL, so every interesting case turns on constraints the hand-rolled fake in
 * `musicCacheTables.test.ts` cannot model: SQLite re-checks a unique index after
 * EVERY row of an UPDATE, and a duplicate INSERT has to be rejected. This suite
 * runs the generated schema (`src/db/normalizedDdl.ts`) on the better-sqlite3-backed
 * op-SQLite seam.
 *
 * Two halves:
 *  - the boot heal in `persistence/db.ts`, exercised by booting the module against
 *    a pre-seeded pre-upgrade database (`jest.isolateModules` + `jest.doMock`, the
 *    pattern in `db.test.ts`);
 *  - the runtime writers, against the shared handle.
 */
import { NORMALIZED_DDL } from '../../../db/normalizedDdl';
import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  insertDownloadQueueItem,
  removeDownloadQueueItem,
  reorderDownloadQueue,
  type DownloadQueueRow,
} from '../musicCacheTables';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
const realDb: InternalDb = handle;

const CREATE_DOWNLOAD_QUEUE = NORMALIZED_DDL.find((s) =>
  s.startsWith('CREATE TABLE IF NOT EXISTS `download_queue`'),
);
if (CREATE_DOWNLOAD_QUEUE === undefined) throw new Error('download_queue DDL not found');

/* ------------------------------------------------------------------ */
/*  Fixtures + raw readers                                             */
/* ------------------------------------------------------------------ */

const makeQueueRow = (overrides: Partial<DownloadQueueRow> = {}): DownloadQueueRow => ({
  queueId: 'q-1',
  itemId: 'alb-1',
  type: 'album',
  name: 'Album One',
  status: 'queued',
  totalSongs: 3,
  completedSongs: 0,
  addedAt: 1_700_000_000_000,
  queuePosition: 1,
  ...overrides,
});

const INSERT_RAW = `INSERT INTO download_queue
   (queue_id, item_id, type, name, artist, cover_art_id, status, total_songs,
    completed_songs, error, added_at, queue_position, songs_json)
   VALUES (?, 'alb-1', 'album', 'Album One', NULL, NULL, 'queued', 3, 0, NULL, ?, ?, '[]');`;

/** Rows in slot order. Insert order is rowid order, which is what makes a naive
 *  `± 1` shift fail — so the seeds below control it explicitly. */
const slotsOf = (db: InternalDb = realDb): Array<{ queue_id: string; queue_position: number }> =>
  db.getAllSync('SELECT queue_id, queue_position FROM download_queue ORDER BY queue_position;');

const orderOf = (): string[] => slotsOf().map((r) => r.queue_id);
const positionsOf = (): number[] => slotsOf().map((r) => r.queue_position);

/** One row per slot, named `q-<slot>`. `descending` inserts them back-to-front, so
 *  rowid order runs opposite to slot order — the layout a completed reorder leaves
 *  behind, and the one that makes a naive `± 1` shift collide. */
function seedSlots(order: 'ascending' | 'descending', slots: number[]): void {
  for (const s of order === 'ascending' ? slots : [...slots].reverse()) {
    realDb.runSync(INSERT_RAW, [`q-${s}`, 1_700_000_000_000 + s, s]);
  }
}

/** Four rows at dense slots 1..4. */
function seedFour(order: 'ascending' | 'descending'): void {
  seedSlots(order, [1, 2, 3, 4]);
}

beforeEach(() => {
  __setDbForTests(realDb);
  realDb.runSync('DELETE FROM download_queue;');
});

/* ------------------------------------------------------------------ */
/*  The constraint itself                                             */
/* ------------------------------------------------------------------ */

describe('idx_download_queue_position_unique', () => {
  it('exists as a UNIQUE index after ensureNormalizedSchema, and the old one is gone', () => {
    const indexes = realDb.getAllSync<{ name: string; unique: number }>(
      "PRAGMA index_list('download_queue')",
    );
    const byName = new Map(indexes.map((i) => [i.name, i.unique]));
    expect(byName.get('idx_download_queue_position_unique')).toBe(1);
    expect(byName.has('idx_download_queue_position')).toBe(false);
  });

  it('rejects a second row at the same slot', () => {
    realDb.runSync(INSERT_RAW, ['q-1', 1, 1]);
    expect(() => realDb.runSync(INSERT_RAW, ['q-2', 2, 1])).toThrow(/UNIQUE/i);
    expect(positionsOf()).toEqual([1]);
  });
});

/* ------------------------------------------------------------------ */
/*  insertDownloadQueueItem — SQL owns the slot                        */
/* ------------------------------------------------------------------ */

describe('insertDownloadQueueItem (real SQL)', () => {
  it('assigns MAX + 1 and returns it, ignoring any slot on the input row', async () => {
    // Both drafts claim slot 1 — exactly what two enqueues off the same stale
    // in-memory snapshot would carry. SQL hands out 1 and 2.
    const first = await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-a', queuePosition: 1 }), []);
    const second = await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-b', queuePosition: 1 }), []);
    expect([first, second]).toEqual([1, 2]);
    expect(slotsOf()).toEqual([
      { queue_id: 'q-a', queue_position: 1 },
      { queue_id: 'q-b', queue_position: 2 },
    ]);
  });

  it('appends past rows the caller never saw', async () => {
    // The hydration race: the store's mirror is empty and would have guessed 1,
    // but the DB already holds a persisted queue.
    seedFour('ascending');
    const assigned = await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-new', queuePosition: 1 }), []);
    expect(assigned).toBe(5);
    expect(positionsOf()).toEqual([1, 2, 3, 4, 5]);
  });

  it('two un-awaited appends serialize into distinct slots', async () => {
    const [a, b] = await Promise.all([
      insertDownloadQueueItem(makeQueueRow({ queueId: 'q-a' }), []),
      insertDownloadQueueItem(makeQueueRow({ queueId: 'q-b' }), []),
    ]);
    expect([a, b].sort()).toEqual([1, 2]);
    expect(positionsOf()).toEqual([1, 2]);
  });

  it('re-writing an existing queue_id keeps its slot', async () => {
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-a' }), []);
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-b' }), []);
    const assigned = await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-a', totalSongs: 99 }), []);
    expect(assigned).toBe(1);
    expect(positionsOf()).toEqual([1, 2]);
    expect(
      realDb.getFirstSync<{ total_songs: number }>(
        'SELECT total_songs FROM download_queue WHERE queue_id = ?;',
        ['q-a'],
      )?.total_songs,
    ).toBe(99);
  });
});

/* ------------------------------------------------------------------ */
/*  removeDownloadQueueItem — the hole is the contract                 */
/* ------------------------------------------------------------------ */

describe.each(['ascending', 'descending'] as const)(
  'removeDownloadQueueItem (rowid %s)',
  (order) => {
    // Slots are UNIQUE and monotonic, NOT dense. Renumbering the tail would cost a
    // rewrite of every row above the deleted one, and the queue drains from the
    // front — O(N²) across a full-library download. These pin the vacancy so nobody
    // "fixes" it back.
    it.each([
      ['the middle', 'q-2', ['q-1', 'q-3', 'q-4'], [1, 3, 4]],
      ['the front', 'q-1', ['q-2', 'q-3', 'q-4'], [2, 3, 4]],
      ['the back', 'q-4', ['q-1', 'q-2', 'q-3'], [1, 2, 3]],
    ])('removing from %s leaves the survivors on their own slots', async (
      _label,
      victim,
      expectedOrder,
      expectedSlots,
    ) => {
      seedFour(order);
      await removeDownloadQueueItem(victim);
      expect(orderOf()).toEqual(expectedOrder);
      expect(positionsOf()).toEqual(expectedSlots);
    });

    it('accumulates holes across repeated removals without touching the survivors', async () => {
      seedFour(order);
      await removeDownloadQueueItem('q-2');
      await removeDownloadQueueItem('q-1');
      expect(orderOf()).toEqual(['q-3', 'q-4']);
      expect(positionsOf()).toEqual([3, 4]);
    });

    it('leaves the table untouched for a queue_id that is not there', async () => {
      seedFour(order);
      await removeDownloadQueueItem('q-nope');
      expect(orderOf()).toEqual(['q-1', 'q-2', 'q-3', 'q-4']);
      expect(positionsOf()).toEqual([1, 2, 3, 4]);
    });

    it('leaves the vacated slot free for a later append to skip past', async () => {
      seedFour(order);
      await removeDownloadQueueItem('q-2');
      // `MAX + 1`, not "the first free slot" — 2 stays empty forever.
      const assigned = await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-new' }), []);
      expect(assigned).toBe(5);
      expect(positionsOf()).toEqual([1, 3, 4, 5]);
    });
  },
);

/* ------------------------------------------------------------------ */
/*  The reported bug: remove, then reorder                             */
/* ------------------------------------------------------------------ */

describe.each(['ascending', 'descending'] as const)(
  'remove then reorder (rowid %s)',
  (order) => {
    it('moves the row the caller asked for', async () => {
      seedFour(order);
      await removeDownloadQueueItem('q-2');
      // Three rows left, at slots 1, 3, 4. Dragging the first to the last is slot
      // 1 → slot 4. Slot 3 — what `index + 1` would have sent — belongs to q-3.
      await reorderDownloadQueue(1, 4);
      expect(orderOf()).toEqual(['q-3', 'q-4', 'q-1']);
    });

    it('moves the right row after a long run of front removals', async () => {
      // What a full-library download leaves behind: every completion vacates the
      // front slot, so the survivors sit at a high, sparse offset.
      seedSlots(order, [1, 2, 3, 4, 5, 6, 7, 8]);
      for (const done of ['q-1', 'q-2', 'q-3', 'q-4', 'q-5']) {
        // eslint-disable-next-line no-await-in-loop
        await removeDownloadQueueItem(done);
      }
      expect(positionsOf()).toEqual([6, 7, 8]);
      await reorderDownloadQueue(8, 6);
      expect(orderOf()).toEqual(['q-8', 'q-6', 'q-7']);
    });
  },
);

/* ------------------------------------------------------------------ */
/*  reorderDownloadQueue                                               */
/* ------------------------------------------------------------------ */

describe.each(['ascending', 'descending'] as const)('reorderDownloadQueue (rowid %s)', (order) => {
  // Every case asserts dense 1..N as well as the permutation: a repack that
  // strands a row in negative space or drops one would still satisfy the order.
  it.each([
    ['up (1 → 3)', 1, 3, ['q-2', 'q-3', 'q-1', 'q-4']],
    ['down (4 → 2)', 4, 2, ['q-1', 'q-4', 'q-2', 'q-3']],
    ['to first (3 → 1)', 3, 1, ['q-3', 'q-1', 'q-2', 'q-4']],
    ['to last (2 → 4)', 2, 4, ['q-1', 'q-3', 'q-4', 'q-2']],
    ['adjacent (2 → 3)', 2, 3, ['q-1', 'q-3', 'q-2', 'q-4']],
  ])('%s', async (_label, from, to, expected) => {
    seedFour(order);
    await reorderDownloadQueue(from, to);
    expect(orderOf()).toEqual(expected);
    expect(positionsOf()).toEqual([1, 2, 3, 4]);
  });

  it('survives a repeat reorder (the layout the first one leaves behind)', async () => {
    seedFour(order);
    await reorderDownloadQueue(1, 4);
    expect(orderOf()).toEqual(['q-2', 'q-3', 'q-4', 'q-1']);
    expect(positionsOf()).toEqual([1, 2, 3, 4]);

    await reorderDownloadQueue(1, 4);
    expect(orderOf()).toEqual(['q-3', 'q-4', 'q-1', 'q-2']);
    expect(positionsOf()).toEqual([1, 2, 3, 4]);
  });

  it('is a no-op when from === to', async () => {
    seedFour(order);
    await reorderDownloadQueue(2, 2);
    expect(orderOf()).toEqual(['q-1', 'q-2', 'q-3', 'q-4']);
    expect(positionsOf()).toEqual([1, 2, 3, 4]);
  });

  // Density is restored by the delete path now, but the repack must not DEPEND on
  // it: a table holed by a build that predates that fix still has to reorder
  // correctly, given the rows' real slots.
  describe('on a table that is already holed', () => {
    it('moves the first row to the back', async () => {
      seedSlots(order, [1, 3, 7]);
      await reorderDownloadQueue(1, 7);
      expect(orderOf()).toEqual(['q-3', 'q-7', 'q-1']);
    });

    it('moves the last row to the front', async () => {
      seedSlots(order, [1, 3, 7]);
      await reorderDownloadQueue(7, 1);
      expect(orderOf()).toEqual(['q-7', 'q-1', 'q-3']);
    });

    it('moves a middle row without disturbing the rows outside the range', async () => {
      seedSlots(order, [1, 3, 7, 9]);
      await reorderDownloadQueue(3, 7);
      expect(orderOf()).toEqual(['q-1', 'q-7', 'q-3', 'q-9']);
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Boot heal (persistence/db.ts)                                      */
/* ------------------------------------------------------------------ */

interface SeedRow {
  queueId: string;
  position: number;
  addedAt: number;
}

/**
 * Boot `persistence/db.ts` against a database in the pre-upgrade shape: the
 * `download_queue` table plus the OLD non-unique position index, and nothing else.
 * `rows === null` leaves the table uncreated (fresh install).
 */
function bootAgainstSeed(rows: SeedRow[] | null): { db: InternalDb | null; raw: InternalDb } {
  let mod: typeof import('../db') | undefined;
  let raw: InternalDb | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createOpSqliteMock } = require('../../../db/testing/opSqliteBetterSqlite3');
    const base = createOpSqliteMock();
    const instance = base.open({ name: 'seed.db', location: ':memory:' });
    if (rows !== null) {
      instance.executeSync(CREATE_DOWNLOAD_QUEUE);
      instance.executeSync(
        'CREATE INDEX IF NOT EXISTS idx_download_queue_position ON download_queue (queue_position);',
      );
      for (const r of rows) {
        instance.executeSync(INSERT_RAW, [r.queueId, r.addedAt, r.position]);
      }
    }
    jest.doMock('@op-engineering/op-sqlite', () => ({
      ...base,
      open: () => instance,
      openSync: () => instance,
      openAsync: async () => instance,
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('../db');
    raw = {
      getAllSync: (sql: string, params?: readonly unknown[]) =>
        instance.executeSync(sql, params).rows,
      getFirstSync: (sql: string, params?: readonly unknown[]) =>
        instance.executeSync(sql, params).rows[0],
      runSync: (sql: string, params?: readonly unknown[]) => instance.executeSync(sql, params),
    } as unknown as InternalDb;
  });
  return { db: mod?.getDb() ?? null, raw: raw as InternalDb };
}

describe('boot heal — download_queue position renumber', () => {
  afterEach(() => {
    __setDbForTests(realDb);
  });

  it('renumbers duplicates dense 1..N by (queue_position, added_at, queue_id), losing no row', () => {
    // Slot 2 held three times. The tiebreak walks all three keys: added_at splits
    // q-d off first, then queue_id orders q-b before q-c.
    const { db, raw } = bootAgainstSeed([
      { queueId: 'q-c', position: 2, addedAt: 100 },
      { queueId: 'q-a', position: 1, addedAt: 300 },
      { queueId: 'q-d', position: 2, addedAt: 50 },
      { queueId: 'q-b', position: 2, addedAt: 100 },
    ]);
    expect(db).not.toBeNull();
    expect(slotsOf(raw)).toEqual([
      { queue_id: 'q-a', queue_position: 1 },
      { queue_id: 'q-d', queue_position: 2 },
      { queue_id: 'q-b', queue_position: 3 },
      { queue_id: 'q-c', queue_position: 4 },
    ]);
  });

  it('leaves the UNIQUE index in place afterwards, so the duplicates cannot come back', () => {
    const { raw } = bootAgainstSeed([
      { queueId: 'q-a', position: 1, addedAt: 1 },
      { queueId: 'q-b', position: 1, addedAt: 2 },
    ]);
    const indexes = raw.getAllSync<{ name: string; unique: number }>(
      "PRAGMA index_list('download_queue')",
    );
    const byName = new Map(indexes.map((i) => [i.name, i.unique]));
    expect(byName.get('idx_download_queue_position_unique')).toBe(1);
    expect(byName.has('idx_download_queue_position')).toBe(false);
  });

  it('is a no-op on a table that is already dense', () => {
    const { db, raw } = bootAgainstSeed([
      { queueId: 'q-b', position: 2, addedAt: 999 },
      { queueId: 'q-a', position: 1, addedAt: 1 },
      { queueId: 'q-c', position: 3, addedAt: 5 },
    ]);
    expect(db).not.toBeNull();
    // Untouched — the same slots, not re-derived from added_at.
    expect(slotsOf(raw)).toEqual([
      { queue_id: 'q-a', queue_position: 1 },
      { queue_id: 'q-b', queue_position: 2 },
      { queue_id: 'q-c', queue_position: 3 },
    ]);
  });

  it('is a no-op when the table does not exist yet (fresh install)', () => {
    const { db, raw } = bootAgainstSeed(null);
    expect(db).not.toBeNull();
    expect(
      raw.getFirstSync<{ c: number }>('SELECT COUNT(*) AS c FROM download_queue;')?.c,
    ).toBe(0);
  });
});
