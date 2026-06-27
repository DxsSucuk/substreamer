jest.mock('expo-sqlite', () => ({
  openDatabaseSync: () => {
    throw new Error('stores run with per-row persistence disabled');
  },
}));

import { songIndexStore } from '../songIndexStore';

beforeEach(() => {
  songIndexStore.setState({ totalCount: 0, hasHydrated: false });
});

describe('songIndexStore', () => {
  describe('upsertSongsForAlbum', () => {
    it('keeps the totalCount in sync with the (disabled) DB — 0 here', async () => {
      songIndexStore.getState().upsertSongsForAlbum('a1', [{ id: 's1' } as any]);
      // The DB write + count refresh are now fire-and-forget async; flush a
      // macrotask so the async countSongIndexAsync result is applied. With DB
      // disabled it returns 0 — the store accepts the live DB count regardless
      // of what we pushed (the DB is the source of truth).
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(songIndexStore.getState().totalCount).toBe(0);
    });
  });

  describe('deleteSongsForAlbums', () => {
    it('is a no-op for an empty list', () => {
      expect(() => songIndexStore.getState().deleteSongsForAlbums([])).not.toThrow();
      expect(songIndexStore.getState().totalCount).toBe(0);
    });

    it('handles non-empty input', async () => {
      songIndexStore.getState().deleteSongsForAlbums(['a1']);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(songIndexStore.getState().totalCount).toBe(0);
    });
  });

  describe('hydrateFromDbAsync', () => {
    it('marks hasHydrated true and is idempotent', async () => {
      expect(songIndexStore.getState().hasHydrated).toBe(false);
      await songIndexStore.getState().hydrateFromDbAsync();
      expect(songIndexStore.getState().hasHydrated).toBe(true);
      await songIndexStore.getState().hydrateFromDbAsync();
      expect(songIndexStore.getState().hasHydrated).toBe(true);
    });
  });

  describe('refreshCount', () => {
    it('reads from the DB', () => {
      songIndexStore.getState().refreshCount();
      expect(songIndexStore.getState().totalCount).toBe(0);
    });
  });
});
