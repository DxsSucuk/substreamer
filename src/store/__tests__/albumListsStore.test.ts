jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));
jest.mock('../../services/subsonicService');
jest.mock('../../services/imageCacheService', () => ({
  prefetchCoverArt: jest.fn(),
}));
jest.mock('../layoutPreferencesStore', () => ({
  layoutPreferencesStore: {
    getState: jest.fn(() => ({ listLength: 20 })),
  },
}));

const mockOffline = { offlineMode: false };
jest.mock('../offlineModeStore', () => ({
  offlineModeStore: { getState: () => mockOffline },
}));

const mockConnectivity = { isInternetReachable: true, isServerReachable: true };
jest.mock('../connectivityStore', () => ({
  connectivityStore: { getState: () => mockConnectivity },
}));

import {
  ensureCoverArtAuth,
  getRecentlyAddedAlbums,
  getRecentlyPlayedAlbums,
  getFrequentlyPlayedAlbums,
  getRandomAlbums,
} from '../../services/subsonicService';
import { albumListsStore } from '../albumListsStore';

const mockGetRecentlyAdded = getRecentlyAddedAlbums as jest.MockedFunction<typeof getRecentlyAddedAlbums>;
const mockGetRecentlyPlayed = getRecentlyPlayedAlbums as jest.MockedFunction<typeof getRecentlyPlayedAlbums>;
const mockGetFrequentlyPlayed = getFrequentlyPlayedAlbums as jest.MockedFunction<typeof getFrequentlyPlayedAlbums>;
const mockGetRandom = getRandomAlbums as jest.MockedFunction<typeof getRandomAlbums>;

const album = (id: string) => ({ id, name: `Album ${id}` } as any);

beforeEach(() => {
  jest.clearAllMocks();
  albumListsStore.setState({
    recentlyAdded: [],
    recentlyPlayed: [],
    frequentlyPlayed: [],
    randomSelection: [],
    lastRefreshedAt: 0,
  });
  mockOffline.offlineMode = false;
  mockConnectivity.isInternetReachable = true;
  mockConnectivity.isServerReachable = true;
});

describe('albumListsStore', () => {
  describe('refreshRecentlyAdded', () => {
    it('fetches and sets recentlyAdded', async () => {
      mockGetRecentlyAdded.mockResolvedValue([album('1')]);
      await albumListsStore.getState().refreshRecentlyAdded();
      expect(ensureCoverArtAuth).toHaveBeenCalled();
      expect(albumListsStore.getState().recentlyAdded).toEqual([album('1')]);
    });

    it('leaves existing state on failure', async () => {
      albumListsStore.setState({ recentlyAdded: [album('old')] });
      mockGetRecentlyAdded.mockRejectedValue(new Error('fail'));
      await albumListsStore.getState().refreshRecentlyAdded();
      expect(albumListsStore.getState().recentlyAdded).toEqual([album('old')]);
    });
  });

  describe('refreshRecentlyPlayed', () => {
    it('fetches and sets recentlyPlayed', async () => {
      mockGetRecentlyPlayed.mockResolvedValue([album('2')]);
      await albumListsStore.getState().refreshRecentlyPlayed();
      expect(albumListsStore.getState().recentlyPlayed).toEqual([album('2')]);
    });

    it('leaves existing state on failure', async () => {
      albumListsStore.setState({ recentlyPlayed: [album('old')] });
      mockGetRecentlyPlayed.mockRejectedValue(new Error('fail'));
      await albumListsStore.getState().refreshRecentlyPlayed();
      expect(albumListsStore.getState().recentlyPlayed).toEqual([album('old')]);
    });
  });

  describe('refreshFrequentlyPlayed', () => {
    it('fetches and sets frequentlyPlayed', async () => {
      mockGetFrequentlyPlayed.mockResolvedValue([album('3')]);
      await albumListsStore.getState().refreshFrequentlyPlayed();
      expect(albumListsStore.getState().frequentlyPlayed).toEqual([album('3')]);
    });

    it('leaves existing state on failure', async () => {
      albumListsStore.setState({ frequentlyPlayed: [album('old')] });
      mockGetFrequentlyPlayed.mockRejectedValue(new Error('fail'));
      await albumListsStore.getState().refreshFrequentlyPlayed();
      expect(albumListsStore.getState().frequentlyPlayed).toEqual([album('old')]);
    });
  });

  describe('refreshRandomSelection', () => {
    it('fetches and sets randomSelection', async () => {
      mockGetRandom.mockResolvedValue([album('4')]);
      await albumListsStore.getState().refreshRandomSelection();
      expect(albumListsStore.getState().randomSelection).toEqual([album('4')]);
    });

    it('leaves existing state on failure', async () => {
      albumListsStore.setState({ randomSelection: [album('old')] });
      mockGetRandom.mockRejectedValue(new Error('fail'));
      await albumListsStore.getState().refreshRandomSelection();
      expect(albumListsStore.getState().randomSelection).toEqual([album('old')]);
    });
  });

  describe('refreshAll', () => {
    it('fetches all lists in parallel', async () => {
      mockGetRecentlyAdded.mockResolvedValue([album('1')]);
      mockGetRecentlyPlayed.mockResolvedValue([album('2')]);
      mockGetFrequentlyPlayed.mockResolvedValue([album('3')]);
      mockGetRandom.mockResolvedValue([album('4')]);

      await albumListsStore.getState().refreshAll();

      const state = albumListsStore.getState();
      expect(state.recentlyAdded).toEqual([album('1')]);
      expect(state.recentlyPlayed).toEqual([album('2')]);
      expect(state.frequentlyPlayed).toEqual([album('3')]);
      expect(state.randomSelection).toEqual([album('4')]);
    });

    it('leaves existing state on failure', async () => {
      albumListsStore.setState({ recentlyAdded: [album('existing')] });
      mockGetRecentlyAdded.mockRejectedValue(new Error('fail'));

      await albumListsStore.getState().refreshAll();

      expect(albumListsStore.getState().recentlyAdded).toEqual([album('existing')]);
    });
  });

  describe('listLength integration', () => {
    it('passes configured listLength to API calls', async () => {
      const { layoutPreferencesStore } = require('../layoutPreferencesStore');
      (layoutPreferencesStore.getState as jest.Mock).mockReturnValue({ listLength: 50 });

      mockGetRecentlyAdded.mockResolvedValue([album('1')]);
      await albumListsStore.getState().refreshRecentlyAdded();
      expect(mockGetRecentlyAdded).toHaveBeenCalledWith(50);
    });

    it('refreshAll uses same listLength for all fetches', async () => {
      const { layoutPreferencesStore } = require('../layoutPreferencesStore');
      (layoutPreferencesStore.getState as jest.Mock).mockReturnValue({ listLength: 100 });

      mockGetRecentlyAdded.mockResolvedValue([]);
      mockGetRecentlyPlayed.mockResolvedValue([]);
      mockGetFrequentlyPlayed.mockResolvedValue([]);
      mockGetRandom.mockResolvedValue([]);

      await albumListsStore.getState().refreshAll();

      expect(mockGetRecentlyAdded).toHaveBeenCalledWith(100);
      expect(mockGetRecentlyPlayed).toHaveBeenCalledWith(100);
      expect(mockGetFrequentlyPlayed).toHaveBeenCalledWith(100);
      expect(mockGetRandom).toHaveBeenCalledWith(100);
    });
  });

  // #148 — home-screen lists weren't auto-refreshing on launch/foreground.
  // refreshAllIfDue is the gated entry point: respects offline, server
  // reachability, and a minimum-since-last-refresh interval to avoid
  // refresh storms on background/foreground flips.
  describe('refreshAllIfDue', () => {
    beforeEach(() => {
      mockGetRecentlyAdded.mockResolvedValue([]);
      mockGetRecentlyPlayed.mockResolvedValue([]);
      mockGetFrequentlyPlayed.mockResolvedValue([]);
      mockGetRandom.mockResolvedValue([]);
    });

    it('refreshes and records lastRefreshedAt when never refreshed before', async () => {
      const before = Date.now();
      const ran = await albumListsStore.getState().refreshAllIfDue(60_000);
      expect(ran).toBe(true);
      expect(mockGetRecentlyAdded).toHaveBeenCalled();
      expect(albumListsStore.getState().lastRefreshedAt).toBeGreaterThanOrEqual(before);
    });

    it('skips when offline mode is on', async () => {
      mockOffline.offlineMode = true;
      const ran = await albumListsStore.getState().refreshAllIfDue(60_000);
      expect(ran).toBe(false);
      expect(mockGetRecentlyAdded).not.toHaveBeenCalled();
    });

    it('skips when server is unreachable', async () => {
      mockConnectivity.isServerReachable = false;
      const ran = await albumListsStore.getState().refreshAllIfDue(60_000);
      expect(ran).toBe(false);
      expect(mockGetRecentlyAdded).not.toHaveBeenCalled();
    });

    it('skips when internet is unreachable', async () => {
      mockConnectivity.isInternetReachable = false;
      const ran = await albumListsStore.getState().refreshAllIfDue(60_000);
      expect(ran).toBe(false);
      expect(mockGetRecentlyAdded).not.toHaveBeenCalled();
    });

    it('skips when last refresh was within the interval', async () => {
      // Pretend we just refreshed 1s ago, interval is 60s.
      albumListsStore.setState({ lastRefreshedAt: Date.now() - 1_000 });
      const ran = await albumListsStore.getState().refreshAllIfDue(60_000);
      expect(ran).toBe(false);
      expect(mockGetRecentlyAdded).not.toHaveBeenCalled();
    });

    it('refreshes when last refresh was longer ago than the interval', async () => {
      // 10 minutes ago, interval 5 minutes.
      albumListsStore.setState({ lastRefreshedAt: Date.now() - 10 * 60_000 });
      const ran = await albumListsStore.getState().refreshAllIfDue(5 * 60_000);
      expect(ran).toBe(true);
      expect(mockGetRecentlyAdded).toHaveBeenCalled();
    });

    it('bypasses the time gate when interval is 0 (boot path)', async () => {
      // Just refreshed 1ms ago — interval 0 means "always go".
      albumListsStore.setState({ lastRefreshedAt: Date.now() - 1 });
      const ran = await albumListsStore.getState().refreshAllIfDue(0);
      expect(ran).toBe(true);
      expect(mockGetRecentlyAdded).toHaveBeenCalled();
    });

    it('still respects offline mode when interval is 0', async () => {
      mockOffline.offlineMode = true;
      const ran = await albumListsStore.getState().refreshAllIfDue(0);
      expect(ran).toBe(false);
      expect(mockGetRecentlyAdded).not.toHaveBeenCalled();
    });
  });

  describe('direct setters', () => {
    it('setRecentlyAdded updates list', () => {
      albumListsStore.getState().setRecentlyAdded([album('x')]);
      expect(albumListsStore.getState().recentlyAdded).toEqual([album('x')]);
    });

    it('setRecentlyPlayed updates list', () => {
      albumListsStore.getState().setRecentlyPlayed([album('x')]);
      expect(albumListsStore.getState().recentlyPlayed).toEqual([album('x')]);
    });

    it('setFrequentlyPlayed updates list', () => {
      albumListsStore.getState().setFrequentlyPlayed([album('x')]);
      expect(albumListsStore.getState().frequentlyPlayed).toEqual([album('x')]);
    });

    it('setRandomSelection updates list', () => {
      albumListsStore.getState().setRandomSelection([album('x')]);
      expect(albumListsStore.getState().randomSelection).toEqual([album('x')]);
    });
  });
});
