jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);
jest.mock('../subsonicService');

import type { Child } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { countAlbums, upsertAlbums } from '../../db/repository/albums';
import { countArtists, deleteArtistsNotIn, listArtists, upsertArtists } from '../../db/repository/artists';
import { getAlbumDetail } from '../../db/repository/details';
import { countSongs, upsertSongs } from '../../db/repository/songs';
import * as favoritesRepo from '../../db/repository/favorites';
import { getDb } from '../../store/persistence/db';
import { kvStorage } from '../../store/persistence/kvStorage';
import { getApi } from '../subsonicService';
import {
  FAVORITES_PERSIST_KEY,
  importLegacyFavoritesBlob,
  readStarredIds,
  reconcileStarred,
  reconcileStarredFromServer,
  resetFavoritesSyncFlags,
} from '../favoritesSyncService';

const mockGetApi = getApi as jest.MockedFunction<typeof getApi>;
const db = () => getDb()!;

const song = (id: string, extra: Partial<Child> = {}): Child =>
  ({ id, title: `Song ${id}`, isDir: false, duration: 10, ...extra }) as Child;
const album = (id: string) => ({ id, name: `Album ${id}`, duration: 0, songCount: 0 });
const artist = (id: string) => ({ id, name: `Artist ${id}`, albumCount: 0 });

const TABLES = ['songs', 'albums', 'artists', 'favorite_songs', 'favorite_albums', 'favorite_artists'];

const writeBlob = async (payload: {
  songs?: Child[];
  albums?: ReturnType<typeof album>[];
  artists?: ReturnType<typeof artist>[];
}) => {
  await kvStorage.setItem(
    FAVORITES_PERSIST_KEY,
    JSON.stringify({ state: { songs: [], albums: [], artists: [], ...payload }, version: 0 }),
  );
};

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(async () => {
  jest.clearAllMocks();
  resetFavoritesSyncFlags();
  for (const t of TABLES) db().runSync(`DELETE FROM ${t}`);
  await kvStorage.removeItem(FAVORITES_PERSIST_KEY);
  mockGetApi.mockReturnValue({} as ReturnType<typeof getApi>);
});

describe('reconcileStarred', () => {
  it('issues ZERO inserts into songs/albums/artists', async () => {
    const upsertSpy = jest.spyOn(favoritesRepo, 'replaceFavoriteSongs');
    const before = [await countSongs(db()), await countAlbums(db()), await countArtists(db())];

    await reconcileStarred({
      songs: [song('s1')],
      albums: [album('a1')],
      artists: [artist('ar1')],
    });

    expect([await countSongs(db()), await countAlbums(db()), await countArtists(db())]).toEqual(before);
    expect(upsertSpy).toHaveBeenCalled();
    upsertSpy.mockRestore();
  });

  it('marks the ids the library has and keeps the rest in the remainder', async () => {
    await upsertSongs(db(), [song('present')]);
    await reconcileStarred({
      songs: [song('present', { starred: new Date(700) }), song('missing', { starred: new Date(600) })],
      albums: [],
      artists: [],
    });

    expect(
      db().getFirstSync<{ starred: number }>("SELECT starred FROM songs WHERE id='present'")?.starred,
    ).toBe(700);
    const rem = db().getAllSync<{ id: string; starred: number }>('SELECT id, starred FROM favorite_songs');
    expect(rem).toEqual([{ id: 'missing', starred: 600 }]);
  });

  it('recovers a starred artist the library sync deleted', async () => {
    // Device-untestable without deleting music from a real server, so it lives here.
    // A library reconcile drops artists the server no longer lists — including one the
    // user still has starred. The next favourites refresh must put it back, from the
    // remainder table, rather than losing the favourite.
    await upsertArtists(db(), [artist('ar1'), artist('keep')]);
    await reconcileStarred({ songs: [], albums: [], artists: [artist('ar1')] });
    expect(
      db().getFirstSync<{ starred: number }>("SELECT starred FROM artists WHERE id='ar1'")?.starred,
    ).not.toBeNull();
    expect(db().getAllSync('SELECT id FROM favorite_artists')).toEqual([]);

    // The server stops listing ar1 at all; the library sync prunes it. (Pruning to an
    // EMPTY keep-list is a deliberate no-op — it would wipe the table — so keep one.)
    await deleteArtistsNotIn(db(), ['keep']);
    expect(await countArtists(db())).toBe(1);

    // Still starred server-side, so the next refresh keeps it — now in the remainder.
    await reconcileStarred({ songs: [], albums: [], artists: [artist('ar1')] });
    expect(db().getAllSync<{ id: string }>('SELECT id FROM favorite_artists')).toEqual([
      { id: 'ar1' },
    ]);
    expect(await countArtists(db())).toBe(1);
  });

  it('leaves the library browse whole — every artist, and an album keeps all its tracks', async () => {
    // The "most serious of the three" failure: if the reconcile wrote favourites INTO
    // songs/albums/artists, the Artists tab would list only starred artists and an album
    // would show only its starred track. Asserted through the reads the screens use, not
    // just a row count.
    await upsertArtists(db(), [artist('ar1'), artist('ar2'), artist('ar3')]);
    await upsertAlbums(db(), [album('al1')]);
    await upsertSongs(db(), [
      { ...song('t1'), albumId: 'al1', track: 1 } as Child,
      { ...song('t2'), albumId: 'al1', track: 2 } as Child,
      { ...song('t3'), albumId: 'al1', track: 3 } as Child,
    ]);

    // One starred artist, one starred track — plus a favourite the library doesn't have,
    // which is what lands in the remainder and must stay out of the library tables.
    await reconcileStarred({
      songs: [song('t2', { starred: new Date(500) }), song('ghost', { starred: new Date(400) })],
      albums: [],
      artists: [artist('ar2')],
    });

    const artists = await listArtists(db(), { limit: 50 });
    expect(artists.rows.map((r) => r.id).sort()).toEqual(['ar1', 'ar2', 'ar3']);
    const detail = await getAlbumDetail(db(), 'al1');
    expect(detail?.songs.map((s) => s.id)).toEqual(['t1', 't2', 't3']);
    // The unsynced favourite is in the remainder and nowhere near `songs`.
    expect(db().getAllSync<{ id: string }>('SELECT id FROM favorite_songs')).toEqual([
      { id: 'ghost' },
    ]);
    expect(await countSongs(db())).toBe(3);
  });

  it('an empty payload WITH a live API clears every mark and empties the remainder', async () => {
    await upsertSongs(db(), [song('s1')]);
    await upsertAlbums(db(), [album('a1')]);
    await upsertArtists(db(), [artist('ar1')]);
    await reconcileStarred({
      songs: [song('s1', { starred: new Date(1) })],
      albums: [album('a1')],
      artists: [artist('ar1')],
    });
    await favoritesRepo.replaceFavoriteSongs(db(), [song('rem')]);

    await reconcileStarred({ songs: [], albums: [], artists: [] });

    const ids = await readStarredIds();
    expect(ids.songIds.size).toBe(0);
    expect(ids.albumIds.size).toBe(0);
    expect(ids.artistIds.size).toBe(0);
  });

  it('stamps 0 when the payload carries no starred date', async () => {
    await upsertSongs(db(), [song('s1')]);
    await reconcileStarred({ songs: [song('s1')], albums: [], artists: [] });
    expect(
      db().getFirstSync<{ starred: number }>("SELECT starred FROM songs WHERE id='s1'")?.starred,
    ).toBe(0);
  });

  it('skips entirely when there is no usable API', async () => {
    await upsertSongs(db(), [song('s1')]);
    await reconcileStarred({ songs: [song('s1', { starred: new Date(9) })], albums: [], artists: [] });

    mockGetApi.mockReturnValue(null);
    const res = await reconcileStarred({ songs: [], albums: [], artists: [] });

    expect(res).toEqual({ skipped: true });
    expect(
      db().getFirstSync<{ starred: number }>("SELECT starred FROM songs WHERE id='s1'")?.starred,
    ).toBe(9);
  });
});

describe('importLegacyFavoritesBlob', () => {
  it('replays the blob into SQL and then deletes the key', async () => {
    await upsertSongs(db(), [song('present')]);
    await writeBlob({
      songs: [song('present', { starred: new Date(400) }), song('missing', { starred: new Date(300) })],
      albums: [album('a1')],
    });

    await importLegacyFavoritesBlob();

    const ids = await readStarredIds();
    expect([...ids.songIds].sort()).toEqual(['missing', 'present']);
    expect([...ids.albumIds]).toEqual(['a1']);
    expect(await kvStorage.getItem(FAVORITES_PERSIST_KEY)).toBeNull();
  });

  it('KEEPS the blob when the reconcile skips — the offline-upgrade case', async () => {
    // This is the whole reason the import exists: an upgrader launching offline. A skip
    // resolves successfully, so an unconditional delete would destroy the only copy.
    await writeBlob({ songs: [song('s1', { starred: new Date(100) })] });
    mockGetApi.mockReturnValue(null);

    await importLegacyFavoritesBlob();

    expect(await kvStorage.getItem(FAVORITES_PERSIST_KEY)).not.toBeNull();
    expect((await readStarredIds()).songIds.size).toBe(0);

    // …and the next launch, once online, imports for real.
    mockGetApi.mockReturnValue({} as ReturnType<typeof getApi>);
    await importLegacyFavoritesBlob();
    expect([...(await readStarredIds()).songIds]).toEqual(['s1']);
    expect(await kvStorage.getItem(FAVORITES_PERSIST_KEY)).toBeNull();
  });

  it('is a no-op after the key is gone', async () => {
    await importLegacyFavoritesBlob();
    expect(await kvStorage.getItem(FAVORITES_PERSIST_KEY)).toBeNull();
    await writeBlob({ songs: [song('late')] });
    // `kvImportDone` short-circuits within the process, so a blob written afterwards is
    // not replayed until the flags are reset (logout).
    await importLegacyFavoritesBlob();
    expect((await readStarredIds()).songIds.size).toBe(0);
  });

  it('drops an unparseable blob rather than retrying it forever', async () => {
    await kvStorage.setItem(FAVORITES_PERSIST_KEY, '{not json');
    await importLegacyFavoritesBlob();
    expect(await kvStorage.getItem(FAVORITES_PERSIST_KEY)).toBeNull();
  });

  it('discards the blob without replaying it once the server has answered', async () => {
    await writeBlob({ songs: [song('stale', { starred: new Date(1) })] });
    await reconcileStarredFromServer({ songs: [], albums: [], artists: [] });

    await importLegacyFavoritesBlob();

    expect(await kvStorage.getItem(FAVORITES_PERSIST_KEY)).toBeNull();
    expect((await readStarredIds()).songIds.size).toBe(0);
  });

  it('serialises against a concurrent server reconcile — the blob never lands last', async () => {
    await upsertSongs(db(), [song('fresh')]);
    await writeBlob({ songs: [song('stale', { starred: new Date(1) })] });

    // Both start before either finishes: without the shared lock the import's
    // `serverReconciled` check is guard-then-act and the stale blob wins.
    const server = reconcileStarredFromServer({
      songs: [song('fresh', { starred: new Date(999) })],
      albums: [],
      artists: [],
    });
    const blob = importLegacyFavoritesBlob();
    await Promise.all([server, blob]);

    expect([...(await readStarredIds()).songIds]).toEqual(['fresh']);
  });

  it('re-arms after a logout resets the flags', async () => {
    await importLegacyFavoritesBlob();
    await writeBlob({ songs: [song('afterLogout')] });
    resetFavoritesSyncFlags();
    await importLegacyFavoritesBlob();
    expect([...(await readStarredIds()).songIds]).toEqual(['afterLogout']);
  });

  it('brings nothing back on the NEXT server once logout cleared the blob', async () => {
    // Cross-server logout: `resetAllStores` clears kvStorage and resets these flags, so
    // the re-armed import has no blob to replay. Server A's favourites must not surface
    // on server B — the import re-arming is exactly what would let them.
    await upsertSongs(db(), [song('serverA')]);
    await writeBlob({ songs: [song('serverA', { starred: new Date(100) })] });
    await importLegacyFavoritesBlob();
    expect([...(await readStarredIds()).songIds]).toEqual(['serverA']);

    // Logout: the tables are dropped, kvStorage is wiped, the flags are re-armed.
    for (const t of TABLES) db().runSync(`DELETE FROM ${t}`);
    await kvStorage.removeItem(FAVORITES_PERSIST_KEY);
    resetFavoritesSyncFlags();

    // Server B: one favourite of its own, and nothing of A's.
    await upsertSongs(db(), [song('serverB')]);
    await importLegacyFavoritesBlob();
    await reconcileStarredFromServer({
      songs: [song('serverB', { starred: new Date(900) })],
      albums: [],
      artists: [],
    });
    expect([...(await readStarredIds()).songIds]).toEqual(['serverB']);
  });
});

describe('readStarredIds', () => {
  it('returns empty sets when the DB is unavailable', async () => {
    const spy = jest.spyOn(require('../../store/persistence/db'), 'getDb').mockReturnValue(null);
    const ids = await readStarredIds();
    expect(ids.songIds.size + ids.albumIds.size + ids.artistIds.size).toBe(0);
    spy.mockRestore();
  });
});
