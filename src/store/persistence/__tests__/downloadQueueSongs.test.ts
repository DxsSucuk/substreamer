/**
 * `download_queue_songs` against REAL SQL on the better-sqlite3-backed op-SQLite seam:
 * the round trip, the FK cascades, and — the load-bearing part — the per-row gate that
 * decides whether a queue item's payload comes from the rows or from the legacy
 * `songs_json`.
 *
 * A queued download has no source to refetch from: an interrupted "download full
 * library" is hours of transfer. So a row whose songs are not stored must keep reading
 * the blob, and a conversion that does not verify must leave the blob authoritative.
 * Reading a row through the child table before it holds any is how a queued download
 * gets silently marked complete.
 *
 * Per AGENTS.md §11 the seam proves SQL semantics, never concurrency.
 */
import type { Child } from 'subsonic-api';

import { __setDbForTests, getDb, type InternalDb } from '../db';
import { migrateDownloadQueueSongs } from '../downloadQueueSongsMigration';
import {
  hydrateDownloadQueueAsync,
  insertDownloadQueueItem,
  markDownloadComplete,
  readDownloadQueueAlbumIdsAsync,
  readDownloadQueueSongRefsAsync,
  readDownloadQueueSongsAsync,
  readQueuedSongStatus,
  removeDownloadQueueItem,
  updateDownloadQueueItem,
  type DownloadQueueRow,
} from '../musicCacheTables';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
const realDb: InternalDb = handle;

/** Every column the snapshot carries, plus the five arrays — so "arrays intact" is a
 *  real assertion and not a check on an empty payload. */
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
  channelCount: 2,
  transcodedContentType: 'audio/mpeg',
  transcodedSuffix: 'mp3',
  size: 12_345_678,
  contentType: 'audio/flac',
  bpm: 128,
  comment: 'a comment',
  type: 'music',
  bookmarkPosition: 12,
  originalWidth: 1000,
  originalHeight: 1000,
  path: 'The Artist/The Album/04 Full Song.flac',
  parent: 'al-1',
  sortName: 'Full Song, The',
  musicBrainzId: 'mb-1',
  explicitStatus: 'clean',
  userRating: 4,
  averageRating: 4.5,
  playCount: 12,
  created: new Date('2020-05-06T07:08:09.000Z'),
  starred: new Date('2021-06-07T08:09:10.000Z'),
  played: '2024-01-02T03:04:05Z',
  displayArtist: 'The Artist feat. Feature',
  displayAlbumArtist: 'Various',
  displayComposer: 'Composer',
  replayGain: {
    trackGain: -7.5,
    albumGain: -6.5,
    trackPeak: 0.98,
    albumPeak: 0.99,
    baseGain: 1,
    fallbackGain: -2,
  },
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

const song = (id: string, overrides: Partial<Child> = {}): Child =>
  ({ ...fullSong, id, title: `Title ${id}`, ...overrides }) as Child;

const albumOf = (n: number): Child[] =>
  Array.from({ length: n }, (_, i) => song(`s-${String(i).padStart(2, '0')}`));

type QueueInput = Omit<DownloadQueueRow, 'queuePosition'>;

const makeQueueRow = (overrides: Partial<QueueInput> = {}): QueueInput => ({
  queueId: 'q-1',
  itemId: 'al-1',
  type: 'album',
  name: 'The Album',
  artist: 'The Artist',
  coverArtId: 'cov-1',
  status: 'queued',
  totalSongs: 1,
  completedSongs: 0,
  addedAt: 1_700_000_000_000,
  ...overrides,
});

const CHILD_TABLES = [
  'download_queue_song_genres',
  'download_queue_song_artists',
  'download_queue_song_album_artists',
  'download_queue_song_contributors',
  'download_queue_song_moods',
];

const countRows = (table: string, queueId: string): number =>
  realDb.getFirstSync<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE queue_id = ?;`, [
    queueId,
  ])?.c ?? 0;

const storedSongCount = (queueId: string): number => countRows('download_queue_songs', queueId);

const storedJson = (queueId: string): string =>
  realDb.getFirstSync<{ songs_json: string }>(
    'SELECT songs_json FROM download_queue WHERE queue_id = ?;',
    [queueId],
  )?.songs_json ?? '<missing>';

/**
 * A queue row exactly as a pre-upgrade build left it: the payload in `songs_json`, and
 * nothing in `download_queue_songs`. This is the row the gate exists for.
 */
function seedUnmigratedRow(queueId: string, songs: Child[], status = 'queued'): void {
  realDb.runSync(
    `INSERT INTO download_queue
       (queue_id, item_id, type, name, artist, cover_art_id, status,
        total_songs, completed_songs, error, added_at, queue_position, songs_json)
       VALUES (?, ?, 'album', 'The Album', 'The Artist', 'cov-1', ?, ?, 0, NULL, ?,
               (SELECT COALESCE(MAX(queue_position), 0) + 1 FROM download_queue), ?);`,
    [queueId, `al-${queueId}`, status, songs.length, 1_700_000_000_000, JSON.stringify(songs)],
  );
}

/** Records the SQL each op issues, so "does not materialise the whole Child" can be
 *  asserted rather than assumed. Delegates everything to the real handle. */
function countingDb(): { db: InternalDb; sql: string[] } {
  const sql: string[] = [];
  const db: InternalDb = {
    ...realDb,
    getFirstSync: (...a) => realDb.getFirstSync(...a),
    getAllSync: (...a) => realDb.getAllSync(...a),
    getAllAsync: (s, p) => {
      sql.push(s);
      return realDb.getAllAsync(s, p);
    },
    getFirstAsync: (s, p) => {
      sql.push(s);
      return realDb.getFirstAsync(s, p);
    },
    runSync: (s, p) => realDb.runSync(s, p),
    runAsync: (s, p) => realDb.runAsync(s, p),
    runBatchAsync: (c) => realDb.runBatchAsync(c),
    runAtomicBatchAsync: (c) => realDb.runAtomicBatchAsync(c),
    execSync: (s) => realDb.execSync(s),
    withTransactionSync: (f) => realDb.withTransactionSync(f),
  };
  return { db, sql };
}

const noop = (): void => {};

beforeEach(() => {
  __setDbForTests(realDb);
  // ON DELETE CASCADE clears the songs and their five array tables with it.
  realDb.runSync('DELETE FROM download_queue;');
});

afterEach(() => {
  __setDbForTests(realDb);
});

/* ------------------------------------------------------------------ */
/*  Round trip                                                         */
/* ------------------------------------------------------------------ */

describe('insertDownloadQueueItem + readDownloadQueueSongsAsync', () => {
  it('round-trips a queued album in order, arrays intact', async () => {
    const songs = albumOf(12);
    await insertDownloadQueueItem(makeQueueRow({ totalSongs: songs.length }), songs);

    const read = await readDownloadQueueSongsAsync('q-1');
    expect(read.map((c) => c.id)).toEqual(songs.map((c) => c.id));
    // Two documented normalisations on the way back: `genres` becomes `string[]`, and
    // the credit mirrors hold identity only, so `albumCount` reconstructs as 0.
    expect(read[0]).toEqual({
      ...songs[0],
      genres: ['Rock', 'Indie'],
      artists: [
        { id: 'ar-1', name: 'The Artist', albumCount: 0 },
        { id: 'ar-2', name: 'Feature', albumCount: 0 },
      ],
      albumArtists: [{ id: 'ar-3', name: 'Various', albumCount: 0 }],
      contributors: [
        {
          role: 'composer',
          subRole: 'lyrics',
          artist: { id: 'ar-4', name: 'Composer', albumCount: 0 },
        },
        { role: 'producer' },
      ],
      moods: ['energetic', 'happy'],
    });
  });

  it('leaves the retained songs_json column empty — the payload is the rows', async () => {
    await insertDownloadQueueItem(makeQueueRow(), [song('s-1')]);
    expect(storedJson('q-1')).toBe('');
    expect(storedSongCount('q-1')).toBe(1);
  });

  it('keeps the queue row out of the hydrate’s projection', async () => {
    await insertDownloadQueueItem(makeQueueRow(), [song('s-1')]);
    const [row] = await hydrateDownloadQueueAsync();
    expect(row.queueId).toBe('q-1');
    expect(Object.keys(row)).not.toContain('songsJson');
  });

  it('stores a duplicated song at both positions', async () => {
    const dup = song('s-dup');
    await insertDownloadQueueItem(makeQueueRow({ totalSongs: 2 }), [dup, dup]);
    expect((await readDownloadQueueSongsAsync('q-1')).map((c) => c.id)).toEqual([
      's-dup',
      's-dup',
    ]);
  });

  it('drops an id-less entry rather than aborting the whole batch', async () => {
    const songs = [song('s-1'), { ...fullSong, id: '' } as Child, song('s-2')];
    await insertDownloadQueueItem(makeQueueRow({ totalSongs: 2 }), songs);
    expect((await readDownloadQueueSongsAsync('q-1')).map((c) => c.id)).toEqual(['s-1', 's-2']);
  });

  it('answers empty for a queue_id that is not there', async () => {
    expect(await readDownloadQueueSongsAsync('q-nope')).toEqual([]);
    expect(await readDownloadQueueSongRefsAsync('q-nope')).toEqual([]);
    expect(await readDownloadQueueAlbumIdsAsync('q-nope')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  The gate — an unmigrated row must NOT read through the child table  */
/* ------------------------------------------------------------------ */

describe('the per-row payload gate', () => {
  it('reads an unmigrated row from songs_json, not from zero child rows', async () => {
    const songs = albumOf(8);
    seedUnmigratedRow('q-old', songs);
    expect(storedSongCount('q-old')).toBe(0);

    const read = await readDownloadQueueSongsAsync('q-old');
    // The whole point: NOT `[]`. An empty answer is what makes `downloadItem` mark a
    // queued download complete with nothing downloaded.
    expect(read).not.toHaveLength(0);
    expect(read.map((c) => c.id)).toEqual(songs.map((c) => c.id));
  });

  it('serves the narrow readers from songs_json too while the gate is shut', async () => {
    seedUnmigratedRow('q-old', [
      song('s-1', { albumId: 'al-a' }),
      song('s-2', { albumId: 'al-b' }),
    ]);
    expect(await readDownloadQueueSongRefsAsync('q-old')).toEqual([
      { id: 's-1', albumId: 'al-a' },
      { id: 's-2', albumId: 'al-b' },
    ]);
    expect((await readDownloadQueueAlbumIdsAsync('q-old')).sort()).toEqual(['al-a', 'al-b']);
  });

  it('keeps reading songs_json when the stored count disagrees with total_songs', async () => {
    // A half-converted row cannot happen through the atomic writers, but the gate is
    // what guarantees a truncated payload is never served as the whole one.
    const songs = albumOf(4);
    seedUnmigratedRow('q-old', songs);
    realDb.runSync(
      `INSERT INTO download_queue_songs (queue_id, pos, song_id, title) VALUES (?, 0, ?, ?);`,
      ['q-old', 's-00', 'Title s-00'],
    );
    expect(storedSongCount('q-old')).toBe(1);
    expect((await readDownloadQueueSongsAsync('q-old')).map((c) => c.id)).toEqual(
      songs.map((c) => c.id),
    );
  });

  it('answers null from the queued-song lookup for an unmigrated row', () => {
    seedUnmigratedRow('q-old', [song('s-1')]);
    expect(readQueuedSongStatus('s-1')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Narrow readers                                                     */
/* ------------------------------------------------------------------ */

describe('the readers that only need an id', () => {
  it('never selects the Child columns for a stored payload', async () => {
    await insertDownloadQueueItem(makeQueueRow({ totalSongs: 2 }), [
      song('s-1', { albumId: 'al-a' }),
      song('s-2', { albumId: 'al-a' }),
    ]);

    const { db, sql } = countingDb();
    __setDbForTests(db);
    expect(await readDownloadQueueAlbumIdsAsync('q-1')).toEqual(['al-a']);
    expect(await readDownloadQueueSongRefsAsync('q-1')).toEqual([
      { id: 's-1', albumId: 'al-a' },
      { id: 's-2', albumId: 'al-a' },
    ]);

    // The gate's own probe reads `download_queue`, so match only the payload SELECTs.
    const payloadReads = sql.filter((s) => s.startsWith('SELECT') && !s.includes('song_rows'));
    expect(payloadReads).toHaveLength(2);
    for (const statement of payloadReads) {
      expect(statement).not.toMatch(/content_type|music_brainz_id|rg_track_gain|title/);
    }
    // …and none of the five array tables was touched.
    expect(sql.some((s) => s.includes('download_queue_song_genres'))).toBe(false);
  });

  it('deduplicates album ids in SQL', async () => {
    await insertDownloadQueueItem(makeQueueRow({ totalSongs: 3 }), [
      song('s-1', { albumId: 'al-a' }),
      song('s-2', { albumId: 'al-a' }),
      song('s-3', { albumId: 'al-b' }),
    ]);
    expect((await readDownloadQueueAlbumIdsAsync('q-1')).sort()).toEqual(['al-a', 'al-b']);
  });
});

/* ------------------------------------------------------------------ */
/*  readQueuedSongStatus                                               */
/* ------------------------------------------------------------------ */

describe('readQueuedSongStatus', () => {
  beforeEach(async () => {
    await insertDownloadQueueItem(makeQueueRow({ totalSongs: 2 }), [song('s-1'), song('s-2')]);
  });

  it('finds a song in a queued item', () => {
    expect(readQueuedSongStatus('s-2')).toBe('queued');
  });

  it('follows the item into downloading', async () => {
    await updateDownloadQueueItem('q-1', { status: 'downloading' });
    expect(readQueuedSongStatus('s-1')).toBe('downloading');
  });

  it('ignores an item that is finished or failed', async () => {
    await updateDownloadQueueItem('q-1', { status: 'error' });
    expect(readQueuedSongStatus('s-1')).toBeNull();
  });

  it('answers null for a song in no queue item, and for no id at all', () => {
    expect(readQueuedSongStatus('s-elsewhere')).toBeNull();
    expect(readQueuedSongStatus('')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Cascades                                                           */
/* ------------------------------------------------------------------ */

describe('the payload cascades with its queue row', () => {
  beforeEach(async () => {
    await insertDownloadQueueItem(makeQueueRow(), [song('s-1')]);
    expect(storedSongCount('q-1')).toBe(1);
    for (const table of CHILD_TABLES) expect(countRows(table, 'q-1')).toBeGreaterThan(0);
  });

  it('markDownloadComplete takes the songs and their arrays with the row', async () => {
    await markDownloadComplete(
      'q-1',
      {
        itemId: 'al-1',
        type: 'album',
        name: 'The Album',
        expectedSongCount: 1,
        lastSyncAt: 1,
        downloadedAt: 1,
      },
      [],
      [],
    );
    expect(storedSongCount('q-1')).toBe(0);
    for (const table of CHILD_TABLES) expect(countRows(table, 'q-1')).toBe(0);
  });

  it('cancelling — removeDownloadQueueItem — does the same', async () => {
    await removeDownloadQueueItem('q-1');
    expect(storedSongCount('q-1')).toBe(0);
    for (const table of CHILD_TABLES) expect(countRows(table, 'q-1')).toBe(0);
  });

  it('keeps an error row’s songs across a hydrate — the user can still retry it', async () => {
    await updateDownloadQueueItem('q-1', { status: 'error', error: 'boom' });
    const [row] = await hydrateDownloadQueueAsync();
    expect(row.status).toBe('error');
    expect(storedSongCount('q-1')).toBe(1);
    expect((await readDownloadQueueSongsAsync('q-1')).map((c) => c.id)).toEqual(['s-1']);
  });

  it('a re-write of the same queue_id replaces the payload rather than appending', async () => {
    await insertDownloadQueueItem(makeQueueRow({ totalSongs: 2 }), [song('s-a'), song('s-b')]);
    expect(storedSongCount('q-1')).toBe(2);
    expect((await readDownloadQueueSongsAsync('q-1')).map((c) => c.id)).toEqual(['s-a', 's-b']);
    // The shrunk case is the one positional rows get wrong without the leading DELETE.
    await insertDownloadQueueItem(makeQueueRow({ totalSongs: 1 }), [song('s-c')]);
    expect((await readDownloadQueueSongsAsync('q-1')).map((c) => c.id)).toEqual(['s-c']);
    for (const table of CHILD_TABLES) {
      expect(countRows(table, 'q-1')).toBeLessThanOrEqual(2);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Migration 39                                                       */
/* ------------------------------------------------------------------ */

describe('migrateDownloadQueueSongs', () => {
  it('converts an unmigrated row and opens its gate', async () => {
    const songs = albumOf(5);
    seedUnmigratedRow('q-old', songs);

    await migrateDownloadQueueSongs(noop);

    expect(storedSongCount('q-old')).toBe(5);
    expect((await readDownloadQueueSongsAsync('q-old')).map((c) => c.id)).toEqual(
      songs.map((c) => c.id),
    );
    // The blob is KEPT — dead data on disk is cheaper than a download that cannot
    // fall back (the owner's decision; nothing drops the column).
    expect(storedJson('q-old')).not.toBe('');
  });

  it('is idempotent — a second run rewrites nothing', async () => {
    seedUnmigratedRow('q-old', albumOf(3));
    const lines: string[] = [];
    await migrateDownloadQueueSongs((m) => lines.push(m));
    const rowidsAfterFirst = realDb.getAllSync<{ rowid: number }>(
      'SELECT rowid FROM download_queue_songs WHERE queue_id = ? ORDER BY pos;',
      ['q-old'],
    );

    await migrateDownloadQueueSongs((m) => lines.push(m));

    expect(
      realDb.getAllSync<{ rowid: number }>(
        'SELECT rowid FROM download_queue_songs WHERE queue_id = ? ORDER BY pos;',
        ['q-old'],
      ),
    ).toEqual(rowidsAfterFirst);
    expect(lines.at(-1)).toContain('already store their songs');
  });

  it('leaves a row already written by the current code alone', async () => {
    await insertDownloadQueueItem(makeQueueRow(), [song('s-1')]);
    const lines: string[] = [];
    await migrateDownloadQueueSongs((m) => lines.push(m));
    expect(lines.at(-1)).toContain('already store their songs');
    expect(storedSongCount('q-1')).toBe(1);
  });

  it('says so when the queue is empty', async () => {
    const lines: string[] = [];
    await migrateDownloadQueueSongs((m) => lines.push(m));
    expect(lines.at(-1)).toContain('nothing to convert');
  });

  it('leaves songs_json intact and the gate shut when the write fails', async () => {
    const songs = albumOf(4);
    seedUnmigratedRow('q-old', songs);
    const before = storedJson('q-old');

    __setDbForTests({
      ...realDb,
      runAtomicBatchAsync: async () => {
        throw new Error('write refused');
      },
    } as InternalDb);
    await migrateDownloadQueueSongs(noop);
    __setDbForTests(realDb);

    expect(storedSongCount('q-old')).toBe(0);
    expect(storedJson('q-old')).toBe(before);
    expect((await readDownloadQueueSongsAsync('q-old')).map((c) => c.id)).toEqual(
      songs.map((c) => c.id),
    );
  });

  it('undoes a write whose read-back does not match, so the blob stays authoritative', async () => {
    const songs = albumOf(4);
    seedUnmigratedRow('q-old', songs);
    const before = storedJson('q-old');

    // The read-back is what proves the rows landed; a wrong one must not be trusted.
    __setDbForTests({
      ...realDb,
      getAllAsync: (async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT song_id FROM download_queue_songs')) {
          return [{ song_id: 'not-the-song' }];
        }
        return realDb.getAllAsync(sql, params as never);
      }) as InternalDb['getAllAsync'],
    } as InternalDb);
    await migrateDownloadQueueSongs(noop);
    __setDbForTests(realDb);

    expect(storedSongCount('q-old')).toBe(0);
    expect(storedJson('q-old')).toBe(before);
    expect((await readDownloadQueueSongsAsync('q-old')).map((c) => c.id)).toEqual(
      songs.map((c) => c.id),
    );
  });

  it('skips a row whose blob cannot satisfy the gate rather than half-converting it', async () => {
    // `total_songs` disagreeing with the payload is a v1 shape Migration 14 could
    // replay. Converting it would leave rows behind a gate that stays shut for good.
    seedUnmigratedRow('q-old', albumOf(3));
    realDb.runSync('UPDATE download_queue SET total_songs = 9 WHERE queue_id = ?;', ['q-old']);

    const lines: string[] = [];
    await migrateDownloadQueueSongs((m) => lines.push(m));

    expect(storedSongCount('q-old')).toBe(0);
    expect(lines.at(-1)).toContain('1 keep reading songs_json');
    expect(await readDownloadQueueSongsAsync('q-old')).toHaveLength(3);
  });

  it('converts the convertible rows and leaves the rest on the blob', async () => {
    seedUnmigratedRow('q-a', albumOf(2));
    seedUnmigratedRow('q-b', []);
    realDb.runSync("UPDATE download_queue SET songs_json = 'not json' WHERE queue_id = ?;", [
      'q-b',
    ]);

    const lines: string[] = [];
    await migrateDownloadQueueSongs((m) => lines.push(m));

    expect(storedSongCount('q-a')).toBe(2);
    expect(storedSongCount('q-b')).toBe(0);
    expect(lines.at(-1)).toContain('converted 1/2');
  });
});
