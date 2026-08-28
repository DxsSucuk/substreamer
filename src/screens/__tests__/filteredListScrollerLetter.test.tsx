jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../../services/playerService', () => ({ playTrack: jest.fn() }));

/**
 * Capture what each filtered screen hands its list view: the items, in the order SQL
 * returned them, and the `sortKeyOf` the A-Z scroller letters with. Those two together
 * are the whole claim under test.
 */
interface Capture {
  items: { id: string }[];
  sortKeyOf?: (item: { id: string }) => string;
  loading?: boolean;
}
const captured: Capture[] = [];
const captureView = () => (p: Capture) => {
  captured.push(p);
  return null;
};
jest.mock('../../components/AlbumListView', () => ({ AlbumListView: captureView() }));
jest.mock('../../components/ArtistListView', () => ({ ArtistListView: captureView() }));
jest.mock('../../components/PlaylistListView', () => ({ PlaylistListView: captureView() }));
jest.mock('../../components/SongListView', () => ({ SongListView: captureView() }));

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

import type { AlbumID3, ArtistID3, Child } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { upsertAlbums } from '../../db/repository/albums';
import { upsertArtists } from '../../db/repository/artists';
import {
  markStarredAlbums,
  markStarredArtists,
  markStarredSongs,
  replaceFavoriteAlbums,
  replaceFavoriteArtists,
  replaceFavoriteSongs,
} from '../../db/repository/favorites';
import { upsertSongs } from '../../db/repository/songs';
import { songSortKeys } from '../../db/sortKeys';
import { getDb } from '../../store/persistence/db';
import { upsertCachedItem } from '../../store/persistence/musicCacheTables';
import { favoritesStore } from '../../store/favoritesStore';
import { layoutPreferencesStore } from '../../store/layoutPreferencesStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import { letterOfSortKey } from '../../utils/sortHelpers';
import { AlbumLibraryListScreen } from '../album-library-list';
import { ArtistListScreen } from '../artist-list';
import { PlaylistListScreen } from '../playlist-list';
import { SongLibraryListScreen } from '../song-library-list';

const db = () => getDb()!;
const latest = (): Capture => captured[captured.length - 1];

const album = (id: string, extra: Partial<AlbumID3> = {}): AlbumID3 =>
  ({ id, name: `Album ${id}`, duration: 0, songCount: 0, ...extra }) as AlbumID3;
const song = (id: string, extra: Partial<Child> = {}): Child =>
  ({ id, title: `Song ${id}`, isDir: false, duration: 10, ...extra }) as Child;

const seedDownloadedAlbum = (id: string, a: Partial<AlbumID3>): Promise<void> =>
  upsertCachedItem({
    itemId: id,
    type: 'album',
    name: a.name ?? `Album ${id}`,
    expectedSongCount: 0,
    lastSyncAt: 0,
    downloadedAt: 0,
    albumMeta: { name: a.name ?? `Album ${id}`, artist: a.artist, displayArtist: a.displayArtist },
  });

const seedDownloadedPlaylist = (id: string, name: string): Promise<void> =>
  upsertCachedItem({
    itemId: id,
    type: 'playlist',
    name,
    expectedSongCount: 0,
    lastSyncAt: 0,
    downloadedAt: 0,
    playlistMeta: { name },
  });

const seedDownloadedSong = (id: string, c: Partial<Child>): void => {
  const keys = songSortKeys(c);
  db().runSync(
    'INSERT INTO cached_songs (song_id, album_id, suffix, bytes, format_captured_at, ' +
      'downloaded_at, title, artist, duration, sort_name, sort_title, sort_artist) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      'al1',
      'mp3',
      1,
      0,
      0,
      c.title ?? '',
      c.artist ?? null,
      10,
      c.sortName ?? null,
      keys.sort_title,
      keys.sort_artist,
    ],
  );
};

/**
 * The three fixtures are the three divergences that actually shipped, one per step:
 *  - an album whose `displayArtist` differs from its `artist` tag (3b),
 *  - a song carrying a server `sortName` (3c),
 *  - a title with leading punctuation (3b's key change).
 * Each is placed BETWEEN two rows that bracket it under the correct letter, so a letter
 * derived from anything but the stored key lands outside its own group.
 */
const seeds: Record<string, () => Promise<void>> = {
  'albums — downloaded': async () => {
    await seedDownloadedAlbum('dl-g', { name: 'Album G', artist: 'Ghosts' });
    await seedDownloadedAlbum('dl-h', { name: '"Heroes"', artist: 'Zebra', displayArtist: 'Heron' });
    await seedDownloadedAlbum('dl-i', { name: 'Album I', artist: 'Ivy' });
  },
  'albums — favourites': async () => {
    await upsertAlbums(db(), [
      album('fav-g', { artist: 'Ghosts' }),
      album('fav-h', { name: '"Heroes"', artist: 'Zebra', displayArtist: 'Heron' }),
    ]);
    await markStarredAlbums(db(), [
      { id: 'fav-g', starredAt: 1 },
      { id: 'fav-h', starredAt: 9 },
    ]);
    // The REMAINDER half — parsed JSON envelopes, ordered on the same stored keys.
    await replaceFavoriteAlbums(db(), [
      album('rem-i', { artist: 'Ivy', starred: new Date(5) }),
    ]);
  },
  'artists — favourites': async () => {
    await upsertArtists(db(), [
      { id: 'fav-g', name: 'Ghosts', albumCount: 1 } as ArtistID3,
      { id: 'fav-h', name: '"Heroes"', albumCount: 1 } as ArtistID3,
    ]);
    await markStarredArtists(db(), [
      { id: 'fav-g', starredAt: 1 },
      { id: 'fav-h', starredAt: 9 },
    ]);
    await replaceFavoriteArtists(db(), [
      { id: 'rem-i', name: 'Ivy', albumCount: 1, starred: new Date(5) } as ArtistID3,
    ]);
  },
  'playlists — downloaded': async () => {
    await seedDownloadedPlaylist('dl-g', 'Ghosts');
    await seedDownloadedPlaylist('dl-h', '"Heroes"');
    await seedDownloadedPlaylist('dl-i', 'Ivy');
  },
  'songs — downloaded': async () => {
    seedDownloadedSong('dl-g', { title: 'Ghosts' });
    seedDownloadedSong('dl-h', { title: '"Heroes"' });
    // The `sortName` case: raw title says A, the stored key says H.
    seedDownloadedSong('dl-h2', { title: 'A Horse With No Name', sortName: 'Horse With No Name' });
    seedDownloadedSong('dl-i', { title: 'Ivy' });
  },
  'songs — favourites': async () => {
    await upsertSongs(db(), [
      song('fav-g', { title: 'Ghosts' }),
      song('fav-h', { title: '"Heroes"' }),
    ]);
    await markStarredSongs(db(), [
      { id: 'fav-g', starredAt: 1 },
      { id: 'fav-h', starredAt: 9 },
    ]);
    await replaceFavoriteSongs(db(), [
      song('rem-h2', {
        title: 'A Horse With No Name',
        sortName: 'Horse With No Name',
        starred: new Date(5),
      }),
      song('rem-i', { title: 'Ivy', starred: new Date(4) }),
    ]);
  },
};

interface Branch {
  name: keyof typeof seeds;
  screen: React.ReactElement;
  /** The ids in the order SQL must return them, and the letter each files under. */
  expected: [string, string][];
}

const branches: Branch[] = [
  {
    name: 'albums — downloaded',
    screen: <AlbumLibraryListScreen downloadedOnly />,
    expected: [
      ['dl-g', 'G'],
      ['dl-h', 'H'],
      ['dl-i', 'I'],
    ],
  },
  {
    name: 'albums — favourites',
    screen: <AlbumLibraryListScreen favoritesOnly />,
    expected: [
      ['fav-g', 'G'],
      ['fav-h', 'H'],
      ['rem-i', 'I'],
    ],
  },
  {
    name: 'artists — favourites',
    screen: <ArtistListScreen favoritesOnly />,
    expected: [
      ['fav-g', 'G'],
      ['fav-h', 'H'],
      ['rem-i', 'I'],
    ],
  },
  {
    name: 'playlists — downloaded',
    screen: <PlaylistListScreen downloadedOnly />,
    expected: [
      ['dl-g', 'G'],
      ['dl-h', 'H'],
      ['dl-i', 'I'],
    ],
  },
  {
    name: 'songs — downloaded',
    screen: <SongLibraryListScreen downloadedOnly />,
    expected: [
      ['dl-g', 'G'],
      ['dl-h', 'H'],
      ['dl-h2', 'H'],
      ['dl-i', 'I'],
    ],
  },
  {
    name: 'songs — favourites',
    screen: <SongLibraryListScreen favoritesOnly />,
    expected: [
      ['fav-g', 'G'],
      ['fav-h', 'H'],
      ['rem-h2', 'H'],
      ['rem-i', 'I'],
    ],
  },
];

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(() => {
  captured.length = 0;
  for (const t of [
    'cached_item_songs',
    'cached_songs',
    'cached_albums',
    'cached_playlists',
    'cached_items',
    'songs',
    'albums',
    'artists',
    'favorite_songs',
    'favorite_albums',
    'favorite_artists',
  ]) {
    db().runSync(`DELETE FROM ${t}`);
  }
  favoritesStore.setState({ version: 0 });
  musicCacheStore.setState({ cachedItems: {}, revision: 0 });
  layoutPreferencesStore.setState({ albumSortOrder: 'artist', songSortOrder: 'title' });
});

/**
 * The property that has broken three times, asserted end to end: the letter the A-Z
 * scroller files a row under is `letterOfSortKey` of the key SQL ORDERED that row by, so
 * it is by construction the letter of the position the row occupies.
 *
 * These read real SQL through the real repository, so the fixture exercises the whole
 * chain: writer → stored `sort_*` key → `ORDER BY` → the key handed to the view.
 */
describe.each(branches)('$name — the scroller letter is the position', (b) => {
  beforeEach(async () => {
    await seeds[b.name]();
  });

  it('returns the rows in the SQL order the fixture expects', async () => {
    render(b.screen);
    await waitFor(() => expect(latest().items).toHaveLength(b.expected.length));
    expect(latest().items.map((i) => i.id)).toEqual(b.expected.map(([id]) => id));
  });

  it('letters each row from the key it was ordered by', async () => {
    render(b.screen);
    await waitFor(() => expect(latest().items).toHaveLength(b.expected.length));
    const keyOf = latest().sortKeyOf;
    expect(keyOf).toBeDefined();
    expect(latest().items.map((i) => letterOfSortKey(keyOf!(i)))).toEqual(
      b.expected.map(([, letter]) => letter),
    );
  });

  it('never lets a letter reappear after another has intervened', async () => {
    // The direct statement of "the letter matches the position": in SQL order, each
    // letter's rows are contiguous. Every one of the three shipped divergences breaks
    // this — the row sorts in one group and claims another group's letter.
    render(b.screen);
    await waitFor(() => expect(latest().items).toHaveLength(b.expected.length));
    const keyOf = latest().sortKeyOf!;
    const seen = new Set<string>();
    let previous: string | null = null;
    for (const item of latest().items) {
      const letter = letterOfSortKey(keyOf(item));
      if (letter !== previous) {
        expect(seen.has(letter)).toBe(false);
        seen.add(letter);
        previous = letter;
      }
    }
  });
});

/** The same claim under the OTHER sort order. Albums and songs key on `sort_artist`
 *  there, so the letter has to follow the preference across the same rows. */
describe('the artist sort order letters on sort_artist, not sort_title', () => {
  it('follows the preference for the downloaded albums list', async () => {
    await seedDownloadedAlbum('dl-1', { name: 'Zulu', artist: 'Alpaca' });
    await seedDownloadedAlbum('dl-2', { name: 'Alpha', artist: 'Zebra' });
    render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(2));
    const keyOf = latest().sortKeyOf!;
    expect(latest().items.map((i) => i.id)).toEqual(['dl-1', 'dl-2']);
    expect(latest().items.map((i) => letterOfSortKey(keyOf(i)))).toEqual(['A', 'Z']);
  });

  it('follows the preference for the downloaded songs list', async () => {
    layoutPreferencesStore.setState({ songSortOrder: 'artist' });
    seedDownloadedSong('dl-1', { title: 'Zulu', artist: 'Alpaca' });
    seedDownloadedSong('dl-2', { title: 'Alpha', artist: 'Zebra' });
    render(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(2));
    const keyOf = latest().sortKeyOf!;
    expect(latest().items.map((i) => i.id)).toEqual(['dl-1', 'dl-2']);
    expect(latest().items.map((i) => letterOfSortKey(keyOf(i)))).toEqual(['A', 'Z']);
  });

  it('follows the preference for the favourites songs list, remainder included', async () => {
    layoutPreferencesStore.setState({ songSortOrder: 'artist' });
    await upsertSongs(db(), [song('lib-1', { title: 'Zulu', artist: 'Alpaca' })]);
    await markStarredSongs(db(), [{ id: 'lib-1', starredAt: 1 }]);
    await replaceFavoriteSongs(db(), [
      song('rem-2', { title: 'Alpha', artist: 'Zebra', starred: new Date(9) }),
    ]);
    render(<SongLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(2));
    const keyOf = latest().sortKeyOf!;
    expect(latest().items.map((i) => i.id)).toEqual(['lib-1', 'rem-2']);
    expect(latest().items.map((i) => letterOfSortKey(keyOf(i)))).toEqual(['A', 'Z']);
  });

  it('follows the preference for the favourites albums list, remainder included', async () => {
    await upsertAlbums(db(), [album('lib-1', { name: 'Zulu', artist: 'Alpaca' })]);
    await markStarredAlbums(db(), [{ id: 'lib-1', starredAt: 1 }]);
    await replaceFavoriteAlbums(db(), [
      album('rem-2', { name: 'Alpha', artist: 'Zebra', starred: new Date(9) }),
    ]);
    render(<AlbumLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(2));
    const keyOf = latest().sortKeyOf!;
    expect(latest().items.map((i) => i.id)).toEqual(['lib-1', 'rem-2']);
    expect(latest().items.map((i) => letterOfSortKey(keyOf(i)))).toEqual(['A', 'Z']);
  });
});
