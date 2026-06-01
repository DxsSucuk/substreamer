import { moreOptionsStore } from '../moreOptionsStore';

import { type AlbumID3, type Child } from '../../services/subsonicService';

const mockSong = { id: 's1', title: 'Song' } as Child;
const mockAlbum = { id: 'a1', name: 'Album' } as AlbumID3;

beforeEach(() => {
  moreOptionsStore.setState({ visible: false, entity: null, source: 'default' });
});

describe('moreOptionsStore', () => {
  it('show sets entity and defaults source to default', () => {
    moreOptionsStore.getState().show({ type: 'song', item: mockSong });
    const state = moreOptionsStore.getState();
    expect(state.visible).toBe(true);
    expect(state.entity).toEqual({ type: 'song', item: mockSong });
    expect(state.source).toBe('default');
  });

  it('show with explicit source sets source', () => {
    moreOptionsStore.getState().show({ type: 'album', item: mockAlbum }, 'player-phone-portrait');
    expect(moreOptionsStore.getState().source).toBe('player-phone-portrait');
  });

  it('show with playerpanel source sets source', () => {
    moreOptionsStore.getState().show({ type: 'song', item: mockSong }, 'player-tablet-splitview');
    expect(moreOptionsStore.getState().source).toBe('player-tablet-splitview');
  });

  it('show with playerexpanded source sets source', () => {
    moreOptionsStore.getState().show({ type: 'song', item: mockSong }, 'player-tablet-landscape');
    expect(moreOptionsStore.getState().source).toBe('player-tablet-landscape');
  });

  it('hide resets all fields including source', () => {
    moreOptionsStore.getState().show({ type: 'song', item: mockSong }, 'player-phone-portrait');
    moreOptionsStore.getState().hide();
    const state = moreOptionsStore.getState();
    expect(state.visible).toBe(false);
    expect(state.entity).toBeNull();
    expect(state.source).toBe('default');
  });

  // #154 fix — hideAndAwait closes the sheet and returns a promise that
  // resolves only when the BottomSheet signals onCloseComplete. Action
  // handlers `await` it before opening a chained modal/alert, so the
  // chained modal mounts AFTER the sheet's native Modal is fully gone.
  describe('hideAndAwait + _signalCloseComplete', () => {
    it('hideAndAwait resets state and waits for the signal to resolve', async () => {
      moreOptionsStore.getState().show({ type: 'song', item: mockSong }, 'player-phone-portrait');

      const promise = moreOptionsStore.getState().hideAndAwait();
      // State is already cleared synchronously
      expect(moreOptionsStore.getState().visible).toBe(false);
      expect(moreOptionsStore.getState().entity).toBeNull();

      // Promise hasn't resolved yet
      let resolved = false;
      promise.then(() => { resolved = true; });
      await Promise.resolve();
      expect(resolved).toBe(false);

      // Fire the close-complete signal
      moreOptionsStore.getState()._signalCloseComplete();
      await promise;
      expect(resolved).toBe(true);
    });

    it('_signalCloseComplete drains every waiter at once', async () => {
      const p1 = moreOptionsStore.getState().hideAndAwait();
      const p2 = moreOptionsStore.getState().hideAndAwait();
      const p3 = moreOptionsStore.getState().hideAndAwait();

      moreOptionsStore.getState()._signalCloseComplete();

      await expect(Promise.all([p1, p2, p3])).resolves.toEqual([
        undefined, undefined, undefined,
      ]);
    });

    it('a signal with no waiters is a no-op', () => {
      expect(() => moreOptionsStore.getState()._signalCloseComplete()).not.toThrow();
    });

    it('hideAndAwait safety-net resolves even if _signalCloseComplete never fires', async () => {
      jest.useFakeTimers();
      try {
        const promise = moreOptionsStore.getState().hideAndAwait();
        let resolved = false;
        promise.then(() => { resolved = true; });

        // Without the signal: simulate the bug path where RAF stalls and
        // _signalCloseComplete never gets called. The safety-net setTimeout
        // (500ms) should fire and resolve the promise anyway.
        await Promise.resolve();
        expect(resolved).toBe(false);

        jest.advanceTimersByTime(500);
        await Promise.resolve();
        expect(resolved).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('safety-net does not double-resolve when signal fires normally', async () => {
      jest.useFakeTimers();
      try {
        const promise = moreOptionsStore.getState().hideAndAwait();
        const resolveSpy = jest.fn();
        promise.then(resolveSpy);

        // Signal fires first (normal path).
        moreOptionsStore.getState()._signalCloseComplete();
        await Promise.resolve();
        expect(resolveSpy).toHaveBeenCalledTimes(1);

        // Safety-net fires later — should be a no-op (resolver already removed).
        jest.advanceTimersByTime(500);
        await Promise.resolve();
        expect(resolveSpy).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
