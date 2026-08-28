jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

import { act, renderHook } from '@testing-library/react-native';

import { favoritesStore } from '../../store/favoritesStore';
import { useIsStarred } from '../useIsStarred';

const setIds = (songs: string[] = [], albums: string[] = [], artists: string[] = []) =>
  favoritesStore.setState({
    songIds: new Set(songs),
    albumIds: new Set(albums),
    artistIds: new Set(artists),
  });

beforeEach(() => {
  setIds();
  favoritesStore.setState({ overrides: {} });
});

describe('useIsStarred', () => {
  it('is false for an empty id', () => {
    setIds(['s1']);
    const { result } = renderHook(() => useIsStarred('song', ''));
    expect(result.current).toBe(false);
  });

  it('reads membership per entity type', () => {
    setIds(['s1'], ['al1'], ['ar1']);
    expect(renderHook(() => useIsStarred('song', 's1')).result.current).toBe(true);
    expect(renderHook(() => useIsStarred('song', 'al1')).result.current).toBe(false);
    expect(renderHook(() => useIsStarred('album', 'al1')).result.current).toBe(true);
    expect(renderHook(() => useIsStarred('artist', 'ar1')).result.current).toBe(true);
    expect(renderHook(() => useIsStarred('artist', 's1')).result.current).toBe(false);
  });

  it('lets an optimistic override win over SQL membership, in both directions', () => {
    setIds(['s1']);
    favoritesStore.setState({ overrides: { s1: false, s2: true } });
    expect(renderHook(() => useIsStarred('song', 's1')).result.current).toBe(false);
    expect(renderHook(() => useIsStarred('song', 's2')).result.current).toBe(true);
  });

  it('re-renders when membership flips', () => {
    const { result } = renderHook(() => useIsStarred('song', 's1'));
    expect(result.current).toBe(false);
    act(() => setIds(['s1']));
    expect(result.current).toBe(true);
  });
});
