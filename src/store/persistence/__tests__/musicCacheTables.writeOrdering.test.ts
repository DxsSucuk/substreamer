/**
 * Write ORDER against the engine's real submission model, which the default seam does
 * not reproduce.
 *
 * op-sqlite's JS layer (`enhanceDB` in `@op-engineering/op-sqlite/src/functions.ts`)
 * parks every `executeBatch` on a transaction lock and only submits it to the native
 * pool from a `setImmediate`, whereas `execute` — every read, and every `runAsync`
 * write — reaches the pool at call time. Batches therefore run in submission order
 * among themselves, and a bare statement OVERTAKES every batch still on the lock.
 *
 * Two consequences this suite pins, both of which shipped as live bugs:
 *   - a queue item's payload is unreadable until its write lands, so the download
 *     worker has to wait for it rather than reading straight after the enqueue;
 *   - an edge sent bare would land before the item/song batches it FKs to, and
 *     `PRAGMA foreign_keys = ON` would reject it — silently, the writes swallow.
 *
 * Per AGENTS.md §11 the seam proves SQL semantics, never native concurrency; what is
 * modelled here is the JS-side submission order, which is ordinary JS scheduling.
 */
jest.mock('@op-engineering/op-sqlite', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createOpSqliteMock } = require('../../../db/testing/opSqliteBetterSqlite3');
  const base = createOpSqliteMock();

  const openMemory = (opts: Record<string, unknown>) => {
    const db = base.open({ ...(opts ?? {}), location: ':memory:' });
    // `enhanceDB`'s transaction lock: one batch at a time, each started from a
    // `setImmediate`. `execute` is left alone — it applies at call time.
    const waiting: Array<() => void> = [];
    let running = false;
    const pump = (): void => {
      if (running || waiting.length === 0) return;
      running = true;
      const start = waiting.shift()!;
      setImmediate(() => {
        start();
        running = false;
        pump();
      });
    };
    return {
      ...db,
      executeBatch: (commands: unknown[]) =>
        new Promise((resolve, reject) => {
          waiting.push(() => {
            try {
              resolve(db.executeBatch(commands as never));
            } catch (e) {
              reject(e as Error);
            }
          });
          pump();
        }),
    };
  };

  return {
    ...base,
    open: openMemory,
    openSync: openMemory,
    openAsync: (o: Record<string, unknown>) => Promise.resolve(openMemory(o)),
  };
});

import { musicCacheStore, whenQueuePayloadWritten } from '../../musicCacheStore';
import { getDb } from '../db';
import {
  countCachedItemSongs,
  insertCachedItemSong,
  insertDownloadQueueItem,
  readDownloadQueueSongsAsync,
  upsertCachedItem,
  upsertCachedSong,
  type CachedItemRow,
  type CachedSongRow,
  type DownloadQueueRow,
} from '../musicCacheTables';

import type { Child } from 'subsonic-api';

const makeSong = (id: string): CachedSongRow => ({
  id,
  title: `Track ${id}`,
  artist: 'Some Artist',
  album: 'Some Album',
  albumId: 'alb-1',
  bytes: 1_000,
  duration: 240,
  suffix: 'mp3',
  formatCapturedAt: 1_700_000_000_000,
  downloadedAt: 1_700_000_000_000,
});

const makeItem = (itemId: string): Omit<CachedItemRow, 'songIds'> => ({
  itemId,
  type: 'album',
  name: 'Some Album',
  expectedSongCount: 1,
  lastSyncAt: 1_700_000_000_000,
  downloadedAt: 1_700_000_000_000,
});

const makeQueueRow = (
  overrides: Partial<Omit<DownloadQueueRow, 'queuePosition'>> = {},
): Omit<DownloadQueueRow, 'queuePosition'> => ({
  queueId: 'q-1',
  itemId: 'alb-1',
  type: 'album',
  name: 'Some Album',
  status: 'queued',
  totalSongs: 1,
  completedSongs: 0,
  addedAt: 1_700_000_000_000,
  ...overrides,
});

const child = (id: string): Child => ({ id, title: `Track ${id}` }) as Child;

/** Drain the batch lock: every pending batch runs on its own macrotask. */
const settleWrites = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(async () => {
  const db = getDb()!;
  for (const t of ['cached_item_songs', 'download_queue', 'cached_items', 'cached_songs']) {
    db.runSync(`DELETE FROM ${t};`);
  }
  musicCacheStore.setState({ downloadQueue: [], cachedItems: {}, cachedSongs: {} } as never);
  await settleWrites();
});

describe('a batch is not visible to anything issued before it lands', () => {
  it('a queue payload reads empty until its write resolves', async () => {
    const write = insertDownloadQueueItem(makeQueueRow(), [child('s-1')]);

    // Exactly what the download worker used to do: read on the next line.
    expect(await readDownloadQueueSongsAsync('q-1')).toEqual([]);

    await write;
    expect((await readDownloadQueueSongsAsync('q-1')).map((c) => c.id)).toEqual(['s-1']);
  });

  it('whenQueuePayloadWritten gates on the payload actually being readable', async () => {
    musicCacheStore.getState().enqueue(
      { itemId: 'alb-1', type: 'album', name: 'Some Album', totalSongs: 1 },
      [child('s-1')],
    );
    const { queueId } = musicCacheStore.getState().downloadQueue[0];

    expect(await readDownloadQueueSongsAsync(queueId)).toEqual([]);

    await whenQueuePayloadWritten(queueId);
    expect((await readDownloadQueueSongsAsync(queueId)).map((c) => c.id)).toEqual(['s-1']);
  });

  it('resolves immediately for a queue item with no write in flight', async () => {
    await expect(whenQueuePayloadWritten('never-enqueued')).resolves.toBeUndefined();
  });
});

describe('an edge lands after the item and song it references', () => {
  it('survives parents whose writes were fired and not awaited', async () => {
    void upsertCachedSong(makeSong('s-1'));
    void upsertCachedItem(makeItem('alb-1'));

    await insertCachedItemSong('alb-1', 1, 's-1');
    await settleWrites();

    expect(countCachedItemSongs()).toBe(1);
  });

  it('still writes the edge when its parents are already durable', async () => {
    await upsertCachedSong(makeSong('s-1'));
    await upsertCachedItem(makeItem('alb-1'));

    await insertCachedItemSong('alb-1', 1, 's-1');
    await settleWrites();

    expect(countCachedItemSongs()).toBe(1);
  });
});
