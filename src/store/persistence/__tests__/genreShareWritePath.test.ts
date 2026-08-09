/**
 * The `genres` and `shares`/`share_entries` repositories, against REAL SQL on the
 * better-sqlite3-backed op-SQLite seam: a share's entries round-trip in order, deleting
 * a share cascades them, and both writes replace the set rather than accumulating it.
 *
 * `share_entries` holds a SNAPSHOT, not a reference into `songs` — the entry-shaped
 * assertions here are what the share list and the edit sheet render, and they must
 * survive a song that is not in the library.
 *
 * Per AGENTS.md §11 the seam proves SQL semantics, never concurrency.
 */
jest.mock('../kvStorage', () => require('../__mocks__/kvStorage'));

import type { Child } from 'subsonic-api';

import { __setDbForTests, getDb, type InternalDb } from '../db';
import { readGenres, replaceGenres } from '../genresTable';
import { deleteShareRow, readShares, replaceShares } from '../sharesTable';

import type { Genre, Share } from '../../../services/subsonicService';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
const realDb: InternalDb = handle;

const entry = (id: string, overrides: Partial<Child> = {}): Child =>
  ({
    id,
    title: `Title ${id}`,
    artist: 'The Artist',
    album: 'The Album',
    albumId: 'al-1',
    coverArt: `cov-${id}`,
    isDir: false,
    ...overrides,
  }) as Child;

const share = (id: string, overrides: Partial<Share> = {}): Share =>
  ({
    id,
    url: `https://music.example.com/share/${id}`,
    description: `Share ${id}`,
    created: new Date(1_700_000_000_000),
    expires: new Date(1_800_000_000_000),
    lastVisited: new Date(1_750_000_000_000),
    username: 'testuser',
    visitCount: 7,
    entry: [entry(`${id}-a`), entry(`${id}-b`), entry(`${id}-c`)],
    ...overrides,
  }) as Share;

const entryRows = (shareId: string): { song_id: string; pos: number }[] =>
  realDb.getAllSync<{ song_id: string; pos: number }>(
    'SELECT song_id, pos FROM share_entries WHERE share_id = ? ORDER BY pos;',
    [shareId],
  );

const countAllEntries = (): number =>
  realDb.getFirstSync<{ c: number }>('SELECT COUNT(*) AS c FROM share_entries;')?.c ?? 0;

beforeEach(() => {
  __setDbForTests(realDb);
  realDb.runSync('DELETE FROM shares;');
  realDb.runSync('DELETE FROM genres;');
});

/* ------------------------------------------------------------------ */
/*  Genres                                                             */
/* ------------------------------------------------------------------ */

describe('genres', () => {
  const rock: Genre = { value: 'Rock', songCount: 120, albumCount: 12 };
  const jazz: Genre = { value: 'jazz', songCount: 40, albumCount: 4 };
  const zydeco: Genre = { value: 'Zydeco', songCount: 3, albumCount: 1 };

  it('round-trips the list with its counts, in the order it was given', async () => {
    // Not alphabetical: `pos` preserves the server's array order, so a hydrated list is
    // identical to the one a fetch produces and no consumer sees it change.
    await replaceGenres([rock, jazz, zydeco]);

    expect(await readGenres()).toEqual([rock, jazz, zydeco]);
  });

  it('re-numbers on every write, so a shorter list has no stale tail order', async () => {
    await replaceGenres([rock, jazz, zydeco]);
    await replaceGenres([zydeco, rock]);

    expect(await readGenres()).toEqual([zydeco, rock]);
  });

  it('replaces the set rather than accumulating it', async () => {
    await replaceGenres([rock, jazz]);
    await replaceGenres([zydeco]);

    expect(await readGenres()).toEqual([zydeco]);
  });

  it('drops an entry with no usable name instead of losing the batch', async () => {
    await replaceGenres([
      rock,
      { value: '', songCount: 1, albumCount: 1 },
      null as unknown as Genre,
      { songCount: 2 } as Genre,
      jazz,
    ]);

    // The survivors stay contiguous and in order — `pos` numbers them, not the input
    // index.
    expect((await readGenres())?.map((g) => g.value)).toEqual(['Rock', 'jazz']);
  });

  it('stores a count that would not bind as NULL and reads it back as 0', async () => {
    await replaceGenres([{ value: 'Odd', songCount: {} as unknown as number, albumCount: 2 }]);

    expect(await readGenres()).toEqual([{ value: 'Odd', songCount: 0, albumCount: 2 }]);
  });

  it('returns null, not an empty list, when the DB is unavailable', async () => {
    await replaceGenres([rock]);
    __setDbForTests(null);

    expect(await readGenres()).toBeNull();
  });

  it('writing with no DB is a silent no-op', async () => {
    __setDbForTests(null);
    await expect(replaceGenres([rock])).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Shares                                                             */
/* ------------------------------------------------------------------ */

describe('shares', () => {
  it('round-trips a share whole, entries in order', async () => {
    await replaceShares([share('sh-1')]);

    const stored = await readShares();
    expect(stored).toHaveLength(1);
    expect(stored?.[0]).toMatchObject({
      id: 'sh-1',
      url: 'https://music.example.com/share/sh-1',
      description: 'Share sh-1',
      username: 'testuser',
      visitCount: 7,
    });
    expect(stored?.[0].created).toEqual(new Date(1_700_000_000_000));
    expect(stored?.[0].expires).toEqual(new Date(1_800_000_000_000));
    expect(stored?.[0].lastVisited).toEqual(new Date(1_750_000_000_000));
    expect(stored?.[0].entry?.map((e) => e.id)).toEqual(['sh-1-a', 'sh-1-b', 'sh-1-c']);
    // The fields the share list and the edit sheet actually render.
    expect(stored?.[0].entry?.[0]).toMatchObject({
      id: 'sh-1-a',
      title: 'Title sh-1-a',
      artist: 'The Artist',
      album: 'The Album',
      albumId: 'al-1',
      coverArt: 'cov-sh-1-a',
    });
  });

  it('keeps each share’s entries with the right share, in the order given', async () => {
    // Deliberately NOT newest-first: `pos` preserves the server's array order, so the
    // browser's unsorted `shares.map(...)` renders the same list before and after a
    // fetch. `created` here is the inverse of the array order to prove it is not used.
    await replaceShares([
      share('older', { created: new Date(1_600_000_000_000) }),
      share('newer', { created: new Date(1_900_000_000_000) }),
    ]);

    const stored = await readShares();
    expect(stored?.map((s) => s.id)).toEqual(['older', 'newer']);
    expect(stored?.[0].entry?.map((e) => e.id)).toEqual(['older-a', 'older-b', 'older-c']);
    expect(stored?.[1].entry?.map((e) => e.id)).toEqual(['newer-a', 'newer-b', 'newer-c']);
  });

  it('re-numbers on every write, so a re-ordered fetch reads back re-ordered', async () => {
    await replaceShares([share('sh-1'), share('sh-2'), share('sh-3')]);
    await replaceShares([share('sh-3'), share('sh-1')]);

    expect((await readShares())?.map((s) => s.id)).toEqual(['sh-3', 'sh-1']);
  });

  it('stores a share the server returned with no entries', async () => {
    await replaceShares([share('empty', { entry: undefined })]);

    const stored = await readShares();
    expect(stored?.[0].entry).toEqual([]);
    expect(countAllEntries()).toBe(0);
  });

  it('leaves an absent title ABSENT so the heading falls through to the album', async () => {
    await replaceShares([
      share('sh-1', { entry: [entry('e-1', { title: undefined, artist: undefined })] }),
    ]);

    const stored = await readShares();
    expect(stored?.[0].entry?.[0]).not.toHaveProperty('title');
    expect(stored?.[0].entry?.[0]).not.toHaveProperty('artist');
    expect(stored?.[0].entry?.[0]).toMatchObject({ id: 'e-1', album: 'The Album' });
  });

  it('deleting a share cascades its entries and leaves the others alone', async () => {
    await replaceShares([share('sh-1'), share('sh-2')]);

    await deleteShareRow('sh-1');

    expect((await readShares())?.map((s) => s.id)).toEqual(['sh-2']);
    expect(entryRows('sh-1')).toEqual([]);
    expect(entryRows('sh-2')).toHaveLength(3);
  });

  it('replacing the set cascades away the entries of the shares it drops', async () => {
    await replaceShares([share('sh-1'), share('sh-2')]);
    await replaceShares([share('sh-3')]);

    expect((await readShares())?.map((s) => s.id)).toEqual(['sh-3']);
    expect(countAllEntries()).toBe(3);
  });

  it('stores an entry whose song is not in the library', async () => {
    // The whole reason `share_entries.song_id` has no FK: with
    // `PRAGMA foreign_keys = ON` a reference to `songs` would fail this INSERT outright.
    expect(
      realDb.getFirstSync('SELECT id FROM songs WHERE id = ?;', ['not-in-library']),
    ).toBeFalsy();

    await replaceShares([share('sh-1', { entry: [entry('not-in-library')] })]);

    expect((await readShares())?.[0].entry?.map((e) => e.id)).toEqual(['not-in-library']);
  });

  it('drops an entry with no id rather than losing the whole write', async () => {
    await replaceShares([
      share('sh-1', {
        entry: [entry('e-1'), { title: 'no id' } as Child, entry('e-2')],
      }),
    ]);

    expect((await readShares())?.[0].entry?.map((e) => e.id)).toEqual(['e-1', 'e-2']);
  });

  it('drops a share with no id and keeps the rest', async () => {
    await replaceShares([{ ...share('sh-1'), id: '' } as Share, share('sh-2')]);

    expect((await readShares())?.map((s) => s.id)).toEqual(['sh-2']);
  });

  it('stores a value that would not bind as NULL rather than aborting', async () => {
    await replaceShares([
      share('sh-1', {
        url: {} as unknown as string,
        visitCount: {} as unknown as number,
        created: 'not a date' as unknown as Date,
      }),
    ]);

    const stored = await readShares();
    expect(stored?.[0]).toMatchObject({ id: 'sh-1', url: '', visitCount: 0 });
    expect(stored?.[0].created).toEqual(new Date(0));
  });

  it('stores an Invalid Date as NULL rather than binding NaN', async () => {
    await replaceShares([share('sh-1', { expires: new Date('nope') })]);

    const stored = await readShares();
    expect(stored?.[0]).not.toHaveProperty('expires');
  });

  it('accepts the ISO-string dates a parsed KV blob carries', async () => {
    await replaceShares([
      share('sh-1', {
        created: '2026-08-09T00:00:00.000Z' as unknown as Date,
        expires: '2026-09-09T00:00:00.000Z' as unknown as Date,
      }),
    ]);

    const stored = await readShares();
    expect(stored?.[0].created).toEqual(new Date('2026-08-09T00:00:00.000Z'));
    expect(stored?.[0].expires).toEqual(new Date('2026-09-09T00:00:00.000Z'));
  });

  it('returns null, not an empty list, when the DB is unavailable', async () => {
    await replaceShares([share('sh-1')]);
    __setDbForTests(null);

    expect(await readShares()).toBeNull();
  });

  it('writing and deleting with no DB are silent no-ops', async () => {
    __setDbForTests(null);
    await expect(replaceShares([share('sh-1')])).resolves.toBeUndefined();
    await expect(deleteShareRow('sh-1')).resolves.toBeUndefined();
  });
});
