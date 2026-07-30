jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));
jest.mock('../../services/subsonicService');

import { ensureCoverArtAuth, getAllPlaylists, getApi } from '../../services/subsonicService';
import { countPlaylists } from '../../db/repository/playlists';
import { playlistLibraryStore } from '../playlistLibraryStore';
import { getDb } from '../persistence/db';

const mockGetAllPlaylists = getAllPlaylists as jest.MockedFunction<typeof getAllPlaylists>;
const mockGetApi = getApi as jest.MockedFunction<typeof getApi>;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  jest.clearAllMocks();
  // The prune only runs when the API actually answered — `getAllPlaylists` returns []
  // (not a throw) with no usable API, and pruning against that empties the table.
  mockGetApi.mockReturnValue({} as ReturnType<typeof getApi>);
  playlistLibraryStore.setState({ playlists: [], loading: false, error: null, lastFetchedAt: null });
  getDb()?.runSync('DELETE FROM playlists');
  getDb()?.runSync('DELETE FROM cached_items');
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

    it('dual-writes the normalized table and prunes server-side deletions', async () => {
      const db = getDb()!;
      mockGetAllPlaylists.mockResolvedValue([makePlaylist('p1', 'Chill'), makePlaylist('p2', 'Bangers')]);
      await playlistLibraryStore.getState().fetchAllPlaylists();
      expect(playlistLibraryStore.getState().playlists).toHaveLength(2); // array kept
      expect(await countPlaylists(db)).toBe(2); // normalized populated

      // a later fetch with p2 removed prunes it from normalized
      mockGetAllPlaylists.mockResolvedValue([makePlaylist('p1', 'Chill')]);
      await playlistLibraryStore.getState().fetchAllPlaylists();
      expect(await countPlaylists(db)).toBe(1);
    });

    it('does NOT prune when there is no usable API (offline / mid-logout)', async () => {
      const db = getDb()!;
      mockGetAllPlaylists.mockResolvedValue([makePlaylist('p1', 'Chill'), makePlaylist('p2', 'Bangers')]);
      await playlistLibraryStore.getState().fetchAllPlaylists();
      expect(await countPlaylists(db)).toBe(2);

      // getApi() null → getAllPlaylists resolves [] without throwing. Honouring that
      // empty set as "the server has no playlists" wiped the whole table.
      mockGetApi.mockReturnValue(null);
      mockGetAllPlaylists.mockResolvedValue([]);
      await playlistLibraryStore.getState().fetchAllPlaylists();
      expect(await countPlaylists(db)).toBe(2);
    });

    it('never prunes a downloaded playlist', async () => {
      const db = getDb()!;
      mockGetAllPlaylists.mockResolvedValue([makePlaylist('p1', 'Chill'), makePlaylist('p2', 'Bangers')]);
      await playlistLibraryStore.getState().fetchAllPlaylists();
      db.runSync(
        `INSERT OR REPLACE INTO cached_items
           (item_id, type, name, expected_song_count, last_sync_at, downloaded_at)
         VALUES ('p2', 'playlist', 'Bangers', 0, 0, 0)`,
      );

      // p2 gone from the server, but it is downloaded — its rows back the offline view.
      mockGetAllPlaylists.mockResolvedValue([makePlaylist('p1', 'Chill')]);
      await playlistLibraryStore.getState().fetchAllPlaylists();
      expect(await countPlaylists(db)).toBe(2);
    });

    it('removePlaylist deletes the normalized row', async () => {
      const db = getDb()!;
      mockGetAllPlaylists.mockResolvedValue([makePlaylist('p1', 'Chill'), makePlaylist('p2', 'Bangers')]);
      await playlistLibraryStore.getState().fetchAllPlaylists();
      playlistLibraryStore.getState().removePlaylist('p1');
      await tick(); // the normalized delete is fire-and-forget
      expect(await countPlaylists(db)).toBe(1);
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
