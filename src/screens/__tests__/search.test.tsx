jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: {
      background: '#000',
      border: '#222',
      label: '#888',
      primary: '#007AFF',
      textPrimary: '#fff',
      textSecondary: '#888',
    },
  }),
}));

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-router/react-navigation', () => ({ useIsFocused: () => true }));
jest.mock('../../services/musicCacheService', () => ({ getLocalTrackUri: () => null }));
jest.mock('../../services/playerService', () => ({ playTrack: jest.fn() }));

// The rows have their own suites; stub them to whatever id reached them.
const stubRow =
  (kind: string) =>
  ({ artist, album, song }: Record<string, { id: string } | undefined>) => {
    const { Text } = require('react-native');
    const React = require('react');
    const item = artist ?? album ?? song;
    return React.createElement(Text, { testID: `${kind}:${item?.id ?? ''}` }, kind);
  };
jest.mock('../../components/ArtistRow', () => ({ ArtistRow: stubRow('artist') }));
jest.mock('../../components/AlbumRow', () => ({ AlbumRow: stubRow('album') }));
jest.mock('../../components/SongRow', () => ({ SongRow: stubRow('song') }));
jest.mock('../../components/RecentSearches', () => ({ RecentSearches: () => null }));

import React from 'react';
import { render } from '@testing-library/react-native';

import type { AlbumID3, ArtistID3, Child } from 'subsonic-api';

import { favoritesStore } from '../../store/favoritesStore';
import { filterBarStore } from '../../store/filterBarStore';
import { searchStore } from '../../store/searchStore';
import { SearchScreen } from '../search';

const artist = (id: string): ArtistID3 => ({ id, name: `Artist ${id}`, albumCount: 1 });
const album = (id: string): AlbumID3 =>
  ({ id, name: `Album ${id}`, duration: 0, songCount: 0 }) as AlbumID3;
const song = (id: string): Child => ({ id, title: `Song ${id}`, isDir: false }) as Child;

beforeEach(() => {
  searchStore.setState({
    query: 'a',
    loading: false,
    results: {
      artists: [artist('ar1'), artist('ar2')],
      albums: [album('al1'), album('al2')],
      songs: [song('s1'), song('s2')],
    },
  });
  filterBarStore.setState({ favoritesOnly: false, downloadedOnly: false });
  favoritesStore.setState({
    songIds: new Set(['s1']),
    albumIds: new Set(['al1']),
    artistIds: new Set(['ar1']),
  });
});

const rowIds = (r: ReturnType<typeof render>): string[] =>
  r.queryAllByTestId(/^(artist|album|song):/).map((n) => String(n.props.testID));

describe('SearchScreen — downloaded filter drops artists entirely', () => {
  // Artists cannot be downloaded. The filter used to keep any artist who owned a matching
  // downloaded album, which disagreed with the library tab (hides artists) and with offline
  // search (returns none). All three now agree: no artists under the Downloaded filter.
  it('renders no artist rows when the Downloaded filter is on', () => {
    filterBarStore.setState({ downloadedOnly: true });
    expect(rowIds(render(<SearchScreen />)).filter((id) => id.startsWith('artist:'))).toEqual([]);
  });

  it('still renders artists when the filter is off', () => {
    expect(rowIds(render(<SearchScreen />))).toEqual(
      expect.arrayContaining(['artist:ar1', 'artist:ar2']),
    );
  });
});

describe('SearchScreen — favourites filter', () => {
  it('shows unstarred results too when the filter is off', () => {
    // `arrayContaining`, not an exact list: SectionList only mounts its initial window,
    // so the tail of a long section legitimately isn't rendered yet.
    expect(rowIds(render(<SearchScreen />))).toEqual(
      expect.arrayContaining(['artist:ar1', 'artist:ar2', 'album:al1', 'album:al2', 'song:s1']),
    );
  });

  it('shows starred items only when the filter is on — across all three types', () => {
    // The Favourites filter reads the membership id sets, the same ones the heart
    // icons read, so search and the star state can never disagree.
    filterBarStore.setState({ favoritesOnly: true });
    expect(rowIds(render(<SearchScreen />))).toEqual(['artist:ar1', 'album:al1', 'song:s1']);
  });

  it('shows the no-results placeholder when nothing in the results is starred', () => {
    filterBarStore.setState({ favoritesOnly: true });
    favoritesStore.setState({
      songIds: new Set(),
      albumIds: new Set(),
      artistIds: new Set(),
    });
    const r = render(<SearchScreen />);
    expect(rowIds(r)).toEqual([]);
    expect(r.getByText('No results found')).toBeTruthy();
  });
});
