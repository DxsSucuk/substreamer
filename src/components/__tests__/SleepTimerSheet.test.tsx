jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      primary: '#ff6600',
      textPrimary: '#ffffff',
      textSecondary: '#888888',
      border: '#333333',
      red: '#ff0000',
      background: '#000000',
      card: '#1e1e1e',
    },
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    Gesture: { Pan: () => ({ activeOffsetY: () => ({ onUpdate: () => ({ onEnd: () => ({}) }) }) }) },
    GestureDetector: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  };
});

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (init: number) => ({ value: init }),
    useAnimatedStyle: (fn: () => object) => fn(),
    withSpring: (val: number) => val,
    withTiming: (val: number, _config?: object, cb?: (finished: boolean) => void) => {
      if (cb) cb(true);
      return val;
    },
    runOnJS: (fn: Function) => fn,
  };
});

jest.mock('react-native-track-player', () => ({
  __esModule: true,
  default: {
    setSleepTimer: jest.fn().mockResolvedValue(undefined),
    clearSleepTimer: jest.fn().mockResolvedValue(undefined),
  },
}));

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import TrackPlayer from 'react-native-track-player';

import { sleepTimerStore } from '../../store/sleepTimerStore';

// Must import after mocks
const { SleepTimerSheet } = require('../SleepTimerSheet');

beforeEach(() => {
  // Fake timers keep BottomSheet's RAF-deferred close (setInternalVisible(false))
  // queued rather than firing after the test ends — these tests assert on the
  // store, which the press handler sets synchronously, not on the close anim.
  jest.useFakeTimers();
  sleepTimerStore.setState({
    endTime: null,
    endOfTrack: false,
    remaining: null,
    sheetVisible: true,
  });
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('SleepTimerSheet', () => {
  it('renders title', () => {
    const { getByText } = render(<SleepTimerSheet />);
    expect(getByText('Sleep Timer')).toBeTruthy();
  });

  it('renders all four time options', () => {
    const { getByText } = render(<SleepTimerSheet />);
    expect(getByText('15 minutes')).toBeTruthy();
    expect(getByText('30 minutes')).toBeTruthy();
    expect(getByText('45 minutes')).toBeTruthy();
    expect(getByText('1 hour')).toBeTruthy();
  });

  it('renders end of track option', () => {
    const { getByText } = render(<SleepTimerSheet />);
    expect(getByText('End of current track')).toBeTruthy();
  });

  it('calls setSleepTimer with 15 minutes and hides sheet', () => {
    const { getByText } = render(<SleepTimerSheet />);
    fireEvent.press(getByText('15 minutes'));
    expect(TrackPlayer.setSleepTimer).toHaveBeenCalledWith(15 * 60);
    expect(sleepTimerStore.getState().sheetVisible).toBe(false);
  });

  it('calls setSleepTimer with 30 minutes', () => {
    const { getByText } = render(<SleepTimerSheet />);
    fireEvent.press(getByText('30 minutes'));
    expect(TrackPlayer.setSleepTimer).toHaveBeenCalledWith(30 * 60);
  });

  it('calls setSleepTimer with 45 minutes', () => {
    const { getByText } = render(<SleepTimerSheet />);
    fireEvent.press(getByText('45 minutes'));
    expect(TrackPlayer.setSleepTimer).toHaveBeenCalledWith(45 * 60);
  });

  it('calls setSleepTimer with 1 hour', () => {
    const { getByText } = render(<SleepTimerSheet />);
    fireEvent.press(getByText('1 hour'));
    expect(TrackPlayer.setSleepTimer).toHaveBeenCalledWith(60 * 60);
  });

  it('calls setSleepTimer with -1 for end of track', () => {
    const { getByText } = render(<SleepTimerSheet />);
    fireEvent.press(getByText('End of current track'));
    expect(TrackPlayer.setSleepTimer).toHaveBeenCalledWith(-1);
    expect(sleepTimerStore.getState().sheetVisible).toBe(false);
  });

  it('does not show cancel button when inactive', () => {
    const { queryByText } = render(<SleepTimerSheet />);
    expect(queryByText('Cancel timer')).toBeNull();
  });

  it('shows cancel button when timed timer is active', () => {
    sleepTimerStore.setState({ endTime: Date.now() / 1000 + 600 });
    const { getByText } = render(<SleepTimerSheet />);
    expect(getByText('Cancel timer')).toBeTruthy();
  });

  it('shows cancel button when endOfTrack is active', () => {
    sleepTimerStore.setState({ endOfTrack: true });
    const { getByText } = render(<SleepTimerSheet />);
    expect(getByText('Cancel timer')).toBeTruthy();
  });

  it('calls clearSleepTimer and hides sheet on cancel', () => {
    sleepTimerStore.setState({ endTime: Date.now() / 1000 + 600 });
    const { getByText } = render(<SleepTimerSheet />);
    fireEvent.press(getByText('Cancel timer'));
    expect(TrackPlayer.clearSleepTimer).toHaveBeenCalled();
    expect(sleepTimerStore.getState().sheetVisible).toBe(false);
  });

  it('hides sheet on backdrop close', () => {
    const { getByTestId } = render(<SleepTimerSheet />);
    fireEvent.press(getByTestId('bottom-sheet-backdrop'));
    expect(sleepTimerStore.getState().sheetVisible).toBe(false);
  });

  it('exercises pressed style branches on option Pressables', () => {
    sleepTimerStore.setState({ endTime: Date.now() / 1000 + 600 });
    const { UNSAFE_root } = render(<SleepTimerSheet />);
    // Find all elements with both onPress and a function style (Pressable internals)
    const pressables = UNSAFE_root.findAll(
      (node: { props?: Record<string, unknown> }) =>
        typeof node.props?.onPress === 'function' &&
        typeof node.props?.style === 'function',
    );
    expect(pressables.length).toBeGreaterThan(0);
    for (const p of pressables) {
      const result = p.props.style({ pressed: true });
      expect(result).toEqual(
        expect.arrayContaining([expect.objectContaining({ opacity: 0.6 })]),
      );
    }
  });
});
