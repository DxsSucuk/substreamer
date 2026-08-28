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
jest.mock('../../components/StarredAlbumList', () => ({ StarredAlbumList: () => null }));
jest.mock('../../components/StarredArtistList', () => ({ StarredArtistList: () => null }));

/** The list has its own suite; record what it is handed on EVERY render. The regressions
 *  this file guards are single frames, so the render history is the assertion. */
interface SongListRender {
  downloadedOnly: boolean;
  loading?: boolean;
  emptyMessage?: string;
  emptySubtitle?: string;
  listHeaderExtra?: React.ReactNode;
}
const mockRenders: SongListRender[] = [];
jest.mock('../../components/StarredSongList', () => ({
  StarredSongList: (p: SongListRender) => {
    mockRenders.push(p);
    const { Text, View } = require('react-native');
    const React = require('react');
    // The action bar rides in as `listHeaderExtra`; render it so its SQL-backed totals
    // are observable.
    return React.createElement(
      View,
      { testID: 'starred-song-list' },
      React.createElement(Text, null, 'songs'),
      p.listHeaderExtra,
    );
  },
}));

import React from 'react';
import { act, render, waitFor, type RenderAPI } from '@testing-library/react-native';

import type { Child } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { markStarredSongs } from '../../db/repository/favorites';
import { upsertSongs } from '../../db/repository/songs';
import { getDb } from '../../store/persistence/db';
import { favoritesStore } from '../../store/favoritesStore';
import { filterBarStore } from '../../store/filterBarStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { FavoritesScreen } from '../favorites';

const db = () => getDb()!;

/** The `__starred__` aggregate on disk. It is a `favorites` intent — it has no component
 *  metadata table at all, so a `cached_items` row is the whole of the fact. */
const seedStarredAggregate = (): void => {
  db().runSync(
    'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, ' +
      'downloaded_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['__starred__', 'favorites', 'Starred', 0, 0, 0],
  );
};

/** What a completing download does to the store: bump the counter the SQL probe keys on. */
const bumpRevision = (): void => {
  act(() => {
    musicCacheStore.setState((s) => ({ revision: s.revision + 1 }));
  });
};

const latest = (): SongListRender => mockRenders[mockRenders.length - 1];
const suppressed = (r: RenderAPI): boolean => r.queryByTestId('starred-song-list') === null;

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(() => {
  mockRenders.length = 0;
  for (const t of ['cached_items', 'cached_songs', 'songs', 'favorite_songs']) {
    db().runSync(`DELETE FROM ${t}`);
  }
  filterBarStore.setState({ downloadedOnly: false, favoritesOnly: false });
  offlineModeStore.setState({ offlineMode: false });
  musicCacheStore.setState({ revision: 0 } as never);
  favoritesStore.setState({ hydrated: true, loading: false, error: null, version: 0 } as never);
});

/**
 * The songs segment asks one question — "is the `__starred__` aggregate downloaded?" — and
 * three decisions hang off the answer: whether the segment renders at all, whether its list
 * is filtered, and which empty-state copy it shows. The answer comes from SQL now, so there
 * is a window where it is NOT YET KNOWN, and the two obvious defaults are both wrong in
 * different directions.
 */
describe('FavoritesScreen — the songs segment reads the aggregate from SQL', () => {
  it('renders the list when the aggregate is downloaded, with the store map empty', async () => {
    // Nothing is seeded into `musicCacheStore.cachedItems`: if the screen still read the
    // map this would suppress the segment instead.
    seedStarredAggregate();
    filterBarStore.setState({ downloadedOnly: true });
    const r = render(<FavoritesScreen />);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(suppressed(r)).toBe(false);
  });

  it('suppresses the segment once the read says the aggregate is ABSENT', async () => {
    filterBarStore.setState({ downloadedOnly: true });
    const r = render(<FavoritesScreen />);
    await waitFor(() => expect(suppressed(r)).toBe(true));
    // The Downloaded chip is what emptied this, not an absence of favourites — the copy
    // says so (see `favorites-filter-empty-copy.test.tsx` for the full matrix).
    expect(r.getByText('Nothing matches your filters')).toBeTruthy();
  });

  it('leaves the segment alone when the Downloaded filter is off', async () => {
    const r = render(<FavoritesScreen />);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(suppressed(r)).toBe(false);
    expect(mockRenders.every((m) => m.downloadedOnly === false)).toBe(true);
  });
});

describe('FavoritesScreen — the NOT-YET-KNOWN window', () => {
  it('does not suppress a segment that is about to appear', () => {
    // The aggregate IS downloaded, but the probe runs in an effect, i.e. after this frame.
    // Defaulting unknown to "absent" would blank the segment and then bring it back.
    seedStarredAggregate();
    filterBarStore.setState({ downloadedOnly: true });
    const r = render(<FavoritesScreen />);
    expect(suppressed(r)).toBe(false);
    expect(mockRenders[0].loading).toBe(true);
  });

  it('keeps the list FILTERED while unknown — never a frame of undownloaded music', () => {
    // The other direction, and the one that must not fall through: an unfiltered frame
    // would show favourites that are not on the device, which is the single failure a
    // Downloaded filter cannot have.
    seedStarredAggregate();
    filterBarStore.setState({ downloadedOnly: true });
    render(<FavoritesScreen />);
    expect(mockRenders[0].downloadedOnly).toBe(true);
  });

  it('never chooses the "download your favourites" copy before the answer', async () => {
    // Asserted on the PROPS, not on rendered text: the copy is only drawn once the list
    // comes back empty and not loading, so a text query in this window passes whatever the
    // derivation says. The props are where the decision is observable.
    offlineModeStore.setState({ offlineMode: true });
    const r = render(<FavoritesScreen />);
    expect(mockRenders[0]).toMatchObject({
      emptyMessage: 'No favorite songs yet',
      emptySubtitle: 'Star songs you love and they will appear here, or check your filters',
    });
    // …and the offline copy is correct once the read confirms the aggregate really is absent.
    await waitFor(() => expect(latest().emptyMessage).toBe('Not available offline'));
    expect(latest().emptySubtitle).toBe(
      'Download your favorite songs to access them in offline mode',
    );
    expect(suppressed(r)).toBe(false);
  });

  it('never renders the offline empty STATE over a segment that is about to appear', async () => {
    offlineModeStore.setState({ offlineMode: true });
    filterBarStore.setState({ downloadedOnly: true });
    const r = render(<FavoritesScreen />);
    expect(r.queryByText('Not available offline')).toBeNull();
    await waitFor(() => expect(r.queryByText('Not available offline')).not.toBeNull());
    expect(
      r.getByText('Download your favorite songs to access them in offline mode'),
    ).toBeTruthy();
  });

  it('holds the list on `loading` until the probe answers', async () => {
    // Offline with the aggregate present: the list itself may legitimately come back empty,
    // and an empty non-loading frame here picks its copy from the unknown state.
    seedStarredAggregate();
    offlineModeStore.setState({ offlineMode: true });
    const r = render(<FavoritesScreen />);
    expect(mockRenders[0].loading).toBe(true);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(suppressed(r)).toBe(false);
  });
});

describe('FavoritesScreen — reactivity on musicCacheStore.revision', () => {
  it('un-suppresses the segment when the aggregate is downloaded under the user', async () => {
    filterBarStore.setState({ downloadedOnly: true });
    const r = render(<FavoritesScreen />);
    await waitFor(() => expect(suppressed(r)).toBe(true));

    seedStarredAggregate();
    // SQL has no Zustand subscription; `revision` is the only signal this probe gets.
    bumpRevision();
    await waitFor(() => expect(suppressed(r)).toBe(false));
  });

  it('suppresses it again when the aggregate is deleted under the user', async () => {
    seedStarredAggregate();
    filterBarStore.setState({ downloadedOnly: true });
    const r = render(<FavoritesScreen />);
    await waitFor(() => expect(suppressed(r)).toBe(false));

    db().runSync("DELETE FROM cached_items WHERE item_id = '__starred__'");
    bumpRevision();
    await waitFor(() => expect(suppressed(r)).toBe(true));
  });

  it('re-runs the SQL totals when a download lands', async () => {
    // `starredSongTotals` counts the DOWNLOADED favourites under this filter, so it must
    // key on the same signal the probe does.
    seedStarredAggregate();
    await upsertSongs(db(), [{ id: 's1', title: 'Song s1', isDir: false, duration: 10 } as Child]);
    await markStarredSongs(db(), [{ id: 's1', starredAt: 100 }]);
    filterBarStore.setState({ downloadedOnly: true });
    const r = render(<FavoritesScreen />);
    await waitFor(() => expect(latest().loading).toBe(false));
    // Starred but not on disk yet, and the filter is on — so the total is zero.
    expect(r.queryByText('1 song')).toBeNull();

    db().runSync(
      'INSERT INTO cached_songs (song_id, album_id, suffix, bytes, format_captured_at, ' +
        'downloaded_at, title, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['s1', 'al1', 'mp3', 1, 0, 0, 'Song s1', 10],
    );
    bumpRevision();
    await waitFor(() => expect(r.queryByText('1 song')).not.toBeNull());
  });

  it('does not fall back to unknown on a re-read — the segment never flickers', async () => {
    seedStarredAggregate();
    filterBarStore.setState({ downloadedOnly: true });
    const r = render(<FavoritesScreen />);
    await waitFor(() => expect(latest().loading).toBe(false));
    mockRenders.length = 0;

    bumpRevision();
    await waitFor(() => expect(latest().loading).toBe(false));
    // Resetting the answer to `null` on every re-read would put a spinner over a perfectly
    // good list each time a download finishes.
    expect(mockRenders.filter((m) => m.loading)).toEqual([]);
    expect(suppressed(r)).toBe(false);
  });
});
