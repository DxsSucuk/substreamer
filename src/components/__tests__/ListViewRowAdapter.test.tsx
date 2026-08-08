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
/** Capture each row's tap handler — the default queue is built by pressing, not by
 *  rendering, and that is the behaviour under test below. */
const rowPresses: (() => void)[] = [];
jest.mock('../TrackRow', () => ({
  TrackRow: ({ onPress }: { onPress: () => void }) => {
    rowPresses.push(onPress);
    return null;
  },
}));

const mockPlayTrack = jest.fn();
jest.mock('../../services/playerService', () => ({
  playTrack: (...a: unknown[]) => mockPlayTrack(...a),
}));
jest.mock('../SongCard', () => ({ SongCard: () => null }));
jest.mock('../AlphabetScroller', () => ({ AlphabetScroller: () => null }));

import React from 'react';
import { render } from '@testing-library/react-native';

import type { AlbumID3, ArtistID3, Child, Playlist } from 'subsonic-api';

import { AlbumListView } from '../AlbumListView';
import { ArtistListView } from '../ArtistListView';
import { PlaylistListView } from '../PlaylistListView';
import { SongListView } from '../SongListView';

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
const asSong = (r: Row): Child => ({ id: r.id, title: r.name, isDir: false });

/** The scroller letter comes from the key the list was ordered by, so the letter pass
 *  calls THIS, not the row adapter. Every letter is distinct, so the set it builds is
 *  the whole array — the widest version of the pass. */
const sortKeyOf = (r: Row): string => r.name.toLowerCase();

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
      sortKeyOf?: (item: Row) => string;
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
  {
    name: 'SongListView',
    newSpy: () => jest.fn(asSong),
    render: (items, convert, extra) => (
      <SongListView items={items} toSong={convert} onSongPress={noopPress} {...extra} />
    ),
  },
];

/** Module-level, so the row adapters' `onPress` is not what churns in these tests. */
function noopPress(): void {}

beforeEach(() => {
  rowPresses.length = 0;
  mockPlayTrack.mockClear();
});

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
    const keyOf = jest.fn(sortKeyOf);
    render(
      r(page(0, 4), convert, {
        showAlphabetScroller: true,
        activeLetters: ALL_LETTERS,
        sortKeyOf: keyOf,
      }),
    );
    // One conversion per rendered row and nothing else — no letter pass at all.
    expect(convert).toHaveBeenCalledTimes(4);
    expect(keyOf).not.toHaveBeenCalled();
  });

  it('runs the letter pass over the KEY, never over the row adapter', () => {
    const convert = newSpy();
    const keyOf = jest.fn(sortKeyOf);
    render(r(page(0, 4), convert, { showAlphabetScroller: true, sortKeyOf: keyOf }));
    // The pass happens (four keys read) and it costs zero conversions: the letter comes
    // from the stored key, not from the envelope the adapter builds.
    expect(keyOf).toHaveBeenCalledTimes(4);
    expect(convert).toHaveBeenCalledTimes(4);
  });
});

/**
 * `SongListView`'s default tap queues the WHOLE list, which needs a `Child[]` the view
 * does not hold. Building it per render would be the parallel envelope array this design
 * exists to delete, so it is built at press time instead — the one place it is needed.
 */
describe('SongListView — the default tap queues the whole list, built at press time', () => {
  it('converts once per rendered row and NOT again until a row is pressed', () => {
    const convert = jest.fn(asSong);
    render(<SongListView items={page(0, 4)} toSong={convert} />);
    // Four rows rendered, four conversions. No queue array was built.
    expect(convert).toHaveBeenCalledTimes(4);
    expect(mockPlayTrack).not.toHaveBeenCalled();
  });

  it('plays the tapped song against the whole list', () => {
    const rows = page(0, 4);
    render(<SongListView items={rows} toSong={asSong} />);
    rowPresses[2]();
    expect(mockPlayTrack).toHaveBeenCalledTimes(1);
    const [track, queue] = mockPlayTrack.mock.calls[0] as [Child, Child[]];
    expect(track.id).toBe('2');
    expect(queue.map((s) => s.id)).toEqual(['0', '1', '2', '3']);
  });

  it('hands the tap to onSongPress instead when the screen supplies one', () => {
    const onSongPress = jest.fn();
    render(<SongListView items={page(0, 2)} toSong={asSong} onSongPress={onSongPress} />);
    rowPresses[1]();
    expect(onSongPress).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
    expect(mockPlayTrack).not.toHaveBeenCalled();
  });
});
