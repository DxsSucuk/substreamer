jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('expo-router/react-navigation', () => ({ useIsFocused: () => true }));

// `STARRED_SONGS_ITEM_ID` is duplicated here rather than imported, because importing it
// pulls the whole download service in. Its value is pinned by `musicCacheService.test.ts`.
jest.mock('../../services/musicCacheService', () => ({
  STARRED_SONGS_ITEM_ID: '__starred__',
  enqueueStarredSongsDownload: jest.fn(),
  deleteStarredSongsDownload: jest.fn(),
}));
jest.mock('../../services/playerService', () => ({ playTrack: jest.fn() }));
jest.mock('../../services/dataSyncService', () => ({ onPullToRefresh: jest.fn() }));
jest.mock('../../components/DownloadButton', () => ({ DownloadButton: () => null }));

/** The three lists have their own suites; here only the empty-state copy they are handed
 *  matters, so each records its props and renders nothing. */
interface EmptyCopy {
  emptyMessage?: string;
  emptySubtitle?: string;
  emptyIcon?: string;
}
const songRenders: EmptyCopy[] = [];
const albumRenders: EmptyCopy[] = [];
const artistRenders: EmptyCopy[] = [];
jest.mock('../../components/StarredSongList', () => ({
  StarredSongList: (p: EmptyCopy) => {
    songRenders.push(p);
    return null;
  },
}));
jest.mock('../../components/StarredAlbumList', () => ({
  StarredAlbumList: (p: EmptyCopy) => {
    albumRenders.push(p);
    return null;
  },
}));
jest.mock('../../components/StarredArtistList', () => ({
  StarredArtistList: (p: EmptyCopy) => {
    artistRenders.push(p);
    return null;
  },
}));

import React from 'react';
import { fireEvent, render, waitFor, type RenderAPI } from '@testing-library/react-native';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { getDb } from '../../store/persistence/db';
import { favoritesStore } from '../../store/favoritesStore';
import { filterBarStore } from '../../store/filterBarStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { FavoritesScreen } from '../favorites';

const db = () => getDb()!;

/** The `__starred__` aggregate on disk — a `favorites` intent, so a `cached_items` row is
 *  the whole of the fact. Present ⇒ the songs segment renders its (filtered) list rather
 *  than being replaced by an empty state. */
const seedStarredAggregate = (): void => {
  db().runSync(
    'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, ' +
      'downloaded_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['__starred__', 'favorites', 'Starred', 0, 0, 0],
  );
};

const lastSong = (): EmptyCopy => songRenders[songRenders.length - 1];
const lastAlbum = (): EmptyCopy => albumRenders[albumRenders.length - 1];
const lastArtist = (): EmptyCopy => artistRenders[artistRenders.length - 1];

const showAlbums = (r: RenderAPI): void => fireEvent.press(r.getByText('Albums'));
const showArtists = (r: RenderAPI): void => fireEvent.press(r.getByText('Artists'));

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(() => {
  songRenders.length = 0;
  albumRenders.length = 0;
  artistRenders.length = 0;
  for (const t of ['cached_items', 'cached_songs', 'songs', 'favorite_songs']) {
    db().runSync(`DELETE FROM ${t}`);
  }
  filterBarStore.setState({ downloadedOnly: false, favoritesOnly: false });
  offlineModeStore.setState({ offlineMode: false });
  musicCacheStore.setState({ revision: 0 } as never);
  favoritesStore.setState({ hydrated: true, loading: false, error: null, version: 0 } as never);
});

/**
 * Favourites → Songs with the Downloaded chip on must not read "No favorite songs yet"
 * for a user who HAS favourites, just none downloaded. Both branches are asserted
 * throughout — it is easy to make every empty state say "check your filters", and that
 * would be the worse bug.
 *
 * Only `downloadedOnly` is consulted on this tab: `FilterBar` hides the Favourites chip on
 * the favourites route and the starred lists never apply it, so a `favoritesOnly` value
 * left over from the Library tab must not change any copy here.
 */
describe('FavoritesScreen — songs segment empty copy', () => {
  it('says the FILTER emptied it when the Downloaded chip is on', async () => {
    seedStarredAggregate(); // aggregate present ⇒ the list renders, filtered
    filterBarStore.setState({ downloadedOnly: true });
    render(<FavoritesScreen />);
    await waitFor(() =>
      expect(lastSong().emptyMessage).toBe('Nothing matches your filters'),
    );
    expect(lastSong().emptySubtitle).toBe('Try adjusting your filters, or pull to refresh');
  });

  it('keeps the "star some songs" copy when no filter is on', async () => {
    render(<FavoritesScreen />);
    await waitFor(() => expect(lastSong().emptyMessage).toBe('No favorite songs yet'));
    expect(lastSong().emptySubtitle).toBe(
      'Star songs you love and they will appear here, or check your filters',
    );
  });

  it('keeps the OFFLINE copy — it outranks the generic filter message', async () => {
    // Offline forces and locks the Downloaded chip, so both conditions hold at once. The
    // offline copy explains the MODE and is the more specific of the two.
    offlineModeStore.setState({ offlineMode: true });
    filterBarStore.setState({ downloadedOnly: true });
    const r = render(<FavoritesScreen />);
    await waitFor(() => expect(r.queryByText('Not available offline')).not.toBeNull());
    expect(
      r.getByText('Download your favorite songs to access them in offline mode'),
    ).toBeTruthy();
    expect(r.queryByText('Nothing matches your filters')).toBeNull();
  });

  it('ignores a stale Favourites chip left over from the Library tab', async () => {
    // The chip is not even rendered on this route, and the starred list does not apply it.
    filterBarStore.setState({ favoritesOnly: true });
    render(<FavoritesScreen />);
    await waitFor(() => expect(lastSong().emptyMessage).toBe('No favorite songs yet'));
  });
});

describe('FavoritesScreen — albums segment empty copy', () => {
  it('says the FILTER emptied it when the Downloaded chip is on', async () => {
    filterBarStore.setState({ downloadedOnly: true });
    const r = render(<FavoritesScreen />);
    showAlbums(r);
    await waitFor(() => expect(lastAlbum().emptyMessage).toBe('Nothing matches your filters'));
    expect(lastAlbum().emptySubtitle).toBe('Try adjusting your filters, or pull to refresh');
  });

  it('keeps the "star some albums" copy when no filter is on', async () => {
    const r = render(<FavoritesScreen />);
    showAlbums(r);
    await waitFor(() => expect(lastAlbum().emptyMessage).toBe('No favorite albums yet'));
    expect(lastAlbum().emptySubtitle).toBe(
      'Star albums you love and they will appear here, or check your filters',
    );
  });
});

/** Artists needed NO change: the Downloaded chip replaces the whole segment with the
 *  "can't be downloaded" placeholder, so the only state left is a genuine absence of
 *  starred artists. This suite is the guard that the fix did not disturb either. */
describe('FavoritesScreen — artists segment empty copy', () => {
  it('keeps the "artists cannot be downloaded" placeholder under the Downloaded chip', async () => {
    filterBarStore.setState({ downloadedOnly: true });
    const r = render(<FavoritesScreen />);
    showArtists(r);
    await waitFor(() => expect(r.queryByText("Artists can't be downloaded")).not.toBeNull());
    expect(r.getByText('Turn off the Downloaded filter to browse artists')).toBeTruthy();
    expect(r.queryByText('Nothing matches your filters')).toBeNull();
  });

  it('keeps the "star some artists" copy when no filter is on', async () => {
    const r = render(<FavoritesScreen />);
    showArtists(r);
    await waitFor(() => expect(lastArtist().emptyMessage).toBe('No favorite artists yet'));
    expect(lastArtist().emptySubtitle).toBe(
      'Star artists you love and they will appear here, or check your filters',
    );
  });
});
