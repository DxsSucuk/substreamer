let mockAlbumsState: Array<{ id: string }> = [];
let mockPlaylistsState: Array<{ id: string }> = [];
let mockOffline = false;
let mockReachable = true;

const mockFetchAllAlbums = jest.fn().mockResolvedValue(undefined);
const mockFetchAllPlaylists = jest.fn().mockResolvedValue(undefined);

jest.mock('../../store/albumLibraryStore', () => ({
  albumLibraryStore: {
    getState: () => ({ albums: mockAlbumsState, fetchAllAlbums: mockFetchAllAlbums }),
  },
}));
jest.mock('../../store/playlistLibraryStore', () => ({
  playlistLibraryStore: {
    getState: () => ({ playlists: mockPlaylistsState, fetchAllPlaylists: mockFetchAllPlaylists }),
  },
}));
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: () => ({ offlineMode: mockOffline }) },
}));
jest.mock('../../store/connectivityStore', () => ({
  connectivityStore: { getState: () => ({ isServerReachable: mockReachable }) },
}));

const mockEnqueueAlbum = jest.fn();
const mockEnqueuePlaylist = jest.fn();
jest.mock('../musicCacheService', () => ({
  enqueueAlbumDownload: (id: string) => mockEnqueueAlbum(id),
  enqueuePlaylistDownload: (id: string) => mockEnqueuePlaylist(id),
}));

import { enqueueFullLibraryDownload } from '../fullLibraryDownloadService';
import { fullLibraryDownloadStore } from '../../store/fullLibraryDownloadStore';

const calls: string[] = [];

beforeEach(() => {
  mockAlbumsState = [{ id: 'a1' }, { id: 'a2' }];
  mockPlaylistsState = [{ id: 'p1' }];
  mockOffline = false;
  mockReachable = true;
  calls.length = 0;
  mockEnqueueAlbum.mockReset();
  mockEnqueuePlaylist.mockReset();
  mockEnqueueAlbum.mockImplementation((id: string) => {
    calls.push(`a:${id}`);
    return Promise.resolve();
  });
  mockEnqueuePlaylist.mockImplementation((id: string) => {
    calls.push(`p:${id}`);
    return Promise.resolve();
  });
  mockFetchAllAlbums.mockClear();
  mockFetchAllPlaylists.mockClear();
  fullLibraryDownloadStore.getState().finish();
});

describe('enqueueFullLibraryDownload', () => {
  it('enqueues every album then every playlist (albums first)', async () => {
    await enqueueFullLibraryDownload();
    expect(mockFetchAllAlbums).toHaveBeenCalledTimes(1);
    expect(mockFetchAllPlaylists).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['a:a1', 'a:a2', 'p:p1']);
    expect(fullLibraryDownloadStore.getState().active).toBe(false);
  });

  it('bails out when offline (no fetch, no enqueue)', async () => {
    mockOffline = true;
    await enqueueFullLibraryDownload();
    expect(mockFetchAllAlbums).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('bails out when the server is unreachable', async () => {
    mockReachable = false;
    await enqueueFullLibraryDownload();
    expect(calls).toEqual([]);
  });

  it('does nothing if a run is already active', async () => {
    fullLibraryDownloadStore.getState().start();
    await enqueueFullLibraryDownload();
    expect(mockFetchAllAlbums).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('continues past a rejected album enqueue and reports the failure', async () => {
    mockEnqueueAlbum.mockImplementation((id: string) => {
      calls.push(`a:${id}`);
      return id === 'a1' ? Promise.reject(new Error('boom')) : Promise.resolve();
    });
    await enqueueFullLibraryDownload();
    expect(calls).toEqual(['a:a1', 'a:a2', 'p:p1']);
    // One album couldn't be queued — surfaced for the card, run still idle.
    expect(fullLibraryDownloadStore.getState().error).toBeTruthy();
    expect(fullLibraryDownloadStore.getState().active).toBe(false);
  });

  it('sets an error and does not queue when preparing fails', async () => {
    mockFetchAllAlbums.mockRejectedValueOnce(new Error('offline mid-prepare'));
    await enqueueFullLibraryDownload();
    expect(calls).toEqual([]);
    expect(fullLibraryDownloadStore.getState().error).toBeTruthy();
    expect(fullLibraryDownloadStore.getState().active).toBe(false);
  });

  it('leaves no error on a clean run', async () => {
    await enqueueFullLibraryDownload();
    expect(fullLibraryDownloadStore.getState().error).toBeNull();
  });

  it('stops adding once cancelled mid-run', async () => {
    mockEnqueueAlbum.mockImplementation((id: string) => {
      calls.push(`a:${id}`);
      fullLibraryDownloadStore.getState().cancel();
      return Promise.resolve();
    });
    await enqueueFullLibraryDownload();
    // First album enqueued; cancel halts the loop before a2 / playlists.
    expect(calls).toEqual(['a:a1']);
  });
});
