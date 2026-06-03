jest.mock('../subsonicService');
jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));
jest.mock('../imageCacheService', () => ({
  ensureCached: jest.fn().mockResolvedValue(undefined),
  prefetchCoverArt: jest.fn(),
}));

import { ensureCoverArtAuth, search3 } from '../subsonicService';
import { albumLibraryStore } from '../../store/albumLibraryStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import { playlistLibraryStore } from '../../store/playlistLibraryStore';
import {
  performOnlineSearch,
  performOfflineSearch,
  getOfflineSongsByGenre,
} from '../searchService';

const mockSearch3 = search3 as jest.MockedFunction<typeof search3>;
const mockEnsureCoverArtAuth = ensureCoverArtAuth as jest.MockedFunction<typeof ensureCoverArtAuth>;

function resetStores() {
  musicCacheStore.setState({ cachedItems: {}, cachedSongs: {} } as any);
  albumLibraryStore.setState({ albums: [] });
  playlistLibraryStore.setState({ playlists: [] });
}

/**
 * Seed `musicCacheStore` from a compact {itemId: {name, tracks: [...]}}
 * description. Each track may carry genre / genres which get serialised
 * into the rawJson envelope so the production path can read them via
 * `getSongEnvelope()` exactly as it does at runtime.
 */
function seedCache(
  oldItems: Record<string, { name: string; tracks: any[] }>,
) {
  const cachedItems: Record<string, any> = {};
  const cachedSongs: Record<string, any> = {};
  for (const [itemId, item] of Object.entries(oldItems)) {
    const songIds: string[] = [];
    for (const t of item.tracks) {
      if (!t?.id) continue;
      if (!songIds.includes(t.id)) songIds.push(t.id);
      if (!cachedSongs[t.id]) {
        cachedSongs[t.id] = {
          id: t.id,
          title: t.title,
          artist: t.artist,
          albumId: t.albumId ?? itemId,
          duration: t.duration ?? 0,
          rawJson: JSON.stringify({
            id: t.id,
            title: t.title,
            artist: t.artist,
            albumId: t.albumId ?? itemId,
            duration: t.duration ?? 0,
            isDir: false,
            ...(t.genre ? { genre: t.genre } : {}),
            ...(t.genres ? { genres: t.genres } : {}),
          }),
        };
      }
    }
    cachedItems[itemId] = {
      itemId,
      name: item.name,
      songIds,
    };
  }
  musicCacheStore.setState({ cachedItems, cachedSongs } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  resetStores();
});

describe('performOnlineSearch', () => {
  it('calls ensureCoverArtAuth then search3', async () => {
    const results = {
      albums: [{ id: 'a1', name: 'Album' }],
      artists: [{ id: 'ar1', name: 'Artist' }],
      songs: [{ id: 's1', title: 'Song' }],
    };
    mockSearch3.mockResolvedValue(results as any);

    const result = await performOnlineSearch('test');

    expect(mockEnsureCoverArtAuth).toHaveBeenCalled();
    expect(mockSearch3).toHaveBeenCalledWith('test');
    expect(result).toEqual(results);
  });

  it('propagates errors from search3', async () => {
    mockSearch3.mockRejectedValue(new Error('Network error'));
    await expect(performOnlineSearch('test')).rejects.toThrow('Network error');
  });
});

describe('performOfflineSearch', () => {
  it('searches cached albums by name', async () => {
    seedCache({ a1: { name: 'Test Album', tracks: [] } });
    albumLibraryStore.setState({
      albums: [{ id: 'a1', name: 'Test Album', artist: 'Artist' }] as any,
    });

    const result = await performOfflineSearch('test');

    expect(result.albums).toHaveLength(1);
    expect(result.albums[0].id).toBe('a1');
  });

  it('searches cached albums by artist name', async () => {
    seedCache({ a1: { name: 'Album', tracks: [] } });
    albumLibraryStore.setState({
      albums: [{ id: 'a1', name: 'Album', artist: 'Radiohead' }] as any,
    });

    expect((await performOfflineSearch('radiohead')).albums).toHaveLength(1);
  });

  it('excludes non-cached albums', async () => {
    albumLibraryStore.setState({
      albums: [{ id: 'a1', name: 'Test Album', artist: 'Artist' }] as any,
    });

    expect((await performOfflineSearch('test')).albums).toHaveLength(0);
  });

  it('includes cached playlists as album-shaped results', async () => {
    seedCache({ p1: { name: 'My Playlist', tracks: [] } });
    playlistLibraryStore.setState({
      playlists: [
        { id: 'p1', name: 'My Playlist', owner: 'user', coverArt: 'c1', songCount: 5, duration: 1000, created: '2024-01-01' },
      ] as any,
    });

    expect((await performOfflineSearch('my')).albums.some((a) => a.id === 'p1')).toBe(true);
  });

  it('searches cached songs by title', async () => {
    seedCache({
      a1: {
        name: 'Album',
        tracks: [
          { id: 't1', title: 'Matching Song', artist: 'Artist', duration: 200 },
          { id: 't2', title: 'Other', artist: 'Nobody', duration: 180 },
        ],
      },
    });

    const result = await performOfflineSearch('matching');

    expect(result.songs).toHaveLength(1);
    expect(result.songs[0].title).toBe('Matching Song');
  });

  it('searches cached songs by artist', async () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Song', artist: 'Radiohead', duration: 200 }] },
    });

    expect((await performOfflineSearch('radiohead')).songs).toHaveLength(1);
  });

  it('deduplicates songs by id across multiple cached items', async () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Dup Song', artist: 'A', duration: 200 }] },
      p1: { name: 'Playlist', tracks: [{ id: 't1', title: 'Dup Song', artist: 'A', duration: 200 }] },
    });

    expect((await performOfflineSearch('dup')).songs).toHaveLength(1);
  });

  it('populates albumId on returned songs so cover-art lookup resolves via entity ID', async () => {
    seedCache({
      a1: {
        name: 'Album',
        tracks: [{ id: 't1', title: 'Track', artist: 'A', duration: 200, albumId: 'parent-album' }],
      },
    });

    expect((await performOfflineSearch('track')).songs[0].albumId).toBe('parent-album');
  });

  it('populates album name from parent item', async () => {
    seedCache({
      a1: { name: 'Parent Item Name', tracks: [{ id: 't1', title: 'Track', artist: 'A', duration: 200 }] },
    });

    expect((await performOfflineSearch('track')).songs[0].album).toBe('Parent Item Name');
  });

  it('always returns empty artists array', async () => {
    expect((await performOfflineSearch('anything')).artists).toEqual([]);
  });

  it('returns empty results for no matches', async () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Song', artist: 'Artist', duration: 200 }] },
    });
    albumLibraryStore.setState({
      albums: [{ id: 'a1', name: 'Album', artist: 'Artist' }] as any,
    });

    const result = await performOfflineSearch('zzzznotfound');
    expect(result.albums).toHaveLength(0);
    expect(result.songs).toHaveLength(0);
  });

  it('handles album with undefined artist gracefully', async () => {
    seedCache({ a1: { name: 'Album', tracks: [] } });
    albumLibraryStore.setState({
      albums: [{ id: 'a1', name: 'Album' }] as any,
    });

    expect((await performOfflineSearch('someartist')).albums).toHaveLength(0);
  });
});

describe('getOfflineSongsByGenre', () => {
  it('returns cached songs matching genre (via genre field)', () => {
    seedCache({
      a1: {
        name: 'Album',
        tracks: [
          { id: 't1', title: 'Song', artist: 'A', duration: 200, genre: 'Rock' },
          { id: 't2', title: 'Other', artist: 'B', duration: 180, genre: 'Jazz' },
        ],
      },
    });

    const result = getOfflineSongsByGenre('Rock');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('t1');
  });

  it('matches genre case-insensitively', () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200, genre: 'ROCK' }] },
    });

    expect(getOfflineSongsByGenre('rock')).toHaveLength(1);
  });

  it('matches via genres array with {name} objects (OpenSubsonic)', () => {
    seedCache({
      a1: {
        name: 'Album',
        tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200, genres: [{ name: 'Electronic' }, { name: 'Ambient' }] }],
      },
    });

    expect(getOfflineSongsByGenre('ambient')).toHaveLength(1);
  });

  it('matches via genres array with plain strings (defensive)', () => {
    seedCache({
      a1: {
        name: 'Album',
        tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200, genres: ['Electronic', 'Ambient'] }],
      },
    });

    expect(getOfflineSongsByGenre('ambient')).toHaveLength(1);
  });

  it('only includes songs present in cachedSongs', () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Cached', artist: 'A', duration: 200, genre: 'Rock' }] },
    });
    // Stamp a stray songId onto the cached item that has no matching cachedSongs row.
    const state = musicCacheStore.getState();
    musicCacheStore.setState({
      ...state,
      cachedItems: {
        ...state.cachedItems,
        a1: { ...state.cachedItems.a1, songIds: ['t1', 't99'] },
      },
    } as any);

    const result = getOfflineSongsByGenre('Rock');
    expect(result.map((s) => s.id)).toEqual(['t1']);
  });

  it('deduplicates songs across multiple cached items', () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200, genre: 'Rock' }] },
      p1: { name: 'Playlist', tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200, genre: 'Rock' }] },
    });

    expect(getOfflineSongsByGenre('Rock')).toHaveLength(1);
  });

  it('returns empty array when no songs match genre', () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200, genre: 'Rock' }] },
    });

    expect(getOfflineSongsByGenre('Classical')).toHaveLength(0);
  });

  it('returns empty array when no cached items', () => {
    expect(getOfflineSongsByGenre('Rock')).toHaveLength(0);
  });

  it('does not match songs without genre or genres field', () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200 }] },
    });

    expect(getOfflineSongsByGenre('Rock')).toHaveLength(0);
  });
});
