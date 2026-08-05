jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

import { renderHook } from '@testing-library/react-native';

import { musicCacheStore } from '../../store/musicCacheStore';
import { useAllSongsByTitle } from '../useAllSongsByTitle';

const cached = (id: string, title: string) => ({ id, title, duration: 1 });

beforeEach(() => {
  musicCacheStore.setState({ cachedItems: {}, cachedSongs: {} } as never);
});

describe('useAllSongsByTitle', () => {
  it('returns nothing when the downloaded filter is off', () => {
    musicCacheStore.setState({ cachedSongs: { s1: cached('s1', 'Alpha') } } as never);
    const { result } = renderHook(() => useAllSongsByTitle());
    expect(result.current.songs).toEqual([]);
    expect(result.current.totalCount).toBe(0);
  });

  it('returns the downloaded set title-sorted', () => {
    musicCacheStore.setState({
      cachedSongs: {
        s2: cached('s2', 'Zulu'),
        s1: cached('s1', 'Alpha'),
      },
    } as never);
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    expect(result.current.songs.map((s) => s.title)).toEqual(['Alpha', 'Zulu']);
  });

  it('dedups by id and skips holes in the map', () => {
    musicCacheStore.setState({
      cachedSongs: { a: cached('s1', 'Alpha'), b: cached('s1', 'Alpha'), c: undefined },
    } as never);
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    expect(result.current.songs).toHaveLength(1);
  });

  it('exposes a no-op refresh (the source is a store, not a fetch)', () => {
    const { result } = renderHook(() => useAllSongsByTitle({ downloadedOnly: true }));
    expect(result.current.loading).toBe(false);
    expect(() => result.current.refresh()).not.toThrow();
  });
});
