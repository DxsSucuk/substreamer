/**
 * `pending_scrobble_events` against REAL SQL on the better-sqlite3-backed op-SQLite
 * seam: the offline queue now stores the same `Child` snapshot the completed table
 * does — typed columns plus five `pending_scrobble_*` child tables — and writes an
 * EMPTY `song_json`.
 *
 * The hand-rolled fake this suite used before stored `(id, song_json, time)` and
 * matched statements by SQL prefix, so it could represent neither the columns nor the
 * child tables' FK/cascade. Same test intents, real SQL — the precedent
 * `scrobbleTable.test.ts` set in step 4.5.
 *
 * Per AGENTS.md §11 the seam proves SQL semantics, never concurrency.
 */
import type { Child } from 'subsonic-api';

import type { BatchCommand } from '../../../db/client';
import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  backfillPendingScrobbleColumnsAsync,
  clearPendingScrobbles,
  deletePendingScrobble,
  hydratePendingScrobblesAsync,
  insertPendingScrobble,
  replaceAllPendingScrobbles,
} from '../pendingScrobbleTable';
import { deriveScrobbleColumns, PENDING_SCROBBLE_COLUMN_NAMES } from '../scrobbleColumns';

import type { PendingScrobble } from '../../pendingScrobbleStore';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
const realDb: InternalDb = handle;

const TIME = 1_700_000_000_000;

/** Every field the plan's §2.2 consumer table names, plus the five arrays — the set a
 *  pending row must carry, because `addCompleted` derives the completed row from it. */
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

/** `fullSong` as the columns + the five child tables give it back. Deliberately a
 *  whole-object comparison: a field dropped anywhere in the round trip fails here,
 *  and whatever pending loses, the completed row `addCompleted` derives loses too.
 *  Three values are normalised rather than echoed — `genres` from `{name}[]` to
 *  `string[]`, artist credits gaining `albumCount: 0`, and `genre` derived from the
 *  first genre — all of which the completed table already does. */
const restoredFullSong = {
  id: 's-full',
  title: 'Full Song',
  isDir: false,
  artist: 'The Artist',
  album: 'The Album',
  coverArt: 'cov-1',
  duration: 210,
  albumId: 'al-1',
  artistId: 'ar-1',
  displayArtist: 'The Artist feat. Feature',
  displayComposer: 'Composer',
  track: 4,
  discNumber: 2,
  year: 1999,
  genre: 'Rock',
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
  replayGain: { trackGain: -7.5, trackPeak: 0.98 },
  genres: ['Rock', 'Indie'],
  artists: [
    { id: 'ar-1', name: 'The Artist', albumCount: 0 },
    { id: 'ar-2', name: 'Feature', albumCount: 0 },
  ],
  albumArtists: [{ id: 'ar-3', name: 'Various', albumCount: 0 }],
  contributors: [
    { role: 'composer', subRole: 'lyrics', artist: { id: 'ar-4', name: 'Composer', albumCount: 0 } },
    { role: 'producer' },
  ],
  moods: ['energetic', 'happy'],
};

const pending = (id: string, song: Child = fullSong, time = TIME): PendingScrobble => ({
  id,
  song,
  time,
});

const childRows = <T,>(table: string, id: string): T[] =>
  realDb.getAllSync<T>(
    `SELECT * FROM pending_scrobble_${table} WHERE scrobble_id = ? ORDER BY pos;`,
    [id],
  );

const envelopeOf = (id: string): string | undefined =>
  realDb.getFirstSync<{ song_json: string }>(
    'SELECT song_json FROM pending_scrobble_events WHERE id = ?;',
    [id],
  )?.song_json;

const scalarsOf = (id: string): Record<string, unknown> | undefined =>
  realDb.getFirstSync<Record<string, unknown>>(
    `SELECT ${PENDING_SCROBBLE_COLUMN_NAMES.join(', ')} FROM pending_scrobble_events WHERE id = ?;`,
    [id],
  );

/** The pending subset of the shared derivation — `hour`/`day_key` are not stored. */
const expectedScalars = (song: Child, time = TIME): Record<string, unknown> => {
  const all = deriveScrobbleColumns(song, time) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const c of PENDING_SCROBBLE_COLUMN_NAMES) out[c] = all[c];
  return out;
};

/** Rows the backfill's own predicate still considers outstanding. */
const outstanding = (): number =>
  realDb.getFirstSync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM pending_scrobble_events WHERE song_id IS NULL OR title IS NULL;',
  )?.c ?? -1;

/** A row as an app version that predates every snapshot column left it. */
const seedLegacy = (id: string, song: unknown, time = TIME): void => {
  realDb.runSync('INSERT INTO pending_scrobble_events (id, song_json, time) VALUES (?, ?, ?);', [
    id,
    typeof song === 'string' ? song : JSON.stringify(song),
    time,
  ]);
};

/** Delegating handle: real reads/writes, with individual methods overridable. */
const wrapDb = (overrides: Partial<InternalDb>): InternalDb =>
  ({
    getAllAsync: <T,>(sql: string, params?: readonly unknown[]) => realDb.getAllAsync<T>(sql, params),
    runBatchAsync: (commands: readonly BatchCommand[]) => realDb.runBatchAsync(commands),
    ...overrides,
  }) as unknown as InternalDb;

/** The arrays as the five child tables give them back, for a `fullSong` row. */
const expectFullArrays = (song: Child): void => {
  expect(song.genres).toEqual(['Rock', 'Indie']);
  expect(song.artists).toEqual([
    { id: 'ar-1', name: 'The Artist', albumCount: 0 },
    { id: 'ar-2', name: 'Feature', albumCount: 0 },
  ]);
  expect(song.albumArtists).toEqual([{ id: 'ar-3', name: 'Various', albumCount: 0 }]);
  expect(song.contributors).toEqual([
    { role: 'composer', subRole: 'lyrics', artist: { id: 'ar-4', name: 'Composer', albumCount: 0 } },
    { role: 'producer' },
  ]);
  expect(song.moods).toEqual(['energetic', 'happy']);
};

beforeEach(() => {
  __setDbForTests(realDb);
  // ON DELETE CASCADE clears the five child tables with it.
  realDb.runSync('DELETE FROM pending_scrobble_events;');
});

afterEach(() => {
  __setDbForTests(realDb);
});

/* ------------------------------------------------------------------ */
/*  Insert + hydrate round trip, with no envelope                      */
/* ------------------------------------------------------------------ */

describe('pendingScrobbleTable — insert + hydrate', () => {
  it('stores an empty song_json and still round-trips every scalar', async () => {
    await insertPendingScrobble(pending('p-1'));

    expect(envelopeOf('p-1')).toBe('');
    expect(scalarsOf('p-1')).toEqual(expectedScalars(fullSong));

    const [row] = await hydratePendingScrobblesAsync();
    expect(row.id).toBe('p-1');
    expect(row.time).toBe(TIME);
    expect(row.song).toEqual(restoredFullSong);
  });

  it('writes all five child tables at their positions', async () => {
    await insertPendingScrobble(pending('p-1'));

    expect(childRows('genres', 'p-1')).toEqual([
      { scrobble_id: 'p-1', pos: 0, name: 'Rock' },
      { scrobble_id: 'p-1', pos: 1, name: 'Indie' },
    ]);
    expect(childRows('artists', 'p-1')).toEqual([
      { scrobble_id: 'p-1', pos: 0, artist_id: 'ar-1', artist_name: 'The Artist' },
      { scrobble_id: 'p-1', pos: 1, artist_id: 'ar-2', artist_name: 'Feature' },
    ]);
    expect(childRows('album_artists', 'p-1')).toEqual([
      { scrobble_id: 'p-1', pos: 0, artist_id: 'ar-3', artist_name: 'Various' },
    ]);
    expect(childRows('contributors', 'p-1')).toEqual([
      {
        scrobble_id: 'p-1',
        pos: 0,
        role: 'composer',
        sub_role: 'lyrics',
        artist_id: 'ar-4',
        artist_name: 'Composer',
      },
      {
        scrobble_id: 'p-1',
        pos: 1,
        role: 'producer',
        sub_role: null,
        artist_id: null,
        artist_name: null,
      },
    ]);
    expect(childRows('moods', 'p-1')).toEqual([
      { scrobble_id: 'p-1', pos: 0, mood: 'energetic' },
      { scrobble_id: 'p-1', pos: 1, mood: 'happy' },
    ]);
  });

  it('reads the five arrays back onto the Child', async () => {
    await insertPendingScrobble(pending('p-1'));
    const [row] = await hydratePendingScrobblesAsync();
    expectFullArrays(row.song);
  });

  it('does not leave the row for the backfill to revisit', async () => {
    await insertPendingScrobble(pending('p-1'));
    expect(outstanding()).toBe(0);
  });

  it('is INSERT OR IGNORE — a duplicate id neither replaces nor duplicates', async () => {
    await insertPendingScrobble(pending('dup', fullSong, 1));
    await insertPendingScrobble(
      pending('dup', { ...fullSong, id: 's2', title: 'Different' } as Child, 999),
    );

    const restored = await hydratePendingScrobblesAsync();
    expect(restored).toHaveLength(1);
    expect(restored[0].time).toBe(1);
    expect(restored[0].song.id).toBe('s-full');
    expect(childRows('genres', 'dup')).toHaveLength(2);
  });

  it('skips records missing id / song.id / song.title', async () => {
    await insertPendingScrobble(pending(''));
    await insertPendingScrobble(pending('bad-song-id', { id: '', title: 'x' } as Child));
    await insertPendingScrobble(pending('no-title', { id: 's1', title: '' } as Child));
    await insertPendingScrobble({ id: 'null-song', song: null, time: TIME } as never);

    expect(await hydratePendingScrobblesAsync()).toEqual([]);
    expect(childRows('genres', 'no-title')).toEqual([]);
  });

  it('returns rows in time-ascending order', async () => {
    await insertPendingScrobble(pending('a', fullSong, 300));
    await insertPendingScrobble(pending('b', fullSong, 100));
    await insertPendingScrobble(pending('c', fullSong, 200));

    expect((await hydratePendingScrobblesAsync()).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('returns empty when the table is empty', async () => {
    expect(await hydratePendingScrobblesAsync()).toEqual([]);
  });

  it('writes no child rows for a song with no arrays', async () => {
    await insertPendingScrobble(
      pending('p-bare', { id: 's-bare', title: 'Bare', isDir: false } as Child),
    );
    for (const t of ['genres', 'artists', 'album_artists', 'contributors', 'moods']) {
      expect(childRows(t, 'p-bare')).toEqual([]);
    }
    // `artist`/`album` fall back to 'Unknown' in the shared derivation, matching the
    // in-memory aggregate keys — the completed table stores them the same way.
    const [row] = await hydratePendingScrobblesAsync();
    expect(row.song).toEqual({
      id: 's-bare',
      title: 'Bare',
      isDir: false,
      artist: 'Unknown',
      album: 'Unknown',
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Hostile server data reaches the live insert path                   */
/* ------------------------------------------------------------------ */

describe('pendingScrobbleTable — entries a NOT NULL child column rejects', () => {
  const hostileSong = {
    id: 's-hostile',
    title: 'Hostile',
    artist: 'A',
    isDir: false,
    genres: [{ name: 'Rock' }, { name: '' }, null, 'Indie'],
    artists: [{ id: 'ar-1', name: 'One' }, null],
    contributors: [{ role: '' }, { role: 'producer' }],
    moods: [null, 'calm', ''],
  } as unknown as Child;

  it('inserts cleanly, skipping only the bad entries', async () => {
    await insertPendingScrobble(pending('p-hostile', hostileSong));

    // The batch is all-or-nothing, so a rejected entry would have lost the row too.
    const [row] = await hydratePendingScrobblesAsync();
    expect(row.id).toBe('p-hostile');
    expect(row.song.genres).toEqual(['Rock', 'Indie']);
    expect(row.song.moods).toEqual(['calm']);
    expect(row.song.contributors).toEqual([{ role: 'producer' }]);
    expect(row.song.artists).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Backfill of rows queued before the columns existed                 */
/* ------------------------------------------------------------------ */

describe('pendingScrobbleTable — backfill', () => {
  it('hydrate backfills a pre-upgrade envelope row, child rows included', async () => {
    seedLegacy('legacy', fullSong);
    expect(scalarsOf('legacy')?.title).toBeNull();

    const [row] = await hydratePendingScrobblesAsync();

    expect(row.id).toBe('legacy');
    expect(row.song).toEqual(restoredFullSong);
    expect(scalarsOf('legacy')).toEqual(expectedScalars(fullSong));
    expect(childRows('genres', 'legacy')).toEqual([
      { scrobble_id: 'legacy', pos: 0, name: 'Rock' },
      { scrobble_id: 'legacy', pos: 1, name: 'Indie' },
    ]);
    expect(childRows('moods', 'legacy')).toHaveLength(2);
    expect(outstanding()).toBe(0);
  });

  it('backfills a row an earlier version stamped song_id on but not title', async () => {
    seedLegacy('half', fullSong);
    realDb.runSync('UPDATE pending_scrobble_events SET song_id = ? WHERE id = ?;', [
      's-full',
      'half',
    ]);

    await backfillPendingScrobbleColumnsAsync();

    expect(scalarsOf('half')).toEqual(expectedScalars(fullSong));
    expect(outstanding()).toBe(0);
  });

  it('stamps BOTH markers on a row it can never decode, and hydrate drops it', async () => {
    seedLegacy('bad', 'not json at all');
    seedLegacy('good', fullSong, TIME + 1);

    const restored = await hydratePendingScrobblesAsync();

    const row = scalarsOf('bad');
    expect(row?.song_id).toBe('bad');
    // '' — present, so the predicate stops matching; falsy, so no reader accepts it.
    expect(row?.title).toBe('');
    expect(restored.map((s) => s.id)).toEqual(['good']);
    expect(outstanding()).toBe(0);
  });

  it.each([
    ['unparseable JSON', 'not json at all'],
    ['valid JSON that is not an object', '42'],
    ['an object with no id', JSON.stringify({ title: 'No Id' })],
    ['an object with no title', JSON.stringify({ id: 's-x' })],
  ])('terminates on a full chunk of rows that can never be fixed: %s', async (_label, blob) => {
    // 501 = one full chunk plus one, the only shape that spins: the loop breaks on
    // `rows.length < BACKFILL_CHUNK`, so ≥500 permanently-unfixable rows are what it
    // takes for a mis-stamped row to be re-selected forever.
    for (let i = 0; i < 501; i++) seedLegacy(`bad-${i}`, blob);

    // Counting handle that HARD-FAILS past 10 passes, so a non-terminating backfill
    // fails the test instead of hanging the suite.
    const state = { selects: 0 };
    __setDbForTests(
      wrapDb({
        getAllAsync: <T,>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
          state.selects += 1;
          if (state.selects > 10) throw new Error('runaway backfill loop');
          return realDb.getAllAsync<T>(sql, params);
        },
      }),
    );
    await backfillPendingScrobbleColumnsAsync();

    // Pass 1 takes 500 (== chunk, so it loops), pass 2 takes the last 1 and breaks.
    expect(state.selects).toBe(2);
    expect(outstanding()).toBe(0);
    expect(scalarsOf('bad-500')?.title).toBe('');
  });

  it('clears stale tail rows a shrunk array leaves behind', async () => {
    seedLegacy('shrunk', fullSong);
    await backfillPendingScrobbleColumnsAsync();
    expect(childRows('genres', 'shrunk')).toHaveLength(2);

    // Re-arm the predicate the way a fresh upgrade would, with a shorter array.
    realDb.runSync('UPDATE pending_scrobble_events SET song_json = ?, title = NULL WHERE id = ?;', [
      JSON.stringify({ ...fullSong, genres: [{ name: 'Rock' }], moods: [] }),
      'shrunk',
    ]);
    await backfillPendingScrobbleColumnsAsync();

    expect(childRows('genres', 'shrunk')).toEqual([
      { scrobble_id: 'shrunk', pos: 0, name: 'Rock' },
    ]);
    expect(childRows('moods', 'shrunk')).toEqual([]);
  });

  it('leaves an already-populated row alone', async () => {
    await insertPendingScrobble(pending('p-1'));
    await backfillPendingScrobbleColumnsAsync();

    expect(envelopeOf('p-1')).toBe('');
    expect(scalarsOf('p-1')).toEqual(expectedScalars(fullSong));
    expect(childRows('genres', 'p-1')).toHaveLength(2);
  });

  it('never throws, and leaves the row for the next boot when the batch fails', async () => {
    seedLegacy('kept', fullSong);
    __setDbForTests(wrapDb({ runBatchAsync: () => Promise.reject(new Error('boom')) }));

    await expect(backfillPendingScrobbleColumnsAsync()).resolves.toBeUndefined();
    expect(outstanding()).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/*  deletePendingScrobble                                              */
/* ------------------------------------------------------------------ */

describe('pendingScrobbleTable — deletePendingScrobble', () => {
  it('removes a single row by id and cascades its child rows', async () => {
    await insertPendingScrobble(pending('a'));
    await insertPendingScrobble(pending('b', fullSong, TIME + 1));
    await insertPendingScrobble(pending('c', fullSong, TIME + 2));
    expect(childRows('moods', 'b')).toHaveLength(2);

    await deletePendingScrobble('b');

    expect((await hydratePendingScrobblesAsync()).map((s) => s.id)).toEqual(['a', 'c']);
    expect(childRows('moods', 'b')).toEqual([]);
    expect(childRows('genres', 'b')).toEqual([]);
  });

  it('is a no-op for ids that do not exist', async () => {
    await insertPendingScrobble(pending('a'));
    await deletePendingScrobble('missing');
    expect(await hydratePendingScrobblesAsync()).toHaveLength(1);
  });

  it('skips empty-string ids', async () => {
    await insertPendingScrobble(pending('a'));
    await deletePendingScrobble('');
    expect(await hydratePendingScrobblesAsync()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  replaceAllPendingScrobbles                                         */
/* ------------------------------------------------------------------ */

describe('pendingScrobbleTable — replaceAllPendingScrobbles', () => {
  it('takes the old rows child tables with it and writes the new set complete', async () => {
    await insertPendingScrobble(pending('old-1'));
    expect(childRows('moods', 'old-1')).toHaveLength(2);

    await replaceAllPendingScrobbles([pending('new-1'), pending('new-2', fullSong, TIME + 1000)]);

    expect(childRows('moods', 'old-1')).toEqual([]);
    expect(childRows('genres', 'new-1')).toHaveLength(2);
    expect(childRows('contributors', 'new-2')).toHaveLength(2);
    expect(envelopeOf('new-1')).toBe('');
    const rows = await hydratePendingScrobblesAsync();
    expect(rows.map((r) => r.id)).toEqual(['new-1', 'new-2']);
    for (const r of rows) expectFullArrays(r.song);
  });

  // The `DELETE FROM pending_scrobble_events` cascades a re-inserted id's children
  // away too, so the same set has to come back with its arrays, not just its parents.
  it('repopulates the children of an id it just deleted', async () => {
    await replaceAllPendingScrobbles([pending('same')]);
    expect(childRows('genres', 'same')).toHaveLength(2);

    await replaceAllPendingScrobbles([pending('same')]);

    expect(childRows('genres', 'same')).toEqual([
      { scrobble_id: 'same', pos: 0, name: 'Rock' },
      { scrobble_id: 'same', pos: 1, name: 'Indie' },
    ]);
    expect(childRows('moods', 'same')).toHaveLength(2);
    expectFullArrays((await hydratePendingScrobblesAsync())[0].song);
  });

  it('drops invalid / duplicate records before inserting', async () => {
    await replaceAllPendingScrobbles([
      pending('ok'),
      pending('ok'),
      pending(''),
      pending('bad-song', { id: '', title: 'x' } as Child),
      pending('no-title', { id: 's1', title: '' } as Child),
      { id: 'null-song', song: null, time: TIME } as never,
    ]);

    const restored = await hydratePendingScrobblesAsync();
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe('ok');
    expect(childRows('genres', 'no-title')).toEqual([]);
    expect(childRows('genres', 'ok')).toHaveLength(2);
  });

  it('with an empty array clears the table', async () => {
    await insertPendingScrobble(pending('a'));
    await replaceAllPendingScrobbles([]);
    expect(await hydratePendingScrobblesAsync()).toEqual([]);
    expect(childRows('genres', 'a')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  clearPendingScrobbles                                              */
/* ------------------------------------------------------------------ */

describe('pendingScrobbleTable — clearPendingScrobbles', () => {
  it('wipes the table and its child rows', async () => {
    await insertPendingScrobble(pending('a'));
    await insertPendingScrobble(pending('b', fullSong, TIME + 1));

    await clearPendingScrobbles();

    expect(await hydratePendingScrobblesAsync()).toEqual([]);
    expect(childRows('moods', 'a')).toEqual([]);
    expect(childRows('moods', 'b')).toEqual([]);
  });

  it('is safe to call on an empty table', async () => {
    await expect(clearPendingScrobbles()).resolves.toBeUndefined();
    expect(await hydratePendingScrobblesAsync()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Best-effort semantics — these paths must not throw into boot       */
/* ------------------------------------------------------------------ */

describe('pendingScrobbleTable — disabled db path', () => {
  beforeEach(() => {
    __setDbForTests(null);
  });

  it('all mutations are no-ops when db is unavailable', async () => {
    await expect(insertPendingScrobble(pending('p-1'))).resolves.toBeUndefined();
    await expect(deletePendingScrobble('p-1')).resolves.toBeUndefined();
    await expect(replaceAllPendingScrobbles([pending('p-1')])).resolves.toBeUndefined();
    await expect(clearPendingScrobbles()).resolves.toBeUndefined();
    await expect(backfillPendingScrobbleColumnsAsync()).resolves.toBeUndefined();
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
    runBatchAsync() {
      return Promise.reject(new Error('boom'));
    },
    runAtomicBatchAsync() {
      return Promise.reject(new Error('boom'));
    },
  };

  beforeEach(() => {
    __setDbForTests(throwingDb as unknown as InternalDb);
  });

  it('mutations swallow errors and do not propagate', async () => {
    await expect(insertPendingScrobble(pending('p-1'))).resolves.toBeUndefined();
    await expect(deletePendingScrobble('x')).resolves.toBeUndefined();
    await expect(replaceAllPendingScrobbles([pending('p-1')])).resolves.toBeUndefined();
    await expect(clearPendingScrobbles()).resolves.toBeUndefined();
    await expect(backfillPendingScrobbleColumnsAsync()).resolves.toBeUndefined();
  });

  it('reads return safe defaults on DB error', async () => {
    expect(await hydratePendingScrobblesAsync()).toEqual([]);
  });
});
