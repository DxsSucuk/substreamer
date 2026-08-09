/**
 * The landscape player is root-mounted (`app/_layout.tsx`) and stays mounted
 * while collapsed, so its lyrics fetch is gated on `tabletLayoutStore
 * .playerExpanded` rather than on the mount. Plan step 5.3.
 */
jest.mock('@/store/persistence/kvStorage', () => require('@/store/persistence/__mocks__/kvStorage'));

jest.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'dark',
    colors: {
      background: '#000000',
      card: '#1e1e1e',
      textPrimary: '#ffffff',
      textSecondary: '#888888',
      primary: '#ff6600',
      border: '#333333',
      label: '#aaaaaa',
      red: '#ff0000',
      inputBg: '#222222',
    },
  }),
}));

jest.mock('@/hooks/useCanSkip', () => ({
  useCanSkip: () => ({ canSkipNext: true, canSkipPrevious: true }),
}));

jest.mock('@/hooks/useCoverGradient', () => ({
  useCoverGradient: () => ({
    gradientColors: ['#111111', '#000000'],
    gradientLocations: [0, 1],
    gradientOpacity: { value: 1 },
  }),
}));

jest.mock('@/hooks/useSongCoverArt', () => ({
  useSongCoverArt: () => 'cover-1',
}));

jest.mock('@/hooks/usePlaybackState', () => ({
  usePlaybackState: () => ({ isPlaying: true, isBuffering: false }),
}));

jest.mock('@/hooks/usePlayerActions', () => ({
  usePlayerActions: () => ({
    handleSeek: jest.fn(),
    handleQueueItemPress: jest.fn(),
    handleQueueItemLongPress: jest.fn(),
    handleShareQueue: jest.fn(),
    handleClearQueue: jest.fn(),
  }),
}));

jest.mock('@/hooks/useShuffleOverlay', () => ({
  useShuffleOverlay: () => ({
    shuffling: false,
    handleShuffle: jest.fn(),
    overlayStyle: {},
    spinStyle: {},
  }),
}));

// Album info has its own gate (`rightPanelMode === 'info'`) and its own store —
// stubbed so this suite only exercises the lyrics gate.
jest.mock('@/hooks/usePlayerAlbumInfo', () => ({
  usePlayerAlbumInfo: () => ({
    entry: undefined,
    loading: false,
    error: null,
    refreshing: false,
    handleRetry: jest.fn(),
    handleRefresh: jest.fn(),
  }),
}));

jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native');
  return { LinearGradient: (props: object) => <View {...props} /> };
});

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (init: number) => ({ value: init }),
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: (val: number) => val,
    withSpring: (val: number) => val,
    cancelAnimation: jest.fn(),
    interpolate: (val: number, _input: number[], output: number[]) =>
      val === 0 ? output[0] : output[1],
    Extrapolation: { CLAMP: 'clamp' },
    Easing: { out: (e: unknown) => e, cubic: (t: number) => t, inOut: (e: unknown) => e },
    runOnJS: (fn: Function) => fn,
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('@/components/CachedImage', () => {
  const { View } = require('react-native');
  return { CachedImage: () => <View testID="cover" /> };
});

jest.mock('@/components/MarqueeText', () => {
  const { Text } = require('react-native');
  return { MarqueeText: ({ children }: { children: React.ReactNode }) => <Text>{children}</Text> };
});

jest.mock('@/components/BookmarkButton', () => {
  const { View } = require('react-native');
  return { BookmarkButton: () => <View testID="bookmark-button" /> };
});

jest.mock('@/components/FavoriteButton', () => {
  const { View } = require('react-native');
  return { FavoriteButton: () => <View testID="favorite-button" /> };
});

jest.mock('@/components/MoreOptionsButton', () => {
  const { View } = require('react-native');
  return { MoreOptionsButton: () => <View testID="more-options" /> };
});

jest.mock('@/components/PlaybackRateButton', () => {
  const { View } = require('react-native');
  return { PlaybackRateButton: () => <View testID="rate-button" /> };
});

jest.mock('@/components/PlayerProgressBar', () => {
  const { View } = require('react-native');
  return { PlayerProgressBar: () => <View testID="progress-bar" /> };
});

jest.mock('@/components/QueueItemRow', () => {
  const { Text } = require('react-native');
  return { QueueItemRow: ({ track }: { track: { title: string } }) => <Text>{track.title}</Text> };
});

jest.mock('@/components/RepeatButton', () => {
  const { View } = require('react-native');
  return { RepeatButton: () => <View testID="repeat-button" /> };
});

jest.mock('@/components/ShuffleButton', () => {
  const { View } = require('react-native');
  return { ShuffleButton: () => <View testID="shuffle-button" /> };
});

jest.mock('@/components/ShuffleOverlay', () => {
  const { View } = require('react-native');
  return { ShuffleOverlay: () => <View testID="shuffle-overlay" /> };
});

jest.mock('@/components/SkipIntervalButton', () => {
  const { View } = require('react-native');
  return { SkipIntervalButton: () => <View testID="skip-interval" /> };
});

jest.mock('@/components/SleepTimerButton', () => {
  const { View } = require('react-native');
  return { SleepTimerButton: () => <View testID="sleep-timer-button" /> };
});

jest.mock('@/components/SleepTimerCapsule', () => {
  const { View } = require('react-native');
  return { SleepTimerCapsule: () => <View testID="sleep-timer-capsule" /> };
});

jest.mock('@/components/SwipeableRow', () => ({
  closeOpenRow: jest.fn(),
}));

jest.mock('@/components/AlbumInfoContent', () => {
  const { Text } = require('react-native');
  return { AlbumInfoContent: () => <Text>AlbumInfoContent</Text> };
});

jest.mock('@/components/LyricsContent', () => {
  const { Text } = require('react-native');
  return { LyricsContent: () => <Text>LyricsContent</Text> };
});

jest.mock('@/store/lyricsStore', () => {
  const fetchLyrics = jest.fn();
  const state = {
    entries: {},
    loading: {},
    errors: {},
    fetchLyrics,
    clearLyrics: jest.fn(),
  };
  const store = (selector: (s: typeof state) => unknown) => selector(state);
  store.getState = () => state;
  store.setState = jest.fn();
  return { lyricsStore: store };
});

jest.mock('@/services/playerService', () => ({
  retryPlayback: jest.fn(),
  skipToNext: jest.fn(),
  skipToPrevious: jest.fn(),
  togglePlayPause: jest.fn(),
}));

jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    FlashList: React.forwardRef(function MockFlashList(
      { data, renderItem, keyExtractor }: {
        data: unknown[];
        renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
        keyExtractor?: (item: unknown, index: number) => string;
      },
      _ref: unknown,
    ) {
      return (
        <View testID="flash-list">
          {data?.map((item: unknown, index: number) => (
            <View key={keyExtractor ? keyExtractor(item, index) : String(index)}>
              {renderItem({ item, index })}
            </View>
          ))}
        </View>
      );
    }),
  };
});

import React from 'react';
import { act, render } from '@testing-library/react-native';
import { type SharedValue } from 'react-native-reanimated';

import { appStateStore } from '@/store/appStateStore';
import { lyricsStore } from '@/store/lyricsStore';
import { playerStore } from '@/store/playerStore';
import { tabletLayoutStore } from '@/store/tabletLayoutStore';
import { type Child } from '@/services/subsonicService';

// Must import after mocks
const { PlayerTabletLandscape } = require('@/components/player/PlayerTabletLandscape');

const MOCK_TRACK: Child = {
  id: 'track-1',
  title: 'Test Song',
  artist: 'Test Artist',
  album: 'Test Album',
  albumId: 'album-1',
  coverArt: 'cover-1',
  isDir: false,
  parent: '',
} as Child;

const expandProgress = { value: 0 } as SharedValue<number>;

const fetchLyrics = lyricsStore.getState().fetchLyrics as jest.Mock;

beforeEach(() => {
  fetchLyrics.mockClear();
  appStateStore.setState({ isActive: true });
  tabletLayoutStore.setState({ playerExpanded: false });
  playerStore.setState({
    currentTrack: MOCK_TRACK,
    currentTrackIndex: 0,
    queue: [MOCK_TRACK],
    queueLoading: false,
    playbackState: 'playing',
    position: 30,
    duration: 180,
    bufferedPosition: 60,
    error: null,
    retrying: false,
  });
});

describe('PlayerTabletLandscape lyrics gate', () => {
  it('does not fetch lyrics while collapsed, even as tracks change', () => {
    render(<PlayerTabletLandscape expandProgress={expandProgress} />);

    expect(fetchLyrics).not.toHaveBeenCalled();

    act(() => {
      playerStore.setState({ currentTrack: { ...MOCK_TRACK, id: 'track-2' } as Child });
    });

    expect(fetchLyrics).not.toHaveBeenCalled();
  });

  it('fetches the in-progress track when the player is expanded', () => {
    render(<PlayerTabletLandscape expandProgress={expandProgress} />);
    expect(fetchLyrics).not.toHaveBeenCalled();

    act(() => {
      tabletLayoutStore.getState().setPlayerExpanded(true);
    });

    expect(fetchLyrics).toHaveBeenCalledTimes(1);
    expect(fetchLyrics).toHaveBeenCalledWith('track-1', 'Test Artist', 'Test Song');
  });

  it('fetches on mount when the player is already expanded', () => {
    tabletLayoutStore.setState({ playerExpanded: true });

    render(<PlayerTabletLandscape expandProgress={expandProgress} />);

    expect(fetchLyrics).toHaveBeenCalledTimes(1);
    expect(fetchLyrics).toHaveBeenCalledWith('track-1', 'Test Artist', 'Test Song');
  });

  it('does not fetch while expanded but backgrounded', () => {
    appStateStore.setState({ isActive: false });
    tabletLayoutStore.setState({ playerExpanded: true });

    render(<PlayerTabletLandscape expandProgress={expandProgress} />);

    expect(fetchLyrics).not.toHaveBeenCalled();
  });
});
