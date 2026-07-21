jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));
jest.mock('../../services/subsonicService');

import { ensureCoverArtAuth, getAllPlaylists } from '../../services/subsonicService';
import { playlistLibraryStore } from '../playlistLibraryStore';

const mockGetAllPlaylists = getAllPlaylists as jest.MockedFunction<typeof getAllPlaylists>;

beforeEach(() => {
  jest.clearAllMocks();
  playlistLibraryStore.setState({ playlists: [], loading: false, error: null, lastFetchedAt: null });
});

const makePlaylist = (id: string, name: string) => ({ id, name } as any);

describe('playlistLibraryStore', () => {
  describe('fetchAllPlaylists', () => {
    it('fetches and stores playlists', async () => {
      mockGetAllPlaylists.mockResolvedValue([makePlaylist('p1', 'Chill')]);

      await playlistLibraryStore.getState().fetchAllPlaylists();

      expect(ensureCoverArtAuth).toHaveBeenCalled();
      const state = playlistLibraryStore.getState();
      expect(state.playlists).toHaveLength(1);
      expect(state.loading).toBe(false);
      expect(state.lastFetchedAt).toBeGreaterThan(0);
    });

    it('prevents duplicate fetches', async () => {
      playlistLibraryStore.setState({ loading: true });
      await playlistLibraryStore.getState().fetchAllPlaylists();
      expect(mockGetAllPlaylists).not.toHaveBeenCalled();
    });

    it('sets error on failure', async () => {
      mockGetAllPlaylists.mockRejectedValue(new Error('Network error'));
      await playlistLibraryStore.getState().fetchAllPlaylists();
      expect(playlistLibraryStore.getState().error).toBe('Network error');
    });

    it('sets generic error for non-Error throws', async () => {
      mockGetAllPlaylists.mockRejectedValue('string');
      await playlistLibraryStore.getState().fetchAllPlaylists();
      expect(playlistLibraryStore.getState().error).toBe('Failed to load playlists');
    });
  });

  describe('removePlaylist', () => {
    it('removes playlist by id', () => {
      playlistLibraryStore.setState({
        playlists: [makePlaylist('p1', 'A'), makePlaylist('p2', 'B')],
      });
      playlistLibraryStore.getState().removePlaylist('p1');
      expect(playlistLibraryStore.getState().playlists).toEqual([makePlaylist('p2', 'B')]);
    });

    it('no-ops for non-existing id', () => {
      playlistLibraryStore.setState({ playlists: [makePlaylist('p1', 'A')] });
      playlistLibraryStore.getState().removePlaylist('nonexistent');
      expect(playlistLibraryStore.getState().playlists).toHaveLength(1);
    });
  });

  describe('patchPlaylistMetadata', () => {
    it('patches name/comment/public in place', () => {
      playlistLibraryStore.setState({
        playlists: [
          { id: 'p1', name: 'Old', comment: 'c', public: false } as any,
          makePlaylist('p2', 'B'),
        ],
      });
      playlistLibraryStore
        .getState()
        .patchPlaylistMetadata('p1', { name: 'New', comment: 'd', public: true });
      const [p1, p2] = playlistLibraryStore.getState().playlists as any[];
      expect(p1).toMatchObject({ id: 'p1', name: 'New', comment: 'd', public: true });
      expect(p2).toEqual(makePlaylist('p2', 'B'));
    });

    it('only patches provided fields', () => {
      playlistLibraryStore.setState({
        playlists: [{ id: 'p1', name: 'Old', comment: 'c', public: true } as any],
      });
      playlistLibraryStore.getState().patchPlaylistMetadata('p1', { name: 'New' });
      const [p1] = playlistLibraryStore.getState().playlists as any[];
      expect(p1).toMatchObject({ name: 'New', comment: 'c', public: true });
    });

    it('can clear a comment with an empty string', () => {
      playlistLibraryStore.setState({
        playlists: [{ id: 'p1', name: 'A', comment: 'c' } as any],
      });
      playlistLibraryStore.getState().patchPlaylistMetadata('p1', { comment: '' });
      expect((playlistLibraryStore.getState().playlists[0] as any).comment).toBe('');
    });

    it('no-ops (same reference) for a non-existing id', () => {
      const before = [makePlaylist('p1', 'A')];
      playlistLibraryStore.setState({ playlists: before });
      playlistLibraryStore.getState().patchPlaylistMetadata('nope', { name: 'X' });
      expect(playlistLibraryStore.getState().playlists).toBe(before);
    });
  });

  describe('clearPlaylists', () => {
    it('resets all state', () => {
      playlistLibraryStore.setState({
        playlists: [makePlaylist('p1', 'A')],
        loading: true,
        error: 'err',
        lastFetchedAt: 1000,
      });
      playlistLibraryStore.getState().clearPlaylists();
      const state = playlistLibraryStore.getState();
      expect(state.playlists).toEqual([]);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
      expect(state.lastFetchedAt).toBeNull();
    });
  });
});
