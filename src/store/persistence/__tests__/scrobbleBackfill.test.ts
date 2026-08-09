/**
 * `backfillScrobbleColumnsAsync` against REAL SQL.
 *
 * Everything interesting here turns on things the hand-rolled fake in
 * `scrobbleTable.test.ts` cannot model: 37 typed columns, the five `scrobble_*`
 * child tables, their FK/cascade, and `runBatchAsync`'s non-atomic abort. This
 * suite runs the generated schema (`src/db/normalizedDdl.ts`, applied at import by
 * `persistence/db.ts`) on the better-sqlite3-backed op-SQLite seam.
 *
 * Per AGENTS.md §11 that seam proves SQL semantics, never concurrency — the seam
 * runs `executeBatch` synchronously, so nothing here says anything about the pool.
 *
 * The backfill only ever reads `song_json`, which the generated schema no longer has —
 * so every case here rebuilds the table in the pre-drop shape it is written for.
 */
import type { Child } from 'subsonic-api';

import type { BatchCommand } from '../../../db/client';
import { __setDbForTests, getDb, type InternalDb } from '../db';
import { deriveScrobbleColumns, SCROBBLE_COLUMN_NAMES } from '../scrobbleColumns';
import { backfillScrobbleColumnsAsync } from '../scrobbleTable';
import { createLegacyScrobbleTables } from '../../../test-utils/legacyScrobbleTables';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
const realDb: InternalDb = handle;

const TIME = 1_700_000_000_000;

/** A `Child` with every array populated and a scalar in each of the late columns
 *  (`bpm`, `sort_name`, `played`, `music_brainz_id`, replay gain) — those are the
 *  ones an off-by-one in the UPDATE's placeholders would shift. */
const fullSong = {
  id: 's-full',
  title: 'Full Song',
  artist: 'The Artist',
  album: 'The Album',
  isDir: false,
  coverArt: 'cov-1',
  duration: 210,
  albumId: 'al-1',
  artistId: 'ar-1',
  year: 1999,
  track: 4,
  discNumber: 2,
  suffix: 'flac',
  bitRate: 960,
  size: 12_345_678,
  contentType: 'audio/flac',
  bpm: 128,
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
  displayComposer: 'Composer',
  replayGain: { trackGain: -7.5, trackPeak: 0.98 },
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

const simpleSong = (id: string, extra: Partial<Child> = {}): Child =>
  ({ id, title: `Title ${id}`, artist: 'A', album: 'B', isDir: false, ...extra }) as Child;

/* ------------------------------------------------------------------ */
/*  Seeds + raw readers                                                */
/* ------------------------------------------------------------------ */

/** A row as an app version that predates every derived column left it. */
const seedLegacy = (id: string, song: unknown, time = TIME): void => {
  realDb.runSync('INSERT INTO scrobble_events (id, song_json, time) VALUES (?, ?, ?);', [
    id,
    typeof song === 'string' ? song : JSON.stringify(song),
    time,
  ]);
};

/** A row an EARLIER backfill already stamped: `song_id` set, `title` still NULL.
 *  The case the old `WHERE song_id IS NULL` predicate could never revisit. */
const seedPartiallyBackfilled = (id: string, song: Child, time = TIME): void => {
  seedLegacy(id, song, time);
  realDb.runSync('UPDATE scrobble_events SET song_id = ?, artist = ? WHERE id = ?;', [
    song.id,
    song.artist ?? 'Unknown',
    id,
  ]);
};

const scalarsOf = (id: string): Record<string, unknown> | undefined =>
  realDb.getFirstSync<Record<string, unknown>>(
    `SELECT ${SCROBBLE_COLUMN_NAMES.join(', ')} FROM scrobble_events WHERE id = ?;`,
    [id],
  );

const childRows = <T,>(table: string, id: string): T[] =>
  realDb.getAllSync<T>(`SELECT * FROM scrobble_${table} WHERE scrobble_id = ? ORDER BY pos;`, [id]);

/** Rows the backfill's own predicate still considers outstanding. */
const outstanding = (): number =>
  realDb.getFirstSync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM scrobble_events WHERE song_id IS NULL OR title IS NULL;',
  )?.c ?? -1;

/** Delegating handle: real reads/writes, with `runBatchAsync` overridable. */
const wrapDb = (overrides: Partial<InternalDb>): InternalDb =>
  ({
    getAllAsync: <T,>(sql: string, params?: readonly unknown[]) => realDb.getAllAsync<T>(sql, params),
    runBatchAsync: (commands: readonly BatchCommand[]) => realDb.runBatchAsync(commands),
    ...overrides,
  }) as unknown as InternalDb;

beforeEach(() => {
  __setDbForTests(realDb);
  // An install that has not run `legacyColumnDropService` yet. The rebuild also
  // cascades the five child tables empty.
  createLegacyScrobbleTables(realDb);
});

afterEach(() => {
  __setDbForTests(realDb);
});

/* ------------------------------------------------------------------ */
/*  The widened predicate                                              */
/* ------------------------------------------------------------------ */

describe('backfillScrobbleColumnsAsync — predicate', () => {
  it('backfills a row an earlier version already stamped song_id on', async () => {
    seedPartiallyBackfilled('half', fullSong);
    expect(scalarsOf('half')?.title).toBeNull();

    await backfillScrobbleColumnsAsync();

    // Every column, compared positionally against the write path's own derivation:
    // a shifted placeholder in the UPDATE lands values in the wrong columns and
    // fails here. 34 names + the WHERE id = ? is the full parameter list.
    expect(scalarsOf('half')).toEqual({ ...deriveScrobbleColumns(fullSong, TIME) });
    expect(childRows('genres', 'half')).toHaveLength(2);
    expect(outstanding()).toBe(0);
  });

  it('backfills a wholly legacy row (song_id and title both NULL)', async () => {
    seedLegacy('legacy', fullSong);

    await backfillScrobbleColumnsAsync();

    expect(scalarsOf('legacy')).toEqual({ ...deriveScrobbleColumns(fullSong, TIME) });
    expect(outstanding()).toBe(0);
  });

  it('leaves an already-complete row alone and selects nothing', async () => {
    seedLegacy('done', fullSong);
    await backfillScrobbleColumnsAsync();

    const { db, state } = countingDb(10);
    __setDbForTests(db);
    await backfillScrobbleColumnsAsync();

    // One SELECT, zero rows, no second pass.
    expect(state.selects).toBe(1);
    expect(childRows('genres', 'done')).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/*  Child tables                                                       */
/* ------------------------------------------------------------------ */

describe('backfillScrobbleColumnsAsync — child tables', () => {
  it('writes all five arrays in their original positions', async () => {
    seedLegacy('arrays', fullSong);

    await backfillScrobbleColumnsAsync();

    expect(childRows('genres', 'arrays')).toEqual([
      { scrobble_id: 'arrays', pos: 0, name: 'Rock' },
      { scrobble_id: 'arrays', pos: 1, name: 'Indie' },
    ]);
    expect(childRows('artists', 'arrays')).toEqual([
      { scrobble_id: 'arrays', pos: 0, artist_id: 'ar-1', artist_name: 'The Artist' },
      { scrobble_id: 'arrays', pos: 1, artist_id: 'ar-2', artist_name: 'Feature' },
    ]);
    expect(childRows('album_artists', 'arrays')).toEqual([
      { scrobble_id: 'arrays', pos: 0, artist_id: 'ar-3', artist_name: 'Various' },
    ]);
    expect(childRows('contributors', 'arrays')).toEqual([
      {
        scrobble_id: 'arrays',
        pos: 0,
        role: 'composer',
        sub_role: 'lyrics',
        artist_id: 'ar-4',
        artist_name: 'Composer',
      },
      {
        scrobble_id: 'arrays',
        pos: 1,
        role: 'producer',
        sub_role: null,
        artist_id: null,
        artist_name: null,
      },
    ]);
    expect(childRows('moods', 'arrays')).toEqual([
      { scrobble_id: 'arrays', pos: 0, mood: 'energetic' },
      { scrobble_id: 'arrays', pos: 1, mood: 'happy' },
    ]);
  });

  it('writes no child rows for a song with no arrays', async () => {
    seedLegacy('bare', simpleSong('s-bare'));

    await backfillScrobbleColumnsAsync();

    for (const t of ['genres', 'artists', 'album_artists', 'contributors', 'moods']) {
      expect(childRows(t, 'bare')).toEqual([]);
    }
    expect(scalarsOf('bare')?.song_id).toBe('s-bare');
  });

  it('cascades child rows away when the parent scrobble is deleted', async () => {
    seedLegacy('cascade', fullSong);
    await backfillScrobbleColumnsAsync();
    expect(childRows('moods', 'cascade')).toHaveLength(2);

    realDb.runSync('DELETE FROM scrobble_events WHERE id = ?;', ['cascade']);
    expect(childRows('moods', 'cascade')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Self-repair after a half-applied chunk (runBatchAsync is NOT atomic) */
/* ------------------------------------------------------------------ */

describe('backfillScrobbleColumnsAsync — half-applied chunk', () => {
  /** `runBatchAsync` that commits the first `applyFirst` statements and then
   *  aborts, exactly as `opsqlite_execute_batch` does on a failing statement. */
  const abortingAfter = (applyFirst: number): InternalDb =>
    wrapDb({
      runBatchAsync: async (commands: readonly BatchCommand[]) => {
        for (const [sql, params] of commands.slice(0, applyFirst)) realDb.runSync(sql, params);
        throw new Error('simulated batch abort');
      },
    });

  it('re-selects the row and leaves no duplicate child rows', async () => {
    seedLegacy('partial', fullSong);

    // Five DELETEs + two genre INSERTs land; the rest of the row's commands,
    // including the scalar UPDATE that clears `title IS NULL`, never run.
    __setDbForTests(abortingAfter(7));
    await expect(backfillScrobbleColumnsAsync()).resolves.toBeUndefined();
    expect(childRows('genres', 'partial')).toHaveLength(2);
    expect(scalarsOf('partial')?.title).toBeNull();
    expect(outstanding()).toBe(1);

    __setDbForTests(realDb);
    await backfillScrobbleColumnsAsync();

    expect(childRows('genres', 'partial')).toEqual([
      { scrobble_id: 'partial', pos: 0, name: 'Rock' },
      { scrobble_id: 'partial', pos: 1, name: 'Indie' },
    ]);
    expect(childRows('artists', 'partial')).toHaveLength(2);
    expect(childRows('moods', 'partial')).toHaveLength(2);
    expect(scalarsOf('partial')).toEqual({ ...deriveScrobbleColumns(fullSong, TIME) });
    expect(outstanding()).toBe(0);
  });

  it('clears stale tail rows a shrunk array leaves behind', async () => {
    seedLegacy('shrunk', fullSong);
    await backfillScrobbleColumnsAsync();
    expect(childRows('genres', 'shrunk')).toHaveLength(2);

    // The envelope now carries one genre. Re-arm the predicate the way a fresh
    // upgrade would and re-run: the DELETE must take the orphaned pos 1 with it.
    realDb.runSync('UPDATE scrobble_events SET song_json = ?, title = NULL WHERE id = ?;', [
      JSON.stringify({ ...fullSong, genres: [{ name: 'Rock' }], moods: [] }),
      'shrunk',
    ]);
    await backfillScrobbleColumnsAsync();

    expect(childRows('genres', 'shrunk')).toEqual([
      { scrobble_id: 'shrunk', pos: 0, name: 'Rock' },
    ]);
    expect(childRows('moods', 'shrunk')).toEqual([]);
  });

  it('completed rows earlier in the aborted chunk stay done', async () => {
    seedLegacy('first', simpleSong('s-1'));
    seedLegacy('second', simpleSong('s-2'));

    // `first` needs 5 DELETEs + 1 UPDATE; the 7th statement is inside `second`.
    __setDbForTests(abortingAfter(6));
    await backfillScrobbleColumnsAsync();
    __setDbForTests(realDb);

    expect(scalarsOf('first')?.song_id).toBe('s-1');
    expect(scalarsOf('second')?.song_id).toBeNull();

    await backfillScrobbleColumnsAsync();
    expect(scalarsOf('second')?.song_id).toBe('s-2');
    expect(outstanding()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Termination                                                        */
/* ------------------------------------------------------------------ */

/** Counting handle that HARD-FAILS past `maxSelects` passes, so a non-terminating
 *  backfill fails the test instead of hanging the suite. */
function countingDb(maxSelects: number): { db: InternalDb; state: { selects: number } } {
  const state = { selects: 0 };
  const db = wrapDb({
    getAllAsync: <T,>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
      state.selects += 1;
      if (state.selects > maxSelects) throw new Error('runaway backfill loop');
      return realDb.getAllAsync<T>(sql, params);
    },
  });
  return { db, state };
}

describe('backfillScrobbleColumnsAsync — termination', () => {
  it('stamps BOTH markers on an unparseable row', async () => {
    seedLegacy('bad', 'not json at all');

    await backfillScrobbleColumnsAsync();

    const row = scalarsOf('bad');
    expect(row?.song_id).toBe('bad');
    // '' — present, so the predicate stops matching; falsy, so no reader accepts it.
    expect(row?.title).toBe('');
    expect(outstanding()).toBe(0);
  });

  it.each([
    ['unparseable JSON', 'not json at all'],
    ['valid JSON that is not an object', '42'],
    ['an object with no id', JSON.stringify({ title: 'No Id' })],
    ['an object with no title', JSON.stringify({ id: 's-x' })],
  ])('terminates on a full chunk of rows that can never be fixed: %s', async (_label, blob) => {
    // 501 = one full chunk plus one, the only shape that spins: the loop breaks on
    // `rows.length < BACKFILL_CHUNK`, so ≥500 permanently-unfixable rows are what
    // it takes for a mis-stamped row to be re-selected forever.
    for (let i = 0; i < 501; i++) seedLegacy(`bad-${i}`, blob);

    const { db, state } = countingDb(10);
    __setDbForTests(db);
    await backfillScrobbleColumnsAsync();

    // Pass 1 takes 500 (== chunk, so it loops), pass 2 takes the last 1 and breaks.
    expect(state.selects).toBe(2);
    expect(outstanding()).toBe(0);
    expect(scalarsOf('bad-500')?.title).toBe('');
  });

  it('terminates on a mixed history of good and unfixable rows', async () => {
    for (let i = 0; i < 400; i++) seedLegacy(`good-${i}`, simpleSong(`s-${i}`));
    for (let i = 0; i < 150; i++) seedLegacy(`bad-${i}`, '{{{');

    const { db, state } = countingDb(10);
    __setDbForTests(db);
    await backfillScrobbleColumnsAsync();

    expect(state.selects).toBe(2);
    expect(outstanding()).toBe(0);
    expect(scalarsOf('good-399')?.song_id).toBe('s-399');
    expect(scalarsOf('bad-149')?.title).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/*  Best-effort semantics                                              */
/* ------------------------------------------------------------------ */

describe('backfillScrobbleColumnsAsync — never throws into boot', () => {
  it('is a no-op when the DB is unavailable', async () => {
    __setDbForTests(null);
    await expect(backfillScrobbleColumnsAsync()).resolves.toBeUndefined();
  });

  it('swallows a failing SELECT', async () => {
    __setDbForTests(
      wrapDb({
        getAllAsync: () => Promise.reject(new Error('boom')),
      }),
    );
    await expect(backfillScrobbleColumnsAsync()).resolves.toBeUndefined();
  });

  it('swallows a failing batch and leaves the row for the next boot', async () => {
    seedLegacy('kept', fullSong);
    __setDbForTests(wrapDb({ runBatchAsync: () => Promise.reject(new Error('boom')) }));

    await expect(backfillScrobbleColumnsAsync()).resolves.toBeUndefined();
    expect(outstanding()).toBe(1);
  });
});
