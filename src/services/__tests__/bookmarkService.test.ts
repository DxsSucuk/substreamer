jest.mock('../playerService', () => ({
  playTrack: jest.fn().mockResolvedValue(undefined),
  seekTo: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../queuePersistenceService', () => ({ flushPosition: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

import {
  buildAutoName,
  bucketKeyForHour,
  createBookmarkFromPlayer,
  restoreBookmark,
  bookmarkTimes,
  bookmarkQueuePosition,
  bookmarkCoverArtId,
  bookmarkCurrentTrack,
} from '../bookmarkService';
import { playTrack, seekTo } from '../playerService';
import { flushPosition } from '../queuePersistenceService';
import { bookmarksStore, type PlayQueueBookmark } from '../../store/bookmarksStore';
import { playerStore } from '../../store/playerStore';

const identity = (key: string) => key;

function track(id: string, opts: { albumId?: string; duration?: number; coverArt?: string } = {}): any {
  return { id, title: `Title ${id}`, artist: `Artist ${id}`, isDir: false, ...opts };
}

function bookmark(partial: Partial<PlayQueueBookmark>): PlayQueueBookmark {
  return {
    id: 'b',
    name: 'B',
    createdAt: 1,
    queue: [track('t1', { duration: 100 })],
    currentIndex: 0,
    positionSec: 0,
    ...partial,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  bookmarksStore.setState({ bookmarks: {}, autoName: true, sortOrder: 'newest' });
  playerStore.setState({ queue: [], currentTrack: null, currentTrackIndex: null, position: 0 });
});

describe('bucketKeyForHour', () => {
  it('maps hours to the right time-of-day bucket', () => {
    expect(bucketKeyForHour(5)).toBe('tod_earlyMorning');
    expect(bucketKeyForHour(7)).toBe('tod_earlyMorning');
    expect(bucketKeyForHour(8)).toBe('tod_midMorning');
    expect(bucketKeyForHour(12)).toBe('tod_midday');
    expect(bucketKeyForHour(13)).toBe('tod_earlyAfternoon');
    expect(bucketKeyForHour(16)).toBe('tod_afternoon');
    expect(bucketKeyForHour(18)).toBe('tod_earlyEvening');
    expect(bucketKeyForHour(19)).toBe('tod_evening');
    expect(bucketKeyForHour(21)).toBe('tod_evening');
  });

  it('wraps the late-night bucket past midnight', () => {
    expect(bucketKeyForHour(22)).toBe('tod_lateNight');
    expect(bucketKeyForHour(23)).toBe('tod_lateNight');
    expect(bucketKeyForHour(0)).toBe('tod_lateNight');
    expect(bucketKeyForHour(4)).toBe('tod_lateNight');
  });
});

describe('buildAutoName', () => {
  // Local-hour constructor keeps getHours() deterministic regardless of TZ.
  const date = new Date(2026, 4, 26, 8, 0, 0); // 08:00 local → midMorning

  it('includes the time-of-day bucket label', () => {
    const base = buildAutoName(identity, 'en-US', [], date);
    expect(base).toContain('tod_midMorning');
  });

  it('appends (2), (3) for same-window duplicates', () => {
    const base = buildAutoName(identity, 'en-US', [], date);
    expect(buildAutoName(identity, 'en-US', [base], date)).toBe(`${base} (2)`);
    expect(buildAutoName(identity, 'en-US', [base, `${base} (2)`], date)).toBe(`${base} (3)`);
  });
});

describe('whole-queue time math', () => {
  it('computes elapsed/total/remaining across the queue', () => {
    const b = bookmark({
      queue: [track('a', { duration: 100 }), track('b', { duration: 200 }), track('c', { duration: 300 })],
      currentIndex: 1,
      positionSec: 50,
    });
    const { elapsedSec, totalSec, remainingSec } = bookmarkTimes(b);
    expect(totalSec).toBe(600);
    expect(elapsedSec).toBe(150); // 100 before + 50 into current
    expect(remainingSec).toBe(450);
  });

  it('treats missing durations as zero', () => {
    const b = bookmark({ queue: [track('a'), track('b')], currentIndex: 0, positionSec: 0 });
    expect(bookmarkTimes(b)).toEqual({ elapsedSec: 0, totalSec: 0, remainingSec: 0 });
  });
});

describe('derived display helpers', () => {
  it('reports a 1-based queue position', () => {
    const b = bookmark({ queue: [track('a'), track('b'), track('c')], currentIndex: 1 });
    expect(bookmarkQueuePosition(b)).toEqual({ index: 2, total: 3 });
  });

  it('clamps an out-of-range index', () => {
    const b = bookmark({ queue: [track('a'), track('b')], currentIndex: 9 });
    expect(bookmarkQueuePosition(b)).toEqual({ index: 2, total: 2 });
  });

  it('resolves the current track cover via the song coverArt value (#202)', () => {
    // Album mode, album not in the (empty) library → falls back to the song's coverArt.
    expect(
      bookmarkCoverArtId(bookmark({ queue: [track('t', { albumId: 'al', coverArt: 'cov-al' })], currentIndex: 0 })),
    ).toBe('cov-al');
    expect(
      bookmarkCoverArtId(bookmark({ queue: [track('t', { coverArt: 'cov-t' })], currentIndex: 0 })),
    ).toBe('cov-t');
    // No coverArt anywhere → undefined (never the entity id).
    expect(bookmarkCoverArtId(bookmark({ queue: [track('t')], currentIndex: 0 }))).toBeUndefined();
  });

  it('returns the clamped current track, undefined for empty queue', () => {
    expect(bookmarkCurrentTrack(bookmark({ queue: [track('a'), track('b')], currentIndex: 1 }))?.id).toBe('b');
    expect(bookmarkCurrentTrack(bookmark({ queue: [], currentIndex: 0 }))).toBeUndefined();
  });
});

describe('createBookmarkFromPlayer', () => {
  it('snapshots the live player state and stores it', () => {
    playerStore.setState({
      queue: [track('a', { duration: 100 }), track('b', { duration: 200 })],
      currentTrack: track('b'),
      currentTrackIndex: 1,
      position: 42,
    });
    const bm = createBookmarkFromPlayer('My Spot');
    expect(bm).not.toBeNull();
    expect(bm!.id).toBe('test-uuid');
    expect(bm!.name).toBe('My Spot');
    expect(bm!.currentIndex).toBe(1);
    expect(bm!.positionSec).toBe(42);
    expect(flushPosition).toHaveBeenCalledWith(42, 'b');
    expect(bookmarksStore.getState().bookmarks['test-uuid']).toBeDefined();
  });

  it('returns null when nothing is playing (empty queue)', () => {
    expect(createBookmarkFromPlayer('x')).toBeNull();
    expect(Object.keys(bookmarksStore.getState().bookmarks)).toHaveLength(0);
  });
});

describe('restoreBookmark', () => {
  // playTrack populates playerStore.queue synchronously on success; mirror that.
  function mockPlayTrackSets(liveQueue: any[]) {
    (playTrack as jest.Mock).mockImplementation(async () => {
      playerStore.setState({ queue: liveQueue });
    });
  }

  it('replays the queue and seeks when the saved track survived into the live queue', async () => {
    const q = [track('a'), track('b'), track('c')];
    mockPlayTrackSets(q);
    await restoreBookmark(bookmark({ queue: q, currentIndex: 2, positionSec: 30 }));
    expect(playTrack).toHaveBeenCalledWith(q[2], q);
    expect(seekTo).toHaveBeenCalledWith(30);
  });

  it('does not seek when position is zero', async () => {
    const q = [track('a')];
    mockPlayTrackSets(q);
    await restoreBookmark(bookmark({ queue: q, currentIndex: 0, positionSec: 0 }));
    expect(playTrack).toHaveBeenCalledWith(q[0], q);
    expect(seekTo).not.toHaveBeenCalled();
  });

  it('does not seek when the queue was cleared (nothing playable)', async () => {
    mockPlayTrackSets([]);
    await restoreBookmark(bookmark({ queue: [track('a')], currentIndex: 0, positionSec: 30 }));
    expect(playTrack).toHaveBeenCalled();
    expect(seekTo).not.toHaveBeenCalled();
  });

  it('does not seek when the saved track was filtered out of the live queue', async () => {
    mockPlayTrackSets([track('other')]);
    await restoreBookmark(bookmark({ queue: [track('a')], currentIndex: 0, positionSec: 30 }));
    expect(seekTo).not.toHaveBeenCalled();
  });

  it('no-ops on an empty queue', async () => {
    await restoreBookmark(bookmark({ queue: [], currentIndex: 0 }));
    expect(playTrack).not.toHaveBeenCalled();
  });
});
