jest.mock('../persistence/kvStorage', () => {
  const mock = require('../persistence/__mocks__/kvStorage');
  // resetAllStores removes the hand-rolled settings-blob keys via the *sync*
  // adapter. Share one removeItem spy across both names so existing
  // `kvStorage.removeItem` assertions observe the production `kvStorageSync`
  // calls.
  const removeItem = jest.fn();
  return {
    ...mock,
    kvStorage: { ...mock.kvStorage, removeItem },
    kvStorageSync: { ...mock.kvStorageSync, removeItem },
    clearKvStorage: jest.fn(),
  };
});
jest.mock('../../services/subsonicService');
jest.mock('../../services/playerService', () => ({}));
jest.mock('../../services/moreOptionsService', () => ({}));
jest.mock('../../services/scrobbleService', () => ({}));
jest.mock('../../services/imageCacheService', () => ({
  ensureCached: jest.fn().mockResolvedValue(undefined),
  prefetchCoverArt: jest.fn(),
  teardownImageCache: jest.fn(),
  clearImageCache: jest.fn().mockResolvedValue(0),
}));
jest.mock('../../services/musicCacheService', () => ({
  teardownMusicCache: jest.fn(),
}));
jest.mock('../persistence/scrobbleTable', () => ({
  clearScrobbles: jest.fn(),
  insertScrobble: jest.fn(),
  replaceAllScrobbles: jest.fn(),
  hydrateScrobbles: jest.fn(() => []),
}));
jest.mock('../persistence/pendingScrobbleTable', () => ({
  clearPendingScrobbles: jest.fn(),
  insertPendingScrobble: jest.fn(),
  deletePendingScrobble: jest.fn(),
  replaceAllPendingScrobbles: jest.fn(),
}));
jest.mock('../persistence/musicCacheTables', () => ({
  clearAllMusicCacheRows: jest.fn(),
  hydrateCachedSongs: jest.fn(() => ({})),
  hydrateCachedItems: jest.fn(() => ({})),
  deleteCachedItem: jest.fn(),
  deleteCachedSong: jest.fn(),
  insertDownloadQueueItem: jest.fn(),
  markDownloadComplete: jest.fn(),
  removeCachedItemSong: jest.fn(),
  removeDownloadQueueItem: jest.fn(),
  reorderCachedItemSongs: jest.fn(),
  reorderDownloadQueue: jest.fn(),
  updateDownloadQueueItem: jest.fn(),
  upsertCachedItem: jest.fn(),
  upsertCachedSong: jest.fn(),
}));

import { kvStorage, clearKvStorage } from '../persistence';
import { getDb, __setDbForTests } from '../persistence/db';
import { clearPendingScrobbles } from '../persistence/pendingScrobbleTable';
import { clearScrobbles } from '../persistence/scrobbleTable';
import { clearAllMusicCacheRows } from '../persistence/musicCacheTables';
import { authStore } from '../authStore';
import { completedScrobbleStore } from '../completedScrobbleStore';
import { mbidOverrideStore } from '../mbidOverrideStore';
import { scrobbleExclusionStore } from '../scrobbleExclusionStore';
import { playerStore } from '../playerStore';
import { searchStore } from '../searchStore';
import { resetAllStores } from '../resetAllStores';

beforeEach(() => {
  (clearKvStorage as jest.Mock).mockClear();
  (clearScrobbles as jest.Mock).mockClear();
  (clearPendingScrobbles as jest.Mock).mockClear();
  (clearAllMusicCacheRows as jest.Mock).mockClear();
  (kvStorage.removeItem as jest.Mock).mockClear();
});

describe('resetAllStores', () => {
  it('clears SQLite storage', async () => {
    await resetAllStores();
    expect(clearKvStorage).toHaveBeenCalledTimes(1);
  });

  // `clearKvStorage()` wipes the blob→normalized ETL's one-shot flag, so any row left
  // in these tables gets re-imported into the NEXT server's library on the following
  // launch. `resetNormalizedSchema` doesn't cover them — they aren't in schema.ts.
  it('truncates the legacy blob tables (album_details + song_index + library_albums)', async () => {
    const handle = getDb()!;
    const runAsync = jest.spyOn(handle, 'runAsync');
    await resetAllStores();
    expect(runAsync.mock.calls.map((c) => c[0] as string)).toEqual(
      expect.arrayContaining([
        'DELETE FROM album_details;',
        'DELETE FROM song_index;',
        'DELETE FROM library_albums;',
      ]),
    );
    runAsync.mockRestore();
  });

  it('skips the legacy-table clear when SQLite is unavailable', async () => {
    const handle = getDb();
    __setDbForTests(null);
    await expect(resetAllStores()).resolves.toBeUndefined();
    __setDbForTests(handle);
  });

  it('truncates the scrobble_events table', async () => {
    await resetAllStores();
    expect(clearScrobbles).toHaveBeenCalledTimes(1);
  });

  it('truncates the pending_scrobble_events table', async () => {
    await resetAllStores();
    expect(clearPendingScrobbles).toHaveBeenCalledTimes(1);
  });

  it('truncates the music cache tables (cached_songs + cached_items + cached_item_songs + download_queue)', async () => {
    await resetAllStores();
    expect(clearAllMusicCacheRows).toHaveBeenCalledTimes(1);
  });

  it('removes the music cache settings blob', async () => {
    await resetAllStores();
    expect(kvStorage.removeItem).toHaveBeenCalledWith('substreamer-music-cache-settings');
  });

  it('resets persisted stores to initial state', async () => {
    // Populate stores with non-default data
    authStore.getState().setSession('https://example.com', 'user', 'pass', '1.16');
    completedScrobbleStore.setState({
      recentScrobbles: [{ id: 's1' }] as any,
    });
    mbidOverrideStore.setState({
      overrides: { 'art-1': { mbid: 'x', name: 'A' } } as any,
    });
    scrobbleExclusionStore.setState({
      excludedAlbums: { 'alb-1': { id: 'alb-1', name: 'X' } },
    });

    await resetAllStores();

    expect(authStore.getState().isLoggedIn).toBe(false);
    expect(authStore.getState().serverUrl).toBeNull();
    expect(completedScrobbleStore.getState().recentScrobbles).toEqual([]);
    expect(mbidOverrideStore.getState().overrides).toEqual({});
    expect(scrobbleExclusionStore.getState().excludedAlbums).toEqual({});
  });

  it('resets non-persisted stores to initial state', async () => {
    playerStore.setState({ currentTrack: { id: 'track-1' } as any });
    searchStore.setState({ query: 'hello' });

    await resetAllStores();

    expect(playerStore.getState().currentTrack).toBeNull();
    expect(searchStore.getState().query).toBe('');
  });
});
