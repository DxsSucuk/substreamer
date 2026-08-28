let mockAlbumsState: Array<{ id: string }> = [];
let mockPlaylistsState: Array<{ id: string }> = [];
let mockOffline = false;
let mockReachable = true;

const mockFetchAllPlaylists = jest.fn().mockResolvedValue(undefined);

jest.mock('../normalizedLibrarySync', () => ({
  refreshPlaylistLibrary: (...a: unknown[]) => mockFetchAllPlaylists(...a),
}));
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: () => ({ offlineMode: mockOffline }) },
}));
jest.mock('../../store/connectivityStore', () => ({
  connectivityStore: { getState: () => ({ isServerReachable: mockReachable }) },
}));

// Enumeration reads the normalized ids; derive them from the same mock state the
// fetch actions "populate" so the queueing order + totals behave as before.
jest.mock('../../store/persistence/db', () => ({ getDb: () => ({}) }));
jest.mock('../../db/repository/albums', () => ({
  ...jest.requireActual('../../db/repository/albums'),
  listAlbumIds: jest.fn(async () => mockAlbumsState.map((a) => a.id)),
}));
jest.mock('../../db/repository/playlists', () => ({
  ...jest.requireActual('../../db/repository/playlists'),
  listPlaylistIds: jest.fn(async () => mockPlaylistsState.map((p) => p.id)),
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
  mockFetchAllPlaylists.mockClear();
  fullLibraryDownloadStore.getState().finish();
});

describe('enqueueFullLibraryDownload', () => {
  it('enqueues every album then every playlist (albums first)', async () => {
    await enqueueFullLibraryDownload();
    expect(mockFetchAllPlaylists).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['a:a1', 'a:a2', 'p:p1']);
    expect(fullLibraryDownloadStore.getState().active).toBe(false);
  });

  it('bails out when offline (no fetch, no enqueue)', async () => {
    mockOffline = true;
    await enqueueFullLibraryDownload();
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
