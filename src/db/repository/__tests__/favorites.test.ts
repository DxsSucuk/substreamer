import type { AlbumID3, ArtistID3, Child } from 'subsonic-api';

import { getSortKey, letterOfSortKey } from '../../../utils/sortHelpers';
import { getDb } from '../../../store/persistence/db';
import { ensureNormalizedSchema } from '../../createNormalizedTables';
import { setSortArticles } from '../../sortArticles';
import { upsertAlbums } from '../albums';
import { upsertArtists } from '../artists';
import { upsertSongs } from '../songs';
import {
  clearStarredSongsNotIn,
  countStarredSongs,
  epochOf,
  listAllStarredAlbums,
  listAllStarredArtists,
  listAllStarredSongs,
  listStarredAlbumIds,
  listStarredArtistIds,
  listStarredArtistNames,
  listStarredSongIds,
  markStarredAlbums,
  markStarredArtists,
  markStarredSongs,
  promoteResolvedFavorites,
  randomStarredSong,
  replaceFavoriteAlbums,
  replaceFavoriteArtists,
  replaceFavoriteSongs,
  starredAlbumsPage,
  starredArtistsPage,
  starredSongTotals,
  starredSongsPage,
  starredSortKeyOf,
} from '../favorites';

const db = () => getDb()!;

const song = (id: string, extra: Partial<Child> = {}): Child =>
  ({ id, title: `Song ${id}`, isDir: false, duration: 100, ...extra }) as Child;
const album = (id: string, extra: Partial<AlbumID3> = {}): AlbumID3 =>
  ({ id, name: `Album ${id}`, duration: 0, songCount: 0, ...extra }) as AlbumID3;
const artist = (id: string, name = `Artist ${id}`): ArtistID3 => ({ id, name, albumCount: 1 });

// Children before parents — `cached_item_songs.song_id` has an FK to `cached_songs`.
const TABLES = [
  'cached_item_songs',
  'cached_albums',
  'cached_items',
  'cached_songs',
  'songs',
  'albums',
  'artists',
  'favorite_songs',
  'favorite_albums',
  'favorite_artists',
];

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  for (const t of TABLES) db().runSync(`DELETE FROM ${t}`);
});

/** A downloaded track — `cached_songs` has no FK to `songs`, which is exactly why the
 *  remainder half needs the downloaded filter too. */
const seedCachedSong = (id: string): void => {
  db().runSync(
    'INSERT INTO cached_songs (song_id, album_id, suffix, bytes, format_captured_at, ' +
      'downloaded_at, title, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, 'a1', 'mp3', 1, 0, 0, 'T', 100],
  );
};

const seedCachedAlbum = (itemId: string, expected: number, present: string[]): void => {
  db().runSync(
    'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, ' +
      'downloaded_at) VALUES (?, ?, ?, ?, ?, ?)',
    [itemId, 'album', 'A', expected, 0, 0],
  );
  present.forEach((songId, i) => {
    seedCachedSong(songId);
    db().runSync(
      'INSERT INTO cached_item_songs (item_id, position, song_id) VALUES (?, ?, ?)',
      [itemId, i, songId],
    );
  });
};

describe('epochOf', () => {
  it('maps an absent date to 0 — membership without a fabricated timestamp', () => {
    expect(epochOf(undefined)).toBe(0);
    expect(epochOf(null)).toBe(0);
    expect(epochOf('not a date')).toBe(0);
  });

  it('accepts Date, epoch-ms and ISO strings', () => {
    expect(epochOf(new Date(1700))).toBe(1700);
    expect(epochOf(1700)).toBe(1700);
    expect(epochOf('2020-01-01T00:00:00.000Z')).toBe(Date.parse('2020-01-01T00:00:00.000Z'));
  });
});

describe('marks on library rows', () => {
  it('never inserts: marking an absent id is a silent no-op', async () => {
    await markStarredSongs(db(), [{ id: 'ghost', starredAt: 500 }]);
    const n = db().getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM songs');
    expect(n?.n).toBe(0);
  });

  it('clears every mark not in the kept set, and leaves the rest', async () => {
    await upsertSongs(db(), [song('s1'), song('s2')]);
    await markStarredSongs(db(), [
      { id: 's1', starredAt: 100 },
      { id: 's2', starredAt: 200 },
    ]);
    await clearStarredSongsNotIn(db(), ['s2']);
    const rows = db().getAllSync<{ id: string; starred: number | null }>(
      'SELECT id, starred FROM songs ORDER BY id',
    );
    expect(rows).toEqual([
      { id: 's1', starred: null },
      { id: 's2', starred: 200 },
    ]);
  });

  it('chunks a mark set larger than one batch', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => song(`s${String(i).padStart(4, '0')}`));
    await upsertSongs(db(), many);
    await markStarredSongs(
      db(),
      many.map((s, i) => ({ id: s.id, starredAt: i + 1 })),
    );
    expect(await countStarredSongs(db())).toBe(1200);
  });
});

describe('the remainder tables', () => {
  it('holds the entity in columns, leaving the legacy envelope column empty', async () => {
    await replaceFavoriteSongs(db(), [
      song('r1', { starred: new Date(900), duration: 42, genre: 'Jazz' }),
    ]);
    const row = db().getFirstSync<{
      starred: number;
      duration: number;
      genre: string;
      title: string;
      json: string;
    }>('SELECT * FROM favorite_songs');
    expect(row?.starred).toBe(900);
    expect(row?.duration).toBe(42);
    expect(row?.genre).toBe('Jazz');
    expect(row?.title).toBe('Song r1');
    expect(row?.json).toBe('');
  });

  it('stores 0 when the server sent no date, and reads it back as undefined', async () => {
    await replaceFavoriteSongs(db(), [song('r1')]);
    expect(
      db().getFirstSync<{ starred: number }>('SELECT starred FROM favorite_songs')?.starred,
    ).toBe(0);
    const [entry] = await listAllStarredSongs(db());
    expect(entry.item.starred).toBeUndefined();
  });

  it('replaces wholesale — a rebuild drops the previous contents', async () => {
    await replaceFavoriteSongs(db(), [song('r1'), song('r2')]);
    await replaceFavoriteSongs(db(), [song('r3')]);
    const ids = db().getAllSync<{ id: string }>('SELECT id FROM favorite_songs');
    expect(ids.map((r) => r.id)).toEqual(['r3']);
  });

  it('rolls back to the previous contents when a rebuild fails mid-way', async () => {
    await replaceFavoriteSongs(db(), [song('keep1'), song('keep2')]);
    const real = db().runAtomicBatchAsync.bind(db());
    // Append a statement that cannot run: the DELETE and the new INSERT have already
    // executed inside the savepoint by the time it fails, so only a real ROLLBACK TO
    // can leave the previous contents in place.
    (db() as unknown as { runAtomicBatchAsync: unknown }).runAtomicBatchAsync = (
      commands: Parameters<typeof real>[0],
    ) => real([...commands, ['INSERT INTO no_such_table (x) VALUES (1)', []]]);
    try {
      await expect(replaceFavoriteSongs(db(), [song('new1')])).rejects.toThrow(/no_such_table/);
    } finally {
      (db() as unknown as { runAtomicBatchAsync: unknown }).runAtomicBatchAsync = real;
    }
    const ids = db().getAllSync<{ id: string }>('SELECT id FROM favorite_songs ORDER BY id');
    expect(ids.map((r) => r.id)).toEqual(['keep1', 'keep2']);
  });
});

describe('read-time disjointness', () => {
  it('hides a remainder row whose library row acquired a mark AFTER the reconcile', async () => {
    // Exactly the "tap a remainder album" case: `fetchAlbumDetail` upserts it into
    // `albums` WITH `starred`, so the two sources stop being disjoint between reconciles.
    await replaceFavoriteAlbums(db(), [album('al1', { starred: new Date(500) })]);
    expect((await listAllStarredAlbums(db())).map((a) => a.id)).toEqual(['al1']);

    await upsertAlbums(db(), [album('al1', { starred: new Date(900) })]);

    const all = await listAllStarredAlbums(db());
    expect(all.map((a) => a.id)).toEqual(['al1']);
    // The row is still physically in the remainder — the READ hides it, not a cleanup.
    expect(
      db().getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM favorite_albums')?.n,
    ).toBe(1);
  });

  it('keeps the remainder row visible while the library row is unmarked', async () => {
    await upsertAlbums(db(), [album('al1')]);
    await replaceFavoriteAlbums(db(), [album('al1', { starred: new Date(500) })]);
    expect((await listAllStarredAlbums(db())).map((a) => a.id)).toEqual(['al1']);
  });

  it('promotes a resolved remainder row onto its library row and deletes it', async () => {
    await replaceFavoriteSongs(db(), [song('s1', { starred: new Date(700) })]);
    await upsertSongs(db(), [song('s1')]); // the library sync catches up
    await promoteResolvedFavorites(db());
    expect(
      db().getFirstSync<{ starred: number }>("SELECT starred FROM songs WHERE id='s1'")?.starred,
    ).toBe(700);
    expect(
      db().getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM favorite_songs')?.n,
    ).toBe(0);
  });
});

describe('ordering + paging', () => {
  beforeEach(async () => {
    await upsertSongs(db(), [song('lib-a'), song('lib-b')]);
    await markStarredSongs(db(), [
      { id: 'lib-a', starredAt: 400 },
      { id: 'lib-b', starredAt: 200 },
    ]);
    await replaceFavoriteSongs(db(), [
      song('rem-a', { starred: new Date(300) }),
      song('rem-b', { starred: new Date(100) }),
    ]);
  });

  it('orders newest favourite first across both halves', async () => {
    const all = await listAllStarredSongs(db());
    expect(all.map((s) => s.id)).toEqual(['lib-a', 'rem-a', 'lib-b', 'rem-b']);
  });

  it('pages the union against one shared cursor, without repeats or gaps', async () => {
    const p1 = await starredSongsPage(db(), { limit: 2 });
    expect(p1.rows.map((r) => r.id)).toEqual(['lib-a', 'rem-a']);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await starredSongsPage(db(), { limit: 2, cursor: p1.nextCursor });
    expect(p2.rows.map((r) => r.id)).toEqual(['lib-b', 'rem-b']);
    // Both halves are exhausted, so the merge reports no further page.
    expect(p2.nextCursor).toBeNull();
  });

  it('pages a library-only set (the steady state — remainder empty)', async () => {
    db().runSync('DELETE FROM favorite_songs');
    const p1 = await starredSongsPage(db(), { limit: 1 });
    expect(p1.rows.map((r) => r.id)).toEqual(['lib-a']);
    const p2 = await starredSongsPage(db(), { limit: 1, cursor: p1.nextCursor });
    expect(p2.rows.map((r) => r.id)).toEqual(['lib-b']);
  });

  it('pages a remainder-only set (the fresh-install case)', async () => {
    db().runSync('DELETE FROM songs');
    const p1 = await starredSongsPage(db(), { limit: 1 });
    expect(p1.rows.map((r) => r.id)).toEqual(['rem-a']);
    const p2 = await starredSongsPage(db(), { limit: 1, cursor: p1.nextCursor });
    expect(p2.rows.map((r) => r.id)).toEqual(['rem-b']);
  });

  it('pages a large tied set to exactly the whole-set order — no repeats, no gaps', async () => {
    // Device-untestable as "scroll a long way down and look for repeats": the failure
    // mode is a cursor that skips or re-serves a row at a page boundary, and it only
    // shows up when the two halves interleave AND share `starred` values (the id
    // tiebreak). Every 4 favourites share one timestamp here, so most pages of 7 end
    // mid-tie, straddling both halves.
    db().runSync('DELETE FROM songs');
    db().runSync('DELETE FROM favorite_songs');
    const N = 50;
    const stamp = (k: number): number => 1000 - Math.floor(k / 4);
    const lib = Array.from({ length: N }, (_, i) => song(`lib-${String(i).padStart(2, '0')}`));
    const rem = Array.from({ length: N }, (_, i) =>
      song(`rem-${String(i).padStart(2, '0')}`, { starred: new Date(stamp(i)) }),
    );
    await upsertSongs(db(), lib);
    await markStarredSongs(
      db(),
      lib.map((s, i) => ({ id: s.id, starredAt: stamp(i) })),
    );
    await replaceFavoriteSongs(db(), rem);

    // The order both reads must produce: `starred DESC, id DESC`, computed here rather
    // than taken from either read, so this is not a self-comparison.
    const expected = [...lib.map((s, i) => ({ id: s.id, k: stamp(i) })), ...rem.map((s, i) => ({ id: s.id, k: stamp(i) }))]
      .sort((a, b) => (a.k !== b.k ? b.k - a.k : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map((e) => e.id);

    expect((await listAllStarredSongs(db())).map((s) => s.id)).toEqual(expected);

    const paged: string[] = [];
    let cursor = null as Awaited<ReturnType<typeof starredSongsPage>>['nextCursor'];
    for (let guard = 0; guard < 100; guard++) {
      const page = await starredSongsPage(db(), { limit: 7, cursor });
      paged.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
      if (page.rows.length === 0 || cursor == null) break;
    }
    expect(paged).toEqual(expected);
    expect(new Set(paged).size).toBe(paged.length);
  });

  it('rehydrates the entity from the remainder envelope', async () => {
    const page = await starredSongsPage(db(), { limit: 10 });
    const rem = page.rows.find((r) => r.id === 'rem-a')!;
    expect(rem.item.title).toBe('Song rem-a');
    expect(rem.item.starred).toBeInstanceOf(Date);
    expect((rem.item.starred as Date).getTime()).toBe(300);
  });

  it('sums count + duration across both halves as SQL aggregates', async () => {
    const totals = await starredSongTotals(db());
    expect(totals.count).toBe(4);
    expect(totals.duration).toBe(400);
  });

  it('reports the union count', async () => {
    expect(await countStarredSongs(db())).toBe(4);
  });
});

describe('the downloaded filter reaches BOTH halves', () => {
  it('keeps a downloaded remainder song and drops an undownloaded one', async () => {
    await upsertSongs(db(), [song('lib-on'), song('lib-off')]);
    await markStarredSongs(db(), [
      { id: 'lib-on', starredAt: 400 },
      { id: 'lib-off', starredAt: 350 },
    ]);
    await replaceFavoriteSongs(db(), [
      song('rem-on', { starred: new Date(300) }),
      song('rem-off', { starred: new Date(200) }),
    ]);
    seedCachedSong('lib-on');
    seedCachedSong('rem-on');

    const all = await listAllStarredSongs(db(), { downloadedOnly: true });
    expect(all.map((s) => s.id)).toEqual(['lib-on', 'rem-on']);
    const totals = await starredSongTotals(db(), { downloadedOnly: true });
    expect(totals.count).toBe(2);
  });

  it('excludes a partial album unless includePartial is set', async () => {
    await upsertAlbums(db(), [album('full'), album('part')]);
    await markStarredAlbums(db(), [
      { id: 'full', starredAt: 200 },
      { id: 'part', starredAt: 100 },
    ]);
    seedCachedAlbum('full', 2, ['f1', 'f2']);
    seedCachedAlbum('part', 3, ['p1']);

    expect((await listAllStarredAlbums(db(), { downloadedOnly: true })).map((a) => a.id)).toEqual([
      'full',
    ]);
    expect(
      (await listAllStarredAlbums(db(), { downloadedOnly: true, includePartial: true })).map(
        (a) => a.id,
      ),
    ).toEqual(['full', 'part']);
  });

  // Artists are NOT downloadable. Owning a downloaded album used to promote an artist into
  // a "downloaded artists" list; it no longer does anywhere, because the Downloaded filter
  // hides artist lists outright instead of narrowing them. The reads below therefore take
  // no filter at all — `StarredArtistPageOpts` omits it so it cannot be passed and silently
  // ignored — and downloads must not change what they return.
  it('returns the whole starred artist set regardless of what is downloaded', async () => {
    await upsertArtists(db(), [artist('ar1'), artist('ar2')]);
    await markStarredArtists(db(), [
      { id: 'ar1', starredAt: 200 },
      { id: 'ar2', starredAt: 100 },
    ]);
    seedCachedAlbum('al1', 1, ['x1']);
    db().runSync('INSERT INTO cached_albums (item_id, artist_id) VALUES (?, ?)', ['al1', 'ar1']);

    const page = await starredArtistsPage(db(), { limit: 10 });
    expect(page.rows.map((r) => r.id)).toEqual(['ar1', 'ar2']);
    expect((await listAllStarredArtists(db())).map((a) => a.id)).toEqual(['ar1', 'ar2']);
  });

  it('a partial download does not hide a starred artist either', async () => {
    await upsertArtists(db(), [artist('ar1')]);
    await markStarredArtists(db(), [{ id: 'ar1', starredAt: 200 }]);
    seedCachedAlbum('al1', 3, ['p1']); // 1 of 3 tracks on disk
    db().runSync('INSERT INTO cached_albums (item_id, artist_id) VALUES (?, ?)', ['al1', 'ar1']);

    expect((await listAllStarredArtists(db())).map((a) => a.id)).toEqual(['ar1']);
  });

  it('applies the downloaded filter to a REMAINDER album, not just a library one', async () => {
    // `cached_items` has no FK to `albums`, so a favourite the library never synced can
    // still be downloaded — and offline must list it while still hiding the rest.
    await replaceFavoriteAlbums(db(), [
      album('rem-on', { starred: new Date(300) }),
      album('rem-off', { starred: new Date(200) }),
    ]);
    seedCachedAlbum('rem-on', 1, ['x1']);

    expect((await listAllStarredAlbums(db(), { downloadedOnly: true })).map((a) => a.id)).toEqual([
      'rem-on',
    ]);
  });
});

describe('membership ids + names', () => {
  it('unions marked library rows with the remainder', async () => {
    await upsertSongs(db(), [song('lib')]);
    await markStarredSongs(db(), [{ id: 'lib', starredAt: 1 }]);
    await replaceFavoriteSongs(db(), [song('rem')]);
    expect([...(await listStarredSongIds(db()))].sort()).toEqual(['lib', 'rem']);

    await upsertAlbums(db(), [album('al')]);
    await markStarredAlbums(db(), [{ id: 'al', starredAt: 1 }]);
    await replaceFavoriteAlbums(db(), [album('al-rem')]);
    expect([...(await listStarredAlbumIds(db()))].sort()).toEqual(['al', 'al-rem']);

    await upsertArtists(db(), [artist('ar')]);
    await markStarredArtists(db(), [{ id: 'ar', starredAt: 1 }]);
    await replaceFavoriteArtists(db(), [artist('ar-rem')]);
    expect([...(await listStarredArtistIds(db()))].sort()).toEqual(['ar', 'ar-rem']);
  });

  it('collects artist names from both halves', async () => {
    await upsertArtists(db(), [artist('ar1', 'ABBA')]);
    await markStarredArtists(db(), [{ id: 'ar1', starredAt: 5 }]);
    await replaceFavoriteArtists(db(), [artist('ar2', 'Beatles')]);
    expect((await listStarredArtistNames(db())).sort()).toEqual(['ABBA', 'Beatles']);
  });

  it('pages starred albums newest first', async () => {
    await upsertAlbums(db(), [album('a1'), album('a2')]);
    await markStarredAlbums(db(), [
      { id: 'a1', starredAt: 100 },
      { id: 'a2', starredAt: 300 },
    ]);
    const page = await starredAlbumsPage(db(), { limit: 10 });
    expect(page.rows.map((r) => r.id)).toEqual(['a2', 'a1']);
  });

  it('returns every starred artist whole-set, newest first', async () => {
    await upsertArtists(db(), [artist('ar1'), artist('ar2')]);
    await markStarredArtists(db(), [
      { id: 'ar1', starredAt: 100 },
      { id: 'ar2', starredAt: 300 },
    ]);
    await replaceFavoriteArtists(db(), [artist('ar3')]);
    expect((await listAllStarredArtists(db())).map((a) => a.id)).toEqual(['ar2', 'ar1', 'ar3']);
  });
});

/**
 * The SAME reader serves two orderings, chosen by the caller: the Favourites TAB is
 * "newest favourite first", the LIBRARY tab's favourites filter is A–Z on the stored
 * `sort_*` keys. Both must merge the two halves under whichever order was asked for.
 */
describe('the whole-set reads take a sort order', () => {
  /** `lib-*` land in `albums`; `rem-*` in the `favorite_albums` remainder. Starred order
   *  and name order deliberately disagree, so a read that ignored `sortOrder` would fail. */
  const seedTwoHalves = async (): Promise<void> => {
    await upsertAlbums(db(), [
      album('lib-zulu', { name: 'Zulu', artist: 'Zebra' }),
      album('lib-alpha', { name: 'Alpha', artist: 'Alpaca' }),
    ]);
    await markStarredAlbums(db(), [
      { id: 'lib-zulu', starredAt: 400 },
      { id: 'lib-alpha', starredAt: 100 },
    ]);
    await replaceFavoriteAlbums(db(), [
      album('rem-mike', { name: 'Mike', artist: 'Mongoose', starred: new Date(300) }),
      album('rem-bravo', { name: 'Bravo', artist: 'Badger', starred: new Date(200) }),
    ]);
  };

  it('defaults to newest favourite first — the Favourites TAB must not change', async () => {
    await seedTwoHalves();
    expect((await listAllStarredAlbums(db())).map((a) => a.id)).toEqual([
      'lib-zulu',
      'rem-mike',
      'rem-bravo',
      'lib-alpha',
    ]);
  });

  it('orders by title across both halves when asked', async () => {
    await seedTwoHalves();
    expect((await listAllStarredAlbums(db(), { sortOrder: 'title' })).map((a) => a.id)).toEqual([
      'lib-alpha',
      'rem-bravo',
      'rem-mike',
      'lib-zulu',
    ]);
  });

  it('orders by artist across both halves when asked', async () => {
    await seedTwoHalves();
    expect((await listAllStarredAlbums(db(), { sortOrder: 'artist' })).map((a) => a.id)).toEqual([
      'lib-alpha', // Alpaca
      'rem-bravo', // Badger
      'rem-mike', // Mongoose
      'lib-zulu', // Zebra
    ]);
  });

  it('breaks an artist tie on the title key, exactly as the browse keyset does', async () => {
    // Ids deliberately run OPPOSITE to the titles, so an order that fell through to the
    // id tiebreak instead of `sort_title` gives the other answer.
    await upsertAlbums(db(), [
      album('aaa', { name: 'Zulu', artist: 'One Band' }),
      album('zzz', { name: 'Alpha', artist: 'One Band' }),
    ]);
    await markStarredAlbums(db(), [
      { id: 'aaa', starredAt: 400 },
      { id: 'zzz', starredAt: 100 },
    ]);
    // The remainder half joins the same tie, so the JS merge has to compare the same
    // tuple the SQL did, not just the leading key.
    await replaceFavoriteAlbums(db(), [
      album('mmm', { name: 'Mike', artist: 'One Band', starred: new Date(300) }),
    ]);
    expect((await listAllStarredAlbums(db(), { sortOrder: 'artist' })).map((a) => a.id)).toEqual([
      'zzz', // alpha
      'mmm', // mike
      'aaa', // zulu
    ]);
  });

  it('applies the downloaded filter under a name order too', async () => {
    await seedTwoHalves();
    seedCachedAlbum('lib-zulu', 1, ['s1']);
    const rows = await listAllStarredAlbums(db(), { sortOrder: 'title', downloadedOnly: true });
    expect(rows.map((a) => a.id)).toEqual(['lib-zulu']);
  });

  it('orders starred artists by name when asked, and newest-first by default', async () => {
    await upsertArtists(db(), [artist('lib-z', 'Zebra'), artist('lib-a', 'Alpaca')]);
    await markStarredArtists(db(), [
      { id: 'lib-z', starredAt: 400 },
      { id: 'lib-a', starredAt: 100 },
    ]);
    await replaceFavoriteArtists(db(), [artist('rem-m', 'Mongoose')]);

    expect((await listAllStarredArtists(db())).map((a) => a.id)).toEqual([
      'lib-z',
      'lib-a',
      'rem-m',
    ]);
    expect((await listAllStarredArtists(db(), { sortOrder: 'name' })).map((a) => a.id)).toEqual([
      'lib-a',
      'rem-m',
      'lib-z',
    ]);
  });

  it('strips articles in the remainder exactly as it does in the library half', async () => {
    await upsertAlbums(db(), [album('lib-b', { name: 'Bravo', artist: 'Bravo Band' })]);
    await markStarredAlbums(db(), [{ id: 'lib-b', starredAt: 1 }]);
    await replaceFavoriteAlbums(db(), [
      album('rem-the-a', { name: 'The Alpha', artist: 'The Alpha Band', starred: new Date(2) }),
    ]);
    // "The Alpha" → "alpha", so it sorts BEFORE "bravo". Unstripped it would sort after.
    expect((await listAllStarredAlbums(db(), { sortOrder: 'title' })).map((a) => a.id)).toEqual([
      'rem-the-a',
      'lib-b',
    ]);
  });

  it('files a punctuation-leading remainder title where the scroller says it is', async () => {
    await upsertAlbums(db(), [
      album('lib-g', { name: 'Ghosts' }),
      album('lib-i', { name: 'Ivy' }),
    ]);
    await markStarredAlbums(db(), [
      { id: 'lib-g', starredAt: 1 },
      { id: 'lib-i', starredAt: 2 },
    ]);
    await replaceFavoriteAlbums(db(), [album('rem-h', { name: '"Heroes"', starred: new Date(3) })]);
    const items = await listAllStarredAlbums(db(), { sortOrder: 'title' });
    expect(items.map((a) => a.id)).toEqual(['lib-g', 'rem-h', 'lib-i']);
    // The letter the scroller files each row under is `charAt(0)` of the key SQL ordered
    // it by, so `"Heroes"` lands between G and I under H rather than in `#`.
    expect(items.map((e) => letterOfSortKey(starredSortKeyOf(e)))).toEqual(['G', 'H', 'I']);
  });
});

/**
 * The song twin of the block above. Its default is the one every play/download caller
 * reads, so it gets its own assertions rather than riding on the album ones.
 */
describe('the whole-set SONG read takes a sort order', () => {
  /** `lib-*` land in `songs`, `rem-*` in the `favorite_songs` remainder. Starred order,
   *  title order and artist order all disagree, so a read that ignored `sortOrder` — or
   *  ordered on the wrong key — fails. */
  const seedTwoHalves = async (): Promise<void> => {
    await upsertSongs(db(), [
      song('lib-zulu', { title: 'Zulu', artist: 'Alpaca' }),
      song('lib-alpha', { title: 'Alpha', artist: 'Zebra' }),
    ]);
    await markStarredSongs(db(), [
      { id: 'lib-zulu', starredAt: 400 },
      { id: 'lib-alpha', starredAt: 100 },
    ]);
    await replaceFavoriteSongs(db(), [
      song('rem-mike', { title: 'Mike', artist: 'Mongoose', starred: new Date(300) }),
      song('rem-bravo', { title: 'Bravo', artist: 'Badger', starred: new Date(200) }),
    ]);
  };

  // THE regression guard for this step: Play All, Shuffle All, tap-to-play, the CarPlay
  // queue and the `__starred__` download all call this with no `sortOrder` and every one
  // of them means "newest favourite first". Adding the option must not move that.
  it('defaults to newest favourite first — Play All and the CarPlay queue depend on it', async () => {
    await seedTwoHalves();
    expect((await listAllStarredSongs(db())).map((s) => s.id)).toEqual([
      'lib-zulu',
      'rem-mike',
      'rem-bravo',
      'lib-alpha',
    ]);
    // Same answer through the option's own absent-vs-undefined path.
    expect((await listAllStarredSongs(db(), { sortOrder: undefined })).map((s) => s.id)).toEqual([
      'lib-zulu',
      'rem-mike',
      'rem-bravo',
      'lib-alpha',
    ]);
  });

  it('orders by title across both halves when asked', async () => {
    await seedTwoHalves();
    expect((await listAllStarredSongs(db(), { sortOrder: 'title' })).map((s) => s.id)).toEqual([
      'lib-alpha',
      'rem-bravo',
      'rem-mike',
      'lib-zulu',
    ]);
  });

  it('orders by artist across both halves when asked', async () => {
    await seedTwoHalves();
    expect((await listAllStarredSongs(db(), { sortOrder: 'artist' })).map((s) => s.id)).toEqual([
      'lib-zulu', // Alpaca
      'rem-bravo', // Badger
      'rem-mike', // Mongoose
      'lib-alpha', // Zebra
    ]);
  });

  it('breaks an artist tie on the title key, exactly as the browse keyset does', async () => {
    // Ids run OPPOSITE to the titles, so an order that fell through to the id tiebreak
    // instead of `sort_title` gives the other answer.
    await upsertSongs(db(), [
      song('aaa', { title: 'Zulu', artist: 'One Band' }),
      song('zzz', { title: 'Alpha', artist: 'One Band' }),
    ]);
    await markStarredSongs(db(), [
      { id: 'aaa', starredAt: 400 },
      { id: 'zzz', starredAt: 100 },
    ]);
    await replaceFavoriteSongs(db(), [
      song('mmm', { title: 'Mike', artist: 'One Band', starred: new Date(300) }),
    ]);
    expect((await listAllStarredSongs(db(), { sortOrder: 'artist' })).map((s) => s.id)).toEqual([
      'zzz', // alpha
      'mmm', // mike
      'aaa', // zulu
    ]);
  });

  it('uses the SONG artist derivation — `artist ?? title`, not the album chain', async () => {
    // An album row would fall back to `displayArtist` first. A song must not: the row
    // renders `artist` and the scroller reads `artist`, so the key has to agree with both.
    await upsertSongs(db(), [
      song('lib-1', { title: 'One', artist: 'Zebra', displayArtist: 'Alpaca' }),
      song('lib-2', { title: 'Two', artist: 'Alpaca', displayArtist: 'Zebra' }),
    ]);
    await markStarredSongs(db(), [
      { id: 'lib-1', starredAt: 2 },
      { id: 'lib-2', starredAt: 1 },
    ]);
    await replaceFavoriteSongs(db(), [
      song('rem-1', { title: 'Three', artist: 'Mongoose', displayArtist: 'Aardvark', starred: new Date(3) }),
    ]);
    expect((await listAllStarredSongs(db(), { sortOrder: 'artist' })).map((s) => s.id)).toEqual([
      'lib-2', // Alpaca
      'rem-1', // Mongoose (NOT Aardvark)
      'lib-1', // Zebra
    ]);
  });

  it('falls back to the title when the song has no artist at all', async () => {
    await replaceFavoriteSongs(db(), [
      song('rem-z', { title: 'Zulu', starred: new Date(2) }),
      song('rem-a', { title: 'Alpha', starred: new Date(1) }),
    ]);
    expect((await listAllStarredSongs(db(), { sortOrder: 'artist' })).map((s) => s.id)).toEqual([
      'rem-a',
      'rem-z',
    ]);
  });

  it('applies the downloaded filter under a name order too', async () => {
    await seedTwoHalves();
    seedCachedSong('lib-alpha');
    seedCachedSong('rem-mike');
    expect(
      (await listAllStarredSongs(db(), { sortOrder: 'title', downloadedOnly: true })).map((s) => s.id),
    ).toEqual(['lib-alpha', 'rem-mike']);
  });

  it('files a punctuation-leading remainder title where the scroller says it is', async () => {
    await upsertSongs(db(), [song('lib-g', { title: 'Ghosts' }), song('lib-i', { title: 'Ivy' })]);
    await markStarredSongs(db(), [
      { id: 'lib-g', starredAt: 1 },
      { id: 'lib-i', starredAt: 2 },
    ]);
    await replaceFavoriteSongs(db(), [song('rem-h', { title: '"Heroes"', starred: new Date(3) })]);
    const items = await listAllStarredSongs(db(), { sortOrder: 'title' });
    expect(items.map((s) => s.id)).toEqual(['lib-g', 'rem-h', 'lib-i']);
    expect(items.map((e) => letterOfSortKey(starredSortKeyOf(e)))).toEqual(['G', 'H', 'I']);
  });

  it('strips the leading article, so `A Horse With No Name` files under H', async () => {
    // `A` is NOT in `DEFAULT_IGNORED_ARTICLES` (it collides with the English preposition),
    // so this only files under H on a server that ships it in `ignoredArticles` — which is
    // exactly the config the defect was reported on. Both halves must read the SAME list.
    setSortArticles(['the', 'a']);
    try {
      await upsertSongs(db(), [song('lib-g', { title: 'Ghosts' }), song('lib-i', { title: 'Ivy' })]);
      await markStarredSongs(db(), [
        { id: 'lib-g', starredAt: 1 },
        { id: 'lib-i', starredAt: 2 },
      ]);
      await replaceFavoriteSongs(db(), [
        song('rem-h', { title: 'A Horse With No Name', starred: new Date(3) }),
      ]);
      const items = await listAllStarredSongs(db(), { sortOrder: 'title' });
      expect(items.map((s) => s.id)).toEqual(['lib-g', 'rem-h', 'lib-i']);
      expect(items.map((e) => letterOfSortKey(starredSortKeyOf(e)))).toEqual(['G', 'H', 'I']);
      expect(letterOfSortKey(getSortKey('A Horse With No Name', undefined, ['the', 'a']))).toBe('H');
    } finally {
      setSortArticles(undefined);
    }
  });

  it('honours a server `sortName` on the remainder, as the library half does', async () => {
    // The other route to the same place, and the one that needs no server config: the
    // envelope carries a server-STRIPPED `sortName`, which `getSortKey` prefers over the
    // raw title. (The comma-suffix shape, `"…, A"`, is deliberately ignored.)
    await upsertSongs(db(), [song('lib-g', { title: 'Ghosts' }), song('lib-i', { title: 'Ivy' })]);
    await markStarredSongs(db(), [
      { id: 'lib-g', starredAt: 1 },
      { id: 'lib-i', starredAt: 2 },
    ]);
    await replaceFavoriteSongs(db(), [
      song('rem-h', {
        title: 'A Horse With No Name',
        sortName: 'Horse With No Name',
        starred: new Date(3),
      }),
    ]);
    const items = await listAllStarredSongs(db(), { sortOrder: 'title' });
    expect(items.map((s) => s.id)).toEqual(['lib-g', 'rem-h', 'lib-i']);
    expect(items.map((e) => letterOfSortKey(starredSortKeyOf(e)))).toEqual(['G', 'H', 'I']);
  });
});

describe('the remainder tables carry the sort keys', () => {
  it('writes them from the SAME envelope, through the album derivation', async () => {
    await replaceFavoriteAlbums(db(), [
      album('r1', { name: 'The Wall', artist: 'Tagged', displayArtist: 'Displayed' }),
    ]);
    const row = await db().getFirstAsync<{ sort_title: string; sort_artist: string }>(
      'SELECT sort_title, sort_artist FROM favorite_albums WHERE id = ?',
      ['r1'],
    );
    // `displayArtist ?? artist` — the ALBUM derivation, not the song one.
    expect(row).toEqual({ sort_title: 'wall', sort_artist: 'displayed' });
  });

  it('matches what the library table stores for the same album', async () => {
    const a = album('same', { name: 'The Wall', artist: 'Pink Floyd' });
    await upsertAlbums(db(), [a]);
    await replaceFavoriteAlbums(db(), [a]);
    const lib = await db().getFirstAsync<{ sort_title: string; sort_artist: string }>(
      'SELECT sort_title, sort_artist FROM albums WHERE id = ?',
      ['same'],
    );
    const rem = await db().getFirstAsync<{ sort_title: string; sort_artist: string }>(
      'SELECT sort_title, sort_artist FROM favorite_albums WHERE id = ?',
      ['same'],
    );
    expect(rem).toEqual(lib);
  });

  it('writes the artist key too', async () => {
    await replaceFavoriteArtists(db(), [artist('r1', 'The Beatles')]);
    const row = await db().getFirstAsync<{ sort_title: string }>(
      'SELECT sort_title FROM favorite_artists WHERE id = ?',
      ['r1'],
    );
    expect(row?.sort_title).toBe('beatles');
  });

  it('writes the SONG keys from the same envelope, through the song derivation', async () => {
    await replaceFavoriteSongs(db(), [
      song('r1', { title: 'The Wall', artist: 'Tagged', displayArtist: 'Displayed' }),
    ]);
    const row = await db().getFirstAsync<{ sort_title: string; sort_artist: string }>(
      'SELECT sort_title, sort_artist FROM favorite_songs WHERE id = ?',
      ['r1'],
    );
    // `artist ?? title` — the SONG derivation. `displayArtist` is the album chain's.
    expect(row).toEqual({ sort_title: 'wall', sort_artist: 'tagged' });
  });

  it('matches what the library table stores for the same song', async () => {
    const s = song('same', { title: 'The Wall', artist: 'Pink Floyd' });
    await upsertSongs(db(), [s]);
    await replaceFavoriteSongs(db(), [s]);
    const lib = await db().getFirstAsync<{ sort_title: string; sort_artist: string }>(
      'SELECT sort_title, sort_artist FROM songs WHERE id = ?',
      ['same'],
    );
    const rem = await db().getFirstAsync<{ sort_title: string; sort_artist: string }>(
      'SELECT sort_title, sort_artist FROM favorite_songs WHERE id = ?',
      ['same'],
    );
    expect(rem).toEqual(lib);
  });
});

describe('randomStarredSong', () => {
  it('returns null when nothing is starred', async () => {
    expect(await randomStarredSong(db())).toBeNull();
  });

  it('picks from the library half', async () => {
    await upsertSongs(db(), [song('s1', { title: 'Only' })]);
    await markStarredSongs(db(), [{ id: 's1', starredAt: 10 }]);
    expect(await randomStarredSong(db())).toEqual({ id: 's1', title: 'Only' });
  });

  it('picks from the remainder half', async () => {
    await replaceFavoriteSongs(db(), [song('r1', { title: 'Remainder' })]);
    expect(await randomStarredSong(db())).toEqual({ id: 'r1', title: 'Remainder' });
  });

  it('spans both halves over repeated picks', async () => {
    await upsertSongs(db(), [song('s1')]);
    await markStarredSongs(db(), [{ id: 's1', starredAt: 10 }]);
    await replaceFavoriteSongs(db(), [song('r1')]);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add((await randomStarredSong(db()))!.id);
    expect([...seen].sort()).toEqual(['r1', 's1']);
  });
});
