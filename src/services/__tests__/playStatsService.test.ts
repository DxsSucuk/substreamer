jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

const mockAlbumDetailApply = jest.fn();
const mockPlaylistDetailApply = jest.fn();
const mockFavoritesApply = jest.fn();
const mockAlbumLibraryApply = jest.fn();
const mockArtistDetailApply = jest.fn();
const mockApplyLocalPlayToPlayer = jest.fn();

jest.mock('../../store/albumDetailStore', () => ({
  albumDetailStore: {
    getState: () => ({ applyLocalPlay: mockAlbumDetailApply }),
  },
}));

jest.mock('../../store/playlistDetailStore', () => ({
  playlistDetailStore: {
    getState: () => ({ applyLocalPlay: mockPlaylistDetailApply }),
  },
}));

jest.mock('../../store/favoritesStore', () => ({
  favoritesStore: {
    getState: () => ({ applyLocalPlay: mockFavoritesApply }),
  },
}));

jest.mock('../../store/albumLibraryStore', () => ({
  albumLibraryStore: {
    getState: () => ({ applyLocalPlay: mockAlbumLibraryApply }),
  },
}));

jest.mock('../../store/artistDetailStore', () => ({
  artistDetailStore: {
    getState: () => ({ applyLocalPlay: mockArtistDetailApply }),
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
  mockAlbumDetailApply.mockClear();
  mockPlaylistDetailApply.mockClear();
  mockFavoritesApply.mockClear();
  mockAlbumLibraryApply.mockClear();
  mockArtistDetailApply.mockClear();
  mockApplyLocalPlayToPlayer.mockClear();
  // Register a fresh listener for each test. playerService would normally
  // register `applyLocalPlayToPlayer` at module load; the test mirrors that
  // with a spy so we can assert the fan-out still hits the player tier.
  registerPlayerPlayStatListener(mockApplyLocalPlayToPlayer);
});

describe('playStatsService.applyLocalPlay', () => {
  it('fans out to every store action + player helper with one shared timestamp', () => {
    const song: Child = { id: 's1', title: 'S', albumId: 'a1' } as Child;

    applyLocalPlay(song);

    // One call per store action + one player helper call.
    expect(mockAlbumDetailApply).toHaveBeenCalledTimes(1);
    expect(mockPlaylistDetailApply).toHaveBeenCalledTimes(1);
    expect(mockFavoritesApply).toHaveBeenCalledTimes(1);
    expect(mockAlbumLibraryApply).toHaveBeenCalledTimes(1);
    expect(mockArtistDetailApply).toHaveBeenCalledTimes(1);
    expect(mockApplyLocalPlayToPlayer).toHaveBeenCalledTimes(1);

    // All calls share the same `now` string.
    const albumDetailNow = mockAlbumDetailApply.mock.calls[0][2];
    const playlistNow = mockPlaylistDetailApply.mock.calls[0][1];
    const favoritesNow = mockFavoritesApply.mock.calls[0][2];
    const libraryNow = mockAlbumLibraryApply.mock.calls[0][1];
    const artistNow = mockArtistDetailApply.mock.calls[0][2];
    const playerNow = mockApplyLocalPlayToPlayer.mock.calls[0][1];

    expect(albumDetailNow).toBe(playlistNow);
    expect(albumDetailNow).toBe(favoritesNow);
    expect(albumDetailNow).toBe(libraryNow);
    expect(albumDetailNow).toBe(artistNow);
    expect(albumDetailNow).toBe(playerNow);
    expect(typeof albumDetailNow).toBe('string');
    expect(Number.isFinite(Date.parse(albumDetailNow as string))).toBe(true);
  });

  it('forwards songId + albumId to all actions that take both', () => {
    const song: Child = { id: 'song-42', title: 'X', albumId: 'album-7' } as Child;

    applyLocalPlay(song);

    expect(mockAlbumDetailApply).toHaveBeenCalledWith('song-42', 'album-7', expect.any(String));
    expect(mockFavoritesApply).toHaveBeenCalledWith('song-42', 'album-7', expect.any(String));
    expect(mockArtistDetailApply).toHaveBeenCalledWith('song-42', 'album-7', expect.any(String));
    expect(mockPlaylistDetailApply).toHaveBeenCalledWith('song-42', expect.any(String));
    expect(mockAlbumLibraryApply).toHaveBeenCalledWith('album-7', expect.any(String));
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

    expect(mockAlbumDetailApply).toHaveBeenCalledWith('s1', undefined, expect.any(String));
    expect(mockFavoritesApply).toHaveBeenCalledWith('s1', undefined, expect.any(String));
    expect(mockArtistDetailApply).toHaveBeenCalledWith('s1', undefined, expect.any(String));
    expect(mockAlbumLibraryApply).toHaveBeenCalledWith(undefined, expect.any(String));
  });
});
