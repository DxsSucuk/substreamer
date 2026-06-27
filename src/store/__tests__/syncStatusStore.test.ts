import { syncStatusStore } from '../syncStatusStore';

jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));

function resetStore() {
  syncStatusStore.setState({
    detailSyncPhase: 'idle',
    detailSyncTotal: 0,
    detailSyncCompleted: 0,
    bannerDismissedAt: null,
    lastChangeDetectionAt: null,
    lastKnownServerUrl: null,
    lastKnownServerSongCount: null,
    lastKnownServerScanTime: null,
    lastKnownNewestAlbumId: null,
    lastKnownNewestAlbumCreated: null,
    generation: 0,
    inFlight: new Map(),
  });
}

beforeEach(() => {
  resetStore();
});

describe('syncStatusStore', () => {
  describe('detail sync phase', () => {
    it('setDetailSyncPhase updates the phase', () => {
      syncStatusStore.getState().setDetailSyncPhase('syncing');
      expect(syncStatusStore.getState().detailSyncPhase).toBe('syncing');
    });

    it('setDetailSyncPhase("idle") clears bannerDismissedAt', () => {
      syncStatusStore.setState({ bannerDismissedAt: 123 });
      syncStatusStore.getState().setDetailSyncPhase('idle');
      expect(syncStatusStore.getState().bannerDismissedAt).toBe(null);
    });

    it('non-idle phase does not clear bannerDismissedAt', () => {
      syncStatusStore.setState({ bannerDismissedAt: 123 });
      syncStatusStore.getState().setDetailSyncPhase('paused-offline');
      expect(syncStatusStore.getState().bannerDismissedAt).toBe(123);
    });
  });

  describe('total / completed', () => {
    it('setDetailSyncTotal stores the total and resets completed', () => {
      syncStatusStore.setState({ detailSyncCompleted: 42 });
      syncStatusStore.getState().setDetailSyncTotal(1000);
      expect(syncStatusStore.getState().detailSyncTotal).toBe(1000);
      expect(syncStatusStore.getState().detailSyncCompleted).toBe(0);
    });

    it('incrementDetailSyncCompleted bumps by one', () => {
      expect(syncStatusStore.getState().detailSyncCompleted).toBe(0);
      syncStatusStore.getState().incrementDetailSyncCompleted();
      expect(syncStatusStore.getState().detailSyncCompleted).toBe(1);
      syncStatusStore.getState().incrementDetailSyncCompleted();
      expect(syncStatusStore.getState().detailSyncCompleted).toBe(2);
    });
  });

  describe('last-known markers', () => {
    it('setLastKnownMarkers merges a partial update', () => {
      syncStatusStore.getState().setLastKnownMarkers({
        lastKnownServerUrl: 'https://a.example',
        lastKnownServerSongCount: 1234,
      });
      const s = syncStatusStore.getState();
      expect(s.lastKnownServerUrl).toBe('https://a.example');
      expect(s.lastKnownServerSongCount).toBe(1234);
      expect(s.lastKnownServerScanTime).toBe(null);
    });

    it('successive setLastKnownMarkers preserve prior fields', () => {
      syncStatusStore.getState().setLastKnownMarkers({ lastKnownServerSongCount: 1 });
      syncStatusStore.getState().setLastKnownMarkers({ lastKnownNewestAlbumId: 'abc' });
      const s = syncStatusStore.getState();
      expect(s.lastKnownServerSongCount).toBe(1);
      expect(s.lastKnownNewestAlbumId).toBe('abc');
    });
  });

  describe('banner dismissal', () => {
    it('setBannerDismissedAt stores the timestamp', () => {
      syncStatusStore.getState().setBannerDismissedAt(999);
      expect(syncStatusStore.getState().bannerDismissedAt).toBe(999);
    });
  });

  describe('reset', () => {
    it('resetDetailSync clears only the sync-progress fields', () => {
      syncStatusStore.setState({
        detailSyncPhase: 'syncing',
        detailSyncTotal: 500,
        bannerDismissedAt: 42,
        lastKnownServerSongCount: 999,
      });
      syncStatusStore.getState().resetDetailSync();
      const s = syncStatusStore.getState();
      expect(s.detailSyncPhase).toBe('idle');
      expect(s.detailSyncTotal).toBe(0);
      expect(s.bannerDismissedAt).toBe(null);
      // Last-known markers preserved (they have separate lifecycle).
      expect(s.lastKnownServerSongCount).toBe(999);
    });
  });

  describe('generation counter', () => {
    it('bumpGeneration increments by one', () => {
      expect(syncStatusStore.getState().generation).toBe(0);
      syncStatusStore.getState().bumpGeneration();
      expect(syncStatusStore.getState().generation).toBe(1);
      syncStatusStore.getState().bumpGeneration();
      expect(syncStatusStore.getState().generation).toBe(2);
    });
  });

  describe('inFlight map', () => {
    it('setInFlight / getInFlight round-trip', () => {
      const promise = Promise.resolve();
      syncStatusStore.getState().setInFlight('albums', promise);
      expect(syncStatusStore.getState().getInFlight('albums')).toBe(promise);
      expect(syncStatusStore.getState().getInFlight('artists')).toBeUndefined();
    });

    it('clearInFlight removes the scope entry', () => {
      const promise = Promise.resolve();
      syncStatusStore.getState().setInFlight('albums', promise);
      syncStatusStore.getState().clearInFlight('albums');
      expect(syncStatusStore.getState().getInFlight('albums')).toBeUndefined();
    });

    it('multiple scopes coexist', () => {
      const a = Promise.resolve();
      const b = Promise.resolve();
      syncStatusStore.getState().setInFlight('albums', a);
      syncStatusStore.getState().setInFlight('artists', b);
      expect(syncStatusStore.getState().getInFlight('albums')).toBe(a);
      expect(syncStatusStore.getState().getInFlight('artists')).toBe(b);
    });
  });
});
