/**
 * Migration 38 — the `genres` and `shares` KV blobs into their tables, against REAL SQL
 * on the better-sqlite3-backed op-SQLite substitute.
 *
 * The load-bearing property is that both blobs are MIGRATED rather than dropped: the
 * share browser renders its empty state off `shares.length === 0`, so a dropped blob
 * shows "no shares" until a fetch completes — and indefinitely offline. The other is the
 * failing case: when the rows do not take the write, the KV key must still be there
 * afterwards so the next launch retries.
 *
 * Per AGENTS.md §11 the substitute proves SQL semantics, never concurrency.
 */
jest.mock('../kvStorage', () => require('../__mocks__/kvStorage'));

import type { Child } from 'subsonic-api';

import { __setDbForTests, getDb, type InternalDb } from '../db';
import { clearKvStorage, kvStorage } from '../kvStorage';
import { migrateGenresAndSharesFromKv } from '../genreShareMigration';
import { readGenres, replaceGenres } from '../genresTable';
import { readShares } from '../sharesTable';
import { genreStore } from '../../genreStore';
import { sharesStore } from '../../sharesStore';

import type { Genre, Share } from '../../../services/subsonicService';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite substitute failed to open');
const realDb: InternalDb = handle;

const GENRES_KEY = 'substreamer-genres';
const SHARES_KEY = 'substreamer-shares';

const genre = (value: string, songCount = 10): Genre => ({
  value,
  songCount,
  albumCount: 1,
});

const entry = (id: string): Child =>
  ({
    id,
    title: `Title ${id}`,
    artist: 'The Artist',
    album: 'The Album',
    albumId: 'al-1',
    coverArt: `cov-${id}`,
    isDir: false,
  }) as Child;

/** Dates survive the blob as ISO strings — that is how a persisted `Share` comes back. */
const legacyShare = (id: string, overrides: Partial<Share> = {}): Share =>
  ({
    id,
    url: `https://music.example.com/share/${id}`,
    description: `Share ${id}`,
    created: '2026-08-01T00:00:00.000Z',
    expires: '2026-09-01T00:00:00.000Z',
    username: 'testuser',
    visitCount: 3,
    entry: [entry(`${id}-a`), entry(`${id}-b`)],
    ...overrides,
  }) as unknown as Share;

/** A blob exactly as a persist middleware wrote it. */
const seedBlob = async (
  key: string,
  field: string,
  items: unknown[],
  rest: Record<string, unknown> = {},
): Promise<void> => {
  await kvStorage.setItem(
    key,
    JSON.stringify({ state: { [field]: items, ...rest }, version: 0 }),
  );
};

const readBlob = async (
  key: string,
): Promise<{ state?: Record<string, unknown>; version?: number }> => {
  const raw = await kvStorage.getItem(key);
  return raw === null ? {} : JSON.parse(raw);
};

const logs: string[] = [];
const log = (message: string): void => {
  logs.push(message);
};

beforeEach(() => {
  __setDbForTests(realDb);
  logs.length = 0;
  // ON DELETE CASCADE clears each share's entries with it.
  realDb.runSync('DELETE FROM shares;');
  realDb.runSync('DELETE FROM genres;');
  genreStore.setState({ genres: [], sqlAuthoritative: false });
  sharesStore.setState({
    shares: [],
    loading: false,
    error: null,
    notAvailable: false,
    sqlAuthoritative: false,
  });
  // Last: the resets above go through `persist`, which rewrites the blobs.
  clearKvStorage();
});

/* ------------------------------------------------------------------ */
/*  Genres                                                             */
/* ------------------------------------------------------------------ */

describe('genres blob → rows', () => {
  it('migrates every genre with its counts, in the blob’s order', async () => {
    await seedBlob(GENRES_KEY, 'genres', [
      genre('Rock', 120),
      genre('Jazz', 40),
      genre('Zydeco', 3),
    ]);

    await migrateGenresAndSharesFromKv(log);

    // The blob's order IS the server's order — the whole point of `pos` is that the
    // migrated list is the one the user was already looking at.
    expect(await readGenres()).toEqual([
      { value: 'Rock', songCount: 120, albumCount: 1 },
      { value: 'Jazz', songCount: 40, albumCount: 1 },
      { value: 'Zydeco', songCount: 3, albumCount: 1 },
    ]);
  });

  it('gives up the blob copy only, keeping anything else on the key', async () => {
    await seedBlob(GENRES_KEY, 'genres', [genre('Rock')], { somethingElse: 'kept' });

    await migrateGenresAndSharesFromKv(log);

    const blob = await readBlob(GENRES_KEY);
    expect(blob.state).not.toHaveProperty('genres');
    expect(blob.state).toMatchObject({ somethingElse: 'kept' });
    expect(blob.version).toBe(0);
  });

  it('is idempotent — a second run duplicates nothing and loses nothing', async () => {
    await seedBlob(GENRES_KEY, 'genres', [genre('Rock'), genre('Jazz')]);

    await migrateGenresAndSharesFromKv(log);
    const first = await readGenres();
    await migrateGenresAndSharesFromKv(log);

    expect(await readGenres()).toEqual(first);
    expect(first).toHaveLength(2);
  });

  it('re-running against a blob that still holds them rewrites rather than duplicates', async () => {
    const genres = [genre('Rock')];
    await seedBlob(GENRES_KEY, 'genres', genres);
    await migrateGenresAndSharesFromKv(log);
    // As if the strip had not landed — a kill between the row write and the rewrite.
    await seedBlob(GENRES_KEY, 'genres', genres);

    await migrateGenresAndSharesFromKv(log);

    expect(await readGenres()).toHaveLength(1);
  });

  it('drops entries a hand-edited blob broke and still verifies', async () => {
    await seedBlob(GENRES_KEY, 'genres', [genre('Rock'), null, { songCount: 2 }, genre('Jazz')]);

    await migrateGenresAndSharesFromKv(log);

    expect((await readGenres())?.map((g) => g.value)).toEqual(['Rock', 'Jazz']);
    expect((await readBlob(GENRES_KEY)).state).not.toHaveProperty('genres');
  });
});

/* ------------------------------------------------------------------ */
/*  Shares                                                             */
/* ------------------------------------------------------------------ */

describe('shares blob → rows', () => {
  it('migrates every share whole, entries included and in order', async () => {
    await seedBlob(SHARES_KEY, 'shares', [
      legacyShare('sh-1'),
      legacyShare('sh-2', { entry: [entry('x'), entry('y'), entry('z')] }),
    ]);

    await migrateGenresAndSharesFromKv(log);

    const stored = await readShares();
    expect(stored?.map((s) => s.id).sort()).toEqual(['sh-1', 'sh-2']);
    const second = stored?.find((s) => s.id === 'sh-2');
    expect(second).toMatchObject({
      url: 'https://music.example.com/share/sh-2',
      description: 'Share sh-2',
      username: 'testuser',
      visitCount: 3,
    });
    expect(second?.created).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(second?.expires).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    expect(second?.entry?.map((e) => e.id)).toEqual(['x', 'y', 'z']);
    // What the browser renders off the first entry.
    expect(second?.entry?.[0]).toMatchObject({
      title: 'Title x',
      artist: 'The Artist',
      album: 'The Album',
      albumId: 'al-1',
      coverArt: 'cov-x',
    });
  });

  it('gives up the blob copy only', async () => {
    await seedBlob(SHARES_KEY, 'shares', [legacyShare('sh-1')], { keepMe: 1 });

    await migrateGenresAndSharesFromKv(log);

    const blob = await readBlob(SHARES_KEY);
    expect(blob.state).not.toHaveProperty('shares');
    expect(blob.state).toMatchObject({ keepMe: 1 });
  });

  it('is idempotent — a second run duplicates nothing and loses nothing', async () => {
    await seedBlob(SHARES_KEY, 'shares', [legacyShare('sh-1'), legacyShare('sh-2')]);

    await migrateGenresAndSharesFromKv(log);
    const first = await readShares();
    await migrateGenresAndSharesFromKv(log);

    expect(await readShares()).toEqual(first);
    expect(first?.[0].entry).toHaveLength(2);
  });

  it('migrates a share the server returned with no entries', async () => {
    await seedBlob(SHARES_KEY, 'shares', [legacyShare('sh-1', { entry: undefined })]);

    await migrateGenresAndSharesFromKv(log);

    expect((await readShares())?.[0].entry).toEqual([]);
    expect((await readBlob(SHARES_KEY)).state).not.toHaveProperty('shares');
  });
});

/* ------------------------------------------------------------------ */
/*  The failure that must stay recoverable                             */
/* ------------------------------------------------------------------ */

describe('a failed row write', () => {
  it('throws and leaves the genres key intact when the rows cannot be read back', async () => {
    await seedBlob(GENRES_KEY, 'genres', [genre('Rock')]);
    __setDbForTests(null);

    await expect(migrateGenresAndSharesFromKv(log)).rejects.toThrow(/genre rows unreadable/);

    expect((await readBlob(GENRES_KEY)).state?.genres).toHaveLength(1);
  });

  it('throws and leaves the shares key intact when the rows cannot be read back', async () => {
    // Genres already done, so the run reaches the shares half.
    await seedBlob(SHARES_KEY, 'shares', [legacyShare('sh-1')]);
    __setDbForTests(null);

    await expect(migrateGenresAndSharesFromKv(log)).rejects.toThrow(/share rows unreadable/);

    expect((await readBlob(SHARES_KEY)).state?.shares).toHaveLength(1);
  });

  it('stops before the shares half when genres fail, leaving both keys', async () => {
    await seedBlob(GENRES_KEY, 'genres', [genre('Rock')]);
    await seedBlob(SHARES_KEY, 'shares', [legacyShare('sh-1')]);
    __setDbForTests(null);

    await expect(migrateGenresAndSharesFromKv(log)).rejects.toThrow();

    expect((await readBlob(GENRES_KEY)).state).toHaveProperty('genres');
    expect((await readBlob(SHARES_KEY)).state).toHaveProperty('shares');
  });

  it('a retry after the failure completes both halves', async () => {
    await seedBlob(GENRES_KEY, 'genres', [genre('Rock')]);
    await seedBlob(SHARES_KEY, 'shares', [legacyShare('sh-1')]);
    __setDbForTests(null);
    await expect(migrateGenresAndSharesFromKv(log)).rejects.toThrow();

    __setDbForTests(realDb);
    await migrateGenresAndSharesFromKv(log);

    expect(await readGenres()).toHaveLength(1);
    expect((await readShares())?.[0].entry).toHaveLength(2);
    expect((await readBlob(GENRES_KEY)).state).not.toHaveProperty('genres');
    expect((await readBlob(SHARES_KEY)).state).not.toHaveProperty('shares');
  });

  it('leaves an unparseable blob in place rather than throwing forever', async () => {
    await kvStorage.setItem(GENRES_KEY, '{not json');
    await kvStorage.setItem(SHARES_KEY, '{not json either');

    await expect(migrateGenresAndSharesFromKv(log)).resolves.toBeUndefined();

    expect(await kvStorage.getItem(GENRES_KEY)).toBe('{not json');
    expect(await kvStorage.getItem(SHARES_KEY)).toBe('{not json either');
    expect(logs.filter((l) => l.includes('unparseable'))).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/*  Nothing to do                                                      */
/* ------------------------------------------------------------------ */

describe('nothing to migrate', () => {
  it('a fresh install writes nothing and raises nothing', async () => {
    await expect(migrateGenresAndSharesFromKv(log)).resolves.toBeUndefined();

    expect(await readGenres()).toEqual([]);
    expect(await readShares()).toEqual([]);
    expect(logs.join(' ')).toContain('no genres blob');
    expect(logs.join(' ')).toContain('no shares blob');
  });

  it('a blob with an empty array is left alone', async () => {
    await seedBlob(GENRES_KEY, 'genres', []);
    await seedBlob(SHARES_KEY, 'shares', []);

    await migrateGenresAndSharesFromKv(log);

    expect(await readGenres()).toEqual([]);
    expect((await readBlob(GENRES_KEY)).state).toHaveProperty('genres');
    expect((await readBlob(SHARES_KEY)).state).toHaveProperty('shares');
  });

  it('a blob whose field is not an array is left alone', async () => {
    await kvStorage.setItem(
      SHARES_KEY,
      JSON.stringify({ state: { shares: 'corrupt' }, version: 0 }),
    );

    await migrateGenresAndSharesFromKv(log);

    expect(await readShares()).toEqual([]);
    expect(logs.join(' ')).toContain('holds no array');
  });
});

/* ------------------------------------------------------------------ */
/*  Migration → each store's read flip                                 */
/* ------------------------------------------------------------------ */

describe('the stores after the migration', () => {
  it('genres hydrate from the rows and stop writing to the blob', async () => {
    const genres = [genre('Rock'), genre('Jazz')];
    await seedBlob(GENRES_KEY, 'genres', genres);
    // As the persist middleware leaves it: memory holds the blob's set.
    genreStore.setState({ genres });

    await migrateGenresAndSharesFromKv(log);
    await genreStore.getState().hydrateFromDbAsync();

    const state = genreStore.getState();
    // Byte-equivalent to what the store already held — the hydrate must not reorder it.
    expect(state.genres.map((g) => g.value)).toEqual(['Rock', 'Jazz']);
    expect(state.sqlAuthoritative).toBe(true);
  });

  it('shares hydrate from the rows with their entries, order untouched', async () => {
    // Ids deliberately descending, so a hydrate that sorted by anything would show it.
    const shares = [legacyShare('sh-2'), legacyShare('sh-1')];
    await seedBlob(SHARES_KEY, 'shares', shares);
    sharesStore.setState({ shares });

    await migrateGenresAndSharesFromKv(log);
    await sharesStore.getState().hydrateFromDbAsync();

    const state = sharesStore.getState();
    expect(state.shares.map((s) => s.id)).toEqual(['sh-2', 'sh-1']);
    expect(state.shares[0].entry).toHaveLength(2);
    expect(state.sqlAuthoritative).toBe(true);
  });

  it('a hydrated list is the same list a fetch produces, order included', async () => {
    // The property `pos` exists for. Without it the cold-start list and the post-fetch
    // list differ, and `useMixBuilder`'s unsorted `.slice(0, 8)` silently yields a
    // different eight.
    const fetched = [genre('Rock', 120), genre('Ambient', 5), genre('Jazz', 40)];
    await replaceGenres(fetched);
    genreStore.setState({ genres: fetched });

    await genreStore.getState().hydrateFromDbAsync();

    expect(genreStore.getState().genres).toEqual(fetched);
  });

  it('keeps reading the blob when the migration has not run', async () => {
    const genres = [genre('Rock')];
    const shares = [legacyShare('sh-1')];
    genreStore.setState({ genres });
    sharesStore.setState({ shares });

    await genreStore.getState().hydrateFromDbAsync();
    await sharesStore.getState().hydrateFromDbAsync();

    expect(genreStore.getState().genres).toEqual(genres);
    expect(genreStore.getState().sqlAuthoritative).toBe(false);
    expect(sharesStore.getState().shares).toEqual(shares);
    expect(sharesStore.getState().sqlAuthoritative).toBe(false);
  });

  it('does not flip on a partial table — one row written before the migration', async () => {
    const shares = [legacyShare('sh-1'), legacyShare('sh-2')];
    sharesStore.setState({ shares });
    // A single share saved after the upgrade makes the table non-empty while the blob is
    // still the only copy of the rest. A row-count gate would replace the list with it.
    await seedBlob(SHARES_KEY, 'shares', [legacyShare('sh-1')]);
    await migrateGenresAndSharesFromKv(log);

    await sharesStore.getState().hydrateFromDbAsync();

    expect(sharesStore.getState().shares.map((s) => s.id)).toEqual(['sh-1', 'sh-2']);
    expect(sharesStore.getState().sqlAuthoritative).toBe(false);
  });

  it('does not flip on a share whose entries did not store', async () => {
    const shares = [legacyShare('sh-1')];
    sharesStore.setState({ shares });
    // Parent row present, entries missing — the share would render with no title and no
    // artwork, so an id-only gate is not enough.
    realDb.runSync(
      'INSERT INTO shares (id, pos, url, created, username, visit_count) VALUES (?, ?, ?, ?, ?, ?);',
      ['sh-1', 0, 'https://x', 1, 'u', 0],
    );

    await sharesStore.getState().hydrateFromDbAsync();

    expect(sharesStore.getState().shares[0].entry).toHaveLength(2);
    expect(sharesStore.getState().sqlAuthoritative).toBe(false);
  });

  it('a DB-unavailable hydrate blanks neither store', async () => {
    const genres = [genre('Rock')];
    const shares = [legacyShare('sh-1')];
    genreStore.setState({ genres });
    sharesStore.setState({ shares });
    __setDbForTests(null);

    await genreStore.getState().hydrateFromDbAsync();
    await sharesStore.getState().hydrateFromDbAsync();

    expect(genreStore.getState().genres).toEqual(genres);
    expect(sharesStore.getState().shares).toEqual(shares);
    expect(genreStore.getState().sqlAuthoritative).toBe(false);
    expect(sharesStore.getState().sqlAuthoritative).toBe(false);
  });

  it('a fresh install flips both by itself, with nothing to hold back', async () => {
    await genreStore.getState().hydrateFromDbAsync();
    await sharesStore.getState().hydrateFromDbAsync();

    expect(genreStore.getState()).toMatchObject({ genres: [], sqlAuthoritative: true });
    expect(sharesStore.getState()).toMatchObject({ shares: [], sqlAuthoritative: true });
  });
});
