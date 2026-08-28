/**
 * downloadedMetadataService — the re-cache pass that repairs downloaded items'
 * detail (album/playlist). The key contract is the RETURN SHAPE
 * `{ attempted, remaining }`, measured from actual store presence after the
 * pass — the backfill trigger uses `remaining` to resume-until-complete without
 * looping forever, so it must be exact for progress / no-progress / already-
 * cached cases. `runPool` is exercised for real (a pure util).
 *
 * State objects are `mock`-prefixed so jest.mock factories may close over them.
 */

const mockOfflineState = { offlineMode: false };
const mockRefreshState = {
  active: false,
  start: jest.fn(),
  tick: jest.fn(),
  finish: jest.fn(),
};
const mockCacheState = {
  cachedItems: {} as Record<string, { type: string; parentAlbumId?: string; songIds?: string[] }>,
  cachedSongs: {} as Record<string, { id: string; albumId?: string | null }>,
};
const mockAlbumState = { albums: {} as Record<string, unknown> };
const mockPlaylistState = { playlists: {} as Record<string, unknown> };

// A fetch populates the store (success) unless the id is flagged to fail —
// mirroring `fetchAlbum` resolving null on a timeout/error without throwing.
const mockFailIds = new Set<string>();
const mockFetchAlbum = jest.fn(async (id: string, _opts?: { prefetchCovers?: boolean }) => {
  if (!mockFailIds.has(id)) mockAlbumState.albums[id] = { id, song: [] };
  return mockAlbumState.albums[id] ?? null;
});
const mockFetchPlaylist = jest.fn(async (id: string, _opts?: { prefetchCovers?: boolean }) => {
  if (!mockFailIds.has(id)) mockPlaylistState.playlists[id] = { id, entry: [] };
  return mockPlaylistState.playlists[id] ?? null;
});

jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: () => mockOfflineState },
}));
jest.mock('../../store/downloadedMetadataRefreshStore', () => ({
  downloadedMetadataRefreshStore: { getState: () => mockRefreshState },
}));
jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: { getState: () => mockCacheState },
}));
// The service now fetches detail via the shared normalized detailFetchService; the mocks
// delegate to the same fetch fns (and mocking this module keeps imageCacheService's
// module-level offline subscription out of the test graph).
jest.mock('../detailFetchService', () => ({
  fetchAlbumDetail: (id: string, opts?: { prefetchCovers?: boolean }) => mockFetchAlbum(id, opts),
  fetchPlaylistDetail: (id: string, opts?: { prefetchCovers?: boolean }) => mockFetchPlaylist(id, opts),
}));

jest.mock('../../store/persistence/db', () => ({ getDb: () => ({}) }));

// The normalized presence checks derive from the same album/playlist state the fetch
// mocks populate, so the "has detail cached" gate + remaining-count behave as before.
jest.mock('../../db/repository/songs', () => ({
  albumIdsWithSongs: jest.fn(
    async (_db: unknown, ids: string[]) => new Set(ids.filter((id) => mockAlbumState.albums[id])),
  ),
}));
jest.mock('../../db/repository/playlists', () => ({
  playlistIdsWithSongs: jest.fn(
    async (_db: unknown, ids: string[]) =>
      new Set(ids.filter((id) => mockPlaylistState.playlists[id])),
  ),
}));

import { refreshDownloadedMetadata } from '../downloadedMetadataService';

beforeEach(() => {
  mockOfflineState.offlineMode = false;
  mockRefreshState.active = false;
  mockRefreshState.start.mockClear();
  mockRefreshState.tick.mockClear();
  mockRefreshState.finish.mockClear();
  mockCacheState.cachedItems = {};
  mockCacheState.cachedSongs = {};
  mockAlbumState.albums = {};
  mockPlaylistState.playlists = {};
  mockFailIds.clear();
  mockFetchAlbum.mockClear();
  mockFetchPlaylist.mockClear();
});

describe('refreshDownloadedMetadata — outcome shape', () => {
  it('no-op {0,0} when offline (never fetches)', async () => {
    mockOfflineState.offlineMode = true;
    mockCacheState.cachedItems = { a1: { type: 'album' } };
    const out = await refreshDownloadedMetadata({ mode: 'missing' });
    expect(out).toEqual({ attempted: 0, remaining: 0 });
    expect(mockFetchAlbum).not.toHaveBeenCalled();
  });

  it('no-op {0,0} when a refresh is already active', async () => {
    mockRefreshState.active = true;
    mockCacheState.cachedItems = { a1: { type: 'album' } };
    const out = await refreshDownloadedMetadata({ mode: 'missing' });
    expect(out).toEqual({ attempted: 0, remaining: 0 });
    expect(mockFetchAlbum).not.toHaveBeenCalled();
  });

  it('all fetched: remaining 0 (complete)', async () => {
    mockCacheState.cachedItems = {
      a1: { type: 'album' },
      a2: { type: 'album' },
      p1: { type: 'playlist' },
    };
    const out = await refreshDownloadedMetadata({ mode: 'missing' });
    expect(out).toEqual({ attempted: 3, remaining: 0 });
    expect(mockFetchAlbum).toHaveBeenCalledTimes(2);
    expect(mockFetchPlaylist).toHaveBeenCalledTimes(1);
  });

  it('partial failure: remaining counts only the still-missing (progress)', async () => {
    mockCacheState.cachedItems = {
      a1: { type: 'album' },
      a2: { type: 'album' },
      p1: { type: 'playlist' },
    };
    mockFailIds.add('a2'); // a2 fetch resolves without populating the store
    const out = await refreshDownloadedMetadata({ mode: 'missing' });
    // attempted 3, only a2 still missing → remaining 1, and remaining < attempted
    expect(out).toEqual({ attempted: 3, remaining: 1 });
  });

  it('all fail: remaining === attempted (no progress → caller bounds the loop)', async () => {
    mockCacheState.cachedItems = { a1: { type: 'album' }, a2: { type: 'album' } };
    mockFailIds.add('a1');
    mockFailIds.add('a2');
    const out = await refreshDownloadedMetadata({ mode: 'missing' });
    expect(out).toEqual({ attempted: 2, remaining: 2 });
  });

  it('missing mode skips items whose detail is already cached', async () => {
    mockCacheState.cachedItems = { a1: { type: 'album' }, a2: { type: 'album' } };
    mockAlbumState.albums = { a1: { id: 'a1', song: [] } }; // a1 already present
    const out = await refreshDownloadedMetadata({ mode: 'missing' });
    expect(out).toEqual({ attempted: 1, remaining: 0 });
    expect(mockFetchAlbum).toHaveBeenCalledTimes(1);
    expect(mockFetchAlbum).toHaveBeenCalledWith('a2', { prefetchCovers: true, force: false });
  });

  it('all mode re-fetches even already-cached detail', async () => {
    mockCacheState.cachedItems = { a1: { type: 'album' } };
    mockAlbumState.albums = { a1: { id: 'a1', song: [] } };
    const out = await refreshDownloadedMetadata({ mode: 'all' });
    expect(out).toEqual({ attempted: 1, remaining: 0 });
    expect(mockFetchAlbum).toHaveBeenCalledTimes(1);
  });

  it('resolves a song item to its parent album', async () => {
    mockCacheState.cachedItems = { s1: { type: 'song', parentAlbumId: 'albX' } };
    const out = await refreshDownloadedMetadata({ mode: 'missing' });
    expect(out).toEqual({ attempted: 1, remaining: 0 });
    expect(mockFetchAlbum).toHaveBeenCalledWith('albX', { prefetchCovers: true, force: false });
  });

  it('resolves favorites to parent albums of its songs', async () => {
    mockCacheState.cachedItems = { __starred__: { type: 'favorites', songIds: ['s1', 's2'] } };
    mockCacheState.cachedSongs = {
      s1: { id: 's1', albumId: 'albA' },
      s2: { id: 's2', albumId: 'albB' },
    };
    const out = await refreshDownloadedMetadata({ mode: 'missing' });
    expect(out).toEqual({ attempted: 2, remaining: 0 });
    expect(mockFetchAlbum).toHaveBeenCalledWith('albA', { prefetchCovers: true, force: false });
    expect(mockFetchAlbum).toHaveBeenCalledWith('albB', { prefetchCovers: true, force: false });
  });
});
