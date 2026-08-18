import { act, render } from '@testing-library/react-native';

jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('../../services/imageCacheService', () => ({
  ensureCached: jest.fn(),
  prefetchCoverArt: jest.fn(),
}));

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (init: number) => ({ value: init }),
    useAnimatedStyle: (fn: () => object) => fn(),
    withSpring: (val: number) => val,
    withTiming: (val: number) => val,
    withDelay: (_ms: number, val: number) => val,
    Easing: { in: () => () => 0, out: () => () => 0, inOut: () => () => 0, cubic: () => 0 },
  };
});

import { LibrarySyncBanner } from '../LibrarySyncBanner';
import { syncStatusStore } from '../../store/syncStatusStore';

function setSyncState(patch: Partial<ReturnType<typeof syncStatusStore.getState>>) {
  syncStatusStore.setState(patch as any);
}

beforeEach(() => {
  setSyncState({
    detailSyncPhase: 'idle',
    detailSyncTotal: 0,
    bannerDismissedAt: null,
  });
});

describe('LibrarySyncBanner', () => {
  it('renders null when phase is idle', () => {
    const { queryByText } = render(<LibrarySyncBanner />);
    // "null" in this harness means no pill label rendered
    expect(queryByText(/Syncing songs/i)).toBeNull();
  });

  it('hides on tiny libraries below the display threshold', () => {
    setSyncState({ detailSyncPhase: 'syncing', detailSyncTotal: 10 });
    const { queryByText } = render(<LibrarySyncBanner />);
    expect(queryByText(/Syncing songs/i)).toBeNull();
  });

  it('names the SONG phase as songs, not as library work', () => {
    setSyncState({ detailSyncPhase: 'syncing', detailSyncTotal: 500 });
    const { getByText } = render(<LibrarySyncBanner />);
    expect(getByText(/Syncing songs/i)).toBeTruthy();
  });

  it('shows the paused-offline variant with its own copy', () => {
    setSyncState({ detailSyncPhase: 'paused-offline', detailSyncTotal: 500 });
    const { getByText } = render(<LibrarySyncBanner />);
    expect(getByText(/paused/i)).toBeTruthy();
  });

  it('shows the error variant with tap-to-retry copy', () => {
    setSyncState({ detailSyncPhase: 'error', detailSyncTotal: 500 });
    const { getByText } = render(<LibrarySyncBanner />);
    expect(getByText(/retry/i)).toBeTruthy();
  });

  it('stays hidden once dismissed for the session', () => {
    setSyncState({ detailSyncPhase: 'syncing', detailSyncTotal: 500 });
    setSyncState({ bannerDismissedAt: Date.now() });
    const { queryByText } = render(<LibrarySyncBanner />);
    expect(queryByText(/Syncing songs/i)).toBeNull();
  });

  it('reappears when phase returns to idle (resetting bannerDismissedAt via setDetailSyncPhase)', () => {
    setSyncState({ detailSyncPhase: 'syncing', detailSyncTotal: 500 });
    syncStatusStore.getState().setBannerDismissedAt(Date.now());
    // Transition to idle clears bannerDismissedAt as a side effect.
    act(() => {
      syncStatusStore.getState().setDetailSyncPhase('idle');
    });
    expect(syncStatusStore.getState().bannerDismissedAt).toBe(null);
  });

  it('shows the album-phase cursor, so a pass over known albums still moves', () => {
    // The album phase reports the walk's position, not a row count: a row count
    // cannot tell "re-writing albums we already hold" from "doing nothing".
    setSyncState({ librarySyncPhase: 'fetching', librarySyncCursor: 1200 });
    const { getByText } = render(<LibrarySyncBanner />);
    expect(getByText(/1200/)).toBeTruthy();
  });

  it('suppresses the album phase on a library below the display threshold', () => {
    setSyncState({ librarySyncPhase: 'fetching', librarySyncCursor: 10 });
    const { queryByText } = render(<LibrarySyncBanner />);
    expect(queryByText(/Syncing albums/i)).toBeNull();
  });

  it('surfaces a sync paused by request errors, so it does not just look stopped', () => {
    // Distinct from paused-offline: nothing will resume this one on its own, so the
    // banner has to say why and stay tappable through to the sync card.
    setSyncState({ librarySyncPhase: 'paused-error', librarySyncCursor: 1200 });
    const { getByText } = render(<LibrarySyncBanner />);
    expect(getByText(/paused/i)).toBeTruthy();
  });
});
