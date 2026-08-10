/**
 * `legacyColumnDropService` against REAL SQL on the better-sqlite3-backed op-SQLite
 * substitute — `ALTER TABLE … DROP COLUMN` included, which the vendored SQLite supports on
 * both platforms.
 *
 * The load-bearing case is the one that does NOT drop: the backfill swallows every
 * error and writes through the non-atomic `runBatchAsync`, so a work set that survives
 * it must stop the column that feeds it being destroyed. Everything else here is the
 * write path staying correct on both sides of the drop.
 *
 * Per AGENTS.md §11 the substitute proves SQL semantics, never concurrency.
 */
import type { Child } from 'subsonic-api';

import { completedScrobbleStore } from '../../store/completedScrobbleStore';
import { pendingScrobbleStore } from '../../store/pendingScrobbleStore';
import { __setDbForTests, getDb, type InternalDb } from '../../store/persistence/db';
import {
  hydratePendingScrobblesAsync,
  insertPendingScrobble,
} from '../../store/persistence/pendingScrobbleTable';
import { loadRecentScrobbles } from '../../store/persistence/scrobbleAggregates';
import { hydrateScrobblesAsync, insertScrobble } from '../../store/persistence/scrobbleTable';
import { syncStatusStore } from '../../store/syncStatusStore';
import {
  createLegacyScrobbleTables,
  createScrobbleTables,
} from '../../test-utils/legacyScrobbleTables';
import {
  __resetLegacyColumnDropForTests,
  runLegacyColumnDropIfNeeded,
} from '../legacyColumnDropService';
import { LATEST_MIGRATION_ID } from '../migrationService';

import type { CompletedScrobble } from '../../store/completedScrobbleStore';
import type { PendingScrobble } from '../../store/pendingScrobbleStore';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite substitute failed to open');
const realDb: InternalDb = handle;

const TABLES = ['scrobble_events', 'pending_scrobble_events'] as const;
const TIME = 1_700_000_000_000;

const fullSong = {
  id: 's-full',
  title: 'Full Song',
  artist: 'The Artist',
  album: 'The Album',
  isDir: false,
  albumId: 'al-1',
  artistId: 'ar-1',
  duration: 210,
  genres: [{ name: 'Rock' }, { name: 'Indie' }],
  artists: [{ id: 'ar-1', name: 'The Artist' }],
  albumArtists: [{ id: 'ar-3', name: 'Various' }],
  contributors: [{ role: 'producer' }],
  moods: ['energetic', 'happy'],
} as unknown as Child;

const scrobble = (id: string, time = TIME): CompletedScrobble & PendingScrobble => ({
  id,
  song: fullSong,
  time,
});

const hasEnvelope = (table: string): boolean =>
  realDb
    .getAllSync<{ name: string }>(`PRAGMA table_info(${table});`)
    .some((c) => c.name === 'song_json');

const childRows = (table: string, id: string): unknown[] =>
  realDb.getAllSync(`SELECT * FROM ${table} WHERE scrobble_id = ? ORDER BY pos;`, [id]);

/** The migration chain's persisted counter, which every background one-shot gates on. */
const stampMigrationChain = (completedVersion: number): void => {
  realDb.runSync("INSERT OR REPLACE INTO storage (key, value) VALUES ('substreamer-migration', ?)", [
    JSON.stringify({ state: { completedVersion }, version: 0 }),
  ]);
};

/** Real handle with individual methods swapped — how the backfill is made to fail. */
const wrapDb = (overrides: Partial<InternalDb>): InternalDb =>
  ({ ...realDb, ...overrides }) as InternalDb;

/** A row as an install that predates the snapshot columns left it. */
const seedLegacy = (table: string, id: string, song: unknown, time = TIME): void => {
  realDb.runSync(`INSERT INTO ${table} (id, song_json, time) VALUES (?, ?, ?);`, [
    id,
    typeof song === 'string' ? song : JSON.stringify(song),
    time,
  ]);
};

const outstanding = (table: string): number =>
  realDb.getFirstSync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM ${table} WHERE song_id IS NULL OR title IS NULL;`,
  )?.c ?? -1;

beforeEach(() => {
  __setDbForTests(realDb);
  __resetLegacyColumnDropForTests();
  createLegacyScrobbleTables(realDb);
  stampMigrationChain(LATEST_MIGRATION_ID);
  syncStatusStore.setState({ inFlight: new Map() });
  completedScrobbleStore.setState({ recentScrobbles: [] });
  pendingScrobbleStore.setState({ pendingScrobbles: [] });
});

afterEach(() => {
  __setDbForTests(realDb);
});

describe('runLegacyColumnDropIfNeeded — the drop', () => {
  it('removes song_json from both tables', async () => {
    expect(hasEnvelope('scrobble_events')).toBe(true);
    expect(hasEnvelope('pending_scrobble_events')).toBe(true);

    await runLegacyColumnDropIfNeeded();

    for (const t of TABLES) expect(hasEnvelope(t)).toBe(false);
  });

  it('backfills the rows it is about to strand, then drops', async () => {
    seedLegacy('scrobble_events', 'legacy-c', fullSong);
    seedLegacy('pending_scrobble_events', 'legacy-p', fullSong);

    await runLegacyColumnDropIfNeeded();

    expect(hasEnvelope('scrobble_events')).toBe(false);
    for (const t of TABLES) expect(outstanding(t)).toBe(0);
    // The child tables the backfill wrote came with them.
    expect(childRows('scrobble_genres', 'legacy-c')).toHaveLength(2);
    expect(childRows('pending_scrobble_moods', 'legacy-p')).toHaveLength(2);
  });

  it('leaves the history readable through every reader, child rows included', async () => {
    await insertScrobble(scrobble('sc-1'));
    seedLegacy('scrobble_events', 'legacy-c', fullSong, TIME + 1);

    await runLegacyColumnDropIfNeeded();

    const hydrated = await hydrateScrobblesAsync();
    expect(hydrated.map((r) => r.id)).toEqual(['sc-1', 'legacy-c']);
    for (const row of hydrated) {
      expect(row.song.genres).toEqual(['Rock', 'Indie']);
      expect(row.song.moods).toEqual(['energetic', 'happy']);
      expect(row.song.albumArtists).toEqual([{ id: 'ar-3', name: 'Various', albumCount: 0 }]);
    }
    const recent = await loadRecentScrobbles(10);
    expect(recent.map((r) => r.id)).toEqual(['legacy-c', 'sc-1']);
  });

  it("refreshes the store's analytics with what the backfill recovered", async () => {
    seedLegacy('scrobble_events', 'legacy-c', fullSong);
    // The store hydrated before the backfill ran, so the row's columns were all NULL
    // and every column-derived aggregate skipped it.
    await completedScrobbleStore.getState().refreshFromDb();
    expect(completedScrobbleStore.getState().recentScrobbles).toEqual([]);
    expect(completedScrobbleStore.getState().aggregates.artistCounts).toEqual({});

    await runLegacyColumnDropIfNeeded();

    expect(completedScrobbleStore.getState().recentScrobbles.map((r) => r.id)).toEqual(['legacy-c']);
    expect(completedScrobbleStore.getState().aggregates.artistCounts['The Artist'].count).toBe(1);
  });
});

describe('runLegacyColumnDropIfNeeded — the work-set guard', () => {
  // The reason the ordering in this service is not negotiable: the backfill swallows
  // every error, so "it ran" is not "it finished". Dropping here would destroy the
  // only copy of that row's track.
  it('does NOT drop while a row the backfill could not resolve remains', async () => {
    seedLegacy('scrobble_events', 'stuck', fullSong);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    __setDbForTests(wrapDb({ runBatchAsync: () => Promise.reject(new Error('disk I/O error')) }));

    await runLegacyColumnDropIfNeeded();

    __setDbForTests(realDb);
    expect(outstanding('scrobble_events')).toBe(1);
    for (const t of TABLES) expect(hasEnvelope(t)).toBe(true);
    // Nothing was lost: the envelope is still there for the next attempt.
    expect(
      realDb.getFirstSync<{ song_json: string }>(
        'SELECT song_json FROM scrobble_events WHERE id = ?;',
        ['stuck'],
      )?.song_json,
    ).toContain('Full Song');
    warn.mockRestore();
  });

  it('drops on the next launch once the backfill gets through', async () => {
    seedLegacy('scrobble_events', 'stuck', fullSong);
    __setDbForTests(wrapDb({ runBatchAsync: () => Promise.reject(new Error('disk I/O error')) }));
    await runLegacyColumnDropIfNeeded();
    expect(hasEnvelope('scrobble_events')).toBe(true);

    __setDbForTests(realDb);
    __resetLegacyColumnDropForTests();
    await runLegacyColumnDropIfNeeded();

    expect(hasEnvelope('scrobble_events')).toBe(false);
    expect((await hydrateScrobblesAsync()).map((r) => r.id)).toEqual(['stuck']);
  });

  // A pending row is an offline play that has never reached the server. The guard is
  // per work set, not per table: one stuck queue row holds BOTH drops.
  it('a stuck pending row blocks the completed table too', async () => {
    seedLegacy('pending_scrobble_events', 'stuck-p', 'not json at all');
    __setDbForTests(wrapDb({ runBatchAsync: () => Promise.reject(new Error('disk I/O error')) }));

    await runLegacyColumnDropIfNeeded();

    __setDbForTests(realDb);
    for (const t of TABLES) expect(hasEnvelope(t)).toBe(true);
  });
});

describe('runLegacyColumnDropIfNeeded — the writers across the drop', () => {
  it('writes the envelope before the drop and omits it after, in one session', async () => {
    await insertScrobble(scrobble('before-c'));
    await insertPendingScrobble(scrobble('before-p'));
    expect(
      realDb.getFirstSync<{ song_json: string }>(
        'SELECT song_json FROM scrobble_events WHERE id = ?;',
        ['before-c'],
      )?.song_json,
    ).toBe('');

    await runLegacyColumnDropIfNeeded();

    // No cache invalidation and these would name a column that is gone.
    await insertScrobble(scrobble('after-c', TIME + 1));
    await insertPendingScrobble(scrobble('after-p', TIME + 1));

    expect((await hydrateScrobblesAsync()).map((r) => r.id)).toEqual(['before-c', 'after-c']);
    expect((await hydratePendingScrobblesAsync()).map((r) => r.id)).toEqual([
      'before-p',
      'after-p',
    ]);
    expect(childRows('scrobble_genres', 'after-c')).toHaveLength(2);
  });
});

describe('runLegacyColumnDropIfNeeded — the gate', () => {
  it('does nothing while the migration chain is unfinished', async () => {
    stampMigrationChain(LATEST_MIGRATION_ID - 1);

    await runLegacyColumnDropIfNeeded();

    for (const t of TABLES) expect(hasEnvelope(t)).toBe(true);
  });

  it('does nothing while a library sync is in flight', async () => {
    syncStatusStore.getState().setInFlight('song-sync', Promise.resolve());

    await runLegacyColumnDropIfNeeded();

    for (const t of TABLES) expect(hasEnvelope(t)).toBe(true);
  });

  it('does nothing when the database is unavailable', async () => {
    __setDbForTests(null);
    await runLegacyColumnDropIfNeeded();
    __setDbForTests(realDb);

    for (const t of TABLES) expect(hasEnvelope(t)).toBe(true);
  });

  it('is a clean no-op once the columns are already gone', async () => {
    createScrobbleTables(realDb);
    await insertScrobble(scrobble('sc-1'));
    __resetLegacyColumnDropForTests();
    const write = jest.spyOn(realDb, 'runAsync');

    await expect(runLegacyColumnDropIfNeeded()).resolves.toBeUndefined();

    // Two `PRAGMA table_info` reads and nothing else — no backfill, no ALTER.
    expect(write).not.toHaveBeenCalled();
    for (const t of TABLES) expect(hasEnvelope(t)).toBe(false);
    expect((await hydrateScrobblesAsync()).map((r) => r.id)).toEqual(['sc-1']);
    write.mockRestore();
  });

  it('leaves both columns in place when the ALTER itself fails, and retries next launch', async () => {
    await insertScrobble(scrobble('sc-1'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const boom = jest
      .spyOn(realDb, 'runAsync')
      .mockRejectedValueOnce(new Error('database is locked'));

    await runLegacyColumnDropIfNeeded();
    for (const t of TABLES) expect(hasEnvelope(t)).toBe(true);

    boom.mockRestore();
    __resetLegacyColumnDropForTests();
    await runLegacyColumnDropIfNeeded();

    for (const t of TABLES) expect(hasEnvelope(t)).toBe(false);
    expect((await hydrateScrobblesAsync()).map((r) => r.id)).toEqual(['sc-1']);
    warn.mockRestore();
  });

  it('shares one pass between two callers rather than running it twice', async () => {
    const first = runLegacyColumnDropIfNeeded();
    expect(runLegacyColumnDropIfNeeded()).toBe(first);
    await first;

    for (const t of TABLES) expect(hasEnvelope(t)).toBe(false);
  });
});
