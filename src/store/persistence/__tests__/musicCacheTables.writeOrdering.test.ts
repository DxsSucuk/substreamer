/**
 * Write ORDER through the music-cache tables, against the submission model the seam
 * reproduces (`src/db/testing/opSqliteBetterSqlite3.ts`): a batch is parked on
 * op-SQLite's transaction lock and started a macrotask later, while a read — or a
 * bare `runAsync` write — reaches the engine at call time and overtakes it.
 *
 * Two consequences pinned here, both of which shipped as live bugs:
 *   - a queue item's payload is unreadable until its write lands, so the download
 *     worker has to wait for it rather than reading straight after the enqueue;
 *   - an edge sent bare would land before the item/song batches it FKs to, and
 *     `PRAGMA foreign_keys = ON` would reject it — silently, the writes swallow.
 */
import { settleDbWrites } from '../../../test-utils/settleDbWrites';
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

beforeEach(async () => {
  const db = getDb()!;
  for (const t of ['cached_item_songs', 'download_queue', 'cached_items', 'cached_songs']) {
    db.runSync(`DELETE FROM ${t};`);
  }
  musicCacheStore.setState({ downloadQueue: [], cachedItems: {}, cachedSongs: {} } as never);
  await settleDbWrites();
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
    await settleDbWrites();

    expect(countCachedItemSongs()).toBe(1);
  });

  it('still writes the edge when its parents are already durable', async () => {
    await upsertCachedSong(makeSong('s-1'));
    await upsertCachedItem(makeItem('alb-1'));

    await insertCachedItemSong('alb-1', 1, 's-1');
    await settleDbWrites();

    expect(countCachedItemSongs()).toBe(1);
  });
});
