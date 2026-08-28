jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

/**
 * The playlist's track rows must open the options sheet with the
 * `playlist-detail` source — that source is what suppresses the per-song
 * "Remove Download" the playlist's own download claim would ignore.
 *
 * Only the prop handoff is under test, so the screen's chrome (lists,
 * navigation, artwork, data fetching) is stubbed down to the point where
 * `renderItem` runs.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

import type { Child } from '../../services/subsonicService';
import type { TrackRowProps } from '../../components/TrackRow';

const mockTrackRowProps: TrackRowProps[] = [];
jest.mock('../../components/TrackRow', () => ({
  TrackRow: (props: TrackRowProps) => {
    mockTrackRowProps.push(props);
    return null;
  },
}));

// Lists: render every row synchronously so `renderItem` actually runs.
jest.mock('@shopify/flash-list', () => {
  const { View } = require('react-native');
  return {
    FlashList: ({
      data,
      renderItem,
      ListHeaderComponent,
    }: {
      data: unknown[];
      renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
    }) => (
      <View>
        {ListHeaderComponent}
        {data.map((item, index) => (
          <View key={index}>{renderItem({ item, index })}</View>
        ))}
      </View>
    ),
  };
});
jest.mock('react-native-reorderable-list', () => {
  const { View } = require('react-native');
  const ReorderableList = () => <View />;
  return {
    __esModule: true,
    default: ReorderableList,
    ReorderableListItem: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    useReorderableDrag: () => jest.fn(),
  };
});

jest.mock('expo-router', () => {
  const { View } = require('react-native');
  const Toolbar = ({ children }: { children: React.ReactNode }) => <View>{children}</View>;
  Toolbar.Button = () => null;
  Toolbar.View = ({ children }: { children: React.ReactNode }) => <View>{children}</View>;
  return {
    Stack: { Toolbar },
    useLocalSearchParams: () => ({ id: 'p1' }),
    useNavigation: () => ({ setOptions: jest.fn() }),
  };
});

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      background: '#000',
      card: '#111',
      textPrimary: '#fff',
      textSecondary: '#888',
      border: '#333',
      inputBg: '#222',
      primary: '#1D9BF0',
      red: '#e91429',
    },
  }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../hooks/useTransitionComplete', () => ({ useTransitionComplete: () => true }));
jest.mock('../../hooks/useDownloadStatus', () => ({ useDownloadStatus: () => 'none' }));
jest.mock('../../hooks/useLayoutMode', () => ({ useLayoutMode: () => 'compact' }));
jest.mock('../../hooks/useRefreshControlKey', () => ({ useRefreshControlKey: () => 0 }));
jest.mock('../../hooks/useSongCoverArt', () => ({
  useSongCoverArt: () => undefined,
  resolveEntityCoverArt: () => undefined,
}));

jest.mock('../../components/CachedImage', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View /> };
});
jest.mock('../../components/MarqueeText', () => {
  const { Text } = require('react-native');
  return { MarqueeText: ({ children }: { children: React.ReactNode }) => <Text>{children}</Text> };
});
jest.mock('../../components/DetailScreenBackground', () => ({ DetailScreenBackground: () => null }));
jest.mock('../../components/BottomChrome', () => ({ BottomChrome: () => null }));
jest.mock('../../components/DownloadButton', () => ({ DownloadButton: () => null }));
jest.mock('../../components/MoreOptionsButton', () => ({ MoreOptionsButton: () => null }));
jest.mock('../../components/EmptyState', () => ({ EmptyState: () => null }));
jest.mock('../../components/DetailHeroButtons', () => ({
  PlayAllButton: () => null,
  ShufflePlayButton: () => null,
}));
jest.mock('../../components/SwipeableRow', () => {
  const { View } = require('react-native');
  return {
    SwipeableRow: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    closeOpenRow: jest.fn(),
  };
});

const playlist = {
  id: 'p1',
  name: 'Road Trip',
  songCount: 2,
  duration: 360,
  owner: 'tester',
  entry: [
    { id: 's1', title: 'First', artist: 'A', duration: 180 },
    { id: 's2', title: 'Second', artist: 'B', duration: 180 },
  ] as Child[],
};

jest.mock('../../services/detailFetchService', () => ({
  fetchPlaylistDetail: jest.fn(async () => playlist),
}));
jest.mock('../../services/musicCacheService', () => ({
  enqueuePlaylistDownload: jest.fn(),
  syncCachedPlaylistTracks: jest.fn(),
}));
jest.mock('../../services/imageCacheService', () => ({
  ensureCached: jest.fn(),
  refreshCoverArt: jest.fn(),
}));
jest.mock('../../services/playerService', () => ({ playTrack: jest.fn() }));
jest.mock('../../services/subsonicService', () => ({
  updatePlaylistDetails: jest.fn(),
  updatePlaylistOrder: jest.fn(),
}));

jest.mock('../../store/persistence/db', () => ({ getDb: () => null }));
jest.mock('../../db/repository/details', () => ({ getPlaylistDetail: jest.fn() }));
jest.mock('../../store/authStore', () => ({
  authStore: Object.assign(
    (sel: (s: { username: string }) => unknown) => sel({ username: 'tester' }),
    { getState: () => ({ username: 'tester' }) },
  ),
}));
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: Object.assign(
    (sel: (s: { offlineMode: boolean }) => unknown) => sel({ offlineMode: false }),
    { getState: () => ({ offlineMode: false }) },
  ),
}));
jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: Object.assign(
    (sel: (s: { cachedItems: Record<string, unknown> }) => unknown) => sel({ cachedItems: {} }),
    { getState: () => ({ cachedItems: {} }) },
  ),
}));
jest.mock('../../store/syncStatusStore', () => ({
  syncStatusStore: { getState: () => ({ bumpLibraryUpdated: jest.fn() }) },
}));
jest.mock('../../store/processingOverlayStore', () => ({
  processingOverlayStore: { getState: () => ({ show: jest.fn(), hide: jest.fn() }) },
  runWithOverlay: jest.fn(),
}));

import { PlaylistDetailScreen } from '../playlist-detail';

beforeEach(() => {
  mockTrackRowProps.length = 0;
});

describe('PlaylistDetailScreen — options-sheet source', () => {
  it('renders every track row with optionsSource="playlist-detail"', async () => {
    render(<PlaylistDetailScreen />);

    await waitFor(() => expect(mockTrackRowProps.length).toBeGreaterThanOrEqual(2));

    const ids = mockTrackRowProps.map((p) => p.track.id);
    expect(ids).toEqual(expect.arrayContaining(['s1', 's2']));
    for (const props of mockTrackRowProps) {
      expect(props.optionsSource).toBe('playlist-detail');
    }
  });
});
