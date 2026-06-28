jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

const mockGetTrackQueueStatus = jest.fn();
jest.mock('../../services/musicCacheService', () => ({
  getTrackQueueStatus: (...a: unknown[]) => (mockGetTrackQueueStatus as any)(...a),
}));

import { renderHook } from '@testing-library/react-native';

import { useDownloadStatus } from '../useDownloadStatus';
import { musicCacheStore } from '../../store/musicCacheStore';
import type { CachedItemMeta } from '../../store/musicCacheStore';

function makeItem(overrides: Partial<CachedItemMeta> = {}): CachedItemMeta {
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

beforeEach(() => {
  mockGetTrackQueueStatus.mockReset();
  musicCacheStore.setState({ cachedItems: {}, cachedSongs: {}, downloadQueue: [] } as any);
});

describe('useDownloadStatus', () => {
  it('returns "none" when id is empty', () => {
    const { result } = renderHook(() => useDownloadStatus('album', ''));
    expect(result.current).toBe('none');
  });

  describe('song', () => {
    it('returns "complete" when the song has a cached_songs row', () => {
      musicCacheStore.setState({ cachedSongs: { s1: { id: 's1' } } } as any);
      const { result } = renderHook(() => useDownloadStatus('song', 's1'));
      expect(result.current).toBe('complete');
    });

    it('returns queue status when not cached', () => {
      mockGetTrackQueueStatus.mockReturnValue('downloading');
      const { result } = renderHook(() => useDownloadStatus('song', 's1'));
      expect(result.current).toBe('downloading');
    });

    it('returns "none" for a song not cached or queued', () => {
      mockGetTrackQueueStatus.mockReturnValue(null);
      const { result } = renderHook(() => useDownloadStatus('song', 's1'));
      expect(result.current).toBe('none');
    });
  });

  describe('album', () => {
    it('returns "complete" when album has all expected songs', () => {
      musicCacheStore.setState({
        cachedItems: {
          a1: makeItem({
            songIds: Array.from({ length: 10 }, (_, i) => `s${i}`),
            expectedSongCount: 10,
          }),
        },
      } as any);
      const { result } = renderHook(() => useDownloadStatus('album', 'a1'));
      expect(result.current).toBe('complete');
    });

    it('returns "partial" when songs on disk < expected', () => {
      musicCacheStore.setState({
        cachedItems: {
          a1: makeItem({ songIds: ['s1', 's2'], expectedSongCount: 10 }),
        },
      } as any);
      const { result } = renderHook(() => useDownloadStatus('album', 'a1'));
      expect(result.current).toBe('partial');
    });

    it('returns "complete" for a real single-track album (1 of 1) — fixes #159', () => {
      // expectedSongCount is now authoritative (server-fetched at write
      // time), so a 1/1 row reflects a real single-track album. The old
      // heuristic that forced this to "partial" caused #159.
      musicCacheStore.setState({
        cachedItems: {
          a1: makeItem({ songIds: ['s1'], expectedSongCount: 1 }),
        },
      } as any);
      const { result } = renderHook(() => useDownloadStatus('album', 'a1'));
      expect(result.current).toBe('complete');
    });

    it('returns "queued" when not cached but in queue', () => {
      musicCacheStore.setState({
        cachedItems: {},
        downloadQueue: [
          { queueId: 'q', itemId: 'a1', type: 'album', status: 'queued' },
        ],
      } as any);
      const { result } = renderHook(() => useDownloadStatus('album', 'a1'));
      expect(result.current).toBe('queued');
    });

    it('returns "downloading" when queue entry is downloading', () => {
      musicCacheStore.setState({
        cachedItems: {},
        downloadQueue: [
          { queueId: 'q', itemId: 'a1', type: 'album', status: 'downloading' },
        ],
      } as any);
      const { result } = renderHook(() => useDownloadStatus('album', 'a1'));
      expect(result.current).toBe('downloading');
    });

    it('returns "none" when neither cached nor queued', () => {
      const { result } = renderHook(() => useDownloadStatus('album', 'a1'));
      expect(result.current).toBe('none');
    });
  });

  describe('playlist', () => {
    it('returns "complete" for a cached playlist (playlists never classify as partial)', () => {
      musicCacheStore.setState({
        cachedItems: {
          p1: makeItem({ type: 'playlist', songIds: ['s1'], expectedSongCount: 10 }),
        },
      } as any);
      const { result } = renderHook(() => useDownloadStatus('playlist', 'p1'));
      expect(result.current).toBe('complete');
    });
  });
});
