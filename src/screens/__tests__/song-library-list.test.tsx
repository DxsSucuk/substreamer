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
import { musicCacheStore, type CachedSongMeta } from '../../store/musicCacheStore';
import { SongLibraryListScreen } from '../song-library-list';

const db = () => getDb()!;
const song = (id: string, extra: Partial<Child> = {}): Child =>
  ({ id, title: `Song ${id}`, isDir: false, duration: 10, ...extra }) as Child;

const downloadedSong = (id: string): CachedSongMeta => ({
  id,
  title: `Song ${id}`,
  albumId: 'al1',
  bytes: 1,
  duration: 10,
  suffix: 'mp3',
  formatCapturedAt: 0,
  downloadedAt: 0,
});

/** The same fact in SQL — the favourites read applies `downloadedOnly` in the query, so
 *  a fixture with both filters on has to satisfy the store AND the database. */
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
  musicCacheStore.setState({ cachedItems: {}, cachedSongs: {} });
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
  it('keeps the downloaded path on its own loading flag, not the favourites one', async () => {
    musicCacheStore.setState({ cachedSongs: { dl1: downloadedSong('dl1') } });
    render(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().songs.map((s) => s.id)).toEqual(['dl1']));
    // `useAllSongsByTitle` reads an already-hydrated store, so it never reports loading —
    // the seeded favourites flag must not leak a spinner into this branch.
    expect(mockRenders.filter((r) => r.loading)).toEqual([]);
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
    musicCacheStore.setState({ cachedSongs: { 'star-a': downloadedSong('star-a') } });
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

  it('drops the spinner immediately when Favourites goes back off', async () => {
    const r = render(<SongLibraryListScreen downloadedOnly favoritesOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    mockRenders.length = 0;

    r.rerender(<SongLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().songs.map((s) => s.id)).toEqual(['star-a']));
    // The downloaded branch reads the store synchronously — a spinner here would be a
    // stale favourites flag leaking across the toggle.
    expect(mockRenders.filter((m) => m.loading)).toEqual([]);
  });
});

describe('SongLibraryListScreen — empty-state copy', () => {
  it('leaves the empty message to the list view, matching albums and artists', async () => {
    render(<SongLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    // No `emptyMessage` override → SongListView's default `noSongsFound`, so all three
    // library tabs say the same thing (asserted in ListViewEmptyState.test.tsx).
    expect(mockRenders.every((r) => r.emptyMessage === undefined)).toBe(true);
  });
});
