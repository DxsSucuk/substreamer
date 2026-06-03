jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));
jest.mock('../../services/subsonicService');
jest.mock('../../services/imageCacheService', () => ({
  ensureCached: jest.fn().mockResolvedValue(undefined),
  prefetchCoverArt: jest.fn(),
}));
// Skip real expo-sqlite for detailTables — the store's own behavior around
// in-memory state is what matters for these tests. Individual persistence
// operations are covered by detailTables.test.ts.
jest.mock('expo-sqlite', () => ({
  openDatabaseSync: () => {
    throw new Error('detailTables tests inject a DB; store tests run with persistence disabled');
  },
}));

import { ensureCoverArtAuth, getAlbum } from '../../services/subsonicService';
import { albumDetailStore } from '../albumDetailStore';
import { ratingStore } from '../ratingStore';

const mockGetAlbum = getAlbum as jest.MockedFunction<typeof getAlbum>;

beforeEach(() => {
  jest.clearAllMocks();
  albumDetailStore.getState().clearAlbums();
  ratingStore.getState().clearOverrides();
});

describe('albumDetailStore', () => {
  describe('fetchAlbum', () => {
    it('fetches and stores album data', async () => {
      const album = { id: 'a1', name: 'Test Album', song: [] };
      mockGetAlbum.mockResolvedValue(album as any);

      const result = await albumDetailStore.getState().fetchAlbum('a1');

      expect(ensureCoverArtAuth).toHaveBeenCalled();
      expect(mockGetAlbum).toHaveBeenCalledWith('a1');
      expect(result).toBe(album);
      expect(albumDetailStore.getState().albums['a1'].album).toBe(album);
      expect(albumDetailStore.getState().albums['a1'].retrievedAt).toBeGreaterThan(0);
    });

    it('returns null when API returns null', async () => {
      mockGetAlbum.mockResolvedValue(null);

      const result = await albumDetailStore.getState().fetchAlbum('a1');

      expect(result).toBeNull();
      expect(albumDetailStore.getState().albums['a1']).toBeUndefined();
    });

    it('preserves existing albums when fetching new one', async () => {
      const album1 = { id: 'a1', name: 'Album 1', song: [] };
      const album2 = { id: 'a2', name: 'Album 2', song: [] };
      mockGetAlbum.mockResolvedValueOnce(album1 as any).mockResolvedValueOnce(album2 as any);

      await albumDetailStore.getState().fetchAlbum('a1');
      await albumDetailStore.getState().fetchAlbum('a2');

      expect(albumDetailStore.getState().albums['a1']).toBeDefined();
      expect(albumDetailStore.getState().albums['a2']).toBeDefined();
    });

    it('reconciles ratings for album and songs with userRating', async () => {
      ratingStore.getState().setOverride('a1', 3);
      ratingStore.getState().setOverride('s1', 2);
      const album = {
        id: 'a1',
        name: 'Rated Album',
        userRating: 5,
        song: [
          { id: 's1', title: 'Song 1', userRating: 4 },
          { id: 's2', title: 'Song 2', userRating: 0 },
        ],
      };
      mockGetAlbum.mockResolvedValue(album as any);

      await albumDetailStore.getState().fetchAlbum('a1');

      expect(ratingStore.getState().overrides['a1']!.rating).toBe(5);
      expect(ratingStore.getState().overrides['s1']!.rating).toBe(4);
      // s2 had no override, so none should be created
      expect(ratingStore.getState().overrides['s2']).toBeUndefined();
    });

    it('handles album with no song property', async () => {
      const album = { id: 'a1', name: 'No Songs' };
      mockGetAlbum.mockResolvedValue(album as any);

      const result = await albumDetailStore.getState().fetchAlbum('a1');

      expect(result).toBe(album);
      expect(albumDetailStore.getState().albums['a1'].album).toBe(album);
    });

    it('handles songs without userRating', async () => {
      ratingStore.getState().setOverride('s1', 3);
      const album = {
        id: 'a1',
        name: 'Album',
        song: [{ id: 's1', title: 'Song 1' }],
      };
      mockGetAlbum.mockResolvedValue(album as any);

      await albumDetailStore.getState().fetchAlbum('a1');

      // userRating undefined → defaults to 0, override was 3 → reconciled to 0
      expect(ratingStore.getState().overrides['s1']!.rating).toBe(0);
    });
  });

  describe('clearAlbums', () => {
    it('removes all cached albums', async () => {
      mockGetAlbum.mockResolvedValue({ id: 'a1', name: 'Test', song: [] } as any);
      await albumDetailStore.getState().fetchAlbum('a1');

      albumDetailStore.getState().clearAlbums();
      expect(albumDetailStore.getState().albums).toEqual({});
    });
  });

  describe('fetchAlbum — timeout', () => {
    it('returns null when the fetch exceeds the 15s budget', async () => {
      jest.useFakeTimers();
      try {
        mockGetAlbum.mockImplementation(
          () => new Promise(() => { /* never resolves */ }),
        );

        const fetchPromise = albumDetailStore.getState().fetchAlbum('a1');
        jest.advanceTimersByTime(15_000);
        const result = await fetchPromise;

        expect(result).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('hasEntry', () => {
    it('returns false for an unknown id', () => {
      expect(albumDetailStore.getState().hasEntry('nope')).toBe(false);
    });

    it('returns true after a successful fetch', async () => {
      mockGetAlbum.mockResolvedValue({ id: 'a1', name: 'A', song: [] } as any);
      await albumDetailStore.getState().fetchAlbum('a1');
      expect(albumDetailStore.getState().hasEntry('a1')).toBe(true);
    });
  });

  describe('removeEntry', () => {
    it('removes a single entry', async () => {
      mockGetAlbum.mockResolvedValue({ id: 'a1', name: 'A', song: [] } as any);
      await albumDetailStore.getState().fetchAlbum('a1');
      albumDetailStore.getState().removeEntry('a1');
      expect(albumDetailStore.getState().albums['a1']).toBeUndefined();
    });

    it('is a no-op for an unknown id', () => {
      albumDetailStore.getState().removeEntry('nope');
      expect(albumDetailStore.getState().albums).toEqual({});
    });
  });

  describe('removeEntries', () => {
    it('removes a batch and preserves others', async () => {
      mockGetAlbum
        .mockResolvedValueOnce({ id: 'a1', name: 'A', song: [] } as any)
        .mockResolvedValueOnce({ id: 'a2', name: 'B', song: [] } as any)
        .mockResolvedValueOnce({ id: 'a3', name: 'C', song: [] } as any);
      await albumDetailStore.getState().fetchAlbum('a1');
      await albumDetailStore.getState().fetchAlbum('a2');
      await albumDetailStore.getState().fetchAlbum('a3');

      albumDetailStore.getState().removeEntries(['a1', 'a3']);
      expect(albumDetailStore.getState().albums['a1']).toBeUndefined();
      expect(albumDetailStore.getState().albums['a2']).toBeDefined();
      expect(albumDetailStore.getState().albums['a3']).toBeUndefined();
    });

    it('is a no-op for an empty list', async () => {
      mockGetAlbum.mockResolvedValue({ id: 'a1', name: 'A', song: [] } as any);
      await albumDetailStore.getState().fetchAlbum('a1');
      albumDetailStore.getState().removeEntries([]);
      expect(albumDetailStore.getState().albums['a1']).toBeDefined();
    });

    it('is a no-op when no supplied ids match', async () => {
      mockGetAlbum.mockResolvedValue({ id: 'a1', name: 'A', song: [] } as any);
      await albumDetailStore.getState().fetchAlbum('a1');
      albumDetailStore.getState().removeEntries(['x1', 'x2']);
      expect(albumDetailStore.getState().albums['a1']).toBeDefined();
    });
  });

  describe('hydrateFromDbAsync', () => {
    it('marks hasHydrated true and is idempotent', async () => {
      expect(albumDetailStore.getState().hasHydrated).toBe(false);
      await albumDetailStore.getState().hydrateFromDbAsync();
      expect(albumDetailStore.getState().hasHydrated).toBe(true);
      // Second call should not throw or duplicate work.
      await albumDetailStore.getState().hydrateFromDbAsync();
      expect(albumDetailStore.getState().hasHydrated).toBe(true);
    });
  });

  describe('applyLocalPlay', () => {
    const now = '2026-04-22T10:00:00.000Z';

    it('bumps album + matching song when both exist', async () => {
      const album = {
        id: 'a1',
        name: 'Test',
        playCount: 4,
        played: '2026-04-01T00:00:00Z',
        song: [
          { id: 's1', title: 'Song 1', playCount: 2, played: '2026-04-01T00:00:00Z' },
          { id: 's2', title: 'Song 2', playCount: 0 },
        ],
      };
      mockGetAlbum.mockResolvedValue(album as any);
      await albumDetailStore.getState().fetchAlbum('a1');

      albumDetailStore.getState().applyLocalPlay('s1', 'a1', now);

      const updated = albumDetailStore.getState().albums['a1']!.album as any;
      expect(updated.playCount).toBe(5);
      expect(updated.played).toBe(now);
      expect(updated.song[0].playCount).toBe(3);
      expect(updated.song[0].played).toBe(now);
      expect(updated.song[1].playCount).toBe(0);
      expect(updated.song[1].played).toBeUndefined();
    });

    it('treats undefined playCount as 0 before incrementing', async () => {
      const album = { id: 'a1', name: 'T', song: [{ id: 's1', title: 'S' }] };
      mockGetAlbum.mockResolvedValue(album as any);
      await albumDetailStore.getState().fetchAlbum('a1');

      albumDetailStore.getState().applyLocalPlay('s1', 'a1', now);

      const updated = albumDetailStore.getState().albums['a1']!.album as any;
      expect(updated.playCount).toBe(1);
      expect(updated.song[0].playCount).toBe(1);
      expect(updated.song[0].played).toBe(now);
    });

    it('bumps album-level stats even when the song is not in the cached song list', async () => {
      const album = {
        id: 'a1',
        name: 'T',
        playCount: 7,
        song: [{ id: 's1', title: 'S' }],
      };
      mockGetAlbum.mockResolvedValue(album as any);
      await albumDetailStore.getState().fetchAlbum('a1');

      albumDetailStore.getState().applyLocalPlay('s99', 'a1', now);

      const updated = albumDetailStore.getState().albums['a1']!.album as any;
      expect(updated.playCount).toBe(8);
      expect(updated.played).toBe(now);
      expect(updated.song[0].playCount).toBeUndefined();
    });

    it('is a no-op when albumId is undefined', async () => {
      const album = { id: 'a1', name: 'T', playCount: 4, song: [] };
      mockGetAlbum.mockResolvedValue(album as any);
      await albumDetailStore.getState().fetchAlbum('a1');
      const before = albumDetailStore.getState().albums['a1'];

      albumDetailStore.getState().applyLocalPlay('s1', undefined, now);

      // Same reference — state should not have changed.
      expect(albumDetailStore.getState().albums['a1']).toBe(before);
    });

    it('is a no-op when the album is not in the cache', () => {
      albumDetailStore.getState().applyLocalPlay('s1', 'unknown-album', now);
      expect(albumDetailStore.getState().albums['unknown-album']).toBeUndefined();
    });

    it('produces a new object reference on the mutated entry (selector identity)', async () => {
      const album = { id: 'a1', name: 'T', playCount: 1, song: [{ id: 's1', title: 'S' }] };
      mockGetAlbum.mockResolvedValue(album as any);
      await albumDetailStore.getState().fetchAlbum('a1');
      const before = albumDetailStore.getState().albums['a1'];

      albumDetailStore.getState().applyLocalPlay('s1', 'a1', now);

      const after = albumDetailStore.getState().albums['a1'];
      expect(after).not.toBe(before);
      expect(after!.album).not.toBe(before!.album);
    });
  });
});
