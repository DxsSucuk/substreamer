jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

const mockFavoritesApply = jest.fn();
const mockApplyLocalPlayToPlayer = jest.fn();

jest.mock('../../store/favoritesStore', () => ({
  favoritesStore: {
    getState: () => ({ applyLocalPlay: mockFavoritesApply }),
  },
}));

// subsonicService only contributes the type import for Child; no runtime needed.
jest.mock('../subsonicService');

import type { Child } from '../subsonicService';
import {
  applyLocalPlay,
  registerPlayerPlayStatListener,
} from '../playStatsService';
import { getDb } from '../../store/persistence/db';
import { upsertAlbums } from '../../db/repository/albums';
import { upsertSongs } from '../../db/repository/songs';

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mockFavoritesApply.mockClear();
  mockApplyLocalPlayToPlayer.mockClear();
  // Register a fresh listener for each test. playerService would normally
  // register `applyLocalPlayToPlayer` at module load; the test mirrors that
  // with a spy so we can assert the fan-out still hits the player tier.
  registerPlayerPlayStatListener(mockApplyLocalPlayToPlayer);
});

describe('playStatsService.applyLocalPlay', () => {
  it('shares one timestamp between the favorites patch and the player helper', () => {
    const song: Child = { id: 's1', title: 'S', albumId: 'a1' } as Child;

    applyLocalPlay(song);

    // One call per store action + one player helper call.
    expect(mockFavoritesApply).toHaveBeenCalledTimes(1);
    expect(mockApplyLocalPlayToPlayer).toHaveBeenCalledTimes(1);

    // All calls share the same `now` string.
    const favoritesNow = mockFavoritesApply.mock.calls[0][2];
    const playerNow = mockApplyLocalPlayToPlayer.mock.calls[0][1];

    expect(favoritesNow).toBe(playerNow);
    expect(typeof favoritesNow).toBe('string');
    expect(Number.isFinite(Date.parse(favoritesNow as string))).toBe(true);
  });

  it('forwards songId + albumId to all actions that take both', () => {
    const song: Child = { id: 'song-42', title: 'X', albumId: 'album-7' } as Child;

    applyLocalPlay(song);
    expect(mockFavoritesApply).toHaveBeenCalledWith('song-42', 'album-7', expect.any(String));
    expect(mockApplyLocalPlayToPlayer).toHaveBeenCalledWith('song-42', expect.any(String));
  });

  it('bumps the normalized song + album play_count so detail/player stay current', async () => {
    const db = getDb()!;
    db.runSync('DELETE FROM songs');
    db.runSync('DELETE FROM albums');
    await upsertSongs(db, [{ id: 's9', title: 'T', albumId: 'al9', playCount: 2 } as unknown as Child]);
    await upsertAlbums(db, [{ id: 'al9', name: 'A', playCount: 5 } as never]);

    applyLocalPlay({ id: 's9', title: 'T', albumId: 'al9' } as Child);
    await tick(); // normalized bumps are fire-and-forget

    const song = db.getFirstSync<{ play_count: number; played: string }>(
      "SELECT play_count, played FROM songs WHERE id='s9'",
    );
    const album = db.getFirstSync<{ play_count: number }>("SELECT play_count FROM albums WHERE id='al9'");
    expect(song?.play_count).toBe(3); // 2 + 1
    expect(typeof song?.played).toBe('string');
    expect(album?.play_count).toBe(6); // 5 + 1
  });

  it('passes undefined albumId through to the per-store actions when the song has no album', () => {
    const song: Child = { id: 's1', title: 'Orphan' } as Child;

    applyLocalPlay(song);
    expect(mockFavoritesApply).toHaveBeenCalledWith('s1', undefined, expect.any(String));
  });
});
