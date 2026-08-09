/**
 * The lyrics READ/WRITE path against REAL SQL on the better-sqlite3-backed op-SQLite
 * seam: one parent row plus its positional `lyric_lines`, written per song.
 *
 * The last describe is the point of the whole change — lyrics used to live in one
 * `substreamer-lyrics` KV blob that every fetch re-stringified in full, so the cost of
 * storing one song grew with every song already stored. The statement count is asserted
 * directly rather than inspected.
 *
 * Per AGENTS.md §11 the seam proves SQL semantics, never concurrency.
 */
jest.mock('../../../services/subsonicService', () => ({
  __esModule: true,
  getLyricsForTrack: jest.fn(),
}));

import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  clearAllLyrics,
  countLyricsBySynced,
  deleteLyrics,
  listCachedLyrics,
  loadLyrics,
  saveLyrics,
} from '../lyricsTable';

import { getLyricsForTrack, type LyricsData } from '../../../services/subsonicService';
import { lyricsStore } from '../../lyricsStore';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
const realDb: InternalDb = handle;

const mockGetLyrics = getLyricsForTrack as jest.MockedFunction<typeof getLyricsForTrack>;

/** A synced set long enough that a stale tail would be obvious. */
const syncedLyrics = (lineCount: number): LyricsData => ({
  synced: true,
  lines: Array.from({ length: lineCount }, (_, i) => ({
    startMs: i * 1500,
    text: `line ${i}`,
  })),
  lang: 'en',
  offsetMs: -250,
  source: 'structured',
});

const classicLyrics: LyricsData = {
  synced: false,
  lines: [
    { startMs: 0, text: 'first' },
    { startMs: 0, text: '' },
    { startMs: 0, text: 'third' },
  ],
  offsetMs: 0,
  source: 'classic',
};

const lineRows = (songId: string): { pos: number; start_ms: number; text: string }[] =>
  realDb.getAllSync('SELECT pos, start_ms, text FROM lyric_lines WHERE song_id = ? ORDER BY pos;', [
    songId,
  ]);

const countOf = (table: string): number =>
  realDb.getFirstSync<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table};`)?.c ?? 0;

beforeEach(() => {
  jest.clearAllMocks();
  __setDbForTests(realDb);
  // ON DELETE CASCADE takes `lyric_lines` with it.
  realDb.runSync('DELETE FROM lyrics;');
  lyricsStore.setState({ entries: {}, loading: {}, errors: {} });
});

afterEach(() => {
  __setDbForTests(realDb);
});

/* ------------------------------------------------------------------ */
/*  Round trips                                                        */
/* ------------------------------------------------------------------ */

describe('saveLyrics / loadLyrics — round trip', () => {
  it('returns a synced set identical to what went in, lines in order', async () => {
    const data = syncedLyrics(64);
    await saveLyrics('song-1', data);

    expect(await loadLyrics('song-1')).toEqual(data);
    expect(lineRows('song-1')).toHaveLength(64);
  });

  it('keeps lang, offsetMs and source', async () => {
    await saveLyrics('song-1', syncedLyrics(3));

    const row = realDb.getFirstSync<{
      synced: number;
      lang: string | null;
      offset_ms: number;
      source: string;
    }>('SELECT synced, lang, offset_ms, source FROM lyrics WHERE song_id = ?;', ['song-1']);
    expect(row).toEqual({ synced: 1, lang: 'en', offset_ms: -250, source: 'structured' });
  });

  it('round-trips an unsynced classic set, including an empty line', async () => {
    await saveLyrics('song-2', classicLyrics);

    const read = await loadLyrics('song-2');
    expect(read).toEqual(classicLyrics);
    expect(read?.lang).toBeUndefined();
    expect(realDb.getFirstSync<{ synced: number }>(
      'SELECT synced FROM lyrics WHERE song_id = ?;',
      ['song-2'],
    )).toEqual({ synced: 0 });
  });

  it('returns null for a song with no stored lyrics', async () => {
    expect(await loadLyrics('never-fetched')).toBeNull();
  });

  it('has no FK to songs — a track outside the library stores fine', async () => {
    expect(countOf('songs')).toBe(0);
    await saveLyrics('not-in-library', syncedLyrics(2));
    expect(await loadLyrics('not-in-library')).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Rewrites: positional lines must not leave a tail                   */
/* ------------------------------------------------------------------ */

describe('saveLyrics — rewriting a song', () => {
  it('leaves no stale tail rows when the replacement is shorter', async () => {
    await saveLyrics('song-1', syncedLyrics(40));
    expect(lineRows('song-1')).toHaveLength(40);

    const shorter = syncedLyrics(3);
    await saveLyrics('song-1', shorter);

    expect(lineRows('song-1')).toHaveLength(3);
    expect(await loadLyrics('song-1')).toEqual(shorter);
  });

  it('updates the scalars in place rather than replacing the parent row', async () => {
    await saveLyrics('song-1', syncedLyrics(4));
    await saveLyrics('song-1', classicLyrics);

    expect(countOf('lyrics')).toBe(1);
    expect(await loadLyrics('song-1')).toEqual(classicLyrics);
  });

  it("does not touch another song's rows", async () => {
    const keep = syncedLyrics(5);
    await saveLyrics('song-keep', keep);
    await saveLyrics('song-other', classicLyrics);
    await saveLyrics('song-other', syncedLyrics(2));

    expect(await loadLyrics('song-keep')).toEqual(keep);
  });
});

/* ------------------------------------------------------------------ */
/*  Names: what the cached-lyrics browser labels its rows with         */
/* ------------------------------------------------------------------ */

describe('title / artist', () => {
  const nameRow = (songId: string) =>
    realDb.getFirstSync<{ title: string | null; artist: string | null }>(
      'SELECT title, artist FROM lyrics WHERE song_id = ?;',
      [songId],
    );

  it('stores the names passed at write time', async () => {
    await saveLyrics('song-1', syncedLyrics(2), 'Paranoid Android', 'Radiohead');

    expect(nameRow('song-1')).toEqual({ title: 'Paranoid Android', artist: 'Radiohead' });
  });

  it('leaves them null when the caller has none', async () => {
    await saveLyrics('song-1', classicLyrics);

    expect(nameRow('song-1')).toEqual({ title: null, artist: null });
  });

  it('keeps the captured names when a later write omits them', async () => {
    await saveLyrics('song-1', syncedLyrics(2), 'Paranoid Android', 'Radiohead');
    await saveLyrics('song-1', classicLyrics);

    expect(nameRow('song-1')).toEqual({ title: 'Paranoid Android', artist: 'Radiohead' });
  });

  it('updates them when a later write supplies new ones', async () => {
    await saveLyrics('song-1', syncedLyrics(2), 'Old', 'Nobody');
    await saveLyrics('song-1', syncedLyrics(2), 'Paranoid Android', 'Radiohead');

    expect(nameRow('song-1')).toEqual({ title: 'Paranoid Android', artist: 'Radiohead' });
  });

  it('round-trips through listCachedLyrics with the synced flag', async () => {
    await saveLyrics('song-1', syncedLyrics(2), 'Synced One', 'Artist A');
    await saveLyrics('song-2', classicLyrics, 'Plain One', 'Artist B');

    const rows = await listCachedLyrics();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { songId: 'song-1', title: 'Synced One', artist: 'Artist A', synced: true },
        { songId: 'song-2', title: 'Plain One', artist: 'Artist B', synced: false },
      ]),
    );
  });

  it('lists nothing when nothing is cached', async () => {
    expect(await listCachedLyrics()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Counts: a SQL aggregate, not a row load                            */
/* ------------------------------------------------------------------ */

describe('countLyricsBySynced', () => {
  it('splits synced from unsynced', async () => {
    await saveLyrics('song-1', syncedLyrics(3));
    await saveLyrics('song-2', syncedLyrics(3));
    await saveLyrics('song-3', classicLyrics);

    expect(await countLyricsBySynced()).toEqual({ synced: 2, unsynced: 1 });
  });

  it('returns zeros for an empty table', async () => {
    expect(await countLyricsBySynced()).toEqual({ synced: 0, unsynced: 0 });
  });

  it('counts a null synced flag as unsynced', async () => {
    realDb.runSync('INSERT INTO lyrics (song_id, synced) VALUES (?, NULL);', ['song-odd']);

    expect(await countLyricsBySynced()).toEqual({ synced: 0, unsynced: 1 });
  });

  it('follows a rewrite that flips the flag', async () => {
    await saveLyrics('song-1', syncedLyrics(3));
    expect(await countLyricsBySynced()).toEqual({ synced: 1, unsynced: 0 });

    await saveLyrics('song-1', classicLyrics);
    expect(await countLyricsBySynced()).toEqual({ synced: 0, unsynced: 1 });
  });
});

/* ------------------------------------------------------------------ */
/*  Deleting one song                                                  */
/* ------------------------------------------------------------------ */

describe('deleteLyrics', () => {
  it('removes the row and cascades its lines', async () => {
    await saveLyrics('song-1', syncedLyrics(10));
    await saveLyrics('song-2', classicLyrics);

    await deleteLyrics('song-1');

    expect(await loadLyrics('song-1')).toBeNull();
    expect(lineRows('song-1')).toHaveLength(0);
    expect(countOf('lyrics')).toBe(1);
    expect(await loadLyrics('song-2')).toEqual(classicLyrics);
  });

  it('is a no-op for a song with nothing stored', async () => {
    await saveLyrics('song-1', classicLyrics);

    await deleteLyrics('never-fetched');

    expect(countOf('lyrics')).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Clearing                                                           */
/* ------------------------------------------------------------------ */

describe('clearing', () => {
  it('clearAllLyrics empties both tables', async () => {
    await saveLyrics('song-1', syncedLyrics(10));
    await saveLyrics('song-2', classicLyrics);
    expect(countOf('lyric_lines')).toBe(13);

    await clearAllLyrics();

    expect(countOf('lyrics')).toBe(0);
    expect(countOf('lyric_lines')).toBe(0);
  });

  it('lyricsStore.clearLyrics empties the table and the session cache', async () => {
    mockGetLyrics.mockResolvedValue(syncedLyrics(6));
    await lyricsStore.getState().fetchLyrics('song-1');
    expect(lyricsStore.getState().entries['song-1']).toBeDefined();
    expect(countOf('lyrics')).toBe(1);

    await lyricsStore.getState().clearLyrics();

    expect(lyricsStore.getState().entries).toEqual({});
    expect(countOf('lyrics')).toBe(0);
    expect(countOf('lyric_lines')).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Degraded DB: silent no-ops, never a throw into the store           */
/* ------------------------------------------------------------------ */

describe('when the DB is unavailable', () => {
  it('reads null and swallows the writes', async () => {
    __setDbForTests(null);

    expect(await loadLyrics('song-1')).toBeNull();
    await expect(saveLyrics('song-1', classicLyrics)).resolves.toBeUndefined();
    await expect(deleteLyrics('song-1')).resolves.toBeUndefined();
    await expect(clearAllLyrics()).resolves.toBeUndefined();
    expect(await countLyricsBySynced()).toEqual({ synced: 0, unsynced: 0 });
    expect(await listCachedLyrics()).toEqual([]);
  });

  it('swallows a query that throws', async () => {
    const failing = new Error('disk gone');
    __setDbForTests({
      ...realDb,
      getFirstAsync: () => Promise.reject(failing),
      getAllAsync: () => Promise.reject(failing),
      runAsync: () => Promise.reject(failing),
      runAtomicBatchAsync: () => Promise.reject(failing),
    } as InternalDb);

    expect(await loadLyrics('song-1')).toBeNull();
    await expect(saveLyrics('song-1', classicLyrics)).resolves.toBeUndefined();
    await expect(deleteLyrics('song-1')).resolves.toBeUndefined();
    await expect(clearAllLyrics()).resolves.toBeUndefined();
    expect(await countLyricsBySynced()).toEqual({ synced: 0, unsynced: 0 });
    expect(await listCachedLyrics()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  The store's memory → SQL → network ladder, against real rows       */
/* ------------------------------------------------------------------ */

describe('lyricsStore.fetchLyrics — over the real table', () => {
  it('writes one row on the network path and serves the next session from SQL', async () => {
    const data = syncedLyrics(8);
    mockGetLyrics.mockResolvedValue(data);
    await lyricsStore.getState().fetchLyrics('song-1');

    expect(countOf('lyrics')).toBe(1);
    expect(lineRows('song-1')).toHaveLength(8);

    // A new session: the memory cache is gone, the rows are not.
    lyricsStore.setState({ entries: {}, loading: {}, errors: {} });
    mockGetLyrics.mockClear();

    expect(await lyricsStore.getState().fetchLyrics('song-1')).toEqual(data);
    expect(mockGetLyrics).not.toHaveBeenCalled();
  });

  it('stores nothing for a track the server has no lyrics for', async () => {
    mockGetLyrics.mockResolvedValue(null);

    expect(await lyricsStore.getState().fetchLyrics('song-none')).toBeNull();
    expect(countOf('lyrics')).toBe(0);
    expect(lyricsStore.getState().errors['song-none']).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  The defect: the write must not scale with what is already stored   */
/* ------------------------------------------------------------------ */

describe('write cost is proportional to the one song, not the cache', () => {
  const LINES = 12;

  /** Statements issued by `saveLyrics` for one song, with `existing` songs already
   *  stored. The SAVEPOINT/RELEASE pair `runAtomicBatchAsync` adds is outside this. */
  const statementsForOneWrite = async (existing: number): Promise<number> => {
    realDb.runSync('DELETE FROM lyrics;');
    for (let i = 0; i < existing; i++) {
      // eslint-disable-next-line no-await-in-loop
      await saveLyrics(`prior-${i}`, syncedLyrics(LINES));
    }
    const spy = jest.spyOn(realDb, 'runAtomicBatchAsync');
    await saveLyrics('subject', syncedLyrics(LINES));
    expect(spy).toHaveBeenCalledTimes(1);
    const count = spy.mock.calls[0][0].length;
    spy.mockRestore();
    return count;
  };

  it('issues the same statement count for song 1 and song 101', async () => {
    const cold = await statementsForOneWrite(0);
    const warm = await statementsForOneWrite(100);

    // parent upsert + the lines DELETE + one INSERT per line.
    expect(cold).toBe(2 + LINES);
    expect(warm).toBe(cold);
  });

  it('leaves every previously stored song untouched', async () => {
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      await saveLyrics(`song-${i}`, syncedLyrics(LINES));
    }
    await saveLyrics('song-new', classicLyrics);

    expect(countOf('lyrics')).toBe(21);
    expect(await loadLyrics('song-0')).toEqual(syncedLyrics(LINES));
    expect(await loadLyrics('song-19')).toEqual(syncedLyrics(LINES));
  });
});
