jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));
jest.mock('../../services/subsonicService');
jest.mock('../../services/imageCacheService', () => ({
  prefetchCoverArt: jest.fn(),
}));
// Row-table helpers are auto-mocked; default resolved values set in beforeEach.
jest.mock('../persistence/libraryAlbumsTable');

import {
  ensureCoverArtAuth,
  getAlbumsPageByName,
  probeEmptySearch3,
  searchAlbumsPage,
} from '../../services/subsonicService';
import {
  clearLibraryAlbumsAsync,
  countLibraryAlbumsAsync,
  deleteLibraryAlbumsAsync,
  hydrateLibraryAlbumsAsync,
  upsertLibraryAlbumsAsync,
} from '../persistence/libraryAlbumsTable';
import { albumLibraryStore } from '../albumLibraryStore';
import { albumListsStore } from '../albumListsStore';
import { layoutPreferencesStore } from '../layoutPreferencesStore';
import { offlineModeStore } from '../offlineModeStore';
import { syncStatusStore } from '../syncStatusStore';
import { kvStorage } from '../persistence/kvStorage';

const mockProbe = probeEmptySearch3 as jest.MockedFunction<typeof probeEmptySearch3>;
const mockSearchPage = searchAlbumsPage as jest.MockedFunction<typeof searchAlbumsPage>;
const mockGetAlbumsPageByName = getAlbumsPageByName as jest.MockedFunction<typeof getAlbumsPageByName>;
const mockCountRows = countLibraryAlbumsAsync as jest.MockedFunction<typeof countLibraryAlbumsAsync>;
const mockUpsert = upsertLibraryAlbumsAsync as jest.MockedFunction<typeof upsertLibraryAlbumsAsync>;
const mockHydrate = hydrateLibraryAlbumsAsync as jest.MockedFunction<typeof hydrateLibraryAlbumsAsync>;

const makeAlbum = (id: string, name: string, artist: string) =>
  ({ id, name, artist } as any);

/** Serve `albums` as pages sliced by offset for the FAST path (searchAlbumsPage,
 *  paged by albumOffset). The store advances by the actual page length and stops
 *  at 0, so any pageSize works even with tiny arrays. */
function serveFast(albums: any[], pageSize = 10000): void {
  mockSearchPage.mockImplementation(async (_count: number, offset: number) =>
    albums.slice(offset, offset + pageSize),
  );
}

/** Serve `albums` as pages for the BASIC path (getAlbumList2 alphabetical). */
function serveBasic(albums: any[], pageSize = 500): void {
  mockGetAlbumsPageByName.mockImplementation(async (_size: number, offset: number) =>
    albums.slice(offset, offset + pageSize),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  albumLibraryStore.setState({ albums: [], loading: false, error: null, hasHydrated: false });
  albumListsStore.setState({ recentlyAdded: [] } as any);
  layoutPreferencesStore.setState({ albumSortOrder: 'artist' });
  offlineModeStore.setState({ offlineMode: false } as any);
  syncStatusStore.setState({
    generation: 0,
    librarySyncPhase: 'idle',
    librarySyncComplete: false,
    librarySyncCount: 0,
    librarySyncCursor: 0,
    librarySyncLastFetchedAt: null,
    syncStrategy: null,
  } as any);
  mockCountRows.mockResolvedValue(0);
  mockHydrate.mockResolvedValue([]);
  mockUpsert.mockResolvedValue(undefined);
  // Default: empty-query search3 supported → fast path. Basic-path tests set false.
  mockProbe.mockResolvedValue(true);
  mockSearchPage.mockResolvedValue([]);
  mockGetAlbumsPageByName.mockResolvedValue([]);
  (clearLibraryAlbumsAsync as jest.Mock).mockReturnValue(undefined);
  (deleteLibraryAlbumsAsync as jest.Mock).mockResolvedValue(undefined);
  (ensureCoverArtAuth as jest.Mock).mockResolvedValue(undefined);
});

describe('albumLibraryStore — fast path (paged search3)', () => {
  it('probes, pages search3, sorts by artist, and marks complete', async () => {
    serveFast([makeAlbum('a2', 'Zebra', 'B Artist'), makeAlbum('a1', 'Alpha', 'A Artist')]);

    await albumLibraryStore.getState().fetchAllAlbums();

    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(mockSearchPage).toHaveBeenCalledWith(1000, 0);
    const state = albumLibraryStore.getState();
    expect(state.loading).toBe(false);
    expect(state.albums[0].artist).toBe('A Artist');
    expect(state.albums[1].artist).toBe('B Artist');
    expect(syncStatusStore.getState().syncStrategy).toBe('search3');
    expect(syncStatusStore.getState().librarySyncComplete).toBe(true);
  });

  it('pages across multiple search3 pages, persisting each and advancing the cursor', async () => {
    const albums = [
      makeAlbum('a1', 'A', 'A'),
      makeAlbum('a2', 'B', 'B'),
      makeAlbum('a3', 'C', 'C'),
      makeAlbum('a4', 'D', 'D'),
      makeAlbum('a5', 'E', 'E'),
    ];
    serveFast(albums, 2); // pages: [a1,a2] [a3,a4] [a5] []

    await albumLibraryStore.getState().fetchAllAlbums();

    expect(mockUpsert).toHaveBeenCalledTimes(3);
    expect(albumLibraryStore.getState().albums).toHaveLength(5);
    expect(syncStatusStore.getState().librarySyncComplete).toBe(true);
  });

  it('stops at the first empty page', async () => {
    serveFast([]);
    await albumLibraryStore.getState().fetchAllAlbums();
    expect(mockSearchPage).toHaveBeenCalledTimes(1);
    expect(albumLibraryStore.getState().albums).toEqual([]);
    expect(syncStatusStore.getState().librarySyncComplete).toBe(true);
  });

  it('resumes from the persisted cursor instead of restarting at 0', async () => {
    const albums = [
      makeAlbum('a1', 'A', 'A'),
      makeAlbum('a2', 'B', 'B'),
      makeAlbum('a3', 'C', 'C'),
      makeAlbum('a4', 'D', 'D'),
    ];
    // Prior fast run persisted 2 and set strategy+cursor.
    syncStatusStore.setState({ syncStrategy: 'search3', librarySyncCursor: 2 } as any);
    albumLibraryStore.setState({ albums: [albums[0], albums[1]] });
    serveFast(albums, 2);

    await albumLibraryStore.getState().fetchAllAlbums();

    expect(mockProbe).not.toHaveBeenCalled(); // strategy persisted → no re-probe
    expect(mockSearchPage).toHaveBeenNthCalledWith(1, 1000, 2);
    expect(albumLibraryStore.getState().albums).toHaveLength(4);
    expect(syncStatusStore.getState().librarySyncComplete).toBe(true);
  });

  it('switches to basic when the server ignores albumOffset (all-duplicate page)', async () => {
    const page = [makeAlbum('a1', 'A', 'A'), makeAlbum('a2', 'B', 'B')];
    mockSearchPage.mockImplementation(async () => page); // same page for any offset
    serveBasic([makeAlbum('a1', 'A', 'A'), makeAlbum('a2', 'B', 'B'), makeAlbum('a3', 'C', 'C')]);

    await albumLibraryStore.getState().fetchAllAlbums();

    // Detected non-paging → cleared + restarted on basic getAlbumList2.
    expect(clearLibraryAlbumsAsync).toHaveBeenCalled();
    expect(syncStatusStore.getState().syncStrategy).toBe('basic');
    expect(albumLibraryStore.getState().albums).toHaveLength(3);
    expect(syncStatusStore.getState().librarySyncComplete).toBe(true);
  });

  it('pauses (not complete) when offline mid-fetch', async () => {
    offlineModeStore.setState({ offlineMode: true } as any);
    serveFast([makeAlbum('a1', 'A', 'A')]);
    await albumLibraryStore.getState().fetchAllAlbums();
    expect(syncStatusStore.getState().librarySyncPhase).toBe('paused-offline');
    expect(syncStatusStore.getState().librarySyncComplete).toBe(false);
  });

  it('prevents duplicate/concurrent fetches', async () => {
    albumLibraryStore.setState({ loading: true });
    await albumLibraryStore.getState().fetchAllAlbums();
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('sets error on transport failure and leaves sync incomplete', async () => {
    mockSearchPage.mockRejectedValue(new Error('Network error'));
    await albumLibraryStore.getState().fetchAllAlbums();
    expect(albumLibraryStore.getState().error).toBe('Network error');
    expect(syncStatusStore.getState().librarySyncComplete).toBe(false);
  });
});

describe('albumLibraryStore — basic path (getAlbumList2, probe false)', () => {
  beforeEach(() => {
    mockProbe.mockResolvedValue(false);
  });

  it('paginates getAlbumList2 and completes', async () => {
    serveBasic([makeAlbum('a1', 'A', 'A'), makeAlbum('a2', 'B', 'B')]);
    await albumLibraryStore.getState().fetchAllAlbums();
    expect(mockSearchPage).not.toHaveBeenCalled();
    expect(syncStatusStore.getState().syncStrategy).toBe('basic');
    expect(albumLibraryStore.getState().albums).toHaveLength(2);
    expect(syncStatusStore.getState().librarySyncComplete).toBe(true);
  });

  it('resumes basic pagination from COUNT(*)', async () => {
    const albums = [makeAlbum('a1', 'A', 'A'), makeAlbum('a2', 'B', 'B'), makeAlbum('a3', 'C', 'C')];
    syncStatusStore.setState({ syncStrategy: 'basic' } as any);
    mockCountRows.mockResolvedValue(1);
    albumLibraryStore.setState({ albums: [albums[0]] });
    serveBasic(albums, 1);
    await albumLibraryStore.getState().fetchAllAlbums();
    expect(mockGetAlbumsPageByName).toHaveBeenNthCalledWith(1, 500, 1);
    expect(albumLibraryStore.getState().albums).toHaveLength(3);
  });
});

describe('albumLibraryStore — sorting', () => {
  it('sorts by title when albumSortOrder is title', async () => {
    layoutPreferencesStore.setState({ albumSortOrder: 'title' });
    serveFast([makeAlbum('a2', 'Zebra', 'A Artist'), makeAlbum('a1', 'Alpha', 'Z Artist')]);
    await albumLibraryStore.getState().fetchAllAlbums();
    expect(albumLibraryStore.getState().albums[0].name).toBe('Alpha');
    expect(albumLibraryStore.getState().albums[1].name).toBe('Zebra');
  });

  it('strips a leading "The " article when sorting by title', async () => {
    layoutPreferencesStore.setState({ albumSortOrder: 'title' });
    serveFast([
      makeAlbum('a1', 'The Wall', 'X'),
      makeAlbum('a2', 'Best Of', 'X'),
      makeAlbum('a3', 'Vampire Weekend', 'X'),
    ]);
    await albumLibraryStore.getState().fetchAllAlbums();
    expect(albumLibraryStore.getState().albums.map((a) => a.name)).toEqual([
      'Best Of',
      'Vampire Weekend',
      'The Wall',
    ]);
  });

  it('strips a leading "The " article when sorting by artist', async () => {
    serveFast([
      makeAlbum('a1', 'Album A', 'The Beatles'),
      makeAlbum('a2', 'Album B', 'Best Coast'),
      makeAlbum('a3', 'Album C', 'Vampire Weekend'),
    ]);
    await albumLibraryStore.getState().fetchAllAlbums();
    expect(albumLibraryStore.getState().albums.map((a) => a.artist)).toEqual([
      'The Beatles',
      'Best Coast',
      'Vampire Weekend',
    ]);
  });

  it('handles null artist/name during sort', async () => {
    serveFast([{ id: 'a1', name: 'Alpha', artist: null } as any, makeAlbum('a2', 'Zebra', 'A Artist')]);
    await albumLibraryStore.getState().fetchAllAlbums();
    expect(albumLibraryStore.getState().albums[0].id).toBe('a1');
  });

  it('resortAlbums re-sorts; no-op when empty', () => {
    albumLibraryStore.setState({
      albums: [makeAlbum('a2', 'Zebra', 'A'), makeAlbum('a1', 'Alpha', 'Z')],
    });
    layoutPreferencesStore.setState({ albumSortOrder: 'title' });
    albumLibraryStore.getState().resortAlbums();
    expect(albumLibraryStore.getState().albums[0].name).toBe('Alpha');
    albumLibraryStore.setState({ albums: [] });
    albumLibraryStore.getState().resortAlbums();
    expect(albumLibraryStore.getState().albums).toEqual([]);
  });

  it('re-sorts on albumSortOrder change (cross-store subscription)', () => {
    albumLibraryStore.setState({
      albums: [makeAlbum('a1', 'Alpha', 'Z Artist'), makeAlbum('a2', 'Zebra', 'A Artist')],
    });
    layoutPreferencesStore.getState().setAlbumSortOrder('title');
    expect(albumLibraryStore.getState().albums[0].name).toBe('Alpha');
  });
});

describe('albumLibraryStore — hydrate + seed', () => {
  it('hydrates from library_albums rows', async () => {
    mockHydrate.mockResolvedValue([makeAlbum('a2', 'Zebra', 'B'), makeAlbum('a1', 'Alpha', 'A')]);
    await albumLibraryStore.getState().hydrateFromDbAsync();
    const state = albumLibraryStore.getState();
    expect(state.hasHydrated).toBe(true);
    expect(state.albums.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('seeds from the legacy KV blob on first upgrade', async () => {
    mockHydrate.mockResolvedValue([]);
    kvStorage.setItem(
      'substreamer-album-library',
      JSON.stringify({ state: { albums: [makeAlbum('a1', 'A', 'A'), makeAlbum('a2', 'B', 'B')] } }),
    );
    await albumLibraryStore.getState().hydrateFromDbAsync();
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(albumLibraryStore.getState().albums).toHaveLength(2);
    expect(await kvStorage.getItem('substreamer-album-library')).toBeNull();
  });

  it('leaves the list empty with no rows and no blob', async () => {
    mockHydrate.mockResolvedValue([]);
    await albumLibraryStore.getState().hydrateFromDbAsync();
    expect(albumLibraryStore.getState().albums).toEqual([]);
    expect(albumLibraryStore.getState().hasHydrated).toBe(true);
  });
});

describe('albumLibraryStore — write-through + clear', () => {
  it('upsertAlbums merges, sorts, and writes rows through', () => {
    albumLibraryStore.setState({ albums: [makeAlbum('a1', 'A', 'A Artist')] });
    albumLibraryStore.getState().upsertAlbums([makeAlbum('a2', 'B', 'B Artist')]);
    expect(albumLibraryStore.getState().albums).toHaveLength(2);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('applyLocalPlay bumps stats and persists the album', () => {
    const now = '2026-04-22T10:00:00.000Z';
    albumLibraryStore.setState({ albums: [{ ...makeAlbum('a1', 'X', 'Y'), playCount: 3 } as any] });
    albumLibraryStore.getState().applyLocalPlay('a1', now);
    const updated = albumLibraryStore.getState().albums[0] as any;
    expect(updated.playCount).toBe(4);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('applyLocalPlay is a no-op (no write) for unknown/undefined album', () => {
    albumLibraryStore.setState({ albums: [makeAlbum('a1', 'X', 'Y')] });
    const before = albumLibraryStore.getState().albums;
    albumLibraryStore.getState().applyLocalPlay('unknown', 'now');
    albumLibraryStore.getState().applyLocalPlay(undefined, 'now');
    expect(albumLibraryStore.getState().albums).toBe(before);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

});
