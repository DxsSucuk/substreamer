/**
 * The four scrobble readers reconstructing a `Child` from the typed columns + the
 * five `scrobble_*` child tables, against REAL SQL on the better-sqlite3-backed
 * op-SQLite substitute.
 *
 * Rows are seeded as an upgrading install leaves them — envelope only — and populated
 * by `backfillScrobbleColumnsAsync`, so reading back through the readers is a genuine
 * round trip through the columns, not through the blob. That shape needs the pre-drop
 * table, which the generated schema no longer produces, so each case rebuilds it.
 *
 * Per AGENTS.md §11 the substitute proves SQL semantics, never concurrency.
 */
import type { Child } from 'subsonic-api';

import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  computeScrobbleAnalytics,
  loadRecentScrobbles,
  loadScrobblesSince,
} from '../scrobbleAggregates';
import { SCROBBLE_COLUMN_NAMES } from '../scrobbleColumns';
import { SCROBBLE_SELECT } from '../scrobbleSnapshot';
import { backfillScrobbleColumnsAsync, hydrateScrobblesAsync } from '../scrobbleTable';
import { createLegacyScrobbleTables } from '../../../test-utils/legacyScrobbleTables';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite substitute failed to open');
const realDb: InternalDb = handle;

const TIME = 1_700_000_000_000;

/** Every field the §2.2 consumer table names, plus the four arrays kept because a
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

const simpleSong = (id: string, extra: Partial<Child> = {}): Child =>
  ({ id, title: `Title ${id}`, artist: 'A', album: 'B', isDir: false, ...extra }) as Child;

/** A row as an app version that predates the derived columns left it. */
const seedLegacy = (id: string, song: unknown, time = TIME): void => {
  realDb.runSync('INSERT INTO scrobble_events (id, song_json, time) VALUES (?, ?, ?);', [
    id,
    typeof song === 'string' ? song : JSON.stringify(song),
    time,
  ]);
};

/** A row carrying a `song_id` but no `title` — what a large history looks like while
 *  the backfill is still running, and the only difference between the readers. */
const seedTitleless = (id: string, songId: string, time = TIME): void => {
  realDb.runSync(
    'INSERT INTO scrobble_events (id, song_json, time, song_id, artist, genre) VALUES (?, ?, ?, ?, ?, ?);',
    [id, '{}', time, songId, 'Ghost', 'Ambient'],
  );
};

/** Delegating handle that records every statement, so a per-row query shows up as a
 *  query count that grows with the row count. */
const countingDb = (): { db: InternalDb; queries: string[] } => {
  const queries: string[] = [];
  const db = {
    getAllAsync: <T,>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
      queries.push(sql);
      return realDb.getAllAsync<T>(sql, params);
    },
    getFirstAsync: <T,>(sql: string, params?: readonly unknown[]): Promise<T | null> => {
      queries.push(sql);
      return realDb.getFirstAsync<T>(sql, params);
    },
  } as unknown as InternalDb;
  return { db, queries };
};

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
/*  Round trip: every consumer field survives the columns              */
/* ------------------------------------------------------------------ */

/** Asserts the whole §2.2 consumer surface, so a column dropped from the SELECT list
 *  or mis-aliased fails here rather than as a blank field on a device. */
const expectFullSong = (song: Child): void => {
  expect(song.id).toBe('s-full');
  expect(song.title).toBe('Full Song');
  expect(song.artist).toBe('The Artist');
  expect(song.album).toBe('The Album');
  expect(song.coverArt).toBe('cov-1');
  expect(song.duration).toBe(210);
  expect(song.albumId).toBe('al-1');
  expect(song.artistId).toBe('ar-1');
  expect(song.displayArtist).toBe('The Artist feat. Feature');
  expect(song.displayComposer).toBe('Composer');
  expect(song.year).toBe(1999);
  expect(song.track).toBe(4);
  expect(song.discNumber).toBe(2);
  expect(song.suffix).toBe('flac');
  expect(song.bitRate).toBe(960);
  expect(song.size).toBe(12_345_678);
  expect(song.contentType).toBe('audio/flac');
  expect(song.bpm).toBe(128);
  expect(song.path).toBe('The Artist/The Album/04 Full Song.flac');
  expect(song.parent).toBe('al-1');
  expect(song.sortName).toBe('Full Song, The');
  expect(song.musicBrainzId).toBe('mb-1');
  expect(song.explicitStatus).toBe('clean');
  expect(song.userRating).toBe(4);
  expect(song.averageRating).toBe(4.5);
  expect(song.playCount).toBe(12);
  expect(song.played).toBe('2024-01-02T03:04:05Z');
  // `genre` is the derived primary; `genres[]` is the child table.
  expect(song.genre).toBe('Rock');
  expect(song.genres).toEqual(['Rock', 'Indie']);
  expect(song.replayGain).toEqual({ trackGain: -7.5, trackPeak: 0.98 });
  // Epoch ms in the column, `Date` back out — an ISO string here renders differently
  // in `formatLongDate`.
  expect(song.created).toBeInstanceOf(Date);
  expect(song.created).toEqual(new Date('2020-05-06T07:08:09.000Z'));
  expect(song.starred).toBeInstanceOf(Date);
  expect(song.starred).toEqual(new Date('2021-06-07T08:09:10.000Z'));
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

describe('scrobble readers — full round trip through the columns', () => {
  beforeEach(async () => {
    seedLegacy('sc-full', fullSong);
    await backfillScrobbleColumnsAsync();
    // The envelope is irrelevant from here: blank it so anything still parsing it
    // fails loudly instead of passing on the blob.
    realDb.runSync("UPDATE scrobble_events SET song_json = '' WHERE id = ?;", ['sc-full']);
  });

  it('loadRecentScrobbles reconstructs every consumer field', async () => {
    const rows = await loadRecentScrobbles(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('sc-full');
    expect(rows[0].time).toBe(TIME);
    expectFullSong(rows[0].song);
  });

  it('hydrateScrobblesAsync reconstructs every consumer field', async () => {
    const rows = await hydrateScrobblesAsync();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('sc-full');
    expect(rows[0].time).toBe(TIME);
    expectFullSong(rows[0].song);
  });

  it('computeScrobbleAnalytics songCounts reconstructs every consumer field', async () => {
    const { aggregates } = await computeScrobbleAnalytics(0);
    expect(aggregates.songCounts['s-full'].count).toBe(1);
    expectFullSong(aggregates.songCounts['s-full'].song);
  });

  it('loadScrobblesSince reconstructs the scalars its consumer reads, without the arrays', async () => {
    const rows = await loadScrobblesSince(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('sc-full');
    expect(rows[0].song.id).toBe('s-full');
    expect(rows[0].song.genre).toBe('Rock');
    expect(rows[0].song.artist).toBe('The Artist');
    expect(rows[0].song.artistId).toBe('ar-1');
    expect(rows[0].song.year).toBe(1999);
    // It skips the child tables deliberately — its consumer reads none of them.
    expect(rows[0].song.genres).toBeUndefined();
    expect(rows[0].song.artists).toBeUndefined();
    expect(rows[0].song.moods).toBeUndefined();
  });

  it('SCROBBLE_SELECT covers every stored column except the time-derived buckets', () => {
    for (const col of SCROBBLE_COLUMN_NAMES) {
      if (col === 'hour' || col === 'day_key') continue;
      expect(SCROBBLE_SELECT).toContain(col);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  The per-reader validity filter                                     */
/* ------------------------------------------------------------------ */

describe('scrobble readers — loadScrobblesSince requires song_id ONLY', () => {
  beforeEach(async () => {
    seedLegacy('sc-good', simpleSong('s-good'), TIME);
    await backfillScrobbleColumnsAsync();
    // Seeded AFTER the backfill so it stays in the half-backfilled state Tuned In can
    // observe: `tuned-in.tsx` calls loadScrobblesSince directly, bypassing the store's
    // await on the backfill.
    seedTitleless('sc-titleless', 's-titleless', TIME + 1000);
  });

  it('returns the titleless row', async () => {
    const rows = await loadScrobblesSince(0);
    expect(rows.map((r) => r.id)).toEqual(['sc-titleless', 'sc-good']);
    const ghost = rows[0];
    expect(ghost.song.id).toBe('s-titleless');
    expect(ghost.song.artist).toBe('Ghost');
    expect(ghost.song.genre).toBe('Ambient');
  });

  it('loadRecentScrobbles drops it', async () => {
    const rows = await loadRecentScrobbles(10);
    expect(rows.map((r) => r.id)).toEqual(['sc-good']);
  });

  it('hydrateScrobblesAsync drops it', async () => {
    const rows = await hydrateScrobblesAsync();
    expect(rows.map((r) => r.id)).toEqual(['sc-good']);
  });

  it('computeScrobbleAnalytics songCounts drops it', async () => {
    const { aggregates } = await computeScrobbleAnalytics(0);
    expect(Object.keys(aggregates.songCounts)).toEqual(['s-good']);
    // The row still counts as a play — only the reconstructed song is withheld.
    expect(aggregates.artistCounts.Ghost.count).toBe(1);
  });

  it('all four drop a row the backfill stamped as permanently unfixable', async () => {
    realDb.runSync('DELETE FROM scrobble_events;');
    seedLegacy('sc-bad', 'not json at all');
    await backfillScrobbleColumnsAsync();
    // `song_id` = the SCROBBLE's own id, `title` = '' — both markers set, so the
    // widened backfill predicate stops matching the row.
    expect(
      realDb.getFirstSync<{ song_id: string; title: string }>(
        'SELECT song_id, title FROM scrobble_events WHERE id = ?;',
        ['sc-bad'],
      ),
    ).toEqual({ song_id: 'sc-bad', title: '' });

    expect(await loadRecentScrobbles(10)).toEqual([]);
    expect(await hydrateScrobblesAsync()).toEqual([]);
    const { aggregates } = await computeScrobbleAnalytics(0);
    expect(aggregates.songCounts).toEqual({});
    // loadScrobblesSince too, despite requiring no title: the stamp's `song_id` is a
    // marker, not a song, and Heavy Rotation's only guard is a truthy `song.id`
    // (`tunedInService.generateMixes`) — it would render an untitled, unplayable row.
    expect(await loadScrobblesSince(0)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  songCounts: scalars and child rows from the SAME play              */
/* ------------------------------------------------------------------ */

describe('scrobble readers — songCounts takes one representative play', () => {
  /** Two plays of one song with metadata that changed between them. The titles and
   *  genres are chosen so a `MAX(col)` group aggregate would pick the OLDER play's
   *  scalars while the child rows came from the newer one. */
  const older = {
    ...simpleSong('s-rep'),
    title: 'Zebra',
    album: 'Zulu',
    genres: [{ name: 'Zydeco' }],
    moods: ['old'],
    bitRate: 128,
  } as unknown as Child;
  const newer = {
    ...simpleSong('s-rep'),
    title: 'Alpha',
    album: 'Able',
    genres: [{ name: 'Ambient' }],
    moods: ['new'],
    bitRate: 960,
  } as unknown as Child;

  beforeEach(async () => {
    seedLegacy('play-old', older, TIME);
    seedLegacy('play-new', newer, TIME + 60_000);
    await backfillScrobbleColumnsAsync();
  });

  it('pairs the scalars and the child rows from the most recent play', async () => {
    const { aggregates } = await computeScrobbleAnalytics(0);
    const entry = aggregates.songCounts['s-rep'];

    expect(entry.count).toBe(2);
    expect(entry.song.title).toBe('Alpha');
    expect(entry.song.album).toBe('Able');
    expect(entry.song.bitRate).toBe(960);
    // The whole point: these come from the same scrobble as the scalars above.
    expect(entry.song.genres).toEqual(['Ambient']);
    expect(entry.song.moods).toEqual(['new']);
  });

  it('follows the window when sinceMs excludes the newer play', async () => {
    const { aggregates } = await computeScrobbleAnalytics(TIME - 1000);
    expect(aggregates.songCounts['s-rep'].count).toBe(2);

    const older_only = await computeScrobbleAnalytics(TIME + 120_000);
    expect(older_only.aggregates.songCounts['s-rep']).toBeUndefined();
  });

  it('scopes the representative to the window', async () => {
    // A third, older play outside a 1-play window: the representative is still the
    // newest row INSIDE the window.
    seedLegacy('play-oldest', older, TIME - 60_000);
    await backfillScrobbleColumnsAsync();

    const { aggregates } = await computeScrobbleAnalytics(TIME + 30_000);
    expect(aggregates.songCounts['s-rep'].count).toBe(1);
    expect(aggregates.songCounts['s-rep'].song.title).toBe('Alpha');
    expect(aggregates.songCounts['s-rep'].song.genres).toEqual(['Ambient']);
  });
});

/* ------------------------------------------------------------------ */
/*  Query count is bounded, not per-row                                */
/* ------------------------------------------------------------------ */

describe('scrobble readers — bounded query count', () => {
  const seedMany = async (n: number): Promise<void> => {
    realDb.runSync('DELETE FROM scrobble_events;');
    for (let i = 0; i < n; i++) {
      seedLegacy(
        `sc-${i}`,
        { ...(fullSong as object), id: `s-${i}`, title: `Song ${i}` },
        TIME + i * 1000,
      );
    }
    await backfillScrobbleColumnsAsync();
  };

  /** Runs `fn` against a counting handle and returns the statements it issued. */
  const countFor = async (n: number, fn: () => Promise<unknown>): Promise<string[]> => {
    await seedMany(n);
    const { db, queries } = countingDb();
    __setDbForTests(db);
    await fn();
    __setDbForTests(realDb);
    return queries;
  };

  it.each([
    // 1 page query + 1 per child table, whatever the row count.
    ['loadRecentScrobbles', () => loadRecentScrobbles(500), 6],
    ['hydrateScrobblesAsync', () => hydrateScrobblesAsync(), 6],
    // 7 aggregate queries + the 5 child tables for the representative rows.
    ['computeScrobbleAnalytics', () => computeScrobbleAnalytics(0), 12],
    // The one reader that skips the child tables entirely.
    ['loadScrobblesSince', () => loadScrobblesSince(0), 1],
  ])('%s issues %d queries for 3 rows and for 60', async (_label, fn, expected) => {
    const few = await countFor(3, fn);
    const many = await countFor(60, fn);

    expect(few).toHaveLength(expected as number);
    expect(many).toHaveLength(expected as number);
  });

  it('still returns every row it read', async () => {
    await seedMany(60);
    expect(await loadRecentScrobbles(500)).toHaveLength(60);
    expect(await hydrateScrobblesAsync()).toHaveLength(60);
    expect(await loadScrobblesSince(0)).toHaveLength(60);
    const { aggregates } = await computeScrobbleAnalytics(0);
    expect(Object.keys(aggregates.songCounts)).toHaveLength(60);
    expect(aggregates.songCounts['s-59'].song.genres).toEqual(['Rock', 'Indie']);
  });
});

/* ------------------------------------------------------------------ */
/*  Best-effort semantics                                              */
/* ------------------------------------------------------------------ */

describe('scrobble readers — never throw into a render', () => {
  it('return empty results when the DB is unavailable', async () => {
    __setDbForTests(null);
    expect(await loadRecentScrobbles(10)).toEqual([]);
    expect(await loadScrobblesSince(0)).toEqual([]);
    expect(await hydrateScrobblesAsync()).toEqual([]);
    expect((await computeScrobbleAnalytics(0)).stats.totalPlays).toBe(0);
  });

  it('swallow a failing child-table query', async () => {
    seedLegacy('sc-full', fullSong);
    await backfillScrobbleColumnsAsync();

    __setDbForTests({
      getAllAsync: (sql: string, params?: readonly unknown[]) =>
        sql.includes('scrobble_genres')
          ? Promise.reject(new Error('boom'))
          : realDb.getAllAsync(sql, params),
      getFirstAsync: (sql: string, params?: readonly unknown[]) =>
        realDb.getFirstAsync(sql, params),
    } as unknown as InternalDb);

    expect(await loadRecentScrobbles(10)).toEqual([]);
    expect(await hydrateScrobblesAsync()).toEqual([]);
    expect((await computeScrobbleAnalytics(0)).stats.totalPlays).toBe(0);
  });
});
