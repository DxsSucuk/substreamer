jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

import React from 'react';
import { ActivityIndicator } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';

const mockEnqueueAlbumDownload = jest.fn();
const mockEnqueuePlaylistDownload = jest.fn();
const mockDeleteCachedItem = jest.fn();
const mockCancelDownload = jest.fn();
const mockConfirmRemove = jest.fn();

jest.mock('../../services/musicCacheService', () => ({
  cancelDownload: (...a: unknown[]) => (mockCancelDownload as any)(...a),
  deleteCachedItem: (...a: unknown[]) => (mockDeleteCachedItem as any)(...a),
  enqueueAlbumDownload: (...a: unknown[]) => (mockEnqueueAlbumDownload as any)(...a),
  enqueuePlaylistDownload: (...a: unknown[]) => (mockEnqueuePlaylistDownload as any)(...a),
  getLocalTrackUri: jest.fn(() => null),
  getTrackQueueStatus: jest.fn(() => null),
}));

jest.mock('../../hooks/useConfirmAlbumRemoval', () => ({
  useConfirmAlbumRemoval: () => ({
    confirmRemove: (...a: unknown[]) => (mockConfirmRemove as any)(...a),
  }),
}));

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      primary: '#1D9BF0',
      orange: '#FF9500',
      partialDownload: '#FF9500',
      textPrimary: '#fff',
      textSecondary: '#888',
      border: '#333',
      card: '#111',
    },
  }),
}));

jest.mock('../CircularProgress', () => {
  const { Text } = require('react-native');
  return { CircularProgress: () => <Text>CircularProgress</Text> };
});

jest.mock('../DownloadedIcon', () => {
  const { Text } = require('react-native');
  return {
    DownloadedIcon: (props: { circleColor: string }) => (
      <Text>DownloadedIcon:{props.circleColor}</Text>
    ),
  };
});

jest.mock('../ThemedAlert', () => {
  const { View } = require('react-native');
  return { ThemedAlert: () => <View /> };
});

import { DownloadButton } from '../DownloadButton';
import { musicCacheStore } from '../../store/musicCacheStore';
import type { CachedItemMeta } from '../../store/musicCacheStore';

function makeItem(overrides: Partial<CachedItemMeta> = {}): CachedItemMeta {
  return {
    itemId: 'a1',
    type: 'album',
    name: 'Album A',
    expectedSongCount: 10,
    lastSyncAt: 0,
    downloadedAt: 0,
    songIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockEnqueueAlbumDownload.mockReset();
  mockEnqueuePlaylistDownload.mockReset();
  mockDeleteCachedItem.mockReset();
  mockCancelDownload.mockReset();
  mockConfirmRemove.mockReset();
  musicCacheStore.setState({ cachedItems: {}, downloadQueue: [] } as any);
});

describe('DownloadButton', () => {
  it('renders the outline arrow for a not-downloaded album', () => {
    const { getByText } = render(<DownloadButton itemId="a1" type="album" />);
    expect(getByText('arrow-down-circle-outline')).toBeTruthy();
  });

  it('renders the primary DownloadedIcon for a fully downloaded album', () => {
    musicCacheStore.setState({
      cachedItems: {
        a1: makeItem({
          songIds: Array.from({ length: 10 }, (_, i) => `s${i}`),
          expectedSongCount: 10,
        }),
      },
    } as any);
    const { getByText } = render(<DownloadButton itemId="a1" type="album" />);
    expect(getByText('DownloadedIcon:#1D9BF0')).toBeTruthy();
  });

  it('renders the orange DownloadedIcon for a partial album', () => {
    musicCacheStore.setState({
      cachedItems: {
        a1: makeItem({
          songIds: ['s1', 's2'],
          expectedSongCount: 10,
        }),
      },
    } as any);
    const { getByText } = render(<DownloadButton itemId="a1" type="album" />);
    expect(getByText('DownloadedIcon:#FF9500')).toBeTruthy();
  });

  it('onPress enqueues album download when status is "none"', () => {
    const { getByText } = render(<DownloadButton itemId="a1" type="album" />);
    fireEvent.press(getByText('arrow-down-circle-outline').parent!);
    expect(mockEnqueueAlbumDownload).toHaveBeenCalledWith('a1');
  });

  it('onPress enqueues album download when status is "partial" (top-up)', () => {
    musicCacheStore.setState({
      cachedItems: {
        a1: makeItem({ songIds: ['s1'], expectedSongCount: 10 }),
      },
    } as any);
    const { getByText } = render(<DownloadButton itemId="a1" type="album" />);
    fireEvent.press(getByText('DownloadedIcon:#FF9500').parent!);
    expect(mockEnqueueAlbumDownload).toHaveBeenCalledWith('a1');
    expect(mockConfirmRemove).not.toHaveBeenCalled();
  });

  it('onPress routes to confirmRemove for a fully-downloaded album', () => {
    musicCacheStore.setState({
      cachedItems: {
        a1: makeItem({
          songIds: Array.from({ length: 10 }, (_, i) => `s${i}`),
          expectedSongCount: 10,
        }),
      },
    } as any);
    const { getByText } = render(<DownloadButton itemId="a1" type="album" />);
    fireEvent.press(getByText('DownloadedIcon:#1D9BF0').parent!);
    expect(mockConfirmRemove).toHaveBeenCalledWith('a1');
    expect(mockDeleteCachedItem).not.toHaveBeenCalled();
  });

  it('onPress calls deleteCachedItem directly for a fully-downloaded playlist (no confirm)', () => {
    musicCacheStore.setState({
      cachedItems: {
        p1: makeItem({
          itemId: 'p1',
          type: 'playlist',
          songIds: ['s1'],
          expectedSongCount: 1,
        }),
      },
    } as any);
    const { getByText } = render(<DownloadButton itemId="p1" type="playlist" />);
    fireEvent.press(getByText('DownloadedIcon:#1D9BF0').parent!);
    expect(mockDeleteCachedItem).toHaveBeenCalledWith('p1');
    expect(mockConfirmRemove).not.toHaveBeenCalled();
  });

  it('onDelete override wins over confirmRemove for albums', () => {
    const onDelete = jest.fn();
    musicCacheStore.setState({
      cachedItems: {
        a1: makeItem({
          songIds: Array.from({ length: 10 }, (_, i) => `s${i}`),
          expectedSongCount: 10,
        }),
      },
    } as any);
    const { getByText } = render(<DownloadButton itemId="a1" type="album" onDelete={onDelete} />);
    fireEvent.press(getByText('DownloadedIcon:#1D9BF0').parent!);
    expect(onDelete).toHaveBeenCalled();
    expect(mockConfirmRemove).not.toHaveBeenCalled();
  });

  it('cancels download on press when status is queued', () => {
    // Queued state renders an ActivityIndicator; pressing the button cancels
    // the in-flight queue entry by its queueId.
    musicCacheStore.setState({
      cachedItems: {},
      downloadQueue: [
        { queueId: 'q1', itemId: 'a1', type: 'album', status: 'queued' },
      ],
    } as any);
    const { UNSAFE_getByType } = render(<DownloadButton itemId="a1" type="album" />);
    fireEvent.press(UNSAFE_getByType(ActivityIndicator).parent!);
    expect(mockCancelDownload).toHaveBeenCalledWith('q1');
  });

  it('renders CircularProgress while downloading and press cancels', () => {
    musicCacheStore.setState({
      cachedItems: {},
      downloadQueue: [
        { queueId: 'q1', itemId: 'a1', type: 'album', status: 'downloading', totalSongs: 10, completedSongs: 3 },
      ],
    } as any);
    const { getByText } = render(<DownloadButton itemId="a1" type="album" />);
    expect(getByText('CircularProgress')).toBeTruthy();
    fireEvent.press(getByText('CircularProgress').parent!);
    expect(mockCancelDownload).toHaveBeenCalledWith('q1');
  });

  it('enqueuePlaylistDownload for a playlist type at "none"', () => {
    const { getByText } = render(<DownloadButton itemId="p1" type="playlist" />);
    fireEvent.press(getByText('arrow-down-circle-outline').parent!);
    expect(mockEnqueuePlaylistDownload).toHaveBeenCalledWith('p1');
  });

  it('onDownload override wins over enqueue', () => {
    const onDownload = jest.fn();
    const { getByText } = render(<DownloadButton itemId="a1" type="album" onDownload={onDownload} />);
    fireEvent.press(getByText('arrow-down-circle-outline').parent!);
    expect(onDownload).toHaveBeenCalled();
    expect(mockEnqueueAlbumDownload).not.toHaveBeenCalled();
  });

  it('no-ops when itemId is empty (returns none without enqueue)', () => {
    const { getByText } = render(<DownloadButton itemId="" type="album" />);
    // With empty id, useDownloadStatus returns 'none' → the outline icon
    // renders. Pressing it should still no-op because the handler short-
    // circuits on empty id.
    fireEvent.press(getByText('arrow-down-circle-outline').parent!);
    expect(mockEnqueueAlbumDownload).not.toHaveBeenCalled();
    expect(mockConfirmRemove).not.toHaveBeenCalled();
  });
});
