jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

const mockDeleteCachedItem = jest.fn();
const mockDemoteAlbumToPartial = jest.fn();
const mockComputeAlbumRemovalOutcome = jest.fn();
jest.mock('../../services/musicCacheService', () => ({
  computeAlbumRemovalOutcome: (...a: unknown[]) => (mockComputeAlbumRemovalOutcome as any)(...a),
  deleteCachedItem: (...a: unknown[]) => (mockDeleteCachedItem as any)(...a),
  demoteAlbumToPartial: (...a: unknown[]) => (mockDemoteAlbumToPartial as any)(...a),
}));

import { Platform, Alert } from 'react-native';
import { renderHook, act } from '@testing-library/react-native';

import { useConfirmAlbumRemoval } from '../useConfirmAlbumRemoval';
import { musicCacheStore } from '../../store/musicCacheStore';

const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

beforeEach(() => {
  mockDeleteCachedItem.mockReset();
  mockDemoteAlbumToPartial.mockReset();
  mockComputeAlbumRemovalOutcome.mockReset();
  alertSpy.mockReset();
  Object.defineProperty(Platform, 'OS', { value: 'ios', writable: true });
  musicCacheStore.setState({ cachedItems: {} } as any);
});

function seedAlbum(itemId: string, overrides: Partial<Record<string, unknown>> = {}) {
  musicCacheStore.setState({
    cachedItems: {
      [itemId]: {
        itemId,
        type: 'album',
        name: 'Album A',
        expectedSongCount: 5,
        songIds: ['s1', 's2', 's3', 's4', 's5'],
        lastSyncAt: 0,
        downloadedAt: 0,
        ...overrides,
      },
    },
  } as any);
}

describe('useConfirmAlbumRemoval', () => {
  it('no-ops on empty id', async () => {
    const { result } = renderHook(() => useConfirmAlbumRemoval());
    await act(async () => { await result.current.confirmRemove(''); });
    expect(mockDeleteCachedItem).not.toHaveBeenCalled();
    expect(mockDemoteAlbumToPartial).not.toHaveBeenCalled();
  });

  it('passes through to deleteCachedItem when item has no cache entry', async () => {
    const { result } = renderHook(() => useConfirmAlbumRemoval());
    await act(async () => { await result.current.confirmRemove('missing'); });
    expect(mockDeleteCachedItem).toHaveBeenCalledWith('missing');
  });

  it('passes through to deleteCachedItem for non-album types', async () => {
    musicCacheStore.setState({
      cachedItems: {
        pl: {
          itemId: 'pl',
          type: 'playlist',
          name: 'Pl',
          expectedSongCount: 3,
          songIds: [],
          lastSyncAt: 0,
          downloadedAt: 0,
        },
      },
    } as any);
    const { result } = renderHook(() => useConfirmAlbumRemoval());
    await act(async () => { await result.current.confirmRemove('pl'); });
    expect(mockDeleteCachedItem).toHaveBeenCalledWith('pl');
  });

  it('fully deletes album when no survivors', async () => {
    seedAlbum('a1');
    mockComputeAlbumRemovalOutcome.mockResolvedValue({ orphanSongIds: ['s1', 's2', 's3', 's4', 's5'], survivorCount: 0 });
    const { result } = renderHook(() => useConfirmAlbumRemoval());
    await act(async () => { await result.current.confirmRemove('a1'); });
    expect(mockDeleteCachedItem).toHaveBeenCalledWith('a1');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('shows confirmation and on confirm calls demoteAlbumToPartial when survivors exist', async () => {
    seedAlbum('a1');
    mockComputeAlbumRemovalOutcome.mockResolvedValue({ orphanSongIds: ['s1'], survivorCount: 2 });
    const { result } = renderHook(() => useConfirmAlbumRemoval());
    await act(async () => { await result.current.confirmRemove('a1'); });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    // Fire the destructive button's onPress.
    const [, , buttons] = alertSpy.mock.calls[0];
    const confirm = buttons?.find((b: any) => b.style === 'destructive');
    expect(confirm).toBeDefined();
    act(() => confirm!.onPress!());
    expect(mockDemoteAlbumToPartial).toHaveBeenCalledWith('a1');
    expect(mockDeleteCachedItem).not.toHaveBeenCalled();
  });

  it('cancel button does nothing destructive', async () => {
    seedAlbum('a1');
    mockComputeAlbumRemovalOutcome.mockResolvedValue({ orphanSongIds: ['s1'], survivorCount: 2 });
    const { result } = renderHook(() => useConfirmAlbumRemoval());
    await act(async () => { await result.current.confirmRemove('a1'); });
    const [, , buttons] = alertSpy.mock.calls[0];
    const cancel = buttons?.find((b: any) => b.style === 'cancel');
    expect(cancel).toBeDefined();
    // Calling onPress if present; it's optional.
    act(() => { if (cancel?.onPress) cancel.onPress(); });
    expect(mockDemoteAlbumToPartial).not.toHaveBeenCalled();
    expect(mockDeleteCachedItem).not.toHaveBeenCalled();
  });
});
