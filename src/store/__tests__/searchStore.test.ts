jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));

// Explicit factory mock (not automock): searchService's transitive imports pull
// in the SQLite layer, which the automock can't shape cleanly here.
const mockSearchLibrary = jest.fn();
jest.mock('../../services/searchService', () => ({
  searchLibrary: (...a: unknown[]) => mockSearchLibrary(...a),
}));

import { searchStore } from '../searchStore';

beforeEach(() => {
  mockSearchLibrary.mockReset();
  searchStore.getState().clear();
  mockSearchLibrary.mockResolvedValue({ albums: [], artists: [], songs: [] });
});

describe('searchStore', () => {
  describe('setQuery', () => {
    it('updates query text', () => {
      searchStore.getState().setQuery('radiohead');
      expect(searchStore.getState().query).toBe('radiohead');
    });
  });

  describe('performSearch — empty query', () => {
    it('clears results and does not call the search service', async () => {
      searchStore.setState({ query: '   ' });
      await searchStore.getState().performSearch();
      expect(mockSearchLibrary).not.toHaveBeenCalled();
      expect(searchStore.getState().results).toEqual({
        albums: [],
        artists: [],
        songs: [],
      });
    });
  });

  describe('performSearch', () => {
    it('delegates to searchLibrary (with a stale-check) and stores results', async () => {
      const results = {
        albums: [{ id: 'a1', name: 'Album' }],
        artists: [{ id: 'ar1', name: 'Artist' }],
        songs: [{ id: 's1', title: 'Song' }],
      };
      mockSearchLibrary.mockResolvedValue(results as any);
      searchStore.setState({ query: 'test' });

      await searchStore.getState().performSearch();

      expect(mockSearchLibrary).toHaveBeenCalledWith('test', expect.any(Function));
      expect(searchStore.getState().results).toEqual(results);
      expect(searchStore.getState().loading).toBe(false);
    });

    it('sets error on failure', async () => {
      mockSearchLibrary.mockRejectedValue(new Error('Network error'));
      searchStore.setState({ query: 'test' });

      await searchStore.getState().performSearch();

      expect(searchStore.getState().error).toBe('Network error');
      expect(searchStore.getState().loading).toBe(false);
    });

    it('sets generic error for non-Error throws', async () => {
      mockSearchLibrary.mockRejectedValue('string');
      searchStore.setState({ query: 'test' });
      await searchStore.getState().performSearch();
      expect(searchStore.getState().error).toBe('Search failed');
    });

    it('reconciles ratings from search results', async () => {
      const results = {
        albums: [{ id: 'a1', name: 'Album', userRating: 4 }],
        artists: [{ id: 'ar1', name: 'Artist' }],
        songs: [{ id: 's1', title: 'Song', userRating: 5 }],
      };
      mockSearchLibrary.mockResolvedValue(results as any);
      searchStore.setState({ query: 'test' });

      const { ratingStore } = require('../ratingStore');
      const reconcileSpy = jest.spyOn(ratingStore.getState(), 'reconcileRatings');

      await searchStore.getState().performSearch();

      expect(reconcileSpy).toHaveBeenCalledWith([
        { id: 'a1', serverRating: 4 },
        { id: 'ar1', serverRating: 0 },
        { id: 's1', serverRating: 5 },
      ]);
      reconcileSpy.mockRestore();
    });

    it('ignores a stale response when the query changed mid-flight', async () => {
      // searchLibrary resolves for the ORIGINAL query, but the user has since
      // typed further — the store must not overwrite state with the stale hit.
      mockSearchLibrary.mockResolvedValue({
        albums: [],
        artists: [],
        songs: [{ id: 's1', title: 'Stale' }],
      } as any);
      searchStore.setState({ query: 'old' });
      const p = searchStore.getState().performSearch();
      searchStore.setState({ query: 'new' });
      await p;
      expect(searchStore.getState().results.songs).toEqual([]);
    });
  });

  describe('overlay and header', () => {
    it('showOverlay sets isOverlayVisible', () => {
      searchStore.getState().showOverlay();
      expect(searchStore.getState().isOverlayVisible).toBe(true);
    });

    it('hideOverlay clears isOverlayVisible', () => {
      searchStore.setState({ isOverlayVisible: true });
      searchStore.getState().hideOverlay();
      expect(searchStore.getState().isOverlayVisible).toBe(false);
    });

    it('setHeaderHeight updates height', () => {
      searchStore.getState().setHeaderHeight(64);
      expect(searchStore.getState().headerHeight).toBe(64);
    });
  });

  describe('clear', () => {
    it('resets all search state', () => {
      searchStore.setState({
        query: 'test',
        results: { albums: [{ id: 'a1' }] as any, artists: [], songs: [] },
        loading: true,
        error: 'err',
        isOverlayVisible: true,
      });
      searchStore.getState().clear();
      const state = searchStore.getState();
      expect(state.query).toBe('');
      expect(state.results).toEqual({ albums: [], artists: [], songs: [] });
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
      expect(state.isOverlayVisible).toBe(false);
    });
  });
});
