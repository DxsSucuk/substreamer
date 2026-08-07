jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: { background: '#000', primary: '#f60', textPrimary: '#fff', textSecondary: '#888' },
  }),
}));

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  useSharedValue: () => ({ value: 0 }),
  useAnimatedStyle: () => ({}),
}));

jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    FlashList: React.forwardRef(function MockFlashList(_p: unknown, _ref: unknown) {
      return React.createElement(View, { testID: 'flash-list' });
    }),
  };
});

jest.mock('../AlbumRow', () => ({ AlbumRow: () => null }));
jest.mock('../AlbumCard', () => ({ AlbumCard: () => null }));

/** Record the letter set the scroller is handed — that set is the claim "this row is
 *  reachable from this letter", and it has to match where the row actually sorts. */
const letterSets: Set<string>[] = [];
jest.mock('../AlphabetScroller', () => ({
  AlphabetScroller: ({ activeLetters }: { activeLetters: Set<string> }) => {
    letterSets.push(activeLetters);
    return null;
  },
}));

import React from 'react';
import { render } from '@testing-library/react-native';

import type { AlbumID3 } from 'subsonic-api';

import { albumSortKeys } from '../../db/sortKeys';
import { layoutPreferencesStore } from '../../store/layoutPreferencesStore';
import { getSortFirstLetter } from '../../utils/sortHelpers';
import { AlbumListView, albumIdentity } from '../AlbumListView';

const latest = (): Set<string> => letterSets[letterSets.length - 1];

const album = (id: string, extra: Partial<AlbumID3> = {}): AlbumID3 =>
  ({ id, name: `Album ${id}`, songCount: 0, duration: 0, ...extra }) as AlbumID3;

beforeEach(() => {
  letterSets.length = 0;
  layoutPreferencesStore.setState({ albumSortOrder: 'artist' });
});

/**
 * The scroller's letter is `charAt(0)` of the key the LIST is ordered by. Now that the
 * order is SQL's `albums.sort_artist` / `sort_title`, the letter has to be derived from
 * the same fields those keys are — otherwise a row is filed under a letter that seeks
 * somewhere else.
 */
describe('AlbumListView — the scroller letter tracks the stored sort key', () => {
  it('uses displayArtist ahead of the artist tag, as `sort_artist` does', () => {
    // A server that sends BOTH, with different values — the only case where the two
    // fallback chains can disagree.
    const a = album('a1', { artist: 'Zebra', displayArtist: 'Alpaca' });
    render(<AlbumListView items={[a]} toAlbum={albumIdentity} showAlphabetScroller />);

    expect([...latest()]).toEqual(['A']); // Alpaca, the key the row sorts on
    expect(albumSortKeys(a).sort_artist).toBe('alpaca');
    expect(getSortFirstLetter(albumSortKeys(a).sort_artist)).toBe([...latest()][0]);
  });

  it('falls back to the artist tag, then the album name', () => {
    render(
      <AlbumListView
        items={[album('a1', { artist: 'Badger' }), album('a2', { name: 'Cormorant' })]}
        toAlbum={albumIdentity}
        showAlphabetScroller
      />,
    );
    expect([...latest()].sort()).toEqual(['B', 'C']);
  });

  it('honours a server sortName in title mode, as `sort_title` does', () => {
    layoutPreferencesStore.setState({ albumSortOrder: 'title' });
    const a = album('a1', { name: 'Abbey Road', sortName: 'Zzz Sorted' });
    render(<AlbumListView items={[a]} toAlbum={albumIdentity} showAlphabetScroller />);
    expect([...latest()]).toEqual(['Z']);
    expect(albumSortKeys(a).sort_title).toBe('zzz sorted');
  });

  it('files a punctuation-leading title under its first letter in title mode', () => {
    layoutPreferencesStore.setState({ albumSortOrder: 'title' });
    render(
      <AlbumListView
        items={[album('a1', { name: '"Heroes"' }), album('a2', { name: "'74 Jailbreak" })]}
        toAlbum={albumIdentity}
        showAlphabetScroller
      />,
    );
    expect([...latest()].sort()).toEqual(['#', 'H']);
  });
});
