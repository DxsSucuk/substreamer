jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

import React from 'react';
import { act, render, fireEvent } from '@testing-library/react-native';

import { musicCacheStore } from '../../store/musicCacheStore';
import type { DownloadQueueItem } from '../../store/musicCacheStore';

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      background: '#000',
      card: '#111',
      textPrimary: '#fff',
      textSecondary: '#888',
      border: '#333',
      primary: '#1D9BF0',
    },
  }),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  return {
    __esModule: true,
    default: {
      View,
      Text,
    },
    // useSharedValue must persist its object across renders so that
    // post-effect mutations (heightValue.value = 44) survive into the
    // next render's useAnimatedStyle read. The trivial `() => ({ value })`
    // version returned a fresh object every render, which made entrance
    // animations untestable.
    useSharedValue: (init: number) => {
      const ref = React.useRef({ value: init });
      return ref.current;
    },
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: (val: number) => val,
    withDelay: (_: number, val: number) => val,
    withSpring: (val: number) => val,
    Easing: {
      out: (e: unknown) => e,
      in: (e: unknown) => e,
      inOut: (e: unknown) => e,
      cubic: (t: number) => t,
    },
  };
});

// Must import after mocks
const { DownloadBanner } = require('../DownloadBanner');

function makeQueueItem(overrides: Partial<DownloadQueueItem> = {}): DownloadQueueItem {
  return {
    queueId: 'q1',
    itemId: 'a1',
    type: 'album',
    name: 'Kind of Blue',
    status: 'queued',
    totalSongs: 9,
    completedSongs: 0,
    addedAt: 0,
    queuePosition: 1,
    ...overrides,
  };
}

beforeEach(() => {
  musicCacheStore.setState({ downloadQueue: [] });
  mockPush.mockClear();
});

describe('DownloadBanner', () => {
  it('has collapsed height when queue is empty', () => {
    const { toJSON } = render(<DownloadBanner />);
    const root = toJSON() as import('react-test-renderer').ReactTestRendererJSON;
    expect(root.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ height: 0 })]),
    );
  });

  it('is at full height on FIRST render when the queue already has items', () => {
    // No rerender: the height must come from the seeded shared value, not from the
    // entrance animation. `BottomChrome` mounts this only once the queue is
    // non-empty, so mounting-while-visible is the normal case, not an edge case —
    // and an entrance animation that fails to land must not be able to hide it.
    musicCacheStore.setState({
      downloadQueue: [makeQueueItem({ status: 'downloading', completedSongs: 3 })],
    });
    const { toJSON } = render(<DownloadBanner />);
    const root = toJSON() as import('react-test-renderer').ReactTestRendererJSON;
    expect(root.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ height: 44 })]),
    );
  });

  it('shows its content on FIRST render too, not just the container', () => {
    // The container can be 44 tall while the inner content sits at opacity 0,
    // which reads to the user as a blank gap rather than a banner.
    musicCacheStore.setState({
      downloadQueue: [makeQueueItem({ status: 'downloading', completedSongs: 3 })],
    });
    const { toJSON } = render(<DownloadBanner />);
    const root = toJSON() as import('react-test-renderer').ReactTestRendererJSON;
    const inner = root.children?.[0] as import('react-test-renderer').ReactTestRendererJSON;
    expect(inner.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ opacity: 1 })]),
    );
  });

  it('shows active downloading item name and track progress', () => {
    musicCacheStore.setState({
      downloadQueue: [
        makeQueueItem({
          status: 'downloading',
          name: 'Kind of Blue',
          completedSongs: 3,
          totalSongs: 9,
        }),
      ],
    });
    const { getByText } = render(<DownloadBanner />);
    expect(getByText('Kind of Blue')).toBeTruthy();
    expect(getByText('3/9')).toBeTruthy();
  });

  it('shows queued count when no item is actively downloading', () => {
    musicCacheStore.setState({
      downloadQueue: [
        makeQueueItem({ queueId: 'q1', status: 'queued' }),
        makeQueueItem({ queueId: 'q2', status: 'queued' }),
      ],
    });
    const { getByText } = render(<DownloadBanner />);
    // react-i18next t() with missing translation returns the key,
    // so we assert on the key (the test-utils setup file loads en.json
    // which contains the full translation).
    expect(getByText(/queued/i)).toBeTruthy();
  });

  it('navigates to download queue on press', () => {
    musicCacheStore.setState({
      downloadQueue: [makeQueueItem({ status: 'downloading' })],
    });
    const { getByText } = render(<DownloadBanner />);
    fireEvent.press(getByText('Kind of Blue'));
    expect(mockPush).toHaveBeenCalledWith('/download-queue');
  });

  it('transitions from hidden to visible when queue gains items', () => {
    const { rerender, getByText } = render(<DownloadBanner />);

    act(() =>
      musicCacheStore.setState({
        downloadQueue: [makeQueueItem({ status: 'downloading' })],
      }),
    );
    rerender(<DownloadBanner />);
    expect(getByText('Kind of Blue')).toBeTruthy();
  });

  it('transitions from visible to hidden when queue empties', () => {
    musicCacheStore.setState({
      downloadQueue: [makeQueueItem({ status: 'downloading' })],
    });
    const { rerender, toJSON } = render(<DownloadBanner />);

    act(() => musicCacheStore.setState({ downloadQueue: [] }));
    rerender(<DownloadBanner />);

    const root = toJSON() as import('react-test-renderer').ReactTestRendererJSON;
    expect(root.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ height: 0 })]),
    );
  });

  it('stays hidden when queue contains only rows with unknown statuses', () => {
    // A row in an unexpected status (e.g. a stuck `complete` survivor
    // from a v1 migration, or any drift) must NOT keep the banner
    // visible — the download-queue screen filters such rows out, so
    // there's no UI affordance for the user to resolve it otherwise.
    musicCacheStore.setState({
      downloadQueue: [
        makeQueueItem({ status: 'complete' as DownloadQueueItem['status'] }),
      ],
    });
    const { toJSON } = render(<DownloadBanner />);
    const root = toJSON() as import('react-test-renderer').ReactTestRendererJSON;
    expect(root.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ height: 0 })]),
    );
  });

  it('stays visible when queue has an error row with no in-flight transfer', () => {
    musicCacheStore.setState({
      downloadQueue: [
        makeQueueItem({ status: 'error', error: 'network' }),
      ],
    });
    const { toJSON, rerender } = render(<DownloadBanner />);
    rerender(<DownloadBanner />);
    const root = toJSON() as import('react-test-renderer').ReactTestRendererJSON;
    expect(root.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ height: 44 })]),
    );
  });

  it('renders zero progress when active item has zero totalSongs', () => {
    musicCacheStore.setState({
      downloadQueue: [
        makeQueueItem({
          status: 'downloading',
          completedSongs: 0,
          totalSongs: 0,
        }),
      ],
    });
    // Render should not throw on divide-by-zero.
    const { getByText } = render(<DownloadBanner />);
    expect(getByText('Kind of Blue')).toBeTruthy();
  });
});
