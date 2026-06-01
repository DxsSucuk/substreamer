/**
 * Tests for the persistent image-download queue worker added in Phase 2
 * of the image-cache rework. See plans/2026-05-23-image-cache-queue-rework.md.
 *
 * These tests focus on the orchestration layer — enqueue → worker → state
 * transitions → cycle accounting. The actual `downloadAndCacheImage`
 * machinery (fetch + variant generation) is exercised by
 * `imageCacheService.test.ts`; here we mock it out and assert the queue
 * state transitions our new code performs.
 */

jest.mock('expo-sqlite', () => ({
  openDatabaseSync: () => ({
    getFirstSync: () => undefined,
    getAllSync: () => [],
    runSync: () => ({ changes: 0, lastInsertRowId: 0 }),
    execSync: () => {},
    withTransactionSync: (fn: () => void) => fn(),
  }),
}));

jest.mock('expo-file-system', () => ({
  File: class {},
  Directory: class {
    create = jest.fn();
    delete = jest.fn();
    get exists() { return true; }
  },
  Paths: { document: { uri: 'file:///document' } },
}));

jest.mock('expo-image-resize', () => ({
  resizeImageToFileAsync: jest.fn(),
}));

jest.mock('expo-async-fs', () => ({
  listDirectoryAsync: jest.fn(async () => []),
  getDirectorySizeAsync: jest.fn(async () => 0),
}));

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

const mockOfflineMode = { offlineMode: false };
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: {
    getState: () => mockOfflineMode,
    subscribe: () => () => {},
  },
}));

const mockConnectivity = { isInternetReachable: true, isServerReachable: true };
jest.mock('../../store/connectivityStore', () => ({
  connectivityStore: {
    getState: () => mockConnectivity,
    subscribe: jest.fn(() => () => {}),
  },
}));

jest.mock('../connectivityService', () => ({
  awaitFirstPing: () => Promise.resolve(),
}));

// imageCacheStore — minimal surface the worker reads.
const mockImageCacheState = {
  maxConcurrentImageDownloads: 1,
  recalculateFromDb: jest.fn(),
};
jest.mock('../../store/imageCacheStore', () => ({
  imageCacheStore: { getState: () => mockImageCacheState },
}));

jest.mock('../imageCacheLogger', () => ({
  logImageCache: jest.fn(),
}));

// Mock the queue table — the worker's persistence layer.
const mockQueueState: {
  rows: Array<{ coverArtId: string; scope: 'refresh-downloads' | 'refresh-all'; status: 'queued' | 'downloading' | 'error'; cycleId: string }>;
} = { rows: [] };

const mockPickNext = jest.fn(() => {
  const next = mockQueueState.rows.find((r) => r.status === 'queued');
  return next
    ? {
        coverArtId: next.coverArtId,
        scope: next.scope,
        status: next.status,
        attempts: 0,
        addedAt: 0,
        cycleId: next.cycleId,
      }
    : null;
});

const mockMarkDownloading = jest.fn((id: string) => {
  const r = mockQueueState.rows.find((x) => x.coverArtId === id);
  if (r) r.status = 'downloading';
});
const mockMarkError = jest.fn((id: string, _err: string) => {
  const r = mockQueueState.rows.find((x) => x.coverArtId === id);
  if (r) r.status = 'error';
});
const mockRemoveFromQueue = jest.fn((id: string) => {
  mockQueueState.rows = mockQueueState.rows.filter((r) => r.coverArtId !== id);
});
const mockEnqueueBulk = jest.fn((ids: readonly string[], scope: 'refresh-downloads' | 'refresh-all', cycleId: string) => {
  let inserted = 0;
  for (const id of ids) {
    if (mockQueueState.rows.some((r) => r.coverArtId === id)) continue;
    mockQueueState.rows.push({ coverArtId: id, scope, status: 'queued', cycleId });
    inserted++;
  }
  return inserted;
});
const mockClearByCycle = jest.fn((cycleId: string) => {
  const before = mockQueueState.rows.length;
  mockQueueState.rows = mockQueueState.rows.filter((r) => r.cycleId !== cycleId);
  return before - mockQueueState.rows.length;
});
const mockResetStalled = jest.fn(() => {
  let n = 0;
  for (const r of mockQueueState.rows) {
    if (r.status === 'downloading' || r.status === 'error') {
      r.status = 'queued';
      n++;
    }
  }
  return n;
});
const mockResetErrorForCycle = jest.fn((cycleId: string) => {
  let n = 0;
  for (const r of mockQueueState.rows) {
    if (r.status === 'error' && r.cycleId === cycleId) {
      r.status = 'queued';
      n++;
    }
  }
  return n;
});
const mockCountByCycle = jest.fn((cycleId: string) =>
  mockQueueState.rows.filter((r) => r.cycleId === cycleId).length,
);
const mockCountByStatus = jest.fn((status: string) =>
  mockQueueState.rows.filter((r) => r.status === status).length,
);

jest.mock('../../store/persistence/imageDownloadQueueTable', () => ({
  enqueueImagesBulk: (ids: readonly string[], scope: any, cycleId: string) => mockEnqueueBulk(ids, scope, cycleId),
  pickNextQueuedImageRow: () => mockPickNext(),
  markImageDownloading: (id: string) => mockMarkDownloading(id),
  markImageError: (id: string, err: string) => mockMarkError(id, err),
  removeImageFromQueue: (id: string) => mockRemoveFromQueue(id),
  clearImageQueueByCycle: (cycleId: string) => mockClearByCycle(cycleId),
  resetStalledImageRows: () => mockResetStalled(),
  resetErrorRowsForCycle: (cycleId: string) => mockResetErrorForCycle(cycleId),
  countImageQueueRowsByCycle: (cycleId: string) => mockCountByCycle(cycleId),
  countImageQueueRowsByStatus: (status: string) => mockCountByStatus(status),
}));

// kvStorage — back the meta with an in-test Map.
const mockKvStore = new Map<string, string>();
jest.mock('../../store/persistence/kvStorage', () => ({
  kvStorage: {
    getItem: (k: string) => mockKvStore.get(k) ?? null,
    setItem: (k: string, v: string) => { mockKvStore.set(k, v); },
    removeItem: (k: string) => { mockKvStore.delete(k); },
  },
}));

// Snapshot helpers in musicCacheTables. Two-source dedup is exercised
// via these returning predictable sets.
const mockHydrateCachedItems = jest.fn(() => ({}));
const mockHydrateCachedSongs = jest.fn(() => ({}));
jest.mock('../../store/persistence/musicCacheTables', () => ({
  hydrateCachedItems: () => mockHydrateCachedItems(),
  hydrateCachedSongs: () => mockHydrateCachedSongs(),
}));

const mockGetAllCachedCoverArtIds = jest.fn(() => [] as string[]);
jest.mock('../../store/persistence/imageCacheTable', () => ({
  // Worker reuses these for snapshot-all-cached.
  getAllCachedCoverArtIds: () => mockGetAllCachedCoverArtIds(),
  // The service file imports several other things from imageCacheTable that
  // are not exercised by these tests; stub them out as no-ops.
  bulkInsertCachedImages: jest.fn(),
  clearAllCachedImages: jest.fn(),
  deleteCachedImageVariant: jest.fn(),
  deleteCachedImagesForCoverArt: jest.fn(() => ({ files: 0 })),
  findIncompleteCovers: jest.fn(() => []),
  hasCachedImage: jest.fn(() => false),
  hydrateImageCacheAggregates: jest.fn(() => ({
    totalBytes: 0,
    imageCount: 0,
    fileCount: 0,
    incompleteCount: 0,
  })),
  listCachedImagesForBrowser: jest.fn(() => []),
  upsertCachedImage: jest.fn(),
}));

jest.mock('../subsonicService', () => ({
  ensureCoverArtAuth: jest.fn(),
  getCoverArtUrl: jest.fn(() => 'http://example/cov'),
}));

// The queue worker calls a swappable `imageDownloader` seam. Tests
// install a deterministic stub via `__setImageDownloaderForTest()` rather
// than driving `downloadAndCacheImage`'s full fetch + resize pipeline.
let mockDownloaderShouldFail = false;
const mockDownloader = jest.fn(async (_id: string) => {
  if (mockDownloaderShouldFail) throw new Error('stubbed download failure');
});

import {
  __setImageDownloaderForTest,
  cancelImageRefreshCycle,
  enqueueImageRefreshCycle,
  getImageQueueState,
  pauseImageQueue,
  processImageQueue,
  recoverStalledImageDownloads,
  resumeImageQueue,
  retryFailedImages,
} from '../imageCacheService';

__setImageDownloaderForTest(mockDownloader);

beforeEach(() => {
  mockQueueState.rows = [];
  mockKvStore.clear();
  jest.clearAllMocks();
  mockImageCacheState.maxConcurrentImageDownloads = 1;
  mockOfflineMode.offlineMode = false;
  mockConnectivity.isInternetReachable = true;
  mockConnectivity.isServerReachable = true;
  mockHydrateCachedItems.mockReturnValue({});
  mockHydrateCachedSongs.mockReturnValue({});
  mockGetAllCachedCoverArtIds.mockReturnValue([]);
  mockDownloaderShouldFail = false;
  // Re-install the downloader stub — the seam may have been reset by
  // earlier tests calling __setImageDownloaderForTest(undefined).
  __setImageDownloaderForTest(mockDownloader);
});

describe('image-queue meta accessors', () => {
  it('getImageQueueState returns the empty shape when no cycle is active', () => {
    expect(getImageQueueState()).toEqual({
      cycleId: null,
      cycleScope: null,
      cycleTotal: 0,
      processed: 0,
      failed: 0,
      isPaused: false,
    });
  });
});

describe('enqueueImageRefreshCycle', () => {
  it('refresh-downloads snapshots from cached_items + per-song covers', async () => {
    // Snapshot now keys off ENTITY IDs (itemId for cached_items,
    // albumId for cached_songs), not the server-supplied .coverArt field.
    mockHydrateCachedItems.mockReturnValue({
      'a-1': { itemId: 'a-1', type: 'album' },
      'pl-1': { itemId: 'pl-1', type: 'playlist' },
    });
    mockHydrateCachedSongs.mockReturnValue({
      's-1': { id: 's-1', albumId: 'a-2' },
      's-2': { id: 's-2', albumId: 'a-1' }, // dedups with cached_items album
    });

    const cycleId = await enqueueImageRefreshCycle('refresh-downloads');

    expect(cycleId).not.toBeNull();
    expect(mockEnqueueBulk).toHaveBeenCalledTimes(1);
    const [ids, scope] = mockEnqueueBulk.mock.calls[0];
    expect(ids).toEqual(['a-1', 'pl-1', 'a-2']);
    expect(scope).toBe('refresh-downloads');
    const meta = getImageQueueState();
    expect(meta.cycleId).toBe(cycleId);
    expect(meta.cycleScope).toBe('refresh-downloads');
    expect(meta.cycleTotal).toBe(3);
  });

  it('refresh-all snapshots from cached_images distinct cover_art_ids', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a', 'cov-b', 'cov-c']);

    const cycleId = await enqueueImageRefreshCycle('refresh-all');

    expect(cycleId).not.toBeNull();
    const [ids, scope] = mockEnqueueBulk.mock.calls[0];
    expect(ids).toEqual(['cov-a', 'cov-b', 'cov-c']);
    expect(scope).toBe('refresh-all');
  });

  it('returns null when the scope has no ids', async () => {
    const cycleId = await enqueueImageRefreshCycle('refresh-all');
    expect(cycleId).toBeNull();
    expect(mockEnqueueBulk).not.toHaveBeenCalled();
  });

  it('does not start a second cycle while one is active', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a']);
    const first = await enqueueImageRefreshCycle('refresh-all');
    // Don't drain — leave the row in 'downloading' or 'queued'
    mockQueueState.rows[0].status = 'queued'; // ensure cycle isn't complete

    // Second call returns the existing cycle id (no-op)
    mockHydrateCachedItems.mockReturnValue({ 'a-1': { type: 'album', coverArtId: 'cov-b' } });
    const second = await enqueueImageRefreshCycle('refresh-downloads');
    expect(second).toBe(first);
    expect(mockEnqueueBulk).toHaveBeenCalledTimes(1);
  });
});

describe('processImageQueue worker', () => {
  it('drains all queued rows and clears cycle metadata on completion', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a', 'cov-b']);
    await enqueueImageRefreshCycle('refresh-all');

    await processImageQueue();

    // Every row consumed; cycle metadata cleared.
    expect(mockQueueState.rows).toEqual([]);
    expect(getImageQueueState().cycleId).toBeNull();
    expect(mockMarkDownloading).toHaveBeenCalledTimes(2);
    expect(mockRemoveFromQueue).toHaveBeenCalledTimes(2);
  });

  it('writes error and increments attempts when the downloader fails repeatedly', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a']);
    mockDownloaderShouldFail = true;
    await enqueueImageRefreshCycle('refresh-all');

    await processImageQueue();

    expect(mockQueueState.rows).toHaveLength(1);
    expect(mockQueueState.rows[0].status).toBe('error');
    expect(mockMarkError).toHaveBeenCalledWith('cov-a', expect.stringContaining('Failed after retry'));
    expect(getImageQueueState().cycleId).not.toBeNull();
    // Retry-once-inline: 2 attempts per row
    expect(mockDownloader).toHaveBeenCalledTimes(2);
  });

  it('returns early when paused', async () => {
    // Seed the queue directly (no auto-kick) and the meta says paused.
    mockQueueState.rows.push({
      coverArtId: 'cov-a',
      scope: 'refresh-all',
      status: 'queued',
      cycleId: 'cyc-test',
    });
    mockKvStore.set(
      'substreamer-image-queue-meta',
      JSON.stringify({
        cycleId: 'cyc-test',
        cycleScope: 'refresh-all',
        cycleTotal: 1,
        isPaused: true,
      }),
    );

    await processImageQueue();

    expect(mockMarkDownloading).not.toHaveBeenCalled();
    expect(mockQueueState.rows).toHaveLength(1);
  });

  it('returns early when offline', async () => {
    mockOfflineMode.offlineMode = true;
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a']);
    await enqueueImageRefreshCycle('refresh-all');

    await processImageQueue();

    expect(mockMarkDownloading).not.toHaveBeenCalled();
  });

  it('returns early when server is unreachable', async () => {
    mockConnectivity.isServerReachable = false;
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a']);
    await enqueueImageRefreshCycle('refresh-all');

    await processImageQueue();

    expect(mockMarkDownloading).not.toHaveBeenCalled();
  });

  it('is idempotent — concurrent calls await the same drain', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a', 'cov-b']);
    await enqueueImageRefreshCycle('refresh-all');

    await Promise.all([processImageQueue(), processImageQueue()]);

    // Each row processed exactly once, even with concurrent processImageQueue() calls.
    expect(mockMarkDownloading).toHaveBeenCalledTimes(2);
    expect(mockDownloader).toHaveBeenCalledTimes(2); // once per row
  });
});

describe('pause / resume', () => {
  it('pauseImageQueue persists isPaused=true and resumeImageQueue clears it', () => {
    pauseImageQueue();
    expect(getImageQueueState().isPaused).toBe(true);
    resumeImageQueue();
    expect(getImageQueueState().isPaused).toBe(false);
  });

  it('pause survives a meta re-read (i.e., simulated app restart)', () => {
    pauseImageQueue();
    // Trigger a fresh read by clearing the in-process memo (the function
    // reads kvStorage every time, so this is implicit). Just call again.
    expect(getImageQueueState().isPaused).toBe(true);
  });
});

describe('cancel', () => {
  it('drops the cycle\'s rows and clears cycle metadata', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a', 'cov-b']);
    await enqueueImageRefreshCycle('refresh-all');
    expect(mockQueueState.rows).toHaveLength(2);

    cancelImageRefreshCycle();

    expect(mockQueueState.rows).toHaveLength(0);
    expect(getImageQueueState().cycleId).toBeNull();
  });

  it('is a no-op when no cycle is active', () => {
    expect(() => cancelImageRefreshCycle()).not.toThrow();
    expect(mockClearByCycle).not.toHaveBeenCalled();
  });
});

describe('retryFailedImages', () => {
  it('resets error rows in the current cycle back to queued', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a']);
    mockDownloaderShouldFail = true;
    await enqueueImageRefreshCycle('refresh-all');
    await processImageQueue();
    expect(mockQueueState.rows[0].status).toBe('error');

    // Now retry — but make the next pass succeed.
    mockDownloaderShouldFail = false;
    retryFailedImages();
    // retryFailedImages kicks the worker via void; flush the event loop.
    await new Promise((r) => setTimeout(r, 0));

    expect(mockResetErrorForCycle).toHaveBeenCalled();
  });

  it('is a no-op when no cycle is active', () => {
    expect(() => retryFailedImages()).not.toThrow();
    expect(mockResetErrorForCycle).not.toHaveBeenCalled();
  });
});

describe('recoverStalledImageDownloads', () => {
  it('resets downloading + error rows to queued', async () => {
    mockQueueState.rows.push(
      { coverArtId: 'cov-a', scope: 'refresh-all', status: 'downloading', cycleId: 'cyc-1' },
      { coverArtId: 'cov-b', scope: 'refresh-all', status: 'error', cycleId: 'cyc-1' },
      { coverArtId: 'cov-c', scope: 'refresh-all', status: 'queued', cycleId: 'cyc-1' },
    );

    await recoverStalledImageDownloads();

    expect(mockQueueState.rows.every((r) => r.status === 'queued')).toBe(true);
    expect(mockResetStalled).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when queue is empty', async () => {
    await recoverStalledImageDownloads();
    expect(mockResetStalled).toHaveBeenCalledTimes(1); // it still calls, just returns 0
  });
});

describe('getImageQueueState — progress derivation', () => {
  it('returns zeros when no cycle', () => {
    const s = getImageQueueState();
    expect(s.processed).toBe(0);
    expect(s.cycleTotal).toBe(0);
    expect(s.failed).toBe(0);
  });

  it('computes processed = total - (queued + downloading)', async () => {
    mockGetAllCachedCoverArtIds.mockReturnValue(['cov-a', 'cov-b', 'cov-c', 'cov-d']);
    await enqueueImageRefreshCycle('refresh-all');

    // Simulate two completed, one queued, one errored
    mockQueueState.rows[0].status = 'queued';
    mockQueueState.rows[1].status = 'error';
    // Remove the "completed" rows
    mockQueueState.rows = mockQueueState.rows.slice(0, 2);

    const s = getImageQueueState();
    expect(s.cycleTotal).toBe(4);
    expect(s.processed).toBe(3); // total 4 minus 1 still-queued = 3 attempted
    expect(s.failed).toBe(1);
  });
});
