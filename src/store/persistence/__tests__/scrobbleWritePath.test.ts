/**
 * The scrobble WRITE path against REAL SQL on the better-sqlite3-backed op-SQLite
 * seam: a live insert writes the five `scrobble_*` child rows alongside the parent,
 * and never depends on the `song_json` envelope — which is gone from the schema and
 * dropped from an upgrading install at idle, so the last block below drives the write
 * path in BOTH column states.
 *
 * `scrobbleReaders.test.ts` covers the other direction — rows seeded as an upgrading
 * install leaves them and populated by the backfill. Here nothing is ever parsed out
 * of an envelope, because nothing writes one: every assertion below is a round trip
 * through the typed columns and the child tables alone.
 *
 * Per AGENTS.md §11 the seam proves SQL semantics, never concurrency.
 */
import type { Child } from 'subsonic-api';

import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  createLegacyScrobbleTables,
  createScrobbleTables,
} from '../../../test-utils/legacyScrobbleTables';
import {
  computeScrobbleAnalytics,
  loadRecentScrobbles,
  loadScrobblesSince,
} from '../scrobbleAggregates';
import {
  countScrobbles,
  hydrateScrobblesAsync,
  insertScrobble,
  mergeScrobbles,
  replaceAllScrobbles,
} from '../scrobbleTable';
import { resetEnvelopeColumnCache } from '../scrobbleSnapshot';

import type { CompletedScrobble } from '../../completedScrobbleStore';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
const realDb: InternalDb = handle;

const TIME = 1_700_000_000_000;

/** Every field the §2.2 consumer table names, plus the five arrays kept because a
 *  scrobble is an unrecoverable historical record. */
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

const scrobble = (id: string, song: Child = fullSong, time = TIME): CompletedScrobble => ({
  id,
  song,
  time,
});

const childRows = <T,>(table: string, id: string): T[] =>
  realDb.getAllSync<T>(`SELECT * FROM scrobble_${table} WHERE scrobble_id = ? ORDER BY pos;`, [id]);

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
  realDb.runSync('DELETE FROM scrobble_events;');
});

afterEach(() => {
  __setDbForTests(realDb);
});

/* ------------------------------------------------------------------ */
/*  A live insert is complete without the envelope                     */
/* ------------------------------------------------------------------ */

describe('insertScrobble — child rows written, envelope not', () => {
  beforeEach(async () => {
    await insertScrobble(scrobble('sc-1'));
  });

  it('writes all five child tables at their positions', () => {
    expect(childRows('genres', 'sc-1')).toEqual([
      { scrobble_id: 'sc-1', pos: 0, name: 'Rock' },
      { scrobble_id: 'sc-1', pos: 1, name: 'Indie' },
    ]);
    expect(childRows('artists', 'sc-1')).toEqual([
      { scrobble_id: 'sc-1', pos: 0, artist_id: 'ar-1', artist_name: 'The Artist' },
      { scrobble_id: 'sc-1', pos: 1, artist_id: 'ar-2', artist_name: 'Feature' },
    ]);
    expect(childRows('album_artists', 'sc-1')).toEqual([
      { scrobble_id: 'sc-1', pos: 0, artist_id: 'ar-3', artist_name: 'Various' },
    ]);
    expect(childRows('contributors', 'sc-1')).toEqual([
      {
        scrobble_id: 'sc-1',
        pos: 0,
        role: 'composer',
        sub_role: 'lyrics',
        artist_id: 'ar-4',
        artist_name: 'Composer',
      },
      {
        scrobble_id: 'sc-1',
        pos: 1,
        role: 'producer',
        sub_role: null,
        artist_id: null,
        artist_name: null,
      },
    ]);
    expect(childRows('moods', 'sc-1')).toEqual([
      { scrobble_id: 'sc-1', pos: 0, mood: 'energetic' },
      { scrobble_id: 'sc-1', pos: 1, mood: 'happy' },
    ]);
  });

  // The end-to-end proof that parts 1 and 2 compose: written with no envelope, read
  // back complete by every reader that needs the arrays.
  it('reads back through loadRecentScrobbles with all five arrays', async () => {
    const [row] = await loadRecentScrobbles(10);
    expect(row.id).toBe('sc-1');
    expect(row.song.title).toBe('Full Song');
    expectFullArrays(row.song);
  });

  it('reads back through hydrateScrobblesAsync with all five arrays', async () => {
    const [row] = await hydrateScrobblesAsync();
    expect(row.id).toBe('sc-1');
    expectFullArrays(row.song);
  });

  it('reads back through computeScrobbleAnalytics songCounts with all five arrays', async () => {
    const { aggregates } = await computeScrobbleAnalytics(0);
    expect(aggregates.songCounts['s-full'].count).toBe(1);
    expectFullArrays(aggregates.songCounts['s-full'].song);
  });

  it('reads back through loadScrobblesSince — scalars only, by design', async () => {
    const [row] = await loadScrobblesSince(0);
    expect(row.song.id).toBe('s-full');
    expect(row.song.genre).toBe('Rock');
    expect(row.song.artistId).toBe('ar-1');
    expect(row.song.genres).toBeUndefined();
  });

  it('does not leave the row for the backfill to revisit', () => {
    expect(
      realDb.getFirstSync<{ c: number }>(
        'SELECT COUNT(*) AS c FROM scrobble_events WHERE song_id IS NULL OR title IS NULL;',
      )?.c,
    ).toBe(0);
  });

  it('is INSERT OR IGNORE — a duplicate id neither replaces nor duplicates', async () => {
    await insertScrobble(scrobble('sc-1', { ...fullSong, title: 'Different' } as Child, 999));
    expect(await countScrobbles()).toBe(1);
    const [row] = await hydrateScrobblesAsync();
    expect(row.time).toBe(TIME);
    expect(row.song.title).toBe('Full Song');
    expect(childRows('genres', 'sc-1')).toHaveLength(2);
  });

  it('writes no child rows for a song with no arrays', async () => {
    await insertScrobble(
      scrobble('sc-bare', { id: 's-bare', title: 'Bare', isDir: false } as Child),
    );
    for (const t of ['genres', 'artists', 'album_artists', 'contributors', 'moods']) {
      expect(childRows(t, 'sc-bare')).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  replaceAllScrobbles: the DELETE cascades, the re-INSERT repopulates */
/* ------------------------------------------------------------------ */

describe('replaceAllScrobbles — cascade then repopulate', () => {
  it('takes the old rows child tables with it and writes the new set complete', async () => {
    await insertScrobble(scrobble('old-1'));
    expect(childRows('moods', 'old-1')).toHaveLength(2);

    await replaceAllScrobbles([scrobble('new-1'), scrobble('new-2', fullSong, TIME + 1000)]);

    expect(childRows('moods', 'old-1')).toEqual([]);
    expect(childRows('genres', 'new-1')).toHaveLength(2);
    expect(childRows('contributors', 'new-2')).toHaveLength(2);
    const rows = await hydrateScrobblesAsync();
    expect(rows.map((r) => r.id)).toEqual(['new-1', 'new-2']);
    for (const r of rows) expectFullArrays(r.song);
  });

  // The `DELETE FROM scrobble_events` cascades a re-inserted id's children away too,
  // so the same set has to come back with its arrays, not just its parent rows.
  it('repopulates the children of an id it just deleted', async () => {
    await replaceAllScrobbles([scrobble('same')]);
    expect(childRows('genres', 'same')).toHaveLength(2);

    await replaceAllScrobbles([scrobble('same')]);

    expect(childRows('genres', 'same')).toEqual([
      { scrobble_id: 'same', pos: 0, name: 'Rock' },
      { scrobble_id: 'same', pos: 1, name: 'Indie' },
    ]);
    expect(childRows('moods', 'same')).toHaveLength(2);
    expectFullArrays((await hydrateScrobblesAsync())[0].song);
  });

  it('drops invalid records without writing their child rows', async () => {
    await replaceAllScrobbles([
      scrobble('ok'),
      { id: 'no-title', song: { ...fullSong, title: '' }, time: TIME } as CompletedScrobble,
    ]);

    expect(await countScrobbles()).toBe(1);
    expect(childRows('genres', 'no-title')).toEqual([]);
    expect(childRows('genres', 'ok')).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/*  mergeScrobbles: INSERT OR IGNORE must not duplicate child rows     */
/* ------------------------------------------------------------------ */

describe('mergeScrobbles — duplicate ids', () => {
  it('adds a new scrobble with its child rows', async () => {
    const result = await mergeScrobbles([scrobble('m-1')]);
    expect(result).toEqual({ added: 1, skipped: 0 });
    expect(childRows('genres', 'm-1')).toHaveLength(2);
  });

  // Delete-then-insert is what makes this safe: a bare INSERT would hit the
  // `(scrobble_id, pos)` PK and abort the whole batch.
  it('re-merging the same id adds nothing and duplicates no child rows', async () => {
    await mergeScrobbles([scrobble('m-1')]);
    const again = await mergeScrobbles([scrobble('m-1')]);

    expect(again).toEqual({ added: 0, skipped: 1 });
    expect(await countScrobbles()).toBe(1);
    expect(childRows('genres', 'm-1')).toEqual([
      { scrobble_id: 'm-1', pos: 0, name: 'Rock' },
      { scrobble_id: 'm-1', pos: 1, name: 'Indie' },
    ]);
    expect(childRows('artists', 'm-1')).toHaveLength(2);
    expect(childRows('album_artists', 'm-1')).toHaveLength(1);
    expect(childRows('contributors', 'm-1')).toHaveLength(2);
    expect(childRows('moods', 'm-1')).toHaveLength(2);
  });

  it('merges alongside an existing row without disturbing it', async () => {
    await insertScrobble(scrobble('kept'));
    const result = await mergeScrobbles([scrobble('kept'), scrobble('added', fullSong, TIME + 1)]);

    expect(result).toEqual({ added: 1, skipped: 1 });
    expect(childRows('moods', 'kept')).toHaveLength(2);
    expect(childRows('moods', 'added')).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/*  Hostile server data reaches the live insert path                   */
/* ------------------------------------------------------------------ */

describe('insertScrobble — entries a NOT NULL child column rejects', () => {
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
    await insertScrobble(scrobble('sc-hostile', hostileSong));

    // The batch is all-or-nothing, so a rejected entry would have lost the row too.
    expect(await countScrobbles()).toBe(1);
    expect(childRows('genres', 'sc-hostile')).toEqual([
      { scrobble_id: 'sc-hostile', pos: 0, name: 'Rock' },
      { scrobble_id: 'sc-hostile', pos: 1, name: 'Indie' },
    ]);
    expect(childRows('moods', 'sc-hostile')).toEqual([
      { scrobble_id: 'sc-hostile', pos: 0, mood: 'calm' },
    ]);
    expect(
      childRows<{ role: string }>('contributors', 'sc-hostile').map((r) => r.role),
    ).toEqual(['producer']);
    expect(childRows('artists', 'sc-hostile')).toHaveLength(1);
  });

  it('reads back with the surviving arrays', async () => {
    await insertScrobble(scrobble('sc-hostile', hostileSong));
    const [row] = await loadRecentScrobbles(10);

    expect(row.song.genres).toEqual(['Rock', 'Indie']);
    expect(row.song.moods).toEqual(['calm']);
    expect(row.song.contributors).toEqual([{ role: 'producer' }]);
  });
});

/* ------------------------------------------------------------------ */
/*  The insert adapts to the live column set, in both directions       */
/* ------------------------------------------------------------------ */

describe('insertScrobble — with and without the legacy envelope column', () => {
  afterEach(() => createScrobbleTables(realDb));

  it("writes '' into song_json while an upgrading install still has it", async () => {
    createLegacyScrobbleTables(realDb);

    await insertScrobble(scrobble('sc-legacy'));

    expect(
      realDb.getFirstSync<{ song_json: string }>(
        'SELECT song_json FROM scrobble_events WHERE id = ?;',
        ['sc-legacy'],
      )?.song_json,
    ).toBe('');
    expectFullArrays((await hydrateScrobblesAsync())[0].song);
  });

  it('omits the column once it is gone, and the row is identical', async () => {
    createScrobbleTables(realDb);

    await insertScrobble(scrobble('sc-dropped'));

    expect(
      realDb
        .getAllSync<{ name: string }>('PRAGMA table_info(scrobble_events);')
        .map((c) => c.name),
    ).not.toContain('song_json');
    const [row] = await hydrateScrobblesAsync();
    expect(row.id).toBe('sc-dropped');
    expectFullArrays(row.song);
  });

  // The statement is resolved once per session and cached, so a drop that lands
  // between two writes has to invalidate it or the second write names a dead column.
  it('follows the column across a drop inside one session', async () => {
    createLegacyScrobbleTables(realDb);
    await insertScrobble(scrobble('before'));

    realDb.execSync('ALTER TABLE scrobble_events DROP COLUMN song_json;');
    resetEnvelopeColumnCache();
    await insertScrobble(scrobble('after', fullSong, TIME + 1));

    expect((await hydrateScrobblesAsync()).map((r) => r.id)).toEqual(['before', 'after']);
  });
});
