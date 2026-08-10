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
// Partial: `openDbConnection` must stay real (persistence/db opens the substitute with it).
// Only `awaitDbWritesIdle` is wrapped, so the guard in front of the DROP loop is
// assertable — it is one easily-deleted line standing between logout and a
// nested-BEGIN failure that skips the rest of the teardown.
jest.mock('../../db/client', () => {
  const actual = jest.requireActual('../../db/client');
  return { ...actual, awaitDbWritesIdle: jest.fn(() => actual.awaitDbWritesIdle()) };
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

import type { AlbumID3, Child } from 'subsonic-api';

import { kvStorage, clearKvStorage } from '../persistence';
import { getDb, __setDbForTests } from '../persistence/db';
import { awaitDbWritesIdle } from '../../db/client';
import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import {
  markStarredSongs,
  replaceFavoriteAlbums,
  replaceFavoriteArtists,
  replaceFavoriteSongs,
} from '../../db/repository/favorites';
import { upsertSongs } from '../../db/repository/songs';
import { favoritesStore } from '../favoritesStore';
import { clearPendingScrobbles } from '../persistence/pendingScrobbleTable';
import { clearScrobbles } from '../persistence/scrobbleTable';
import { clearAllMusicCacheRows } from '../persistence/musicCacheTables';
import { authStore } from '../authStore';
import { completedScrobbleStore } from '../completedScrobbleStore';
import { mbidOverrideStore } from '../mbidOverrideStore';
import { scrobbleExclusionStore } from '../scrobbleExclusionStore';
import { playerStore } from '../playerStore';
import { processingOverlayStore } from '../processingOverlayStore';
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

  it('wipes the favourites — both the marks and the remainder — so server B starts clean', async () => {
    // Favourites are server-scoped and live in two places: `starred` marks on the
    // library rows and the `favorite_*` remainder tables. Logging out of server A and
    // into server B must leave neither behind.
    const handle = getDb()!;
    ensureNormalizedSchema(handle);
    await upsertSongs(handle, [{ id: 's1', title: 'A', isDir: false } as Child]);
    await markStarredSongs(handle, [{ id: 's1', starredAt: 500 }]);
    await replaceFavoriteSongs(handle, [{ id: 'rem1', title: 'B', isDir: false } as Child]);
    await replaceFavoriteAlbums(handle, [{ id: 'ral1', name: 'C' } as AlbumID3]);
    await replaceFavoriteArtists(handle, [{ id: 'rar1', name: 'D', albumCount: 0 }]);
    favoritesStore.setState({ songIds: new Set(['s1', 'rem1']), version: 3 });

    await resetAllStores();

    for (const table of ['songs', 'favorite_songs', 'favorite_albums', 'favorite_artists']) {
      expect(
        handle.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n,
      ).toBe(0);
    }
    expect(favoritesStore.getState().songIds.size).toBe(0);
  });

  it('waits for the pool to be write-idle BEFORE the DROP loop', async () => {
    // `resetNormalizedSchema`'s `BEGIN` runs on the JS thread and bypasses the pool, so
    // it hard-fails on Android if a pool transaction is still open. Ordering is the
    // whole point of the guard — asserted here because the substitute runs everything
    // synchronously and cannot reproduce the overlap itself.
    const handle = getDb()!;
    const withTransactionSync = jest.spyOn(handle, 'withTransactionSync');

    await resetAllStores();

    const idleCall = (awaitDbWritesIdle as jest.Mock).mock.invocationCallOrder[0];
    expect(idleCall).toBeDefined();
    expect(idleCall).toBeLessThan(withTransactionSync.mock.invocationCallOrder[0]);
    withTransactionSync.mockRestore();
  });

  it('carries on when the normalized-schema reset throws', async () => {
    // `resetNormalizedSchema` is a `withTransactionSync` DROP-TABLE loop; its `BEGIN`
    // hard-fails if a batch's savepoint is still open on the connection. Unguarded, that
    // threw straight out of here and everything after it — scrobbles, the music cache,
    // the image cache, the store resets — silently never ran, so the next login saw the
    // previous server's data.
    const handle = getDb()!;
    const withTransactionSync = jest
      .spyOn(handle, 'withTransactionSync')
      .mockImplementation(() => {
        throw new Error('cannot start a transaction within a transaction');
      });
    playerStore.setState({ currentTrack: { id: 'track-1' } as any });

    await expect(resetAllStores()).resolves.toBeUndefined();

    expect(clearScrobbles).toHaveBeenCalledTimes(1);
    expect(clearAllMusicCacheRows).toHaveBeenCalledTimes(1);
    expect(playerStore.getState().currentTrack).toBeNull();
    withTransactionSync.mockRestore();
  });

  it('leaves the processing overlay alone — logout runs behind it', async () => {
    // Logout shows the overlay, then calls this. Resetting it here would blank the
    // only progress the user can see, half way through a multi-second teardown.
    processingOverlayStore.getState().show('Logging out…');

    await resetAllStores();

    expect(processingOverlayStore.getState().status).toBe('processing');
    expect(processingOverlayStore.getState().label).toBe('Logging out…');
    processingOverlayStore.getState().hide();
  });
});
