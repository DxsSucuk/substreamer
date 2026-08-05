jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));
jest.mock('../../services/subsonicService');
jest.mock('../../services/imageCacheService', () => ({
  ensureCached: jest.fn().mockResolvedValue(undefined),
  prefetchCoverArt: jest.fn(),
}));

import type { Child } from 'subsonic-api';

import { getApi, getStarred2 } from '../../services/subsonicService';
import { resetFavoritesSyncFlags } from '../../services/favoritesSyncService';
import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { upsertAlbums } from '../../db/repository/albums';
import { upsertArtists } from '../../db/repository/artists';
import {
  listAllStarredAlbums,
  listAllStarredArtists,
  listAllStarredSongs,
  markStarredSongs,
  replaceFavoriteSongs,
} from '../../db/repository/favorites';
import { upsertSongs } from '../../db/repository/songs';
import { getDb } from '../persistence/db';
import { syncStatusStore } from '../syncStatusStore';
import { favoritesStore } from '../favoritesStore';

const mockGetStarred2 = getStarred2 as jest.MockedFunction<typeof getStarred2>;
const mockGetApi = getApi as jest.MockedFunction<typeof getApi>;

const db = () => getDb()!;
const song = (id: string, extra: Partial<Child> = {}): Child =>
  ({ id, title: `Song ${id}`, isDir: false, duration: 10, ...extra }) as Child;

const TABLES = ['songs', 'albums', 'artists', 'favorite_songs', 'favorite_albums', 'favorite_artists'];

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(() => {
  jest.clearAllMocks();
  resetFavoritesSyncFlags();
  for (const t of TABLES) db().runSync(`DELETE FROM ${t}`);
  favoritesStore.setState({
    songIds: new Set(),
    albumIds: new Set(),
    artistIds: new Set(),
    loading: false,
    error: null,
    overrides: {},
    version: 0,
    hydrated: false,
  });
  // A usable API — the reconcile refuses to run (and must not clear anything) without one.
  mockGetApi.mockReturnValue({} as ReturnType<typeof getApi>);
  mockGetStarred2.mockResolvedValue({ songs: [], albums: [], artists: [] });
});

describe('setOverride', () => {
  it('sets optimistic override for item', () => {
    favoritesStore.getState().setOverride('album-1', true);
    expect(favoritesStore.getState().overrides['album-1']).toBe(true);

    favoritesStore.getState().setOverride('album-1', false);
    expect(favoritesStore.getState().overrides['album-1']).toBe(false);
  });

  it('supports multiple overrides simultaneously', () => {
    favoritesStore.getState().setOverride('a', true);
    favoritesStore.getState().setOverride('b', false);
    favoritesStore.getState().setOverride('c', true);
    expect(favoritesStore.getState().overrides).toEqual({ a: true, b: false, c: true });
  });
});

describe('fetchStarred', () => {
  it('clears overrides on success', async () => {
    favoritesStore.getState().setOverride('album-1', true);
    await favoritesStore.getState().fetchStarred();
    expect(favoritesStore.getState().overrides).toEqual({});
  });

  it('adopts the reconciled membership sets', async () => {
    await upsertSongs(db(), [song('s1')]);
    mockGetStarred2.mockResolvedValue({
      songs: [song('s1', { starred: new Date(500) })],
      albums: [{ id: 'a1', name: 'Album', created: new Date(), duration: 0, songCount: 0 }],
      artists: [{ id: 'ar1', name: 'Artist', albumCount: 0 }],
    });
    await favoritesStore.getState().fetchStarred();
    expect([...favoritesStore.getState().songIds]).toEqual(['s1']);
    expect([...favoritesStore.getState().albumIds]).toEqual(['a1']);
    expect([...favoritesStore.getState().artistIds]).toEqual(['ar1']);
  });

  it('marks the library row and never inserts one', async () => {
    await upsertSongs(db(), [song('s1')]);
    mockGetStarred2.mockResolvedValue({
      songs: [song('s1', { starred: new Date(500) }), song('s2', { starred: new Date(400) })],
      albums: [],
      artists: [],
    });
    await favoritesStore.getState().fetchStarred();

    const rows = db().getAllSync<{ id: string; starred: number | null }>(
      'SELECT id, starred FROM songs',
    );
    expect(rows).toEqual([{ id: 's1', starred: 500 }]);
    const remainder = db().getAllSync<{ id: string }>('SELECT id FROM favorite_songs');
    expect(remainder.map((r) => r.id)).toEqual(['s2']);
  });

  it('bumps `version` only when membership actually changed', async () => {
    await upsertSongs(db(), [song('s1')]);
    mockGetStarred2.mockResolvedValue({
      songs: [song('s1', { starred: new Date(500) })],
      albums: [],
      artists: [],
    });
    await favoritesStore.getState().fetchStarred();
    const v1 = favoritesStore.getState().version;
    const ids = favoritesStore.getState().songIds;

    await favoritesStore.getState().fetchStarred();
    expect(favoritesStore.getState().version).toBe(v1);
    // Set identity is preserved too — the `__starred__` reactor guards on it.
    expect(favoritesStore.getState().songIds).toBe(ids);
  });

  it('leaves the sets alone when the reconcile skips (no usable API)', async () => {
    await upsertSongs(db(), [song('s1')]);
    await markStarredSongs(db(), [{ id: 's1', starredAt: 500 }]);
    await favoritesStore.getState().refreshFromDb();
    expect([...favoritesStore.getState().songIds]).toEqual(['s1']);

    // Offline: `getStarred2` answers with an empty stand-in rather than throwing.
    mockGetApi.mockReturnValue(null);
    await favoritesStore.getState().fetchStarred();

    expect([...favoritesStore.getState().songIds]).toEqual(['s1']);
    expect(
      db().getFirstSync<{ starred: number }>("SELECT starred FROM songs WHERE id='s1'")?.starred,
    ).toBe(500);
    expect(favoritesStore.getState().loading).toBe(false);
  });

  it('does not reconcile when the API only came back DURING the round trip', async () => {
    // Offline at fetch time, so `getStarred2` answers with its empty stand-in; offline
    // mode is switched off while that await is in flight. Reconciling the stand-in would
    // clear every mark, so the snapshot taken before the fetch has to win.
    await upsertSongs(db(), [song('s1')]);
    await markStarredSongs(db(), [{ id: 's1', starredAt: 500 }]);
    await favoritesStore.getState().refreshFromDb();

    mockGetApi.mockReturnValue(null);
    mockGetStarred2.mockImplementation(async () => {
      mockGetApi.mockReturnValue({} as ReturnType<typeof getApi>);
      return { songs: [], albums: [], artists: [] };
    });
    await favoritesStore.getState().fetchStarred();

    expect([...favoritesStore.getState().songIds]).toEqual(['s1']);
    expect(
      db().getFirstSync<{ starred: number }>("SELECT starred FROM songs WHERE id='s1'")?.starred,
    ).toBe(500);
  });

  it('star → unstar round-trips the list AND the tab filters together', async () => {
    // The three-dots toggle re-fetches. Two readers must agree afterwards: the id sets
    // (the Songs/Albums/Artists tab filters + every heart icon) and the whole-set SQL
    // reads (the Favourites tab itself). A change landing in one but not the other is
    // the "heart says starred, the list disagrees" bug.
    await upsertSongs(db(), [song('s1')]);
    await upsertAlbums(db(), [{ id: 'al1', name: 'Album', duration: 0, songCount: 0 }]);
    await upsertArtists(db(), [{ id: 'ar1', name: 'Artist', albumCount: 0 }]);
    const starred = {
      songs: [song('s1', { starred: new Date(500) })],
      albums: [{ id: 'al1', name: 'Album', duration: 0, songCount: 0, starred: new Date(400) }],
      artists: [{ id: 'ar1', name: 'Artist', albumCount: 0, starred: new Date(300) }],
    };
    mockGetStarred2.mockResolvedValue(starred);
    await favoritesStore.getState().fetchStarred();

    const state = favoritesStore.getState();
    expect([[...state.songIds], [...state.albumIds], [...state.artistIds]]).toEqual([
      ['s1'],
      ['al1'],
      ['ar1'],
    ]);
    expect((await listAllStarredSongs(db())).map((s) => s.id)).toEqual(['s1']);
    expect((await listAllStarredAlbums(db())).map((a) => a.id)).toEqual(['al1']);
    expect((await listAllStarredArtists(db())).map((a) => a.id)).toEqual(['ar1']);

    // Unstar all three — the server stops listing them.
    mockGetStarred2.mockResolvedValue({ songs: [], albums: [], artists: [] });
    await favoritesStore.getState().fetchStarred();

    const after = favoritesStore.getState();
    expect(after.songIds.size + after.albumIds.size + after.artistIds.size).toBe(0);
    expect(await listAllStarredSongs(db())).toEqual([]);
    expect(await listAllStarredAlbums(db())).toEqual([]);
    expect(await listAllStarredArtists(db())).toEqual([]);
  });

  it('puts a newly starred song at the TOP of the list', async () => {
    // "Most recently starred first" — the newest star has to lead the list, not append
    // to it, and the tie-free case is the one a user actually sees after tapping a heart.
    await upsertSongs(db(), [song('old'), song('newer')]);
    await markStarredSongs(db(), [{ id: 'old', starredAt: 100 }]);
    mockGetStarred2.mockResolvedValue({
      songs: [
        song('old', { starred: new Date(100) }),
        song('newer', { starred: new Date(9_000) }),
      ],
      albums: [],
      artists: [],
    });
    await favoritesStore.getState().fetchStarred();
    expect((await listAllStarredSongs(db())).map((s) => s.id)).toEqual(['newer', 'old']);
  });

  it('sets error and clears loading on API failure', async () => {
    mockGetStarred2.mockRejectedValue(new Error('Network error'));
    await favoritesStore.getState().fetchStarred();
    expect(favoritesStore.getState().loading).toBe(false);
    expect(favoritesStore.getState().error).toBe('Network error');
  });

  it('sets generic error for non-Error throws', async () => {
    mockGetStarred2.mockRejectedValue('some string');
    await favoritesStore.getState().fetchStarred();
    expect(favoritesStore.getState().error).toBe('Failed to load favorites');
  });

  it('prevents duplicate concurrent fetches', async () => {
    let callCount = 0;
    mockGetStarred2.mockImplementation(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return { songs: [], albums: [], artists: [] };
    });
    const p1 = favoritesStore.getState().fetchStarred();
    const p2 = favoritesStore.getState().fetchStarred();
    await Promise.all([p1, p2]);
    expect(callCount).toBe(1);
  });

  it('does not clear overrides on failure', async () => {
    favoritesStore.getState().setOverride('album-1', true);
    mockGetStarred2.mockRejectedValue(new Error('fail'));
    await favoritesStore.getState().fetchStarred();
    expect(favoritesStore.getState().overrides['album-1']).toBe(true);
  });
});

describe('refreshFromDb', () => {
  it('reads the union of marked library rows and the remainder', async () => {
    await upsertSongs(db(), [song('lib')]);
    await markStarredSongs(db(), [{ id: 'lib', starredAt: 1 }]);
    await replaceFavoriteSongs(db(), [song('rem')]);
    await favoritesStore.getState().refreshFromDb();
    expect([...favoritesStore.getState().songIds].sort()).toEqual(['lib', 'rem']);
    expect(favoritesStore.getState().version).toBe(1);
  });

  it('is a no-op — no `set`, no version bump — when nothing moved', async () => {
    await favoritesStore.getState().refreshFromDb();
    const v = favoritesStore.getState().version;
    const listener = jest.fn();
    const unsub = favoritesStore.subscribe(listener);
    await favoritesStore.getState().refreshFromDb();
    unsub();
    expect(listener).not.toHaveBeenCalled();
    expect(favoritesStore.getState().version).toBe(v);
  });
});

describe('the post-sync promote hook', () => {
  it('promotes resolved remainder rows and repaints when the song sync completes', async () => {
    await replaceFavoriteSongs(db(), [song('s1', { starred: new Date(600) })]);
    await favoritesStore.getState().refreshFromDb();
    const v = favoritesStore.getState().version;

    // The library sync catches up: the row arrives, then the phase completes.
    await upsertSongs(db(), [song('s1')]);
    syncStatusStore.setState({ songSyncComplete: false });
    syncStatusStore.setState({ songSyncComplete: true });
    await new Promise((r) => setTimeout(r, 0));

    expect(
      db().getFirstSync<{ starred: number }>("SELECT starred FROM songs WHERE id='s1'")?.starred,
    ).toBe(600);
    expect(
      db().getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM favorite_songs')?.n,
    ).toBe(0);
    // Membership is unchanged by a promote, so `version` must NOT churn.
    expect(favoritesStore.getState().version).toBe(v);
    expect([...favoritesStore.getState().songIds]).toEqual(['s1']);
  });

  it('ignores a syncStatus write that does not flip songSyncComplete', async () => {
    await replaceFavoriteSongs(db(), [song('s1', { starred: new Date(600) })]);
    syncStatusStore.setState({ songSyncComplete: false });
    syncStatusStore.setState({ librarySyncCursor: 7 });
    await new Promise((r) => setTimeout(r, 0));
    expect(
      db().getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM favorite_songs')?.n,
    ).toBe(1);
  });
});

describe('hydrateFromDbAsync', () => {
  it('marks the store hydrated and reads membership from SQL', async () => {
    await upsertSongs(db(), [song('s1')]);
    await markStarredSongs(db(), [{ id: 's1', starredAt: 5 }]);
    await favoritesStore.getState().hydrateFromDbAsync();
    expect(favoritesStore.getState().hydrated).toBe(true);
    expect([...favoritesStore.getState().songIds]).toEqual(['s1']);
  });

  it('dedups concurrent callers onto one in-flight read', async () => {
    const a = favoritesStore.getState().hydrateFromDbAsync();
    const b = favoritesStore.getState().hydrateFromDbAsync();
    expect(a).toBe(b);
    await a;
  });
});
