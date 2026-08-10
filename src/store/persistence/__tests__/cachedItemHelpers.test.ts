import {
  computeQueueItemProgress,
  isPartialAlbum,
} from '../cachedItemHelpers';
import type {
  CachedItemRow,
  DownloadQueueRow,
} from '../musicCacheTables';

function makeItem(overrides: Partial<CachedItemRow> = {}): CachedItemRow {
  return {
    itemId: 'a1',
    type: 'album',
    name: 'A',
    expectedSongCount: 10,
    lastSyncAt: 0,
    downloadedAt: 0,
    songIds: [],
    ...overrides,
  };
}

function makeQueue(overrides: Partial<DownloadQueueRow> = {}): DownloadQueueRow {
  return {
    queueId: 'q',
    itemId: 'a1',
    type: 'album',
    name: 'A',
    status: 'downloading',
    totalSongs: 10,
    completedSongs: 0,
    addedAt: 0,
    queuePosition: 1,
    ...overrides,
  };
}

describe('isPartialAlbum', () => {
  it('returns false for non-album types', () => {
    expect(isPartialAlbum(makeItem({ type: 'playlist', songIds: ['s1'], expectedSongCount: 10 }))).toBe(false);
    expect(isPartialAlbum(makeItem({ type: 'song', songIds: ['s1'], expectedSongCount: 10 }))).toBe(false);
    expect(isPartialAlbum(makeItem({ type: 'favorites', songIds: [], expectedSongCount: 10 }))).toBe(false);
  });

  it('returns true when songs on disk < expected', () => {
    expect(isPartialAlbum(makeItem({ songIds: ['s1', 's2'], expectedSongCount: 10 }))).toBe(true);
  });

  it('returns false when songs on disk == expected', () => {
    expect(isPartialAlbum(makeItem({
      songIds: Array.from({ length: 10 }, (_, i) => `s${i}`),
      expectedSongCount: 10,
    }))).toBe(false);
  });

  it('treats a real single-track album (1 of 1 downloaded) as complete', () => {
    // ensurePartialAlbumEdge now fetches the authoritative song count
    // from the server when the album-detail store is empty, so an
    // expectedSongCount of 1 always reflects a real single-track album.
    // The previous defensive heuristic that flagged this case as partial
    // is gone — it was misclassifying genuine singles.
    expect(isPartialAlbum(makeItem({ songIds: ['s1'], expectedSongCount: 1 }))).toBe(false);
  });

  it('defensive: expectedSongCount 0 with 0 songs is NOT partial (empty album edge case)', () => {
    expect(isPartialAlbum(makeItem({ songIds: [], expectedSongCount: 0 }))).toBe(false);
  });
});


describe('computeQueueItemProgress', () => {
  it('falls back to queue-row progress when itemId has no cachedItems entry (fresh download)', () => {
    const p = computeQueueItemProgress(makeQueue({ completedSongs: 3, totalSongs: 10 }), {});
    expect(p).toEqual({ completed: 3, total: 10 });
  });

  it('reports album-level progress for a top-up: existing + delta / expectedSongCount', () => {
    const cachedItems = {
      a1: makeItem({ itemId: 'a1', songIds: ['s1', 's2', 's3', 's4', 's5'], expectedSongCount: 10 }),
    };
    const queue = makeQueue({ itemId: 'a1', completedSongs: 3, totalSongs: 5 });
    expect(computeQueueItemProgress(queue, cachedItems)).toEqual({ completed: 8, total: 10 });
  });

  it('reports 5/10 at start of top-up when completedSongs is 0', () => {
    const cachedItems = {
      a1: makeItem({ itemId: 'a1', songIds: ['s1', 's2', 's3', 's4', 's5'], expectedSongCount: 10 }),
    };
    const queue = makeQueue({ itemId: 'a1', completedSongs: 0, totalSongs: 5 });
    expect(computeQueueItemProgress(queue, cachedItems)).toEqual({ completed: 5, total: 10 });
  });
});
