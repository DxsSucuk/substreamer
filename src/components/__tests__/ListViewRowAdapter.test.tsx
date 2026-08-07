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

/**
 * Renders EVERY row, where the real list renders a window. That amplification is
 * deliberate: a windowed list would hide the behaviour this suite is about, which is
 * what happens to rows that are already on screen when the array grows.
 */
jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    FlashList: React.forwardRef(function MockFlashList(
      {
        data,
        renderItem,
        keyExtractor,
      }: {
        data: unknown[];
        renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
        keyExtractor: (item: unknown) => string;
      },
      _ref: unknown,
    ) {
      return (
        <View testID="flash-list">
          {data.map((item, index) => (
            <View key={keyExtractor(item)}>{renderItem({ item, index })}</View>
          ))}
        </View>
      );
    }),
  };
});

// The card and row components are unchanged by this design and have their own suites;
// stubbing them keeps the count here to conversions the views themselves make.
jest.mock('../AlbumRow', () => ({ AlbumRow: () => null }));
jest.mock('../AlbumCard', () => ({ AlbumCard: () => null }));
jest.mock('../ArtistRow', () => ({ ArtistRow: () => null }));
jest.mock('../ArtistCard', () => ({ ArtistCard: () => null }));
jest.mock('../PlaylistRow', () => ({ PlaylistRow: () => null }));
jest.mock('../PlaylistCard', () => ({ PlaylistCard: () => null }));
jest.mock('../AlphabetScroller', () => ({ AlphabetScroller: () => null }));

import React from 'react';
import { render } from '@testing-library/react-native';

import type { AlbumID3, ArtistID3, Playlist } from 'subsonic-api';

import { AlbumListView } from '../AlbumListView';
import { ArtistListView } from '../ArtistListView';
import { PlaylistListView } from '../PlaylistListView';

/** Stands in for a SQL browse row: object identity is stable across pages, which is
 *  what the per-row memo keys on. */
interface Row {
  id: string;
  name: string;
}

const page = (from: number, to: number): Row[] =>
  Array.from({ length: to - from }, (_, i) => ({ id: `${from + i}`, name: `Item ${from + i}` }));

const asAlbum = (r: Row): AlbumID3 => ({ id: r.id, name: r.name, songCount: 0, duration: 0 });
const asArtist = (r: Row): ArtistID3 => ({ id: r.id, name: r.name, albumCount: 0 });
const asPlaylist = (r: Row): Playlist => ({ id: r.id, name: r.name, songCount: 0, duration: 0 });

interface ViewCase {
  name: string;
  /** A fresh spy adapter, so each test counts conversions from zero. */
  newSpy: () => jest.Mock;
  render: (
    items: Row[],
    convert: jest.Mock,
    extra?: {
      layout?: 'list' | 'grid';
      showAlphabetScroller?: boolean;
      activeLetters?: Set<string>;
    },
  ) => React.ReactElement;
}

const views: ViewCase[] = [
  {
    name: 'AlbumListView',
    newSpy: () => jest.fn(asAlbum),
    render: (items, convert, extra) => (
      <AlbumListView items={items} toAlbum={convert} {...extra} />
    ),
  },
  {
    name: 'ArtistListView',
    newSpy: () => jest.fn(asArtist),
    render: (items, convert, extra) => (
      <ArtistListView items={items} toArtist={convert} {...extra} />
    ),
  },
  {
    name: 'PlaylistListView',
    newSpy: () => jest.fn(asPlaylist),
    render: (items, convert, extra) => (
      <PlaylistListView items={items} toPlaylist={convert} {...extra} />
    ),
  },
];

/**
 * The point of the whole design: the conversion is per ROW, not per array identity.
 * Paging appends a new array, and before this it re-mapped everything already loaded —
 * O(N²) mapper calls across a long scroll. Without these tests that regression is
 * invisible: the rendered output is identical either way.
 */
describe.each(views)('$name — the per-row adapter runs once per row', ({ newSpy, render: r }) => {
  it('converts each row exactly once on the first render', () => {
    const convert = newSpy();
    render(r(page(0, 4), convert));
    expect(convert).toHaveBeenCalledTimes(4);
    expect(convert.mock.calls.map(([row]: [Row]) => row.id)).toEqual(['0', '1', '2', '3']);
  });

  it('converts ONLY the appended rows when a page lands', () => {
    const convert = newSpy();
    const first = page(0, 4);
    const view = render(r(first, convert));
    convert.mockClear();

    // Exactly what `setRows((rows) => [...rows, ...next])` produces: a new array
    // identity holding the same row objects, plus the new page.
    view.rerender(r([...first, ...page(4, 6)], convert));

    expect(convert.mock.calls.map(([row]: [Row]) => row.id)).toEqual(['4', '5']);
  });

  it('converts ONLY the prepended rows when a backward page lands', () => {
    const convert = newSpy();
    const first = page(4, 8);
    const view = render(r(first, convert));
    convert.mockClear();

    view.rerender(r([...page(2, 4), ...first], convert));

    expect(convert.mock.calls.map(([row]: [Row]) => row.id)).toEqual(['2', '3']);
  });

  it('converts nothing again when the array identity changes but the rows do not', () => {
    const convert = newSpy();
    const first = page(0, 4);
    const view = render(r(first, convert));
    convert.mockClear();

    view.rerender(r([...first], convert));

    expect(convert).not.toHaveBeenCalled();
  });

  it('re-converts a row that was genuinely replaced, and only that row', () => {
    const convert = newSpy();
    const first = page(0, 4);
    const view = render(r(first, convert));
    convert.mockClear();

    const replaced = [...first];
    replaced[2] = { id: '2', name: 'Item 2 (renamed)' };
    view.rerender(r(replaced, convert));

    expect(convert.mock.calls.map(([row]: [Row]) => row.name)).toEqual(['Item 2 (renamed)']);
  });

  it('re-converts every row when the adapter identity changes — why it must be stable', () => {
    const first = page(0, 4);
    const view = render(r(first, newSpy()));
    const replacement = newSpy();

    view.rerender(r(first, replacement));

    // The consumers pass module-level functions for exactly this reason: an inline arrow
    // would hand a new adapter down on every render and re-convert the whole window.
    expect(replacement).toHaveBeenCalledTimes(4);
  });

  it('converts only the appended rows in grid layout too', () => {
    const convert = newSpy();
    const first = page(0, 4);
    const view = render(r(first, convert, { layout: 'grid' }));
    convert.mockClear();

    view.rerender(r([...first, ...page(4, 6)], convert, { layout: 'grid' }));

    expect(convert.mock.calls.map(([row]: [Row]) => row.id)).toEqual(['4', '5']);
  });

  it('keeps the per-row memo across a prepend in grid layout, where every index shifts', () => {
    const convert = newSpy();
    const first = page(4, 8);
    const view = render(r(first, convert, { layout: 'grid' }));
    convert.mockClear();

    view.rerender(r([...page(2, 4), ...first], convert, { layout: 'grid' }));

    expect(convert.mock.calls.map(([row]: [Row]) => row.id)).toEqual(['2', '3']);
  });
});

/**
 * The A-Z scroller's second whole-array pass. In keyset mode the screen supplies the
 * full active letter set because the loaded window cannot reveal it — so computing
 * letters from the window is work whose result is thrown away.
 */
describe.each(views)('$name — the A-Z letter pass', ({ newSpy, render: r }) => {
  const ALL_LETTERS = new Set(['#', 'A', 'B']);

  it('skips the whole-array pass when the screen supplies activeLetters', () => {
    const convert = newSpy();
    render(r(page(0, 4), convert, { showAlphabetScroller: true, activeLetters: ALL_LETTERS }));
    // One conversion per rendered row and nothing else.
    expect(convert).toHaveBeenCalledTimes(4);
  });

  it('still computes the letters from the array when the screen supplies none', () => {
    const convert = newSpy();
    render(r(page(0, 4), convert, { showAlphabetScroller: true }));
    // Four rendered rows plus the letter pass over all four.
    expect(convert).toHaveBeenCalledTimes(8);
  });
});
