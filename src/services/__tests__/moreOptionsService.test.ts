jest.mock('../playerService', () => ({
  addToQueue: jest.fn().mockResolvedValue(undefined),
  playTrack: jest.fn().mockResolvedValue(undefined),
  removeFromQueue: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../subsonicService');

jest.mock('../musicCacheService', () => ({
  enqueueAlbumDownload: jest.fn(),
  enqueuePlaylistDownload: jest.fn(),
  enqueueSongDownload: jest.fn().mockResolvedValue(undefined),
  deleteCachedItem: jest.fn(),
  removeCachedAlbumSong: jest.fn(),
  cancelDownload: jest.fn(),
}));

const mockSetOverride = jest.fn();
const mockFetchStarred = jest.fn();

jest.mock('../../store/favoritesStore', () => ({
  favoritesStore: {
    getState: jest.fn(() => ({
      songs: [],
      albums: [],
      artists: [],
      overrides: {} as Record<string, boolean>,
      setOverride: mockSetOverride,
      fetchStarred: mockFetchStarred,
    })),
  },
}));

jest.mock('../../store/albumDetailStore', () => ({
  albumDetailStore: {
    getState: jest.fn(() => ({ albums: {} })),
  },
}));

jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: {
    getState: jest.fn(() => ({ offlineMode: false })),
  },
}));

jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: {
    getState: jest.fn(() => ({ cachedItems: {} })),
  },
}));

jest.mock('../../store/playlistDetailStore', () => ({
  playlistDetailStore: {
    getState: jest.fn(() => ({ playlists: {} })),
  },
}));

jest.mock('../../store/persistence/db', () => ({
  getDb: jest.fn(() => ({})),
}));

// The normalized detail reads derive from the (mocked) detail stores so the existing
// cached-data test setups exercise the same code path without per-test churn.
jest.mock('../../db/repository/details', () => ({
  getAlbumDetail: jest.fn(async (_db: unknown, id: string) => {
    const al = require('../../store/albumDetailStore').albumDetailStore.getState().albums[id];
    return al ? { album: al.album, songs: al.album?.song ?? [] } : null;
  }),
  getPlaylistDetail: jest.fn(async (_db: unknown, id: string) => {
    const p = require('../../store/playlistDetailStore').playlistDetailStore.getState().playlists[id];
    return p ? { entry: p.playlist?.entry ?? [] } : null;
  }),
}));

// Artist detail fetch routes through the shared normalized detailFetchService; bridge it to
// the per-test `fetchArtist` injection on the (still-present) artistDetailStore mock.
// The artist detail parts are fetched independently now; these read the per-test state
// object below, which replaces the deleted store as the injection point.
// eslint-disable-next-line no-var
var mockArtistParts: { albums?: unknown[]; topSongs?: unknown[]; throws?: boolean } = {};

jest.mock('../detailFetchService', () => ({
  fetchArtistBase: async () => {
    if (mockArtistParts.throws) throw new Error('fetch failed');
    return mockArtistParts.albums
      ? { artist: { id: 'ar1', name: 'Test Artist' }, albums: mockArtistParts.albums }
      : null;
  },
  fetchArtistTopSongs: async () => {
    if (mockArtistParts.throws) throw new Error('fetch failed');
    return mockArtistParts.topSongs
      ? { songs: mockArtistParts.topSongs, retrievedAt: 1, listLength: 20, songCount: mockArtistParts.topSongs.length }
      : null;
  },
}));

// The playlist-list refresh moved off the store onto the sync service; route it back
// at the store mock so the existing call assertions keep working.
jest.mock('../normalizedLibrarySync', () => ({
  refreshPlaylistLibrary: () =>
    require('../../store/playlistLibraryStore').playlistLibraryStore.getState().fetchAllPlaylists(),
}));
jest.mock('../../store/playlistLibraryStore', () => ({
  playlistLibraryStore: {
    getState: jest.fn(() => ({
      fetchAllPlaylists: jest.fn().mockResolvedValue(undefined),
    })),
  },
}));

jest.mock('../../store/layoutPreferencesStore', () => ({
  layoutPreferencesStore: {
    getState: jest.fn(() => ({ listLength: 20 })),
  },
}));

const mockOverlayShow = jest.fn();
const mockOverlayShowSuccess = jest.fn();
const mockOverlayShowError = jest.fn();

jest.mock('../../store/processingOverlayStore', () => ({
  processingOverlayStore: {
    getState: jest.fn(() => ({
      show: mockOverlayShow,
      showSuccess: mockOverlayShowSuccess,
      showError: mockOverlayShowError,
    })),
  },
}));

import { addToQueue, playTrack, removeFromQueue } from '../playerService';
import {
  enqueueSongDownload as mockEnqueueSongDownload,
  deleteCachedItem as mockDeleteCachedItem,
  removeCachedAlbumSong as mockRemoveCachedAlbumSong,
} from '../musicCacheService';
import {
  starSong,
  unstarSong,
  starAlbum,
  unstarAlbum,
  starArtist,
  unstarArtist,
  getAlbum,
  getPlaylist,
  getRandomSongsFiltered,
  getSimilarSongs,
  getSimilarSongs2,
  getTopSongs,
  createNewPlaylist,
} from '../subsonicService';
import { favoritesStore } from '../../store/favoritesStore';
import { albumDetailStore } from '../../store/albumDetailStore';
import { playlistDetailStore } from '../../store/playlistDetailStore';
import { playlistLibraryStore } from '../../store/playlistLibraryStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import {
  toggleStar,
  addSongToQueue,
  addAlbumToQueue,
  addPlaylistToQueue,
  removeItemFromQueue,
  playMoreLikeThis,
  playSimilarArtistsMix,
  saveArtistTopSongsPlaylist,
  playMoreByArtist,
  playAllByArtist,
  handleDownloadSong,
  handleRemoveSongDownload,
  songItemId,
} from '../moreOptionsService';

const mockStarSong = starSong as jest.Mock;
const mockUnstarSong = unstarSong as jest.Mock;
const mockStarAlbum = starAlbum as jest.Mock;
const mockUnstarAlbum = unstarAlbum as jest.Mock;
const mockStarArtist = starArtist as jest.Mock;
const mockUnstarArtist = unstarArtist as jest.Mock;
const mockGetAlbum = getAlbum as jest.Mock;
const mockGetPlaylist = getPlaylist as jest.Mock;
const mockGetSimilarSongs = getSimilarSongs as jest.Mock;
const mockGetSimilarSongs2 = getSimilarSongs2 as jest.Mock;
const mockGetRandomSongsFiltered = getRandomSongsFiltered as jest.Mock;
const mockGetTopSongs = getTopSongs as jest.Mock;
const mockCreateNewPlaylist = createNewPlaylist as jest.Mock;
const mockAddToQueue = addToQueue as jest.Mock;
const mockPlayTrack = playTrack as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (favoritesStore.getState as jest.Mock).mockReturnValue({
    songs: [],
    albums: [],
    artists: [],
    overrides: {},
    setOverride: mockSetOverride,
    fetchStarred: mockFetchStarred,
  });
});

describe('toggleStar', () => {
  it('stars an unstarred song', async () => {
    const result = await toggleStar('song', 'song-1');

    expect(result).toBe(true);
    expect(mockSetOverride).toHaveBeenCalledWith('song-1', true);
    expect(mockStarSong).toHaveBeenCalledWith('song-1');
    expect(mockFetchStarred).toHaveBeenCalled();
  });

  it('unstars a starred song', async () => {
    (favoritesStore.getState as jest.Mock).mockReturnValue({
      songs: [{ id: 'song-1' }],
      albums: [],
      artists: [],
      overrides: {},
      setOverride: mockSetOverride,
      fetchStarred: mockFetchStarred,
    });

    const result = await toggleStar('song', 'song-1');

    expect(result).toBe(false);
    expect(mockSetOverride).toHaveBeenCalledWith('song-1', false);
    expect(mockUnstarSong).toHaveBeenCalledWith('song-1');
  });

  it('uses override value when present', async () => {
    (favoritesStore.getState as jest.Mock).mockReturnValue({
      songs: [],
      albums: [],
      artists: [],
      overrides: { 'song-1': true },
      setOverride: mockSetOverride,
      fetchStarred: mockFetchStarred,
    });

    const result = await toggleStar('song', 'song-1');
    expect(result).toBe(false);
    expect(mockUnstarSong).toHaveBeenCalledWith('song-1');
  });

  it('stars an album', async () => {
    const result = await toggleStar('album', 'album-1');
    expect(result).toBe(true);
    expect(mockStarAlbum).toHaveBeenCalledWith('album-1');
  });

  it('unstars an album', async () => {
    (favoritesStore.getState as jest.Mock).mockReturnValue({
      songs: [],
      albums: [{ id: 'album-1' }],
      artists: [],
      overrides: {},
      setOverride: mockSetOverride,
      fetchStarred: mockFetchStarred,
    });
    const result = await toggleStar('album', 'album-1');
    expect(result).toBe(false);
    expect(mockUnstarAlbum).toHaveBeenCalledWith('album-1');
  });

  it('stars an artist', async () => {
    const result = await toggleStar('artist', 'artist-1');
    expect(result).toBe(true);
    expect(mockStarArtist).toHaveBeenCalledWith('artist-1');
  });

  it('unstars an artist', async () => {
    (favoritesStore.getState as jest.Mock).mockReturnValue({
      songs: [],
      albums: [],
      artists: [{ id: 'artist-1' }],
      overrides: {},
      setOverride: mockSetOverride,
      fetchStarred: mockFetchStarred,
    });
    const result = await toggleStar('artist', 'artist-1');
    expect(result).toBe(false);
    expect(mockUnstarArtist).toHaveBeenCalledWith('artist-1');
  });

  it('reverts optimistic update on API failure', async () => {
    mockStarSong.mockRejectedValueOnce(new Error('network'));

    const result = await toggleStar('song', 'song-1');

    expect(result).toBe(true);
    // First call: optimistic (true), second call: revert (false)
    expect(mockSetOverride).toHaveBeenCalledWith('song-1', true);
    expect(mockSetOverride).toHaveBeenCalledWith('song-1', false);
  });
});

describe('addSongToQueue', () => {
  it('adds a single song to the queue', async () => {
    const song = { id: 's1', title: 'Song 1' } as any;
    await addSongToQueue(song);
    expect(mockAddToQueue).toHaveBeenCalledWith([song]);
  });
});

describe('addAlbumToQueue', () => {
  it('uses cached album data when available', async () => {
    const songs = [{ id: 's1' }, { id: 's2' }];
    (albumDetailStore.getState as jest.Mock).mockReturnValueOnce({
      albums: { 'a1': { album: { song: songs } } },
    });

    await addAlbumToQueue({ id: 'a1' } as any);

    expect(mockGetAlbum).not.toHaveBeenCalled();
    expect(mockAddToQueue).toHaveBeenCalledWith(songs);
  });

  it('fetches from API when not cached', async () => {
    (albumDetailStore.getState as jest.Mock).mockReturnValueOnce({ albums: {} });
    const songs = [{ id: 's1' }];
    mockGetAlbum.mockResolvedValue({ song: songs });

    await addAlbumToQueue({ id: 'a1' } as any);

    expect(mockGetAlbum).toHaveBeenCalledWith('a1');
    expect(mockAddToQueue).toHaveBeenCalledWith(songs);
  });

  it('does nothing when album has no songs', async () => {
    (albumDetailStore.getState as jest.Mock).mockReturnValueOnce({ albums: {} });
    mockGetAlbum.mockResolvedValue({ song: [] });
    await addAlbumToQueue({ id: 'a1' } as any);
    expect(mockAddToQueue).not.toHaveBeenCalled();
  });

  it('does nothing when API returns null', async () => {
    (albumDetailStore.getState as jest.Mock).mockReturnValueOnce({ albums: {} });
    mockGetAlbum.mockResolvedValue(null);
    await addAlbumToQueue({ id: 'a1' } as any);
    expect(mockAddToQueue).not.toHaveBeenCalled();
  });
});

describe('addPlaylistToQueue', () => {
  it('uses cached playlist data when available', async () => {
    const entries = [{ id: 's1' }, { id: 's2' }];
    (playlistDetailStore.getState as jest.Mock).mockReturnValueOnce({
      playlists: { 'p1': { playlist: { entry: entries } } },
    });

    await addPlaylistToQueue({ id: 'p1' } as any);

    expect(mockGetPlaylist).not.toHaveBeenCalled();
    expect(mockAddToQueue).toHaveBeenCalledWith(entries, 'p1');
  });

  it('fetches from API when not cached', async () => {
    (playlistDetailStore.getState as jest.Mock).mockReturnValueOnce({ playlists: {} });
    const entries = [{ id: 's1' }];
    mockGetPlaylist.mockResolvedValue({ entry: entries });

    await addPlaylistToQueue({ id: 'p1' } as any);

    expect(mockGetPlaylist).toHaveBeenCalledWith('p1');
    expect(mockAddToQueue).toHaveBeenCalledWith(entries, 'p1');
  });

  it('does nothing when playlist has no entries', async () => {
    (playlistDetailStore.getState as jest.Mock).mockReturnValueOnce({ playlists: {} });
    mockGetPlaylist.mockResolvedValue({ entry: [] });
    await addPlaylistToQueue({ id: 'p1' } as any);
    expect(mockAddToQueue).not.toHaveBeenCalled();
  });
});

describe('removeItemFromQueue', () => {
  it('delegates to removeFromQueue', async () => {
    await removeItemFromQueue(3);
    expect(removeFromQueue).toHaveBeenCalledWith(3);
  });
});

describe('playMoreLikeThis', () => {
  beforeEach(() => {
    mockGetSimilarSongs2.mockResolvedValue([]);
    mockGetRandomSongsFiltered.mockResolvedValue([]);
    mockGetTopSongs.mockResolvedValue([]);
  });

  it('plays similar songs on success', async () => {
    const tracks = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}` })) as any[];
    mockGetSimilarSongs.mockResolvedValue(tracks);

    await playMoreLikeThis({ id: 's1' } as any);

    expect(mockOverlayShow).toHaveBeenCalledWith('Loading…');
    expect(mockGetSimilarSongs).toHaveBeenCalledWith('s1', 20);
    expect(mockPlayTrack).toHaveBeenCalledWith(tracks[0], tracks);
    expect(mockOverlayShowSuccess).toHaveBeenCalledWith('Playing similar songs');
    // No fallbacks needed — first call returned the full target
    expect(mockGetSimilarSongs2).not.toHaveBeenCalled();
    expect(mockGetRandomSongsFiltered).not.toHaveBeenCalled();
    expect(mockGetTopSongs).not.toHaveBeenCalled();
  });

  it('shows error when no similar songs found via any path', async () => {
    mockGetSimilarSongs.mockResolvedValue([]);
    mockGetSimilarSongs2.mockResolvedValue([]);
    mockGetRandomSongsFiltered.mockResolvedValue([]);
    mockGetTopSongs.mockResolvedValue([]);

    await playMoreLikeThis({
      id: 's1', artist: 'X', artistId: 'a1', genre: 'Rock',
    } as any);

    expect(mockOverlayShowError).toHaveBeenCalledWith('No similar songs found');
    expect(mockPlayTrack).not.toHaveBeenCalled();
  });

  it('shows error on failure', async () => {
    mockGetSimilarSongs.mockRejectedValue(new Error('fail'));

    await playMoreLikeThis({ id: 's1' } as any);

    expect(mockOverlayShowError).toHaveBeenCalledWith('Failed to load similar songs');
  });

  // Issue #156 — thin getSimilarSongs results used to ship a 2-track queue.
  // Now we top up via similar2 → same-genre → artist top, preserving order
  // and deduping the source song + duplicates.
  it('tops up via similar2 when getSimilarSongs returns too few', async () => {
    mockGetSimilarSongs.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
    mockGetSimilarSongs2.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({ id: `a${i}` })),
    );

    await playMoreLikeThis({
      id: 's1', artist: 'X', artistId: 'a1', genre: 'Rock',
    } as any);

    expect(mockGetSimilarSongs2).toHaveBeenCalledWith('a1', 20);
    const queueArg = mockPlayTrack.mock.calls[0][1];
    expect(queueArg).toHaveLength(20);
    expect(queueArg[0].id).toBe('t1');
    expect(queueArg[1].id).toBe('t2');
    // No need to fall back further
    expect(mockGetRandomSongsFiltered).not.toHaveBeenCalled();
    expect(mockGetTopSongs).not.toHaveBeenCalled();
  });

  it('falls through to same-genre random when similar + similar2 are thin', async () => {
    mockGetSimilarSongs.mockResolvedValue([{ id: 't1' }]);
    mockGetSimilarSongs2.mockResolvedValue([{ id: 'a1' }]);
    mockGetRandomSongsFiltered.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({ id: `g${i}` })),
    );

    await playMoreLikeThis({
      id: 's1', artist: 'X', artistId: 'a1', genre: 'Rock',
    } as any);

    expect(mockGetRandomSongsFiltered).toHaveBeenCalledWith({ size: 40, genre: 'Rock' });
    const queueArg = mockPlayTrack.mock.calls[0][1];
    expect(queueArg).toHaveLength(20);
    expect(queueArg[0].id).toBe('t1');
    expect(queueArg[1].id).toBe('a1');
  });

  it('falls through to artist top songs when all upstream layers are thin', async () => {
    mockGetSimilarSongs.mockResolvedValue([{ id: 't1' }]);
    mockGetSimilarSongs2.mockResolvedValue([{ id: 'a1' }]);
    mockGetRandomSongsFiltered.mockResolvedValue([{ id: 'g1' }]);
    mockGetTopSongs.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({ id: `top${i}` })),
    );

    await playMoreLikeThis({
      id: 's1', artist: 'X', artistId: 'a1', genre: 'Rock',
    } as any);

    expect(mockGetTopSongs).toHaveBeenCalledWith('X', 20);
    const queueArg = mockPlayTrack.mock.calls[0][1];
    expect(queueArg).toHaveLength(20);
    expect(queueArg[0].id).toBe('t1');
    expect(queueArg[1].id).toBe('a1');
    expect(queueArg[2].id).toBe('g1');
  });

  it('dedupes overlaps across layers and excludes the source song', async () => {
    mockGetSimilarSongs.mockResolvedValue([{ id: 't1' }, { id: 's1' }]);
    // similar2 returns 't1' again + the source 's1' + new ones
    mockGetSimilarSongs2.mockResolvedValue([
      { id: 't1' }, { id: 's1' }, { id: 'a1' }, { id: 'a2' },
    ]);
    mockGetRandomSongsFiltered.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({ id: `g${i}` })),
    );

    await playMoreLikeThis({
      id: 's1', artist: 'X', artistId: 'a1', genre: 'Rock',
    } as any);

    const queueArg = mockPlayTrack.mock.calls[0][1];
    const ids = queueArg.map((t: any) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).not.toContain('s1'); // source excluded
    expect(ids[0]).toBe('t1');
    expect(ids[1]).toBe('a1');
    expect(ids[2]).toBe('a2');
  });

  it('skips layers that need fields the source lacks', async () => {
    // Source has no artistId, no genre, no artist name — only similar()
    // should fire; we should NOT make doomed API calls.
    mockGetSimilarSongs.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);

    await playMoreLikeThis({ id: 's1' } as any);

    expect(mockGetSimilarSongs2).not.toHaveBeenCalled();
    expect(mockGetRandomSongsFiltered).not.toHaveBeenCalled();
    expect(mockGetTopSongs).not.toHaveBeenCalled();
    const queueArg = mockPlayTrack.mock.calls[0][1];
    expect(queueArg.map((t: any) => t.id)).toEqual(['t1', 't2']);
  });

  it('uses genres[0] when the legacy single-genre field is absent', async () => {
    mockGetSimilarSongs.mockResolvedValue([{ id: 't1' }]);
    mockGetSimilarSongs2.mockResolvedValue([]);
    mockGetRandomSongsFiltered.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({ id: `g${i}` })),
    );

    await playMoreLikeThis({
      id: 's1', artistId: 'a1', genres: ['Jazz', 'Blues'],
    } as any);

    expect(mockGetRandomSongsFiltered).toHaveBeenCalledWith({ size: 40, genre: 'Jazz' });
  });
});

describe('playSimilarArtistsMix', () => {
  it('plays similar artist mix on success', async () => {
    const tracks = [{ id: 't1' }, { id: 't2' }] as any[];
    mockGetSimilarSongs2.mockResolvedValue(tracks);

    await playSimilarArtistsMix({ id: 'ar1', name: 'Artist' } as any);

    expect(mockGetSimilarSongs2).toHaveBeenCalledWith('ar1', 20);
    expect(mockPlayTrack).toHaveBeenCalledWith(tracks[0], tracks);
    expect(mockOverlayShowSuccess).toHaveBeenCalledWith('Playing similar artists mix');
  });

  it('shows error when no similar artists mix available', async () => {
    mockGetSimilarSongs2.mockResolvedValue([]);

    await playSimilarArtistsMix({ id: 'ar1', name: 'Artist' } as any);

    expect(mockOverlayShowError).toHaveBeenCalledWith('No similar artists mix available');
  });

  it('shows error on failure', async () => {
    mockGetSimilarSongs2.mockRejectedValue(new Error('fail'));

    await playSimilarArtistsMix({ id: 'ar1', name: 'Artist' } as any);

    expect(mockOverlayShowError).toHaveBeenCalledWith('Failed to load similar artists mix');
  });
});

describe('saveArtistTopSongsPlaylist', () => {
  const artist = { id: 'ar1', name: 'Test Artist' } as any;

  it('creates playlist from cached top songs', async () => {
    const topSongs = [{ id: 's1' }, { id: 's2' }];
    mockArtistParts = { topSongs };
    mockCreateNewPlaylist.mockResolvedValue(true);
    const mockFetchAllPlaylists = jest.fn().mockResolvedValue(undefined);
    (playlistLibraryStore.getState as jest.Mock).mockReturnValue({
      fetchAllPlaylists: mockFetchAllPlaylists,
    });

    await saveArtistTopSongsPlaylist(artist);

    expect(mockOverlayShow).toHaveBeenCalledWith('Creating…');
    expect(mockCreateNewPlaylist).toHaveBeenCalledWith('Test Artist Top Songs', ['s1', 's2']);
    expect(mockFetchAllPlaylists).toHaveBeenCalled();
    expect(mockOverlayShowSuccess).toHaveBeenCalledWith('Playlist Created');
  });

  it('creates the playlist from a fetcher that had to go to the server', async () => {
    // The local-first read lives inside fetchArtistTopSongs now; from here it is one call.
    const topSongs = [{ id: 's1' }];
    mockArtistParts = { topSongs };
    mockCreateNewPlaylist.mockResolvedValue(true);
    const mockFetchAllPlaylists = jest.fn().mockResolvedValue(undefined);
    (playlistLibraryStore.getState as jest.Mock).mockReturnValue({
      fetchAllPlaylists: mockFetchAllPlaylists,
    });

    await saveArtistTopSongsPlaylist(artist);

    expect(mockCreateNewPlaylist).toHaveBeenCalledWith('Test Artist Top Songs', ['s1']);
    expect(mockOverlayShowSuccess).toHaveBeenCalledWith('Playlist Created');
  });

  it('shows error when no top songs are available', async () => {
    mockArtistParts = { topSongs: [] };

    await saveArtistTopSongsPlaylist(artist);

    expect(mockOverlayShowError).toHaveBeenCalledWith('No top songs available');
    expect(mockCreateNewPlaylist).not.toHaveBeenCalled();
  });

  it('shows error when createNewPlaylist returns false', async () => {
    const topSongs = [{ id: 's1' }];
    mockArtistParts = { topSongs };
    mockCreateNewPlaylist.mockResolvedValue(false);

    await saveArtistTopSongsPlaylist(artist);

    expect(mockOverlayShowError).toHaveBeenCalledWith('Failed to create playlist');
  });

  it('shows error on exception', async () => {
    mockArtistParts = { throws: true };

    await saveArtistTopSongsPlaylist(artist);

    expect(mockOverlayShowError).toHaveBeenCalledWith('Failed to create playlist');
  });
});

describe('playMoreByArtist', () => {
  describe('online path', () => {
    beforeEach(() => {
      (offlineModeStore.getState as jest.Mock).mockReturnValue({ offlineMode: false });
    });

    it('fetches albums, shuffles songs, and plays', async () => {
      const songs = [
        { id: 's1', title: 'Song 1', artist: 'Artist A', artistId: 'ar1' },
        { id: 's2', title: 'Song 2', artist: 'Artist A', artistId: 'ar1' },
        { id: 's3', title: 'Song 3', artist: 'Artist A', artistId: 'ar1' },
        { id: 's4', title: 'Song 4', artist: 'Artist A', artistId: 'ar1' },
        { id: 's5', title: 'Song 5', artist: 'Artist A', artistId: 'ar1' },
      ];
      mockArtistParts = { albums: [{ id: 'alb1' }] };
      (albumDetailStore.getState as jest.Mock).mockReturnValue({
        albums: { alb1: { album: { song: songs } } },
      });

      await playMoreByArtist('ar1', 'Artist A');

      expect(mockOverlayShow).toHaveBeenCalledWith('Loading…');
      expect(mockPlayTrack).toHaveBeenCalled();
      const [firstTrack, queue] = mockPlayTrack.mock.calls[0];
      expect(queue.length).toBe(5);
      expect(queue).toContain(firstTrack);
      expect(mockOverlayShowSuccess).toHaveBeenCalledWith(`Playing Artist A mix`);
    });

    it('fetches artist when not cached', async () => {
      const songs = Array.from({ length: 6 }, (_, i) => ({
        id: `s${i}`, artist: 'Artist B', artistId: 'ar2',
      }));
      mockArtistParts = { albums: [{ id: 'alb1' }] };
      (albumDetailStore.getState as jest.Mock).mockReturnValue({ albums: {} });
      mockGetAlbum.mockResolvedValue({ song: songs });

      await playMoreByArtist('ar2', 'Artist B');

      expect(mockGetAlbum).toHaveBeenCalledWith('alb1');
      expect(mockPlayTrack).toHaveBeenCalled();
    });

    it('filters out songs from other artists in compilations', async () => {
      const songs = [
        { id: 's1', artist: 'Artist A', artistId: 'ar1' },
        { id: 's2', artist: 'Other Artist', artistId: 'ar99' },
        { id: 's3', artist: 'Artist A', artistId: 'ar1' },
        { id: 's4', artist: 'Artist A', artistId: 'ar1' },
        { id: 's5', artist: 'Artist A', artistId: 'ar1' },
        { id: 's6', artist: 'Artist A', artistId: 'ar1' },
        { id: 's7', artist: 'Another', artistId: 'ar88' },
      ];
      mockArtistParts = { albums: [{ id: 'alb1' }] };
      (albumDetailStore.getState as jest.Mock).mockReturnValue({
        albums: { alb1: { album: { song: songs } } },
      });

      await playMoreByArtist('ar1', 'Artist A');

      const [, queue] = mockPlayTrack.mock.calls[0];
      expect(queue.length).toBe(5);
      expect(queue.every((s: any) => s.artistId === 'ar1')).toBe(true);
    });

    it('limits queue to listLength (default 20)', async () => {
      const songs = Array.from({ length: 30 }, (_, i) => ({
        id: `s${i}`,
        artist: 'Artist A',
        artistId: 'ar1',
      }));
      mockArtistParts = { albums: [{ id: 'alb1' }] };
      (albumDetailStore.getState as jest.Mock).mockReturnValue({
        albums: { alb1: { album: { song: songs } } },
      });

      await playMoreByArtist('ar1', 'Artist A');

      const [, queue] = mockPlayTrack.mock.calls[0];
      expect(queue.length).toBe(20);
    });

    it('shows error when no songs found', async () => {
      mockArtistParts = { albums: [{ id: 'alb1' }] };
      (albumDetailStore.getState as jest.Mock).mockReturnValue({
        albums: { alb1: { album: { song: [] } } },
      });

      await playMoreByArtist('ar1', 'Artist A');

      expect(mockOverlayShowError).toHaveBeenCalledWith('No songs found by Artist A');
      expect(mockPlayTrack).not.toHaveBeenCalled();
    });

    it('shows error when artist has no albums', async () => {
      mockArtistParts = { albums: [] };

      await playMoreByArtist('ar1', 'Artist A');

      expect(mockOverlayShowError).toHaveBeenCalledWith('No songs found by Artist A');
      expect(mockPlayTrack).not.toHaveBeenCalled();
    });

    it('shows error when fewer than 5 songs found', async () => {
      const songs = [
        { id: 's1', artist: 'Artist A', artistId: 'ar1' },
        { id: 's2', artist: 'Artist A', artistId: 'ar1' },
        { id: 's3', artist: 'Artist A', artistId: 'ar1' },
      ];
      mockArtistParts = { albums: [{ id: 'alb1' }] };
      (albumDetailStore.getState as jest.Mock).mockReturnValue({
        albums: { alb1: { album: { song: songs } } },
      });

      await playMoreByArtist('ar1', 'Artist A');

      expect(mockOverlayShowError).toHaveBeenCalledWith('Not enough songs by Artist A');
      expect(mockPlayTrack).not.toHaveBeenCalled();
    });

    it('plays when exactly 5 songs found', async () => {
      const songs = Array.from({ length: 5 }, (_, i) => ({
        id: `s${i}`, artist: 'Artist A', artistId: 'ar1',
      }));
      mockArtistParts = { albums: [{ id: 'alb1' }] };
      (albumDetailStore.getState as jest.Mock).mockReturnValue({
        albums: { alb1: { album: { song: songs } } },
      });

      await playMoreByArtist('ar1', 'Artist A');

      expect(mockPlayTrack).toHaveBeenCalled();
      const [, queue] = mockPlayTrack.mock.calls[0];
      expect(queue.length).toBe(5);
    });

    it('shows error on exception', async () => {
      mockArtistParts = { throws: true };

      await playMoreByArtist('ar1', 'Artist A');

      expect(mockOverlayShowError).toHaveBeenCalledWith('Failed to load Artist A songs');
    });
  });

  describe('offline path', () => {
    beforeEach(() => {
      (offlineModeStore.getState as jest.Mock).mockReturnValue({ offlineMode: true });
    });

    it('plays songs from cached items matching artist name', async () => {
      (musicCacheStore.getState as jest.Mock).mockReturnValue({
        cachedItems: {
          alb1: { itemId: 'alb1', name: 'Album One', coverArtId: 'cov1', songIds: ['s1', 's2', 's4', 's5'] },
          alb2: { itemId: 'alb2', name: 'Album Two', coverArtId: 'cov2', songIds: ['s3', 's6'] },
        },
        cachedSongs: {
          s1: { id: 's1', title: 'Song 1', artist: 'Artist A', duration: 200, bytes: 1000 },
          s2: { id: 's2', title: 'Song 2', artist: 'Other', duration: 180, bytes: 900 },
          s3: { id: 's3', title: 'Song 3', artist: 'Artist A', duration: 210, bytes: 1100 },
          s4: { id: 's4', title: 'Song 4', artist: 'Artist A', duration: 190, bytes: 950 },
          s5: { id: 's5', title: 'Song 5', artist: 'Artist A', duration: 220, bytes: 1050 },
          s6: { id: 's6', title: 'Song 6', artist: 'Artist A', duration: 230, bytes: 1200 },
        },
      });

      await playMoreByArtist('ar1', 'Artist A');

      expect(mockPlayTrack).toHaveBeenCalled();
      const [firstTrack, queue] = mockPlayTrack.mock.calls[0];
      expect(queue.length).toBe(5);
      expect(queue.every((s: any) => s.artist === 'Artist A')).toBe(true);
      // Verify Child reconstruction
      const song = queue.find((s: any) => s.id === 's1');
      expect(song.album).toBe('Album One');
      expect(song.coverArt).toBe('cov1');
      expect(song.isDir).toBe(false);
      expect(queue).toContain(firstTrack);
      expect(mockOverlayShowSuccess).toHaveBeenCalledWith(`Playing Artist A mix`);
    });

    it('shows error when no offline songs match', async () => {
      (musicCacheStore.getState as jest.Mock).mockReturnValue({
        cachedItems: {
          alb1: { itemId: 'alb1', name: 'Album One', coverArtId: 'cov1', songIds: ['s1'] },
        },
        cachedSongs: {
          s1: { id: 's1', title: 'Song 1', artist: 'Other', duration: 200, bytes: 1000 },
        },
      });

      await playMoreByArtist('ar1', 'Artist A');

      expect(mockOverlayShowError).toHaveBeenCalledWith('No offline songs by Artist A');
      expect(mockPlayTrack).not.toHaveBeenCalled();
    });

    it('shows error when cache is empty', async () => {
      (musicCacheStore.getState as jest.Mock).mockReturnValue({ cachedItems: {}, cachedSongs: {} });

      await playMoreByArtist('ar1', 'Artist A');

      expect(mockOverlayShowError).toHaveBeenCalledWith('No offline songs by Artist A');
      expect(mockPlayTrack).not.toHaveBeenCalled();
    });

    it('shows error when fewer than 5 offline songs match', async () => {
      (musicCacheStore.getState as jest.Mock).mockReturnValue({
        cachedItems: {
          alb1: { itemId: 'alb1', name: 'Album One', coverArtId: 'cov1', songIds: ['s1', 's2'] },
        },
        cachedSongs: {
          s1: { id: 's1', title: 'Song 1', artist: 'Artist A', duration: 200, bytes: 1000 },
          s2: { id: 's2', title: 'Song 2', artist: 'Artist A', duration: 180, bytes: 900 },
        },
      });

      await playMoreByArtist('ar1', 'Artist A');

      expect(mockOverlayShowError).toHaveBeenCalledWith('Not enough offline songs by Artist A');
      expect(mockPlayTrack).not.toHaveBeenCalled();
    });

    it('limits offline queue to 20', async () => {
      const songIds = Array.from({ length: 25 }, (_, i) => `s${i}`);
      const cachedSongs: Record<string, any> = {};
      for (let i = 0; i < 25; i++) {
        cachedSongs[`s${i}`] = {
          id: `s${i}`,
          title: `Song ${i}`,
          artist: 'Artist A',
          duration: 200,
          bytes: 1000,
        };
      }
      (musicCacheStore.getState as jest.Mock).mockReturnValue({
        cachedItems: {
          alb1: { itemId: 'alb1', name: 'Album', coverArtId: 'cov', songIds },
        },
        cachedSongs,
      });

      await playMoreByArtist('ar1', 'Artist A');

      const [, queue] = mockPlayTrack.mock.calls[0];
      expect(queue.length).toBe(20);
    });
  });
});

describe('playAllByArtist', () => {
  describe('online – sequential (shuffle=false)', () => {
    beforeEach(() => {
      (offlineModeStore.getState as jest.Mock).mockReturnValue({ offlineMode: false });
    });

    it('plays all songs sorted by year → disc → track', async () => {
      const songs = [
        { id: 's1', artist: 'A', artistId: 'ar1', year: 2020, discNumber: 1, track: 2 },
        { id: 's2', artist: 'A', artistId: 'ar1', year: 2019, discNumber: 1, track: 1 },
        { id: 's3', artist: 'A', artistId: 'ar1', year: 2020, discNumber: 1, track: 1 },
        { id: 's4', artist: 'A', artistId: 'ar1', year: 2020, discNumber: 2, track: 1 },
      ];
      mockArtistParts = { albums: [{ id: 'alb1' }] };
      (albumDetailStore.getState as jest.Mock).mockReturnValue({
        albums: { alb1: { album: { song: songs } } },
      });

      await playAllByArtist('ar1', 'A', false);

      const [firstTrack, queue] = mockPlayTrack.mock.calls[0];
      expect(queue.map((s: any) => s.id)).toEqual(['s2', 's3', 's1', 's4']);
      expect(firstTrack.id).toBe('s2');
      expect(mockOverlayShowSuccess).toHaveBeenCalledWith('Playing all songs by A');
    });

    it('does not cap queue length', async () => {
      const songs = Array.from({ length: 50 }, (_, i) => ({
        id: `s${i}`, artist: 'A', artistId: 'ar1', year: 2020, discNumber: 1, track: i + 1,
      }));
      mockArtistParts = { albums: [{ id: 'alb1' }] };
      (albumDetailStore.getState as jest.Mock).mockReturnValue({
        albums: { alb1: { album: { song: songs } } },
      });

      await playAllByArtist('ar1', 'A', false);

      const [, queue] = mockPlayTrack.mock.calls[0];
      expect(queue.length).toBe(50);
    });

    it('plays even with fewer than 5 songs (no min check)', async () => {
      const songs = [
        { id: 's1', artist: 'A', artistId: 'ar1', year: 2020, discNumber: 1, track: 1 },
        { id: 's2', artist: 'A', artistId: 'ar1', year: 2020, discNumber: 1, track: 2 },
      ];
      mockArtistParts = { albums: [{ id: 'alb1' }] };
      (albumDetailStore.getState as jest.Mock).mockReturnValue({
        albums: { alb1: { album: { song: songs } } },
      });

      await playAllByArtist('ar1', 'A', false);

      expect(mockPlayTrack).toHaveBeenCalled();
      const [, queue] = mockPlayTrack.mock.calls[0];
      expect(queue.length).toBe(2);
    });

    it('shows error when no songs found', async () => {
      mockArtistParts = { albums: [{ id: 'alb1' }] };
      (albumDetailStore.getState as jest.Mock).mockReturnValue({
        albums: { alb1: { album: { song: [] } } },
      });

      await playAllByArtist('ar1', 'A', false);

      expect(mockOverlayShowError).toHaveBeenCalledWith('No songs found by A');
      expect(mockPlayTrack).not.toHaveBeenCalled();
    });

    it('shows error on exception', async () => {
      mockArtistParts = { throws: true };

      await playAllByArtist('ar1', 'A', false);

      expect(mockOverlayShowError).toHaveBeenCalledWith('Failed to load A songs');
    });
  });

  describe('online – shuffle (shuffle=true)', () => {
    beforeEach(() => {
      (offlineModeStore.getState as jest.Mock).mockReturnValue({ offlineMode: false });
    });

    it('shuffles all songs and plays', async () => {
      const songs = Array.from({ length: 10 }, (_, i) => ({
        id: `s${i}`, artist: 'A', artistId: 'ar1',
      }));
      mockArtistParts = { albums: [{ id: 'alb1' }] };
      (albumDetailStore.getState as jest.Mock).mockReturnValue({
        albums: { alb1: { album: { song: songs } } },
      });

      await playAllByArtist('ar1', 'A', true);

      expect(mockPlayTrack).toHaveBeenCalled();
      const [firstTrack, queue] = mockPlayTrack.mock.calls[0];
      expect(queue.length).toBe(10);
      expect(queue).toContain(firstTrack);
      expect(mockOverlayShowSuccess).toHaveBeenCalledWith('Shuffling all songs by A');
    });
  });

  describe('offline', () => {
    beforeEach(() => {
      (offlineModeStore.getState as jest.Mock).mockReturnValue({ offlineMode: true });
    });

    it('plays offline songs sorted by year when shuffle=false', async () => {
      (musicCacheStore.getState as jest.Mock).mockReturnValue({
        cachedItems: {
          alb1: { itemId: 'alb1', name: 'Album', coverArtId: 'cov', songIds: ['s1', 's2'] },
        },
        cachedSongs: {
          s1: { id: 's1', title: 'Song 1', artist: 'A', duration: 200, bytes: 1000 },
          s2: { id: 's2', title: 'Song 2', artist: 'A', duration: 180, bytes: 900 },
        },
      });

      await playAllByArtist('ar1', 'A', false);

      expect(mockPlayTrack).toHaveBeenCalled();
      const [, queue] = mockPlayTrack.mock.calls[0];
      expect(queue.length).toBe(2);
    });

    it('shows error when no offline songs match', async () => {
      (musicCacheStore.getState as jest.Mock).mockReturnValue({ cachedItems: {}, cachedSongs: {} });

      await playAllByArtist('ar1', 'A', false);

      expect(mockOverlayShowError).toHaveBeenCalledWith('No offline songs by A');
      expect(mockPlayTrack).not.toHaveBeenCalled();
    });
  });
});

describe('songItemId', () => {
  it('returns the deterministic synthetic item id', () => {
    expect(songItemId('abc')).toBe('song:abc');
    expect(songItemId('')).toBe('song:');
  });
});

describe('handleDownloadSong', () => {
  const mockEnqueue = mockEnqueueSongDownload as jest.Mock;

  it('no-ops on falsy song', async () => {
    await handleDownloadSong(undefined as any);
    await handleDownloadSong({} as any);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockOverlayShowSuccess).not.toHaveBeenCalled();
  });

  it('enqueues and shows success toast on happy path', async () => {
    const song = { id: 's1', title: 'Cool Song', artist: 'A' } as any;
    await handleDownloadSong(song);
    expect(mockEnqueue).toHaveBeenCalledWith(song);
    expect(mockOverlayShowSuccess).toHaveBeenCalledWith('Downloading "Cool Song"');
  });

  it('falls back to unknownSong when title is missing', async () => {
    const song = { id: 's1' } as any;
    await handleDownloadSong(song);
    expect(mockOverlayShowSuccess).toHaveBeenCalledWith('Downloading "Unknown Song"');
  });

  it('shows error overlay when enqueue throws', async () => {
    mockEnqueue.mockRejectedValueOnce(new Error('boom'));
    const song = { id: 's1', title: 'Cool Song' } as any;
    await handleDownloadSong(song);
    expect(mockOverlayShowError).toHaveBeenCalledWith('Download failed');
  });

  it('still fires enqueue when song is already cached (service short-circuits)', async () => {
    // The service layer handles the already-cached short-circuit. From the
    // more-options perspective we still call through and show a toast.
    const song = { id: 'cached', title: 'Cached' } as any;
    await handleDownloadSong(song);
    expect(mockEnqueue).toHaveBeenCalledWith(song);
    expect(mockOverlayShowSuccess).toHaveBeenCalled();
  });
});

describe('handleRemoveSongDownload', () => {
  const mockDelete = mockDeleteCachedItem as jest.Mock;
  const mockRemoveAlbumSong = mockRemoveCachedAlbumSong as jest.Mock;
  const mockGetState = musicCacheStore.getState as jest.Mock;

  /** Make `cachedItems` report the given ids as present. */
  const withCachedItems = (...ids: string[]) => {
    const cachedItems: Record<string, unknown> = {};
    for (const id of ids) cachedItems[id] = { type: 'album' };
    mockGetState.mockReturnValue({ cachedItems });
  };

  it('no-ops on falsy song', () => {
    handleRemoveSongDownload(undefined as any);
    handleRemoveSongDownload({} as any);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRemoveAlbumSong).not.toHaveBeenCalled();
  });

  it('deletes the song: item and shows a success toast', async () => {
    withCachedItems('song:s1');
    const song = { id: 's1', title: 'Cool Song' } as any;
    await handleRemoveSongDownload(song);
    expect(mockDelete).toHaveBeenCalledWith('song:s1');
    expect(mockOverlayShowSuccess).toHaveBeenCalledWith('Removed "Cool Song"');
  });

  it('falls back to unknownSong when title is missing', async () => {
    withCachedItems('song:s1');
    const song = { id: 's1' } as any;
    await handleRemoveSongDownload(song);
    expect(mockOverlayShowSuccess).toHaveBeenCalledWith('Removed "Unknown Song"');
  });

  it('removes the song from its parent album (reverts album to partial)', async () => {
    mockGetState.mockReturnValue({ cachedItems: {} }); // no explicit song: item
    mockRemoveAlbumSong.mockResolvedValueOnce(true);
    const song = { id: 's1', title: 'Cool Song', albumId: 'alb1' } as any;
    await handleRemoveSongDownload(song);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRemoveAlbumSong).toHaveBeenCalledWith('alb1', 's1');
    expect(mockOverlayShowSuccess).toHaveBeenCalledWith('Removed "Cool Song"');
  });

  it('shows error overlay when nothing was removed', async () => {
    mockGetState.mockReturnValue({ cachedItems: {} });
    mockRemoveAlbumSong.mockResolvedValueOnce(false);
    const song = { id: 's1', title: 'Cool Song', albumId: 'alb1' } as any;
    await handleRemoveSongDownload(song);
    expect(mockOverlayShowError).toHaveBeenCalledWith('Failed to load');
  });

  it('shows error overlay when delete throws', async () => {
    withCachedItems('song:s1');
    mockDelete.mockImplementationOnce(() => { throw new Error('nope'); });
    const song = { id: 's1', title: 'Cool Song' } as any;
    await handleRemoveSongDownload(song);
    expect(mockOverlayShowError).toHaveBeenCalledWith('Failed to load');
  });
});
