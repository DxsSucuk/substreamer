/**
 * Detail fetch: the ONE shared path the app screens, the download path and the
 * CarPlay/Android-Auto headless service all use. These cover the local-first
 * fallback — an unreachable server is not the same thing as the user asking to be
 * offline, and before the fallback existed a headless drill-down into an album or
 * playlist we already held locally resolved to an empty track list.
 */
import { fetchAlbumDetail, fetchPlaylistDetail } from '../detailFetchService';

const mockGetAlbum = jest.fn();
const mockGetPlaylist = jest.fn();
jest.mock('../subsonicService', () => ({
  ensureCoverArtAuth: () => Promise.resolve(),
  getAlbum: (id: string) => mockGetAlbum(id),
  getPlaylist: (id: string) => mockGetPlaylist(id),
  getArtist: jest.fn(),
  getArtistInfo2: jest.fn(),
  getTopSongs: jest.fn(),
  getVariousArtistsBio: jest.fn(),
  isVariousArtists: () => false,
  VARIOUS_ARTISTS_COVER_ART_ID: 'va',
}));
jest.mock('../musicbrainzService', () => ({
  getArtistBiography: jest.fn(),
  searchArtistMBID: jest.fn(),
}));
jest.mock('../imageCacheService', () => ({
  ensureCached: () => Promise.resolve(),
  prefetchCoverArt: jest.fn(),
}));

let mockOfflineMode = false;
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: () => ({ offlineMode: mockOfflineMode }) },
}));

const mockLocalAlbum = jest.fn();
const mockLocalPlaylist = jest.fn();
jest.mock('../../db/repository/details', () => ({
  getAlbumDetail: (_db: unknown, id: string) => mockLocalAlbum(id),
  getPlaylistDetail: (_db: unknown, id: string) => mockLocalPlaylist(id),
  getArtistDetail: jest.fn(),
}));

jest.mock('../../store/persistence/db', () => ({
  getDb: () => ({}),
  serializeDbWrite: (fn: () => Promise<void>) => fn(),
}));

// The success path upserts into the normalized model; these tests are about which
// SOURCE wins, so stub the writes rather than standing up a real DB.
jest.mock('../../db/repository/albums', () => ({ upsertAlbums: () => Promise.resolve(0) }));
jest.mock('../../db/repository/songs', () => ({
  upsertSongs: () => Promise.resolve(0),
  deleteAlbumSongsNotIn: () => Promise.resolve(),
}));
jest.mock('../../db/repository/playlists', () => ({
  upsertPlaylists: () => Promise.resolve(0),
  setPlaylistSongs: jest.fn(),
}));
jest.mock('../../db/repository/artists', () => ({
  listArtistsWithTopSongs: jest.fn(),
  setArtistDetailMeta: jest.fn(),
  setArtistTopSongs: jest.fn(),
  upsertArtistInfo: jest.fn(),
  upsertArtists: jest.fn(),
}));

beforeEach(() => {
  mockOfflineMode = false;
  mockGetAlbum.mockReset();
  mockGetPlaylist.mockReset();
  mockLocalAlbum.mockReset();
  mockLocalPlaylist.mockReset();
});

describe('fetchAlbumDetail — local first', () => {
  it('answers from the local database WITHOUT any server round trip', async () => {
    mockLocalAlbum.mockResolvedValue({
      album: { id: 'al1', name: 'Cached' },
      songs: [{ id: 's1' }, { id: 's2' }],
    });

    const result = await fetchAlbumDetail('al1', { prefetchCovers: false });

    expect(result?.song).toHaveLength(2);
    expect(result?.name).toBe('Cached');
    // The point of the local database: no pointless round trip when we have the data,
    // whether or not the server happens to be reachable.
    expect(mockGetAlbum).not.toHaveBeenCalled();
  });

  it('treats a row with no songs as a MISS and fetches', async () => {
    // The `albums` row exists for every album in the library after a list sync, so
    // "row present" is not "tracks present".
    mockLocalAlbum.mockResolvedValue({ album: { id: 'al1', name: 'Row only' }, songs: [] });
    mockGetAlbum.mockResolvedValue({ id: 'al1', name: 'Fetched', song: [{ id: 's9' }] });

    const result = await fetchAlbumDetail('al1', { prefetchCovers: false });

    expect(mockGetAlbum).toHaveBeenCalled();
    expect(result?.name).toBe('Fetched');
  });

  it('fetches when nothing is cached', async () => {
    mockLocalAlbum.mockResolvedValue(null);
    mockGetAlbum.mockResolvedValue({ id: 'al1', name: 'Fetched', song: [{ id: 's9' }] });

    expect((await fetchAlbumDetail('al1', { prefetchCovers: false }))?.name).toBe('Fetched');
  });

  it('force bypasses the cache, but still falls back to it when the server cannot answer', async () => {
    mockGetAlbum.mockResolvedValue({ id: 'al1', name: 'Fresh', song: [{ id: 's9' }] });
    mockLocalAlbum.mockResolvedValue({
      album: { id: 'al1', name: 'Stale' },
      songs: [{ id: 's1' }],
    });

    expect((await fetchAlbumDetail('al1', { prefetchCovers: false, force: true }))?.name)
      .toBe('Fresh');

    mockGetAlbum.mockResolvedValue(null);
    expect((await fetchAlbumDetail('al1', { prefetchCovers: false, force: true }))?.name)
      .toBe('Stale');
  });

  it('returns null when nothing is cached and the server cannot answer', async () => {
    mockGetAlbum.mockResolvedValue(null);
    mockLocalAlbum.mockResolvedValue(null);

    expect(await fetchAlbumDetail('al1', { prefetchCovers: false })).toBeNull();
  });

  it('does not touch the network in offline mode', async () => {
    mockOfflineMode = true;
    mockLocalAlbum.mockResolvedValue({ album: { id: 'al1', name: 'Cached' }, songs: [{ id: 's1' }] });

    const result = await fetchAlbumDetail('al1', { prefetchCovers: false });

    expect(mockGetAlbum).not.toHaveBeenCalled();
    expect(result?.song).toHaveLength(1);
  });
});

describe('fetchPlaylistDetail — local first', () => {
  it('answers from the local database WITHOUT any server round trip', async () => {
    mockLocalPlaylist.mockResolvedValue({
      playlist: { id: 'p1', name: 'Cached' },
      entry: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    });

    const result = await fetchPlaylistDetail('p1', { prefetchCovers: false });

    expect(result?.entry).toHaveLength(3);
    expect(result?.name).toBe('Cached');
    expect(mockGetPlaylist).not.toHaveBeenCalled();
  });

  it('force bypasses the cache, but still falls back to it when the server cannot answer', async () => {
    mockGetPlaylist.mockResolvedValue({ id: 'p1', name: 'Fresh', entry: [{ id: 's9' }] });
    mockLocalPlaylist.mockResolvedValue({
      playlist: { id: 'p1', name: 'Stale' },
      entry: [{ id: 's1' }],
    });

    expect((await fetchPlaylistDetail('p1', { prefetchCovers: false, force: true }))?.name)
      .toBe('Fresh');

    mockGetPlaylist.mockResolvedValue(null);
    expect((await fetchPlaylistDetail('p1', { prefetchCovers: false, force: true }))?.name)
      .toBe('Stale');
  });

  it('returns null when nothing is cached and the server cannot answer', async () => {
    mockGetPlaylist.mockResolvedValue(null);
    mockLocalPlaylist.mockResolvedValue(null);

    expect(await fetchPlaylistDetail('p1', { prefetchCovers: false })).toBeNull();
  });
});
