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

/** The A-Z tap seeks by INDEX in array mode, so the ref's `scrollToIndex` is the answer
 *  under test — not the rendered output. */
const scrollCalls: { index: number }[] = [];
jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    FlashList: React.forwardRef(function MockFlashList(_p: unknown, ref: unknown) {
      React.useImperativeHandle(ref, () => ({
        scrollToIndex: (a: { index: number }) => scrollCalls.push(a),
      }));
      return React.createElement(View, { testID: 'flash-list' });
    }),
  };
});

jest.mock('../AlbumRow', () => ({ AlbumRow: () => null }));
jest.mock('../AlbumCard', () => ({ AlbumCard: () => null }));
jest.mock('../ArtistRow', () => ({ ArtistRow: () => null }));
jest.mock('../ArtistCard', () => ({ ArtistCard: () => null }));
jest.mock('../PlaylistRow', () => ({ PlaylistRow: () => null }));
jest.mock('../PlaylistCard', () => ({ PlaylistCard: () => null }));
jest.mock('../TrackRow', () => ({ TrackRow: () => null }));
jest.mock('../SongCard', () => ({ SongCard: () => null }));

/** The scroller's claim: "these letters are reachable, and tapping one goes here." */
let letters: Set<string> = new Set();
let tap: (letter: string) => void = () => {};
jest.mock('../AlphabetScroller', () => ({
  AlphabetScroller: (p: { activeLetters: Set<string>; onLetterChange: (l: string) => void }) => {
    letters = p.activeLetters;
    tap = p.onLetterChange;
    return null;
  },
}));

import React from 'react';
import { render } from '@testing-library/react-native';

import type { AlbumID3, ArtistID3, Child, Playlist } from 'subsonic-api';

import { albumSortKeys, artistSortTitle, playlistSortTitle, songSortKeys } from '../../db/sortKeys';
import { letterOfSortKey } from '../../utils/sortHelpers';
import { AlbumListView } from '../AlbumListView';
import { ArtistListView } from '../ArtistListView';
import { PlaylistListView } from '../PlaylistListView';
import { SongListView } from '../SongListView';

/**
 * One row as SQL hands it over: the envelope it renders, and the key the `ORDER BY`
 * used. `key` is produced by the REAL derivation (`db/sortKeys`), never written by hand,
 * so a change to what gets stored moves this fixture with it.
 */
interface Row {
  id: string;
  key: string;
  album?: AlbumID3;
  artist?: ArtistID3;
  playlist?: Playlist;
  song?: Child;
}

/** SQLite's BINARY collation on TEXT: UTF-16 code units, which is `<` on strings. The
 *  tiebreak is the id, exactly as every `ORDER BY … , id` tuple does. */
const inSqlOrder = (rows: Row[]): Row[] =>
  [...rows].sort((a, b) => (a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.id < b.id ? -1 : 1));

const keyOf = (r: Row): string => r.key;

interface ViewCase {
  name: string;
  /** In arbitrary order — the test sorts them the way SQL would. */
  rows: Row[];
  /** The letter each row must file under, once sorted. */
  expected: string[];
  render: (
    rows: Row[],
    opts?: { activeLetters?: Set<string>; sortKeyOf?: (r: Row) => string },
  ) => React.ReactElement;
}

/* ------------------------------------------------------------------ */
/*  The fixtures — the three divergences that actually shipped         */
/* ------------------------------------------------------------------ */

/** 3b: `sort_artist` is `displayArtist ?? artist ?? name`, and the scroller read
 *  `artist ?? name`. A server sending BOTH with different values filed the row under Z
 *  while the list sorted it at A. */
const albumRow = (id: string, a: Partial<AlbumID3>): Row => {
  const album = { id, name: 'Album', songCount: 0, duration: 0, ...a } as AlbumID3;
  return { id, key: albumSortKeys(album).sort_artist, album };
};

/** 3c: `sort_title` is `getSortKey(title, sortName)`, and the projection dropped
 *  `sortName` — so the scroller recomputed from the raw title and filed under A. */
const songRow = (id: string, c: Partial<Child>): Row => {
  const song = { id, title: 'Song', isDir: false, ...c } as Child;
  return { id, key: songSortKeys(song).sort_title, song };
};

const artistRow = (id: string, a: Partial<ArtistID3>): Row => {
  const artist = { id, name: 'Artist', albumCount: 0, ...a } as ArtistID3;
  return { id, key: artistSortTitle(artist), artist };
};

const playlistRow = (id: string, p: Partial<Playlist>): Row => {
  const playlist = { id, name: 'Playlist', songCount: 0, duration: 0, ...p } as Playlist;
  return { id, key: playlistSortTitle(playlist), playlist };
};

const toAlbum = (r: Row): AlbumID3 => r.album!;
const toArtist = (r: Row): ArtistID3 => r.artist!;
const toPlaylist = (r: Row): Playlist => r.playlist!;
const toSong = (r: Row): Child => r.song!;
const noopPress = (): void => {};

const views: ViewCase[] = [
  {
    name: 'AlbumListView',
    rows: [
      albumRow('a-ghosts', { artist: 'Ghosts' }),
      // displayArtist differs from the artist tag: files under A, not Z.
      albumRow('a-display', { artist: 'Zebra', displayArtist: 'Alpaca' }),
      albumRow('a-ivy', { artist: 'Ivy' }),
      // Leading punctuation on the fallback (no artist at all): H, not '#'.
      albumRow('a-heroes', { name: '"Heroes"' }),
      // A second row under H — a tap must land on the FIRST of a group, not the last.
      albumRow('a-heron', { artist: 'Heron' }),
      albumRow('a-digit', { name: "'74 Jailbreak" }),
    ],
    expected: ['#', 'A', 'G', 'H', 'H', 'I'],
    render: (rows, opts) => (
      <AlbumListView
        items={rows}
        toAlbum={toAlbum}
        sortKeyOf={keyOf}
        showAlphabetScroller
        {...opts}
      />
    ),
  },
  {
    name: 'SongListView',
    rows: [
      songRow('s-ghosts', { title: 'Ghosts' }),
      // A server-stripped sortName: files under H, not A.
      songRow('s-sortname', { title: 'A Horse With No Name', sortName: 'Horse With No Name' }),
      songRow('s-ivy', { title: 'Ivy' }),
      songRow('s-heroes', { title: '"Heroes"' }),
      songRow('s-digit', { title: "'74 Jailbreak" }),
    ],
    expected: ['#', 'G', 'H', 'H', 'I'],
    render: (rows, opts) => (
      <SongListView
        items={rows}
        toSong={toSong}
        sortKeyOf={keyOf}
        onSongPress={noopPress}
        showAlphabetScroller
        {...opts}
      />
    ),
  },
  {
    name: 'ArtistListView',
    rows: [
      artistRow('r-ghosts', { name: 'Ghosts' }),
      artistRow('r-sortname', { name: 'U2', sortName: 'You Two' }),
      artistRow('r-ivy', { name: 'Ivy' }),
      artistRow('r-heroes', { name: '"Heroes"' }),
      artistRow('r-heron', { name: 'Heron' }),
      artistRow('r-digit', { name: "'74 Jailbreak" }),
    ],
    expected: ['#', 'G', 'H', 'H', 'I', 'Y'],
    render: (rows, opts) => (
      <ArtistListView
        items={rows}
        toArtist={toArtist}
        sortKeyOf={keyOf}
        showAlphabetScroller
        {...opts}
      />
    ),
  },
  {
    name: 'PlaylistListView',
    rows: [
      playlistRow('p-ghosts', { name: 'Ghosts' }),
      playlistRow('p-the', { name: 'The Alpacas' }),
      playlistRow('p-ivy', { name: 'Ivy' }),
      playlistRow('p-heroes', { name: '"Heroes"' }),
      playlistRow('p-heron', { name: 'Heron' }),
      playlistRow('p-digit', { name: "'74 Jailbreak" }),
    ],
    expected: ['#', 'A', 'G', 'H', 'H', 'I'],
    render: (rows, opts) => (
      <PlaylistListView
        items={rows}
        toPlaylist={toPlaylist}
        sortKeyOf={keyOf}
        showAlphabetScroller
        {...opts}
      />
    ),
  },
];

beforeEach(() => {
  letters = new Set();
  tap = () => {};
  scrollCalls.length = 0;
});

/**
 * The property that has broken three times, asserted directly: the letter a row files
 * under is the letter of the POSITION it occupies in the SQL order. Two derivations of
 * the same thing cannot both be right, so there is only one — the stored key.
 */
describe.each(views)('$name — the scroller letter IS the position', (v) => {
  const sorted = (): Row[] => inSqlOrder(v.rows);

  it('files every row under the letter of the key it sorted on', () => {
    const rows = sorted();
    render(v.render(rows));
    expect(rows.map((r) => letterOfSortKey(r.key))).toEqual(v.expected);
    expect([...letters].sort()).toEqual([...new Set(v.expected)].sort());
  });

  it('never lets a letter reappear after another has intervened', () => {
    // The direct statement of "the letter matches the position": read down the list in
    // SQL order and each letter's rows are contiguous. Every one of the three shipped
    // divergences breaks this — the row sorts in one group and claims another's letter.
    const rows = sorted();
    render(v.render(rows));
    const seq = rows.map((r) => letterOfSortKey(r.key));
    const seen = new Set<string>();
    let previous: string | null = null;
    for (const letter of seq) {
      if (letter !== previous) {
        expect(seen.has(letter)).toBe(false);
        seen.add(letter);
        previous = letter;
      }
    }
  });

  it('lands a tap on the FIRST row of that letter', () => {
    const rows = sorted();
    render(v.render(rows));
    for (const letter of new Set(v.expected)) {
      scrollCalls.length = 0;
      tap(letter);
      expect(scrollCalls).toEqual([
        { index: rows.findIndex((r) => letterOfSortKey(r.key) === letter), animated: false },
      ]);
    }
  });

  it('does not scroll for a letter no row files under', () => {
    render(v.render(sorted()));
    tap('Q');
    expect(scrollCalls).toEqual([]);
  });

  it('reads the KEY, not the envelope — a key that disagrees with the name wins', () => {
    // The mechanical guarantee. If any view still derived a letter from the item it
    // renders, this row would file under Z; the key says A and the key is what sorts.
    // `sorted()[0]` is the `'74 Jailbreak` row: its envelope letters as `#`.
    render(v.render([{ ...sorted()[0], key: 'alpaca' }]));
    expect([...letters]).toEqual(['A']);
  });

  it('re-letters when the key accessor changes, as a sort-order flip does', () => {
    // The filtered screens hand a NEW `sortKeyOf` when the sort preference changes (the
    // key moves from `sort_title` to `sort_artist`). A letter set memoised on the old
    // accessor would keep lettering the rows by the order they are no longer in.
    const rows = sorted();
    const view = render(v.render(rows));
    expect([...letters].sort()).toEqual([...new Set(v.expected)].sort());

    view.rerender(v.render(rows, { sortKeyOf: () => 'quokka' }));
    expect([...letters]).toEqual(['Q']);
  });

  it('skips its own letter set entirely when the screen supplies one', () => {
    // Keyset mode: the loaded window cannot reveal which letters exist, so the screen
    // says, and the tap seeks through SQL rather than scrolling within the window.
    const supplied = new Set(['#', 'Q']);
    render(v.render(sorted(), { activeLetters: supplied }));
    expect(letters).toBe(supplied);
  });
});

/** Every consumer without an alphabetical order — the home album lists and the three
 *  Favourites-tab lists — hands no key at all. */
describe('a view with no sortKeyOf claims no letters', () => {
  it('offers an empty active set rather than guessing from the envelope', () => {
    render(
      <AlbumListView items={inSqlOrder(views[0].rows)} toAlbum={toAlbum} showAlphabetScroller />,
    );
    expect([...letters]).toEqual([]);
    tap('A');
    expect(scrollCalls).toEqual([]);
  });
});
