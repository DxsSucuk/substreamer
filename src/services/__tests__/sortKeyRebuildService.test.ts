jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

import type { AlbumID3, ArtistID3, Child, Playlist } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { upsertAlbums } from '../../db/repository/albums';
import { upsertArtists } from '../../db/repository/artists';
import {
  replaceFavoriteAlbums,
  replaceFavoriteArtists,
  replaceFavoriteSongs,
} from '../../db/repository/favorites';
import { upsertPlaylists } from '../../db/repository/playlists';
import { upsertSongs } from '../../db/repository/songs';
import { clearKvStorage, kvStorage } from '../../store/persistence';
import { __setDbForTests, getDb } from '../../store/persistence/db';
import { upsertCachedItem, upsertCachedSong } from '../../store/persistence/musicCacheTables';
import {
  __resetSortKeyRebuildForTests,
  runSortKeyRebuildIfNeeded,
} from '../sortKeyRebuildService';

const db = () => getDb()!;
const STATE_KEY = 'substreamer-sort-key-rebuild';
/** Mirrors `REBUILD_VERSION`. A cursor stamped with anything else is discarded rather
 *  than resumed into, so the resume cases below have to name the current one. */
const VERSION = 3;

const TABLES = [
  'cached_item_songs',
  'cached_albums',
  'cached_playlists',
  'cached_items',
  'cached_songs',
  'songs',
  'albums',
  'artists',
  'playlists',
  'favorite_albums',
  'favorite_artists',
  'favorite_songs',
];

const album = (id: string, name: string, artist?: string): AlbumID3 =>
  ({ id, name, artist, duration: 0, songCount: 0 }) as AlbumID3;
const song = (id: string, title: string, artist?: string): Child =>
  ({ id, title, artist, isDir: false, duration: 1 }) as Child;
const artistOf = (id: string, name: string): ArtistID3 => ({ id, name, albumCount: 1 });
const playlist = (id: string, name: string): Playlist =>
  ({ id, name, songCount: 0, duration: 0 }) as Playlist;

/** Force the pre-P2 key onto a row — what a build before the punctuation strip wrote. */
const setKey = (table: string, idCol: string, id: string, cols: Record<string, string | null>) => {
  const names = Object.keys(cols);
  db().runSync(
    `UPDATE ${table} SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE ${idCol} = ?`,
    [...names.map((n) => cols[n]), id],
  );
};

const readKey = <T>(sql: string, params: unknown[]): Promise<T | null> =>
  db().getFirstAsync<T>(sql, params);

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(() => {
  clearKvStorage();
  __resetSortKeyRebuildForTests();
  for (const t of TABLES) db().runSync(`DELETE FROM ${t}`);
});

describe('runSortKeyRebuildIfNeeded', () => {
  it('recomputes a stale key from the row\'s own name', async () => {
    await upsertAlbums(db(), [album('a1', '"Heroes"', 'David Bowie')]);
    // The key a pre-P2 build stored: leading quote intact, so the row filed under `#`
    // while the scroller (which computes live) says H.
    setKey('albums', 'id', 'a1', { sort_title: '"heroes"' });

    await runSortKeyRebuildIfNeeded();

    const row = await readKey<{ sort_title: string }>(
      'SELECT sort_title FROM albums WHERE id = ?',
      ['a1'],
    );
    expect(row?.sort_title).toBe('heroes"');
  });

  it('rebuilds every table that stores a key', async () => {
    await upsertAlbums(db(), [album('a1', '"Heroes"', '(The) Band')]);
    await upsertSongs(db(), [song('s1', '"Song"', '"Artist"')]);
    await upsertArtists(db(), [artistOf('ar1', '"Artist"')]);
    await upsertPlaylists(db(), [playlist('p1', '"List"')]);
    await replaceFavoriteAlbums(db(), [album('fa1', '"Fav"', '"Who"')]);
    await replaceFavoriteArtists(db(), [artistOf('far1', '"FavArtist"')]);
    await replaceFavoriteSongs(db(), [song('fs1', '"FavSong"', '"FavBand"')]);
    await upsertCachedSong({
      id: 'cs1',
      title: '"CachedSong"',
      artist: '"CachedBand"',
      albumId: 'dir',
      bytes: 1,
      duration: 1,
      suffix: 'mp3',
      formatCapturedAt: 0,
      downloadedAt: 0,
    });
    await upsertCachedItem({
      itemId: 'ci1',
      type: 'album',
      name: '"Cached"',
      expectedSongCount: 0,
      lastSyncAt: 0,
      downloadedAt: 0,
      albumMeta: { name: '"Cached"', artist: '"CachedArtist"' },
    });
    await upsertCachedItem({
      itemId: 'cp1',
      type: 'playlist',
      name: '"CachedList"',
      expectedSongCount: 0,
      lastSyncAt: 0,
      downloadedAt: 0,
      playlistMeta: { name: '"CachedList"' },
    });

    // Blank every key, so only the rebuild can put them back.
    setKey('albums', 'id', 'a1', { sort_title: null, sort_artist: null });
    setKey('songs', 'id', 's1', { sort_title: null, sort_artist: null });
    setKey('artists', 'id', 'ar1', { sort_title: null });
    setKey('playlists', 'id', 'p1', { sort_title: null });
    setKey('favorite_albums', 'id', 'fa1', { sort_title: null, sort_artist: null });
    setKey('favorite_artists', 'id', 'far1', { sort_title: null });
    setKey('favorite_songs', 'id', 'fs1', { sort_title: null, sort_artist: null });
    setKey('cached_songs', 'song_id', 'cs1', { sort_title: null, sort_artist: null });
    setKey('cached_albums', 'item_id', 'ci1', { sort_title: null, sort_artist: null });
    setKey('cached_playlists', 'item_id', 'cp1', { sort_title: null });

    await runSortKeyRebuildIfNeeded();

    expect(
      await readKey('SELECT sort_title, sort_artist FROM albums WHERE id = ?', ['a1']),
    ).toEqual({ sort_title: 'heroes"', sort_artist: 'the) band' });
    expect(await readKey('SELECT sort_title, sort_artist FROM songs WHERE id = ?', ['s1'])).toEqual(
      { sort_title: 'song"', sort_artist: 'artist"' },
    );
    expect(await readKey('SELECT sort_title FROM artists WHERE id = ?', ['ar1'])).toEqual({
      sort_title: 'artist"',
    });
    expect(await readKey('SELECT sort_title FROM playlists WHERE id = ?', ['p1'])).toEqual({
      sort_title: 'list"',
    });
    expect(
      await readKey('SELECT sort_title, sort_artist FROM favorite_albums WHERE id = ?', ['fa1']),
    ).toEqual({ sort_title: 'fav"', sort_artist: 'who"' });
    expect(await readKey('SELECT sort_title FROM favorite_artists WHERE id = ?', ['far1'])).toEqual(
      { sort_title: 'favartist"' },
    );
    expect(
      await readKey('SELECT sort_title, sort_artist FROM favorite_songs WHERE id = ?', ['fs1']),
    ).toEqual({ sort_title: 'favsong"', sort_artist: 'favband"' });
    expect(
      await readKey('SELECT sort_title, sort_artist FROM cached_songs WHERE song_id = ?', ['cs1']),
    ).toEqual({ sort_title: 'cachedsong"', sort_artist: 'cachedband"' });
    expect(
      await readKey('SELECT sort_title, sort_artist FROM cached_albums WHERE item_id = ?', ['ci1']),
    ).toEqual({ sort_title: 'cached"', sort_artist: 'cachedartist"' });
    expect(
      await readKey('SELECT sort_title FROM cached_playlists WHERE item_id = ?', ['cp1']),
    ).toEqual({ sort_title: 'cachedlist"' });
  });

  it('recomputes SORT keys only — the search derivatives are untouched', async () => {
    await upsertAlbums(db(), [album('a1', '"Heroes"', 'David Bowie')]);
    const before = await readKey(
      'SELECT norm_name, norm_artist, dmeta_name, dmeta_artist FROM albums WHERE id = ?',
      ['a1'],
    );
    await runSortKeyRebuildIfNeeded();
    expect(
      await readKey(
        'SELECT norm_name, norm_artist, dmeta_name, dmeta_artist FROM albums WHERE id = ?',
        ['a1'],
      ),
    ).toEqual(before);
  });

  it('is idempotent — a second full run changes nothing', async () => {
    await upsertAlbums(db(), [album('a1', '"Heroes"'), album('a2', 'Plain')]);
    await runSortKeyRebuildIfNeeded();
    const first = await db().getAllAsync('SELECT id, sort_title, sort_artist FROM albums ORDER BY id');

    __resetSortKeyRebuildForTests();
    await kvStorage.setItem(STATE_KEY, JSON.stringify({ version: VERSION })); // re-arm
    __resetSortKeyRebuildForTests();
    await runSortKeyRebuildIfNeeded();
    expect(await db().getAllAsync('SELECT id, sort_title, sort_artist FROM albums ORDER BY id')).toEqual(
      first,
    );
  });

  it('stamps completion and no-ops on the next launch', async () => {
    await upsertAlbums(db(), [album('a1', '"Heroes"')]);
    await runSortKeyRebuildIfNeeded();
    expect(JSON.parse((await kvStorage.getItem(STATE_KEY)) as string)).toMatchObject({
      complete: true,
    });

    // A key hand-broken AFTER completion must survive — the pass is one-shot per version.
    setKey('albums', 'id', 'a1', { sort_title: 'STALE' });
    __resetSortKeyRebuildForTests();
    await runSortKeyRebuildIfNeeded();
    expect(
      await readKey<{ sort_title: string }>('SELECT sort_title FROM albums WHERE id = ?', ['a1']),
    ).toEqual({ sort_title: 'STALE' });
  });

  it('resumes from the persisted cursor rather than restarting the table', async () => {
    await upsertAlbums(db(), [album('a1', '"One"'), album('a2', '"Two"'), album('a3', '"Three"')]);
    setKey('albums', 'id', 'a1', { sort_title: 'STALE-1' });
    setKey('albums', 'id', 'a2', { sort_title: 'STALE-2' });
    setKey('albums', 'id', 'a3', { sort_title: 'STALE-3' });

    // Interrupted mid-`albums`, having committed through `a1`.
    await kvStorage.setItem(
      STATE_KEY,
      JSON.stringify({ version: VERSION, tableIndex: 0, lastId: 'a1' }),
    );
    await runSortKeyRebuildIfNeeded();

    // `a1` is BELOW the cursor, so the resume skips it — which is the proof the cursor is
    // honoured rather than the table being rescanned from the top.
    expect(
      await readKey('SELECT sort_title FROM albums WHERE id = ?', ['a1']),
    ).toEqual({ sort_title: 'STALE-1' });
    expect(await readKey('SELECT sort_title FROM albums WHERE id = ?', ['a2'])).toEqual({
      sort_title: 'two"',
    });
    expect(await readKey('SELECT sort_title FROM albums WHERE id = ?', ['a3'])).toEqual({
      sort_title: 'three"',
    });
  });

  it('ignores a cursor left by an older key format and starts over', async () => {
    await upsertAlbums(db(), [album('a1', '"One"')]);
    setKey('albums', 'id', 'a1', { sort_title: 'STALE' });
    // A previous format's cursor: same table, past this row. Resuming into it would skip
    // `a1` forever, so it must be discarded.
    await kvStorage.setItem(STATE_KEY, JSON.stringify({ version: 1, tableIndex: 9, lastId: 'zz' }));

    await runSortKeyRebuildIfNeeded();
    expect(await readKey('SELECT sort_title FROM albums WHERE id = ?', ['a1'])).toEqual({
      sort_title: 'one"',
    });
  });

  it('chunks a table larger than one batch, walking every row', async () => {
    const many = Array.from({ length: 1100 }, (_, i) =>
      album(`b${String(i).padStart(4, '0')}`, `"Album ${i}"`),
    );
    await upsertAlbums(db(), many);
    db().runSync('UPDATE albums SET sort_title = NULL');

    await runSortKeyRebuildIfNeeded();
    const unfilled = await db().getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM albums WHERE sort_title IS NULL',
    );
    expect(unfilled?.n).toBe(0);
  });

  it('skips a remainder row Migration 40 has not converted, rather than keying off NULLs', async () => {
    await replaceFavoriteAlbums(db(), [album('fa1', 'Fine')]);
    // Exactly what `ALTER TABLE ADD COLUMN` leaves on a row written before the columns
    // existed: the stored key and the envelope, and NULL everywhere else.
    db().runSync(
      "UPDATE favorite_albums SET name = NULL, artist = NULL, display_artist = NULL, " +
        "json = '{\"id\":\"fa1\",\"name\":\"Fine\"}' WHERE id = 'fa1'",
    );
    await upsertAlbums(db(), [album('a1', '"Heroes"')]);
    setKey('albums', 'id', 'a1', { sort_title: null });

    await runSortKeyRebuildIfNeeded();
    // The unconverted row keeps the key it already had; the rest of the pass completed.
    expect(await readKey('SELECT sort_title FROM favorite_albums WHERE id = ?', ['fa1'])).toEqual({
      sort_title: 'fine',
    });
    expect(await readKey('SELECT sort_title FROM albums WHERE id = ?', ['a1'])).toEqual({
      sort_title: 'heroes"',
    });
  });

  it('is a no-op with no database, leaving the state unstamped', async () => {
    const real = getDb();
    __setDbForTests(null);
    try {
      await runSortKeyRebuildIfNeeded();
      expect(await kvStorage.getItem(STATE_KEY)).toBeNull();
    } finally {
      __setDbForTests(real);
    }
  });

  it('leaves the cursor in place when a chunk fails, so the next launch resumes', async () => {
    // Two chunks' worth, so there is a committed chunk before the failing one.
    await upsertAlbums(
      db(),
      Array.from({ length: 600 }, (_, i) => album(`b${String(i).padStart(4, '0')}`, `"A${i}"`)),
    );
    db().runSync('UPDATE albums SET sort_title = NULL');
    const real = getDb()!;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Fail on the SECOND write, so the first chunk's cursor is already persisted.
    let writes = 0;
    __setDbForTests({
      ...real,
      getAllAsync: real.getAllAsync.bind(real),
      runAtomicBatchAsync: async (c) => {
        writes += 1;
        if (writes > 1) throw new Error('write failed');
        return real.runAtomicBatchAsync(c);
      },
    } as typeof real);
    try {
      await runSortKeyRebuildIfNeeded();
      const state = JSON.parse((await kvStorage.getItem(STATE_KEY)) as string);
      expect(state.complete).toBeUndefined();
      expect(state).toMatchObject({ version: VERSION, tableIndex: 0, lastId: 'b0499' });
      expect(warn).toHaveBeenCalled();
      // The committed chunk kept its work; the failed one did not half-apply.
      const filled = await db().getFirstAsync<{ n: number }>(
        'SELECT COUNT(*) AS n FROM albums WHERE sort_title IS NOT NULL',
      );
      expect(filled?.n).toBe(500);
    } finally {
      __setDbForTests(real);
      warn.mockRestore();
    }
  });

  it('treats an unreadable state row as "never run"', async () => {
    await upsertAlbums(db(), [album('a1', '"One"')]);
    db().runSync('UPDATE albums SET sort_title = NULL');
    await kvStorage.setItem(STATE_KEY, '{ not json');
    await runSortKeyRebuildIfNeeded();
    expect(await readKey('SELECT sort_title FROM albums WHERE id = ?', ['a1'])).toEqual({
      sort_title: 'one"',
    });
  });

  it('shares one in-flight run rather than starting a second', async () => {
    await upsertAlbums(db(), [album('a1', '"Heroes"')]);
    const a = runSortKeyRebuildIfNeeded();
    const b = runSortKeyRebuildIfNeeded();
    expect(b).toBe(a);
    await a;
  });
});
