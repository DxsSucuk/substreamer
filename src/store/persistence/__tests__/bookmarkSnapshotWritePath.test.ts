/**
 * Bookmarks on the shared snapshot table, against REAL SQL on the better-sqlite3-backed
 * op-SQLite seam: the store writes through, a fresh hydrate rebuilds whole `Child`s,
 * a RENAME keeps the songs (the `INSERT OR REPLACE` cascade trap), a delete takes them,
 * and the live queue and the bookmarks never touch each other in the one table they share.
 *
 * Per AGENTS.md §11 the seam proves SQL semantics, never concurrency.
 */
jest.mock('../kvStorage', () => require('../__mocks__/kvStorage'));

import type { Child } from 'subsonic-api';

import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  readSnapshotSync,
  replaceSnapshotTracks,
  SNAPSHOT_LIVE_ID,
  upsertSnapshot,
} from '../queueSnapshotTable';
import { bookmarksStore, type PlayQueueBookmark } from '../../bookmarksStore';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
const realDb: InternalDb = handle;

/** A `Child` carrying all five arrays plus the field groups the queue UI reads. */
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
  artistId: 'ar-1',
  year: 1999,
  track: 4,
  discNumber: 2,
  suffix: 'flac',
  bitRate: 960,
  bitDepth: 24,
  samplingRate: 96_000,
  userRating: 4,
  playCount: 12,
  path: 'The Artist/The Album/04 Full Song.flac',
  created: new Date('2020-05-06T07:08:09.000Z'),
  starred: new Date('2021-06-07T08:09:10.000Z'),
  replayGain: { trackGain: -7.5, albumGain: -6.5, trackPeak: 0.98, albumPeak: 0.99 },
  // Real OpenSubsonic servers return `{name}[]` here despite the `string[]` type.
  genres: [{ name: 'Rock' }, { name: 'Indie' }],
  artists: [
    { id: 'ar-1', name: 'The Artist' },
    { id: 'ar-2', name: 'Feature' },
  ],
  albumArtists: [{ id: 'ar-3', name: 'Various' }],
  contributors: [
    { role: 'composer', subRole: 'lyrics', artist: { id: 'ar-4', name: 'Composer' } },
    { role: 'producer' },
  ],
  moods: ['energetic', 'happy'],
} as unknown as Child;

const song = (id: string): Child => ({ ...fullSong, id, title: `Title ${id}` });

const queueOf = (n: number, prefix = 's'): Child[] =>
  Array.from({ length: n }, (_, i) => song(`${prefix}-${String(i).padStart(2, '0')}`));

const bookmark = (
  id: string,
  overrides: Partial<PlayQueueBookmark> = {},
): PlayQueueBookmark => ({
  id,
  name: `Bookmark ${id}`,
  createdAt: 1_700_000_000_000,
  queue: queueOf(4, id),
  currentIndex: 1,
  positionSec: 12.5,
  ...overrides,
});

const countRows = (table: string, snapshotId: string): number =>
  realDb.getFirstSync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM ${table} WHERE snapshot_id = ?;`,
    [snapshotId],
  )?.c ?? 0;

const CHILD_TABLES = [
  'queue_snapshot_song_genres',
  'queue_snapshot_song_artists',
  'queue_snapshot_song_album_artists',
  'queue_snapshot_song_contributors',
  'queue_snapshot_song_moods',
];

const songRows = (snapshotId: string): unknown[] =>
  realDb.getAllSync('SELECT * FROM queue_snapshot_songs WHERE snapshot_id = ? ORDER BY pos;', [
    snapshotId,
  ]);

/** The store's actions write through fire-and-forget; the seam resolves every promise
 *  synchronously, so one macrotask drains the whole chain. */
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Drop the in-memory map and rebuild it from SQL — a cold start, with the same call
 *  `rehydrateAllStores` makes. */
async function hydrateFresh(): Promise<Record<string, PlayQueueBookmark>> {
  bookmarksStore.setState({ bookmarks: {} });
  await bookmarksStore.getState().hydrateFromDbAsync();
  return bookmarksStore.getState().bookmarks;
}

beforeEach(() => {
  __setDbForTests(realDb);
  // ON DELETE CASCADE clears the songs and their five array tables with it.
  realDb.runSync('DELETE FROM queue_snapshots;');
  bookmarksStore.setState({ bookmarks: {}, autoName: true, sortOrder: 'newest' });
});

/* ------------------------------------------------------------------ */
/*  Create → hydrate                                                   */
/* ------------------------------------------------------------------ */

describe('addBookmark → hydrateFromDbAsync', () => {
  it('round-trips the whole bookmark, arrays included', async () => {
    bookmarksStore.getState().addBookmark(bookmark('bm-1', { queue: [fullSong] }));
    await settle();

    const hydrated = (await hydrateFresh())['bm-1'];
    expect(hydrated).toMatchObject({
      id: 'bm-1',
      name: 'Bookmark bm-1',
      createdAt: 1_700_000_000_000,
      currentIndex: 1,
      positionSec: 12.5,
    });
    expect(hydrated.queue).toHaveLength(1);
    const track = hydrated.queue[0];
    expect(track).toMatchObject({
      id: 's-full',
      title: 'Full Song',
      artist: 'The Artist',
      album: 'The Album',
      coverArt: 'cov-1',
      duration: 210,
      albumId: 'al-1',
      userRating: 4,
      suffix: 'flac',
      bitRate: 960,
      year: 1999,
      playCount: 12,
      path: 'The Artist/The Album/04 Full Song.flac',
    });
    expect(track.created).toEqual(new Date('2020-05-06T07:08:09.000Z'));
    expect(track.starred).toEqual(new Date('2021-06-07T08:09:10.000Z'));
    expect(track.isDir).toBe(false);
    expect(track.replayGain).toEqual({
      trackGain: -7.5,
      albumGain: -6.5,
      trackPeak: 0.98,
      albumPeak: 0.99,
    });
    // The five arrays — what the scrobble write path snapshots out of a restored queue.
    expect(track.genres).toEqual(['Rock', 'Indie']);
    expect(track.artists).toEqual([
      { id: 'ar-1', name: 'The Artist', albumCount: 0 },
      { id: 'ar-2', name: 'Feature', albumCount: 0 },
    ]);
    expect(track.albumArtists).toEqual([{ id: 'ar-3', name: 'Various', albumCount: 0 }]);
    expect(track.contributors).toEqual([
      {
        role: 'composer',
        subRole: 'lyrics',
        artist: { id: 'ar-4', name: 'Composer', albumCount: 0 },
      },
      { role: 'producer' },
    ]);
    expect(track.moods).toEqual(['energetic', 'happy']);
  });

  it('preserves the queue order', async () => {
    bookmarksStore.getState().addBookmark(bookmark('bm-1', { queue: queueOf(12) }));
    await settle();

    const hydrated = await hydrateFresh();
    expect(hydrated['bm-1'].queue.map((t) => t.id)).toEqual(queueOf(12).map((t) => t.id));
  });

  it('stores the snapshot as a bookmark, not as another live row', async () => {
    bookmarksStore.getState().addBookmark(bookmark('bm-1'));
    await settle();

    expect(readSnapshotSync('bm-1')?.kind).toBe('bookmark');
    expect(readSnapshotSync('bm-1')?.trackCount).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/*  Rename — the INSERT OR REPLACE cascade trap                        */
/* ------------------------------------------------------------------ */

describe('renameBookmark', () => {
  it('keeps every song row and array row', async () => {
    bookmarksStore.getState().addBookmark(bookmark('bm-1'));
    await settle();
    const before = songRows('bm-1');
    expect(before).toHaveLength(4);

    bookmarksStore.getState().renameBookmark('bm-1', 'Renamed');
    await settle();

    // The parent UPSERT must not have behaved like DELETE-then-INSERT.
    expect(songRows('bm-1')).toEqual(before);
    for (const table of CHILD_TABLES) expect(countRows(table, 'bm-1')).toBeGreaterThan(0);
    expect(readSnapshotSync('bm-1')?.trackCount).toBe(4);

    const hydrated = await hydrateFresh();
    expect(hydrated['bm-1'].name).toBe('Renamed');
    expect(hydrated['bm-1'].queue).toHaveLength(4);
    expect(hydrated['bm-1'].queue[0].moods).toEqual(['energetic', 'happy']);
  });

  it('is a no-op for an unknown id', async () => {
    bookmarksStore.getState().renameBookmark('nope', 'X');
    await settle();

    expect(bookmarksStore.getState().bookmarks).toEqual({});
    expect(readSnapshotSync('nope')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Delete                                                             */
/* ------------------------------------------------------------------ */

describe('removeBookmark', () => {
  it('removes the snapshot and cascades its songs and arrays', async () => {
    bookmarksStore.getState().addBookmark(bookmark('bm-1'));
    bookmarksStore.getState().addBookmark(bookmark('bm-2'));
    await settle();

    bookmarksStore.getState().removeBookmark('bm-1');
    await settle();

    expect(readSnapshotSync('bm-1')).toBeNull();
    expect(countRows('queue_snapshot_songs', 'bm-1')).toBe(0);
    for (const table of CHILD_TABLES) expect(countRows(table, 'bm-1')).toBe(0);
    // The other bookmark is untouched.
    expect(countRows('queue_snapshot_songs', 'bm-2')).toBe(4);
    expect(Object.keys(await hydrateFresh())).toEqual(['bm-2']);
  });
});

/* ------------------------------------------------------------------ */
/*  The live queue and the bookmarks share one table                   */
/* ------------------------------------------------------------------ */

describe('live snapshot ⇄ bookmarks isolation', () => {
  const liveMeta = {
    id: SNAPSHOT_LIVE_ID,
    kind: 'live' as const,
    name: null,
    createdAt: 1_600_000_000_000,
    currentIndex: 3,
    positionSec: 55.25,
  };

  const writeLive = async (tracks: Child[]): Promise<void> => {
    await upsertSnapshot(liveMeta);
    await replaceSnapshotTracks(SNAPSHOT_LIVE_ID, tracks);
  };

  it('creating and deleting bookmarks never touches the live row', async () => {
    await writeLive(queueOf(6, 'live'));
    const liveBefore = songRows(SNAPSHOT_LIVE_ID);

    bookmarksStore.getState().addBookmark(bookmark('bm-1'));
    bookmarksStore.getState().addBookmark(bookmark('bm-2'));
    await settle();
    bookmarksStore.getState().renameBookmark('bm-1', 'Renamed');
    bookmarksStore.getState().removeBookmark('bm-2');
    await settle();

    const live = readSnapshotSync(SNAPSHOT_LIVE_ID);
    expect(live).toMatchObject({ kind: 'live', currentIndex: 3, positionSec: 55.25, trackCount: 6 });
    expect(live?.tracks.map((t) => t.id)).toEqual(queueOf(6, 'live').map((t) => t.id));
    expect(songRows(SNAPSHOT_LIVE_ID)).toEqual(liveBefore);
  });

  it('rewriting the live queue never touches the bookmarks', async () => {
    bookmarksStore.getState().addBookmark(bookmark('bm-1'));
    await settle();
    const bookmarkBefore = songRows('bm-1');

    await writeLive(queueOf(6, 'live'));
    await writeLive(queueOf(2, 'other'));

    expect(songRows('bm-1')).toEqual(bookmarkBefore);
    const hydrated = await hydrateFresh();
    expect(hydrated['bm-1'].queue.map((t) => t.id)).toEqual(
      queueOf(4, 'bm-1').map((t) => t.id),
    );
  });

  it('hydration reads bookmarks only — the live queue is never one of them', async () => {
    await writeLive(queueOf(6, 'live'));
    bookmarksStore.getState().addBookmark(bookmark('bm-1'));
    await settle();

    expect(Object.keys(await hydrateFresh())).toEqual(['bm-1']);
  });

  it('clearing the live snapshot leaves the bookmarks intact', async () => {
    await writeLive(queueOf(6, 'live'));
    bookmarksStore.getState().addBookmark(bookmark('bm-1'));
    await settle();

    realDb.runSync('DELETE FROM queue_snapshots WHERE id = ?;', [SNAPSHOT_LIVE_ID]);

    expect(readSnapshotSync(SNAPSHOT_LIVE_ID)).toBeNull();
    expect((await hydrateFresh())['bm-1'].queue).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------ */
/*  Many bookmarks                                                     */
/* ------------------------------------------------------------------ */

describe('many bookmarks', () => {
  it('round-trip in a stable newest-first order with their own queues', async () => {
    for (let i = 0; i < 10; i++) {
      bookmarksStore.getState().addBookmark(
        bookmark(`bm-${i}`, {
          name: `Saved ${i}`,
          createdAt: 1_700_000_000_000 + i * 1_000,
          queue: queueOf(i + 1, `bm-${i}`),
        }),
      );
    }
    await settle();

    const first = await hydrateFresh();
    expect(Object.keys(first)).toEqual([
      'bm-9', 'bm-8', 'bm-7', 'bm-6', 'bm-5', 'bm-4', 'bm-3', 'bm-2', 'bm-1', 'bm-0',
    ]);
    expect(Object.keys(await hydrateFresh())).toEqual(Object.keys(first));

    for (let i = 0; i < 10; i++) {
      expect(first[`bm-${i}`].name).toBe(`Saved ${i}`);
      expect(first[`bm-${i}`].queue.map((t) => t.id)).toEqual(
        queueOf(i + 1, `bm-${i}`).map((t) => t.id),
      );
      expect(first[`bm-${i}`].queue[0].moods).toEqual(['energetic', 'happy']);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Hydration edges                                                    */
/* ------------------------------------------------------------------ */

describe('hydrateFromDbAsync', () => {
  // The read is authoritative — it REPLACES the map, it does not merge. That is why it
  // stays unwired until D1.4's migration has made the table the complete set: run it
  // against a partly-filled table and the bookmarks missing from it are gone, and the
  // persist middleware writes that loss through to the KV blob.
  it('replaces the map wholesale, dropping anything the table does not hold', async () => {
    bookmarksStore.setState({ bookmarks: { 'not-in-sql': bookmark('not-in-sql') } });
    bookmarksStore.getState().addBookmark(bookmark('bm-1'));
    await settle();

    await bookmarksStore.getState().hydrateFromDbAsync();

    expect(Object.keys(bookmarksStore.getState().bookmarks)).toEqual(['bm-1']);
  });

  it('yields an empty map when the table holds no bookmarks', async () => {
    bookmarksStore.setState({ bookmarks: { kv: bookmark('kv') } });

    await bookmarksStore.getState().hydrateFromDbAsync();

    expect(bookmarksStore.getState().bookmarks).toEqual({});
  });

  it('writes degrade to no-ops with no DB handle, leaving memory authoritative', async () => {
    bookmarksStore.getState().addBookmark(bookmark('bm-1'));
    await settle();
    __setDbForTests(null);

    bookmarksStore.getState().addBookmark(bookmark('bm-2'));
    bookmarksStore.getState().renameBookmark('bm-2', 'X');
    bookmarksStore.getState().removeBookmark('bm-1');
    await settle();

    // Memory still updated; nothing threw.
    expect(Object.keys(bookmarksStore.getState().bookmarks)).toEqual(['bm-2']);
    expect(bookmarksStore.getState().bookmarks['bm-2'].name).toBe('X');
    // A read with no handle resolves empty rather than throwing — which is precisely
    // why D1.4 must gate the wiring on the migration, not just on row count.
    await expect(bookmarksStore.getState().hydrateFromDbAsync()).resolves.toBeUndefined();
  });
});
