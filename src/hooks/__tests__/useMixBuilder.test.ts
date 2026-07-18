import { renderHook, act } from '@testing-library/react-native';

// t returns the key so we can assert on the message key directly.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const mockPlayTrack = jest.fn();
jest.mock('../../services/playerService', () => ({
  playTrack: (...a: unknown[]) => mockPlayTrack(...a),
}));

const mockFetchMixSongs = jest.fn();
const mockFetchCustomMix = jest.fn();
jest.mock('../../services/tunedInService', () => ({
  fetchMixSongs: (...a: unknown[]) => mockFetchMixSongs(...a),
  fetchCustomMix: (...a: unknown[]) => mockFetchCustomMix(...a),
  decadeRangesForLabels: () => [],
}));

jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: () => ({ offlineMode: false }) },
}));
jest.mock('../../store/connectivityStore', () => ({
  connectivityStore: { getState: () => ({ isServerReachable: true }) },
}));
jest.mock('../../store/layoutPreferencesStore', () => ({
  layoutPreferencesStore: { getState: () => ({ listLength: 20 }) },
}));
jest.mock('../../store/genreStore', () => ({
  genreStore: (selector: (s: { genres: unknown[] }) => unknown) => selector({ genres: [] }),
}));
jest.mock('../../utils/haptics', () => ({ selectionAsync: jest.fn() }));

import { useMixBuilder } from '../useMixBuilder';

beforeEach(() => {
  mockPlayTrack.mockReset();
  mockFetchMixSongs.mockReset();
  mockFetchCustomMix.mockReset();
});

describe('useMixBuilder.play', () => {
  it('plays and leaves error null when the mix has songs', async () => {
    mockFetchCustomMix.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    const { result } = renderHook(() => useMixBuilder(['Rock']));
    act(() => result.current.toggleGenre('Rock'));
    await act(async () => {
      await result.current.play();
    });
    expect(mockPlayTrack).toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it('sets noSongsFound when the mix resolves empty (no silent failure)', async () => {
    mockFetchCustomMix.mockResolvedValue([]);
    const { result } = renderHook(() => useMixBuilder(['Rock']));
    act(() => result.current.toggleGenre('Rock'));
    await act(async () => {
      await result.current.play();
    });
    expect(mockPlayTrack).not.toHaveBeenCalled();
    expect(result.current.error).toBe('noSongsFound');
  });

  it('sets failedToLoad when resolving throws', async () => {
    mockFetchCustomMix.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useMixBuilder(['Rock']));
    act(() => result.current.toggleGenre('Rock'));
    await act(async () => {
      await result.current.play();
    });
    expect(result.current.error).toBe('failedToLoad');
  });

  it('clears a prior error when the selection changes', async () => {
    mockFetchCustomMix.mockResolvedValue([]);
    const { result } = renderHook(() => useMixBuilder(['Rock', 'Pop']));
    act(() => result.current.toggleGenre('Rock'));
    await act(async () => {
      await result.current.play();
    });
    expect(result.current.error).toBe('noSongsFound');
    act(() => result.current.toggleGenre('Pop'));
    expect(result.current.error).toBeNull();
  });
});
