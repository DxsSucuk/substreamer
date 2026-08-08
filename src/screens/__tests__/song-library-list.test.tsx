jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../../services/playerService', () => ({ playTrack: jest.fn() }));

/** The list view has its own suite; record what it is handed on EVERY render. The
 *  regression is a single frame, so the render history — not the final state — is
 *  the assertion. */
interface SongRender {
  items: { id: string }[];
  loading?: boolean;
  emptyMessage?: string;
  emptySubtitle?: string;
}
const mockRenders: SongRender[] = [];
/** Mounts, not renders: the filtered screen picks its adapter per branch, so it renders
 *  two different `SongListView` calls. They must reconcile as one instance — a remount
 *  would drop the list's scroll position on every filter toggle. */
const mockMounts: string[] = [];
jest.mock('../../components/SongListView', () => {
  const React = require('react');
  return {
    SongListView: (p: SongRender) => {
      mockRenders.push(p);
      React.useEffect(() => {
        mockMounts.push('mount');
      }, []);
      return null;
    },
  };
});

import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';

import type { Child } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { songSortKeys } from '../../db/sortKeys';
import { upsertSongs } from '../../db/repository/songs';
import { markStarredSongs, replaceFavoriteSongs } from '../../db/repository/favorites';
import { getDb } from '../../store/persistence/db';
import { favoritesStore } from '../../store/favoritesStore';
import { layoutPreferencesStore } from '../../store/layoutPreferencesStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import { SongLibraryListScreen } from '../song-library-list';

const db = () => getDb()!;
const song = (id: string, extra: Partial<Child> = {}): Child =>
  ({ id, title: `Song ${id}`, isDir: false, duration: 10, ...extra }) as Child;

/** A downloaded song. BOTH filters read this from SQL now — the favourites read applies
 *  `downloadedOnly` in the query, and the downloaded filter is a whole-set read of it.
 *  The `sort_*` keys come from the same derivation the download writer uses, because the
 *  downloaded read ORDERs BY them. */
const markDownloadedInDb = (id: string, title = `Song ${id}`, artist?: string): void => {
  const keys = songSortKeys({ title, artist });
  db().runSync(
    'INSERT INTO cached_songs (song_id, album_id, suffix, bytes, format_captured_at, ' +
      'downloaded_at, title, artist, duration, sort_title, sort_artist) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, 'al1', 'mp3', 1, 0, 0, title, artist ?? null, 10, keys.sort_title, keys.sort_artist],
  );
};

/** The last render's props — `mockRenders` grows for the life of a test. */
const latest = (): SongRender => mockRenders[mockRenders.length - 1];

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(() => {
  mockRenders.length = 0;
  mockMounts.length = 0;
  for (const t of ['songs', 'favorite_songs', 'cached_songs']) db().runSync(`DELETE FROM ${t}`);
  favoritesStore.setState({ version: 0 });
  layoutPreferencesStore.setState({ songSortOrder: 'title' });
  musicCacheStore.setState({ cachedItems: {}, cachedSongs: {}, revision: 0 });
});

describe('SongLibraryListScreen — favourites filter never flashes the empty state', () => {
  beforeEach(async () => {
    await upsertSongs(db(), [song('star-a'), song('plain-b')]);
    await markStarredSongs(db(), [{ id: 'star-a', starredAt: 400 }]);
  });

  it('is already loading on the FIRST render, before the SQL read resolves', () => {
    render(<SongLibraryListScreen favoritesOnly />);
    // The read runs in an effect, i.e. after this frame is on screen. Loading has to be
    // seeded true or the list falls through to "No songs found" with zero rows.
    expect(mockRenders[0]).toMatchObject({ items: [], loading: true });
  });

  it('is never handed an empty, non-loading list while the read is in flight', async () => {
    render(<SongLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(1));
    // Every frame either has rows or says it is loading — the exact invariant that
    // keeps SongListView off its `ListEmptyComponent` branch.
    expect(mockRenders.filter((r) => r.items.length === 0 && !r.loading)).toEqual([]);
  });

  it('clears loading and renders the starred rows once the read resolves', async () => {
    render(<SongLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(1));
    expect(latest().items.map((s) => s.id)).toEqual(['star-a']);
    expect(latest().loading).toBe(false);
  });

  it('reports a genuinely empty favourites set only AFTER the read completes', async () => {
    db().runSync('DELETE FROM songs');
    render(<SongLibraryListScreen favoritesOnly />);
    expect(mockRenders[0].loading).toBe(true);
    // The placeholder is correct here — it just must not appear before the answer is known.
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest().items).toEqual([]);
  });
});

describe('SongLibraryListScreen — downloaded filter', () => {
  it('renders the downloaded rows from SQL, not from the store map', async () => {
    // The store is deliberately NOT seeded here: if the hook still walked `cachedSongs`
    // this would render nothing.
    markDownloadedInDb('dl1');
    render(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items.map((s) => s.id)).toEqual(['dl1']));
    expect(latest().loading).toBe(false);
  });

  it('is already loading on the FIRST render, before the SQL read resolves', () => {
    markDownloadedInDb('dl1');
    render(<SongLibraryListScreen downloadedOnly />);
    // The downloaded read is asynchronous now, so it needs the same derived flag the
    // favourites branch has — otherwise this frame is empty-and-not-loading and
    // SongListView flashes "No songs found".
    expect(mockRenders[0]).toMatchObject({ items: [], loading: true });
  });

  it('is never handed an empty, non-loading list while the read is in flight', async () => {
    markDownloadedInDb('dl1');
    render(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(1));
    expect(mockRenders.filter((r) => r.items.length === 0 && !r.loading)).toEqual([]);
  });

  it('reports a genuinely empty downloaded set only AFTER the read completes', async () => {
    render(<SongLibraryListScreen downloadedOnly />);
    expect(mockRenders[0].loading).toBe(true);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest().items).toEqual([]);
  });
});

/** `FilteredSongList` is mounted for EITHER filter, so switching Favourites on while
 *  Downloaded is already on re-renders the SAME instance — no mount, no fresh state
 *  initialiser. The loading flag has to be derived from the props to cover this. */
describe('SongLibraryListScreen — toggling Favourites on an already-mounted list', () => {
  beforeEach(async () => {
    await upsertSongs(db(), [song('star-a')]);
    await markStarredSongs(db(), [{ id: 'star-a', starredAt: 400 }]);
    markDownloadedInDb('star-a');
  });

  it('is loading from the very first frame after Favourites goes on', async () => {
    const r = render(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(1));
    mockRenders.length = 0;

    r.rerender(<SongLibraryListScreen downloadedOnly favoritesOnly />);
    // Before the derived flag this frame was `{ items: [], loading: false }` — one frame
    // of "No songs found" between the downloaded rows and the favourites rows.
    expect(mockRenders[0]).toMatchObject({ items: [], loading: true });
    await waitFor(() => expect(latest().items.map((s) => s.id)).toEqual(['star-a']));
    expect(mockRenders.filter((m) => m.items.length === 0 && !m.loading)).toEqual([]);
  });

  it('is loading from the very first frame after Favourites goes back OFF too', async () => {
    const r = render(<SongLibraryListScreen downloadedOnly favoritesOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    mockRenders.length = 0;

    r.rerender(<SongLibraryListScreen downloadedOnly />);
    // This assertion used to say the opposite: the downloaded branch read the store
    // synchronously, so a spinner here meant a stale favourites flag. It is a SQL read
    // now, so the same mounted component drops the favourites rows and waits — and the
    // frame in between has to say loading, exactly as the toggle-ON direction does.
    expect(mockRenders[0]).toMatchObject({ items: [], loading: true });
    await waitFor(() => expect(latest().items.map((s) => s.id)).toEqual(['star-a']));
    expect(mockRenders.filter((m) => m.items.length === 0 && !m.loading)).toEqual([]);
  });

  it('reuses the same list instance across the toggle in both directions', async () => {
    const r = render(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(1));

    r.rerender(<SongLibraryListScreen downloadedOnly favoritesOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    r.rerender(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));

    // The two branches hand the view different item shapes, different adapters and
    // different key accessors, but they are the same component in the same slot, so React
    // updates rather than remounts — which is what the derived loading flags depend on.
    expect(mockMounts).toHaveLength(1);
  });
});

/**
 * The defect this step fixes: with the sort order set to Artist the browse list ordered
 * by artist and both filtered lists silently fell back to raw-title order. Every case
 * below asserts a filtered list against an order the JS comparator could not produce.
 */
describe('SongLibraryListScreen — the filters follow the song sort order', () => {
  /** Titles and artists disagree, and the ids run with the TITLES — so an artist-ordered
   *  result cannot be reached by the id tiebreak either. */
  const seedFavourites = async (): Promise<void> => {
    await upsertSongs(db(), [
      song('a-lib', { title: 'Alpha', artist: 'Zebra' }),
      song('z-lib', { title: 'Zulu', artist: 'Alpaca' }),
    ]);
    await markStarredSongs(db(), [
      { id: 'a-lib', starredAt: 100 },
      { id: 'z-lib', starredAt: 400 },
    ]);
    await replaceFavoriteSongs(db(), [
      song('m-rem', { title: 'Mike', artist: 'Mongoose', starred: new Date(300) }),
    ]);
  };

  it('orders the FAVOURITES filter by artist when that is the preference', async () => {
    layoutPreferencesStore.setState({ songSortOrder: 'artist' });
    await seedFavourites();
    render(<SongLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(3));
    expect(latest().items.map((s) => s.id)).toEqual(['z-lib', 'm-rem', 'a-lib']);
  });

  it('orders the DOWNLOADED filter by artist when that is the preference', async () => {
    layoutPreferencesStore.setState({ songSortOrder: 'artist' });
    markDownloadedInDb('a-dl', 'Alpha', 'Zebra');
    markDownloadedInDb('z-dl', 'Zulu', 'Alpaca');
    render(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(2));
    expect(latest().items.map((s) => s.id)).toEqual(['z-dl', 'a-dl']);
  });

  it('RE-READS the favourites half when the preference changes', async () => {
    await seedFavourites();
    render(<SongLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().items.map((s) => s.id)).toEqual(['a-lib', 'm-rem', 'z-lib']));
    mockRenders.length = 0;

    act(() => layoutPreferencesStore.setState({ songSortOrder: 'artist' }));
    // The derived flag says so the moment the request changes: the rows we hold are no
    // longer the rows this sort order asks for. The view keeps drawing them (it only
    // spins with zero rows), so this never flashes.
    expect(mockRenders[0].loading).toBe(true);
    await waitFor(() => expect(latest().items.map((s) => s.id)).toEqual(['z-lib', 'm-rem', 'a-lib']));
    expect(mockRenders.filter((m) => m.items.length === 0)).toEqual([]);
  });

  it('RE-READS the downloaded half when the preference changes', async () => {
    markDownloadedInDb('a-dl', 'Alpha', 'Zebra');
    markDownloadedInDb('z-dl', 'Zulu', 'Alpaca');
    render(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items.map((s) => s.id)).toEqual(['a-dl', 'z-dl']));
    mockRenders.length = 0;

    act(() => layoutPreferencesStore.setState({ songSortOrder: 'artist' }));
    expect(mockRenders[0].loading).toBe(true);
    await waitFor(() => expect(latest().items.map((s) => s.id)).toEqual(['z-dl', 'a-dl']));
    expect(mockRenders.filter((m) => m.items.length === 0)).toEqual([]);
  });

  it('files a punctuation-leading title under H in EVERY filter combination', async () => {
    // The reported symptom: `"Heroes"` jumped back to `#` the moment a filter went on,
    // because the JS comparator compared the RAW title.
    await upsertSongs(db(), [
      song('s-h', { title: '"Heroes"' }),
      song('s-g', { title: 'Ghosts' }),
      song('s-i', { title: 'Ivy' }),
    ]);
    await markStarredSongs(db(), [
      { id: 's-h', starredAt: 3 },
      { id: 's-g', starredAt: 2 },
      { id: 's-i', starredAt: 1 },
    ]);
    for (const [id, title] of [
      ['s-h', '"Heroes"'],
      ['s-g', 'Ghosts'],
      ['s-i', 'Ivy'],
    ] as const) {
      markDownloadedInDb(id, title);
    }

    const expected = ['s-g', 's-h', 's-i'];
    const r = render(<SongLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().items.map((s) => s.id)).toEqual(expected));

    r.rerender(<SongLibraryListScreen favoritesOnly downloadedOnly />);
    await waitFor(() => expect(latest().items.map((s) => s.id)).toEqual(expected));

    r.rerender(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items.map((s) => s.id)).toEqual(expected));
  });

  it('does not reorder the list when a filter is toggled', async () => {
    // Same three rows reachable through both filters; the orders must be identical.
    await upsertSongs(db(), [
      song('a-lib', { title: 'Alpha', artist: 'Zebra' }),
      song('m-lib', { title: 'Mike', artist: 'Mongoose' }),
      song('z-lib', { title: 'Zulu', artist: 'Alpaca' }),
    ]);
    await markStarredSongs(db(), [
      { id: 'a-lib', starredAt: 1 },
      { id: 'm-lib', starredAt: 2 },
      { id: 'z-lib', starredAt: 3 },
    ]);
    markDownloadedInDb('a-lib', 'Alpha', 'Zebra');
    markDownloadedInDb('m-lib', 'Mike', 'Mongoose');
    markDownloadedInDb('z-lib', 'Zulu', 'Alpaca');
    layoutPreferencesStore.setState({ songSortOrder: 'artist' });

    const r = render(<SongLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(3));
    const underFavourites = latest().items.map((s) => s.id);

    r.rerender(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(3));
    expect(latest().items.map((s) => s.id)).toEqual(underFavourites);
    expect(underFavourites).toEqual(['z-lib', 'm-lib', 'a-lib']);
  });
});

/**
 * A list emptied BY A FILTER is a different statement from a library with nothing in it,
 * and the two get different copy. Both branches are asserted: it is easy to make every
 * empty state say "check your filters", which would be the worse bug.
 */
describe('SongLibraryListScreen — empty-state copy', () => {
  it('says the FILTER emptied it, under Favourites', async () => {
    render(<SongLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest()).toMatchObject({
      items: [],
      emptyMessage: 'Nothing matches your filters',
      emptySubtitle: 'Try adjusting your filters, or pull to refresh',
    });
  });

  it('says the FILTER emptied it, under Downloaded', async () => {
    render(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest()).toMatchObject({
      items: [],
      emptyMessage: 'Nothing matches your filters',
      emptySubtitle: 'Try adjusting your filters, or pull to refresh',
    });
  });

  it('leaves the empty message to the list view when NO filter is on', async () => {
    // The regression guard: with no filter the library really is empty, so `SongListView`'s
    // own `noSongsFound` copy stands (asserted in ListViewEmptyState.test.tsx).
    render(<SongLibraryListScreen />);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(mockRenders.every((r) => r.emptyMessage === undefined)).toBe(true);
    expect(mockRenders.every((r) => r.emptySubtitle === undefined)).toBe(true);
  });
});
