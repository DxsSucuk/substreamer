jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../../services/playerService', () => ({ playTrack: jest.fn() }));

/** The list view has its own suite; record what it is handed on EVERY render. The
 *  regression is a single frame, so the render history — not the final state — is
 *  the assertion. */
interface SongRender {
  songs: { id: string }[];
  loading?: boolean;
  emptyMessage?: string;
  emptySubtitle?: string;
}
const mockRenders: SongRender[] = [];
jest.mock('../../components/SongListView', () => ({
  SongListView: (p: SongRender) => {
    mockRenders.push(p);
    return null;
  },
}));

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

import type { Child } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { upsertSongs } from '../../db/repository/songs';
import { markStarredSongs } from '../../db/repository/favorites';
import { getDb } from '../../store/persistence/db';
import { favoritesStore } from '../../store/favoritesStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import { SongLibraryListScreen } from '../song-library-list';

const db = () => getDb()!;
const song = (id: string, extra: Partial<Child> = {}): Child =>
  ({ id, title: `Song ${id}`, isDir: false, duration: 10, ...extra }) as Child;

/** A downloaded song. BOTH filters read this from SQL now — the favourites read applies
 *  `downloadedOnly` in the query, and the downloaded filter is a whole-set read of it. */
const markDownloadedInDb = (id: string): void => {
  db().runSync(
    'INSERT INTO cached_songs (song_id, album_id, suffix, bytes, format_captured_at, ' +
      'downloaded_at, title, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, 'al1', 'mp3', 1, 0, 0, `Song ${id}`, 10],
  );
};

/** The last render's props — `mockRenders` grows for the life of a test. */
const latest = (): SongRender => mockRenders[mockRenders.length - 1];

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(() => {
  mockRenders.length = 0;
  for (const t of ['songs', 'favorite_songs', 'cached_songs']) db().runSync(`DELETE FROM ${t}`);
  favoritesStore.setState({ version: 0 });
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
    expect(mockRenders[0]).toMatchObject({ songs: [], loading: true });
  });

  it('is never handed an empty, non-loading list while the read is in flight', async () => {
    render(<SongLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().songs).toHaveLength(1));
    // Every frame either has rows or says it is loading — the exact invariant that
    // keeps SongListView off its `ListEmptyComponent` branch.
    expect(mockRenders.filter((r) => r.songs.length === 0 && !r.loading)).toEqual([]);
  });

  it('clears loading and renders the starred rows once the read resolves', async () => {
    render(<SongLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().songs).toHaveLength(1));
    expect(latest().songs.map((s) => s.id)).toEqual(['star-a']);
    expect(latest().loading).toBe(false);
  });

  it('reports a genuinely empty favourites set only AFTER the read completes', async () => {
    db().runSync('DELETE FROM songs');
    render(<SongLibraryListScreen favoritesOnly />);
    expect(mockRenders[0].loading).toBe(true);
    // The placeholder is correct here — it just must not appear before the answer is known.
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest().songs).toEqual([]);
  });
});

describe('SongLibraryListScreen — downloaded filter', () => {
  it('renders the downloaded rows from SQL, not from the store map', async () => {
    // The store is deliberately NOT seeded here: if the hook still walked `cachedSongs`
    // this would render nothing.
    markDownloadedInDb('dl1');
    render(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().songs.map((s) => s.id)).toEqual(['dl1']));
    expect(latest().loading).toBe(false);
  });

  it('is already loading on the FIRST render, before the SQL read resolves', () => {
    markDownloadedInDb('dl1');
    render(<SongLibraryListScreen downloadedOnly />);
    // The downloaded read is asynchronous now, so it needs the same derived flag the
    // favourites branch has — otherwise this frame is empty-and-not-loading and
    // SongListView flashes "No songs found".
    expect(mockRenders[0]).toMatchObject({ songs: [], loading: true });
  });

  it('is never handed an empty, non-loading list while the read is in flight', async () => {
    markDownloadedInDb('dl1');
    render(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().songs).toHaveLength(1));
    expect(mockRenders.filter((r) => r.songs.length === 0 && !r.loading)).toEqual([]);
  });

  it('reports a genuinely empty downloaded set only AFTER the read completes', async () => {
    render(<SongLibraryListScreen downloadedOnly />);
    expect(mockRenders[0].loading).toBe(true);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest().songs).toEqual([]);
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
    await waitFor(() => expect(latest().songs).toHaveLength(1));
    mockRenders.length = 0;

    r.rerender(<SongLibraryListScreen downloadedOnly favoritesOnly />);
    // Before the derived flag this frame was `{ songs: [], loading: false }` — one frame
    // of "No songs found" between the downloaded rows and the favourites rows.
    expect(mockRenders[0]).toMatchObject({ songs: [], loading: true });
    await waitFor(() => expect(latest().songs.map((s) => s.id)).toEqual(['star-a']));
    expect(mockRenders.filter((m) => m.songs.length === 0 && !m.loading)).toEqual([]);
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
    expect(mockRenders[0]).toMatchObject({ songs: [], loading: true });
    await waitFor(() => expect(latest().songs.map((s) => s.id)).toEqual(['star-a']));
    expect(mockRenders.filter((m) => m.songs.length === 0 && !m.loading)).toEqual([]);
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
      songs: [],
      emptyMessage: 'Nothing matches your filters',
      emptySubtitle: 'Try adjusting your filters, or pull to refresh',
    });
  });

  it('says the FILTER emptied it, under Downloaded', async () => {
    render(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest()).toMatchObject({
      songs: [],
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
