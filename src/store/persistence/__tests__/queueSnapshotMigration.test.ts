/**
 * Migration 36 — the pre-upgrade KV blobs into `queue_snapshots`, against REAL SQL on
 * the better-sqlite3-backed op-SQLite seam.
 *
 * The load-bearing case is the failing one: a bookmark has no source to refetch from,
 * so when the rows do not take the write the KV key must still be there afterwards.
 * That is the difference between recoverable and gone.
 *
 * Per AGENTS.md §11 the seam proves SQL semantics, never concurrency.
 */
jest.mock('../kvStorage', () => require('../__mocks__/kvStorage'));

import type { Child } from 'subsonic-api';

import { __setDbForTests, getDb, type InternalDb } from '../db';
import { clearKvStorage, kvStorage } from '../kvStorage';
import { migrateQueueSnapshotsFromKv } from '../queueSnapshotMigration';
import {
  listBookmarks,
  readBookmarkSnapshots,
  readSnapshotSync,
  replaceSnapshotTracks,
  upsertSnapshot,
  SNAPSHOT_LIVE_ID,
} from '../queueSnapshotTable';
import { bookmarksStore, type PlayQueueBookmark } from '../../bookmarksStore';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
const realDb: InternalDb = handle;

const BOOKMARKS_KEY = 'substreamer-bookmarks';
const QUEUE_KEY = 'substreamer-persisted-queue';
const POSITION_KEY = 'substreamer-persisted-position';

/** A `Child` carrying all five arrays — the ones a scrobble written out of a restored
 *  queue depends on. */
const fullSong = {
  id: 's-full',
  title: 'Full Song',
  artist: 'The Artist',
  album: 'The Album',
  isDir: false,
  isVideo: false,
  coverArt: 'cov-1',
  duration: 210,
  albumId: 'al-1',
  year: 1999,
  suffix: 'flac',
  userRating: 4,
  genres: [{ name: 'Rock' }, { name: 'Indie' }],
  artists: [{ id: 'ar-1', name: 'The Artist' }],
  albumArtists: [{ id: 'ar-3', name: 'Various' }],
  contributors: [{ role: 'composer', artist: { id: 'ar-4', name: 'Composer' } }],
  moods: ['energetic'],
} as unknown as Child;

const song = (id: string): Child => ({ ...fullSong, id, title: `Title ${id}` });

const queueOf = (n: number, prefix: string): Child[] =>
  Array.from({ length: n }, (_, i) => song(`${prefix}-${i}`));

const legacyBookmark = (
  id: string,
  overrides: Partial<PlayQueueBookmark> = {},
): PlayQueueBookmark => ({
  id,
  name: `Saved ${id}`,
  createdAt: 1_700_000_000_000,
  queue: queueOf(3, id),
  currentIndex: 1,
  positionSec: 42.5,
  ...overrides,
});

/** The blob exactly as `bookmarksStore`'s persist middleware wrote it. */
const seedBookmarksBlob = async (
  bookmarks: Record<string, PlayQueueBookmark>,
  rest: Record<string, unknown> = { autoName: false, sortOrder: 'oldest' },
): Promise<void> => {
  await kvStorage.setItem(
    BOOKMARKS_KEY,
    JSON.stringify({ state: { bookmarks, ...rest }, version: 0 }),
  );
};

const readBlob = async (): Promise<{ state?: Record<string, unknown>; version?: number }> => {
  const raw = await kvStorage.getItem(BOOKMARKS_KEY);
  return raw === null ? {} : JSON.parse(raw);
};

const logs: string[] = [];
const log = (message: string): void => {
  logs.push(message);
};

const songCount = (snapshotId: string): number =>
  realDb.getFirstSync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM queue_snapshot_songs WHERE snapshot_id = ?;',
    [snapshotId],
  )?.c ?? 0;

beforeEach(() => {
  __setDbForTests(realDb);
  logs.length = 0;
  // ON DELETE CASCADE clears the songs and their five array tables with it.
  realDb.runSync('DELETE FROM queue_snapshots;');
  bookmarksStore.setState({
    bookmarks: {},
    autoName: true,
    sortOrder: 'newest',
    sqlAuthoritative: false,
  });
  // Last: the reset above goes through `persist`, which rewrites the blob.
  clearKvStorage();
});

/* ------------------------------------------------------------------ */
/*  Bookmarks                                                          */
/* ------------------------------------------------------------------ */

describe('bookmarks blob → rows', () => {
  it('migrates every bookmark whole, tracks and arrays included', async () => {
    await seedBookmarksBlob({
      'bm-1': legacyBookmark('bm-1'),
      'bm-2': legacyBookmark('bm-2', { queue: queueOf(5, 'bm-2'), currentIndex: 4 }),
      'bm-3': legacyBookmark('bm-3', { name: 'Third', createdAt: 1_700_000_500_000 }),
      'bm-4': legacyBookmark('bm-4'),
      'bm-5': legacyBookmark('bm-5'),
    });

    await migrateQueueSnapshotsFromKv(log);

    const snapshots = await readBookmarkSnapshots();
    expect(snapshots).not.toBeNull();
    expect(snapshots?.map((s) => s.id).sort()).toEqual(['bm-1', 'bm-2', 'bm-3', 'bm-4', 'bm-5']);

    const second = snapshots?.find((s) => s.id === 'bm-2');
    expect(second).toMatchObject({ kind: 'bookmark', currentIndex: 4, positionSec: 42.5 });
    expect(second?.tracks.map((t) => t.id)).toEqual(queueOf(5, 'bm-2').map((t) => t.id));
    expect(second?.tracks[0]).toMatchObject({
      title: 'Title bm-2-0',
      artist: 'The Artist',
      album: 'The Album',
      coverArt: 'cov-1',
      duration: 210,
      userRating: 4,
      year: 1999,
    });
    // The arrays are what a scrobble written out of a restored queue carries.
    expect(second?.tracks[0].genres).toEqual(['Rock', 'Indie']);
    expect(second?.tracks[0].artists).toEqual([{ id: 'ar-1', name: 'The Artist', albumCount: 0 }]);
    expect(second?.tracks[0].albumArtists).toEqual([
      { id: 'ar-3', name: 'Various', albumCount: 0 },
    ]);
    expect(second?.tracks[0].contributors).toEqual([
      { role: 'composer', artist: { id: 'ar-4', name: 'Composer', albumCount: 0 } },
    ]);
    expect(second?.tracks[0].moods).toEqual(['energetic']);
    expect(snapshots?.find((s) => s.id === 'bm-3')?.name).toBe('Third');
  });

  it('gives up the blob copy only, keeping the preferences that share the key', async () => {
    await seedBookmarksBlob({ 'bm-1': legacyBookmark('bm-1') });

    await migrateQueueSnapshotsFromKv(log);

    const blob = await readBlob();
    expect(blob.state).not.toHaveProperty('bookmarks');
    expect(blob.state).toMatchObject({ autoName: false, sortOrder: 'oldest' });
    expect(blob.version).toBe(0);
  });

  it('is idempotent — a second run duplicates nothing and loses nothing', async () => {
    await seedBookmarksBlob({
      'bm-1': legacyBookmark('bm-1'),
      'bm-2': legacyBookmark('bm-2'),
    });

    await migrateQueueSnapshotsFromKv(log);
    const first = await readBookmarkSnapshots();
    await migrateQueueSnapshotsFromKv(log);
    const second = await readBookmarkSnapshots();

    expect(second).toEqual(first);
    expect(songCount('bm-1')).toBe(3);
    expect(songCount('bm-2')).toBe(3);
  });

  it('re-running against a blob that still holds them rewrites rather than duplicates', async () => {
    const bookmarks = { 'bm-1': legacyBookmark('bm-1') };
    await seedBookmarksBlob(bookmarks);
    await migrateQueueSnapshotsFromKv(log);
    // As if the strip had not landed — a kill between the row write and the rewrite.
    await seedBookmarksBlob(bookmarks);

    await migrateQueueSnapshotsFromKv(log);

    expect(await listBookmarks()).toHaveLength(1);
    expect(songCount('bm-1')).toBe(3);
  });

  it('never removes a bookmark the blob does not mention', async () => {
    // Saved after the upgrade, so it exists as a row and not in the blob.
    await upsertSnapshot({
      id: 'post-upgrade',
      kind: 'bookmark',
      name: 'New',
      createdAt: 1_700_000_900_000,
      currentIndex: 0,
      positionSec: 0,
    });
    await replaceSnapshotTracks('post-upgrade', queueOf(2, 'new'));
    await seedBookmarksBlob({ 'bm-1': legacyBookmark('bm-1') });

    await migrateQueueSnapshotsFromKv(log);

    expect((await listBookmarks()).map((b) => b.id).sort()).toEqual(['bm-1', 'post-upgrade']);
    expect(songCount('post-upgrade')).toBe(2);
  });

  it('fills in the fields a hand-edited blob is missing', async () => {
    await seedBookmarksBlob({
      'bm-1': { id: 'bm-1', queue: queueOf(2, 'bm-1') } as PlayQueueBookmark,
    });

    await migrateQueueSnapshotsFromKv(log);

    const stored = readSnapshotSync('bm-1');
    expect(stored).toMatchObject({ name: null, currentIndex: 0, positionSec: 0 });
    expect(stored?.tracks).toHaveLength(2);
    expect(typeof stored?.createdAt).toBe('number');
  });

  it('drops entries with no id from the queue and still verifies', async () => {
    await seedBookmarksBlob({
      'bm-1': legacyBookmark('bm-1', {
        queue: [song('a'), { title: 'no id' } as Child, song('b')],
      }),
    });

    await migrateQueueSnapshotsFromKv(log);

    expect(readSnapshotSync('bm-1')?.tracks.map((t) => t.id)).toEqual(['a', 'b']);
  });
});

/* ------------------------------------------------------------------ */
/*  The failure that must stay recoverable                             */
/* ------------------------------------------------------------------ */

describe('a failed row write', () => {
  it('throws and leaves the KV blob intact when a track poisons the batch', async () => {
    const poisoned = legacyBookmark('bm-poison', {
      // A hand-edited backup can carry this; it binds as neither string nor number, so
      // the atomic batch aborts.
      queue: [song('ok'), { ...song('x'), id: { nope: true } } as unknown as Child],
    });
    await seedBookmarksBlob({ 'bm-1': legacyBookmark('bm-1'), 'bm-poison': poisoned });

    await expect(migrateQueueSnapshotsFromKv(log)).rejects.toThrow(/did not store/);

    // The only complete copy is still on disk, so the next launch retries.
    const blob = await readBlob();
    expect(Object.keys((blob.state?.bookmarks ?? {}) as object).sort()).toEqual([
      'bm-1',
      'bm-poison',
    ]);
    // And the batch is all-or-nothing: no half-written bookmark either.
    expect(await listBookmarks()).toHaveLength(0);
  });

  it('throws and leaves the KV blob intact when the rows cannot be read back', async () => {
    await seedBookmarksBlob({ 'bm-1': legacyBookmark('bm-1') });
    __setDbForTests(null);

    await expect(migrateQueueSnapshotsFromKv(log)).rejects.toThrow(/unreadable/);

    const blob = await readBlob();
    expect(blob.state?.bookmarks).toHaveProperty('bm-1');
  });

  it('a retry after the failure completes the migration', async () => {
    await seedBookmarksBlob({ 'bm-1': legacyBookmark('bm-1') });
    __setDbForTests(null);
    await expect(migrateQueueSnapshotsFromKv(log)).rejects.toThrow();

    __setDbForTests(realDb);
    await migrateQueueSnapshotsFromKv(log);

    expect(readSnapshotSync('bm-1')?.tracks).toHaveLength(3);
    expect((await readBlob()).state).not.toHaveProperty('bookmarks');
  });

  it('leaves an unparseable blob in place rather than throwing forever', async () => {
    await kvStorage.setItem(BOOKMARKS_KEY, '{not json');

    await expect(migrateQueueSnapshotsFromKv(log)).resolves.toBeUndefined();

    expect(await kvStorage.getItem(BOOKMARKS_KEY)).toBe('{not json');
    expect(logs.join(' ')).toContain('unparseable');
  });
});

/* ------------------------------------------------------------------ */
/*  The live queue                                                     */
/* ------------------------------------------------------------------ */

describe('live queue blob → the live row', () => {
  const seedQueue = async (queue: Child[], currentTrackIndex: number): Promise<void> => {
    await kvStorage.setItem(QUEUE_KEY, JSON.stringify({ queue, currentTrackIndex }));
  };

  it('migrates the queue with its cursor and position, then drops the keys', async () => {
    const queue = queueOf(6, 'live');
    await seedQueue(queue, 2);
    await kvStorage.setItem(
      POSITION_KEY,
      JSON.stringify({ position: 88.5, trackId: 'live-2' }),
    );

    await migrateQueueSnapshotsFromKv(log);

    const live = readSnapshotSync(SNAPSHOT_LIVE_ID);
    expect(live).toMatchObject({ kind: 'live', currentIndex: 2, positionSec: 88.5 });
    expect(live?.tracks.map((t) => t.id)).toEqual(queue.map((t) => t.id));
    expect(await kvStorage.getItem(QUEUE_KEY)).toBeNull();
    expect(await kvStorage.getItem(POSITION_KEY)).toBeNull();
  });

  it('drops a position measured on a different track', async () => {
    await seedQueue(queueOf(4, 'live'), 1);
    await kvStorage.setItem(
      POSITION_KEY,
      JSON.stringify({ position: 61, trackId: 'live-3' }),
    );

    await migrateQueueSnapshotsFromKv(log);

    expect(readSnapshotSync(SNAPSHOT_LIVE_ID)?.positionSec).toBe(0);
  });

  it('does NOT restore a stale key over an existing live row', async () => {
    await upsertSnapshot({
      id: SNAPSHOT_LIVE_ID,
      kind: 'live',
      name: null,
      createdAt: 1_700_000_000_000,
      currentIndex: 1,
      positionSec: 30,
    });
    await replaceSnapshotTracks(SNAPSHOT_LIVE_ID, queueOf(2, 'current'));
    await seedQueue(queueOf(9, 'stale'), 5);

    await migrateQueueSnapshotsFromKv(log);

    const live = readSnapshotSync(SNAPSHOT_LIVE_ID);
    expect(live?.tracks.map((t) => t.id)).toEqual(['current-0', 'current-1']);
    expect(live).toMatchObject({ currentIndex: 1, positionSec: 30 });
    // The dead key goes, because the row it would have overwritten is there.
    expect(await kvStorage.getItem(QUEUE_KEY)).toBeNull();
  });

  it('keeps the cursor on the same track when an id-less entry is dropped', async () => {
    await seedQueue([{ title: 'no id' } as Child, song('a'), song('b')], 2);

    await migrateQueueSnapshotsFromKv(log);

    const live = readSnapshotSync(SNAPSHOT_LIVE_ID);
    expect(live?.tracks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(live?.currentIndex).toBe(1);
  });

  it('drops the keys when the stored queue is empty', async () => {
    await seedQueue([], 0);

    await migrateQueueSnapshotsFromKv(log);

    expect(readSnapshotSync(SNAPSHOT_LIVE_ID)).toBeNull();
    expect(await kvStorage.getItem(QUEUE_KEY)).toBeNull();
  });

  it('drops the keys when the queue blob is unparseable', async () => {
    await kvStorage.setItem(QUEUE_KEY, 'not json at all');

    await migrateQueueSnapshotsFromKv(log);

    expect(readSnapshotSync(SNAPSHOT_LIVE_ID)).toBeNull();
    expect(await kvStorage.getItem(QUEUE_KEY)).toBeNull();
  });

  // The disposable half: a failure here does NOT throw (migration 30 already treats the
  // queue as expendable, and a task that could never pass would pin the counter below
  // the latest id for good), so it must leave a clean slate behind instead.
  it('keeps the keys and leaves no stub row when the write does not take', async () => {
    await seedQueue([song('a'), { ...song('b'), id: { nope: true } } as unknown as Child], 0);

    await migrateQueueSnapshotsFromKv(log);

    expect(readSnapshotSync(SNAPSHOT_LIVE_ID)).toBeNull();
    expect(await kvStorage.getItem(QUEUE_KEY)).not.toBeNull();
    expect(logs.join(' ')).toContain('did not store');
  });
});

/* ------------------------------------------------------------------ */
/*  Nothing to do                                                      */
/* ------------------------------------------------------------------ */

describe('nothing to migrate', () => {
  it('a user who already ran migration 30 migrates bookmarks with no queue', async () => {
    // m30 deletes both queue keys unconditionally; finding them gone is the normal path.
    await seedBookmarksBlob({ 'bm-1': legacyBookmark('bm-1') });

    await migrateQueueSnapshotsFromKv(log);

    expect(readSnapshotSync('bm-1')?.tracks).toHaveLength(3);
    expect(readSnapshotSync(SNAPSHOT_LIVE_ID)).toBeNull();
    expect(logs.join(' ')).toContain('no persisted-queue keys');
  });

  it('a fresh install writes nothing and raises nothing', async () => {
    await expect(migrateQueueSnapshotsFromKv(log)).resolves.toBeUndefined();

    expect(await listBookmarks()).toEqual([]);
    expect(readSnapshotSync(SNAPSHOT_LIVE_ID)).toBeNull();
  });

  it('a blob with an empty bookmark map is left alone', async () => {
    await seedBookmarksBlob({});

    await migrateQueueSnapshotsFromKv(log);

    expect(await listBookmarks()).toEqual([]);
    expect((await readBlob()).state).toHaveProperty('bookmarks');
  });
});

/* ------------------------------------------------------------------ */
/*  Migration → the store's read flip                                  */
/* ------------------------------------------------------------------ */

describe('the store after the migration', () => {
  it('hydrates from the rows and stops writing bookmarks to the blob', async () => {
    const bookmarks = {
      'bm-1': legacyBookmark('bm-1'),
      'bm-2': legacyBookmark('bm-2'),
    };
    await seedBookmarksBlob(bookmarks);
    // As the persist middleware leaves it: memory holds the blob's set.
    bookmarksStore.setState({ bookmarks });

    await migrateQueueSnapshotsFromKv(log);
    await bookmarksStore.getState().hydrateFromDbAsync();

    const state = bookmarksStore.getState();
    expect(Object.keys(state.bookmarks).sort()).toEqual(['bm-1', 'bm-2']);
    expect(state.bookmarks['bm-1'].queue.map((t) => t.id)).toEqual(
      queueOf(3, 'bm-1').map((t) => t.id),
    );
    expect(state.sqlAuthoritative).toBe(true);
  });

  it('keeps reading the blob when the migration has not run', async () => {
    const bookmarks = { 'bm-1': legacyBookmark('bm-1') };
    bookmarksStore.setState({ bookmarks });

    await bookmarksStore.getState().hydrateFromDbAsync();

    const state = bookmarksStore.getState();
    expect(state.bookmarks['bm-1'].queue).toHaveLength(3);
    expect(state.sqlAuthoritative).toBe(false);
  });
});
