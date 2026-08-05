jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

/** The list view has its own suite; record what it is handed on EVERY render. The
 *  regression is a single frame, so the render history — not the final state — is
 *  the assertion. */
interface ArtistRender {
  artists: { id: string }[];
  loading?: boolean;
}
const mockRenders: ArtistRender[] = [];
jest.mock('../../components/ArtistListView', () => ({
  ArtistListView: (p: ArtistRender) => {
    mockRenders.push(p);
    return null;
  },
}));

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

import type { ArtistID3 } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { upsertArtists } from '../../db/repository/artists';
import { markStarredArtists } from '../../db/repository/favorites';
import { getDb } from '../../store/persistence/db';
import { favoritesStore } from '../../store/favoritesStore';
import { musicCacheStore, type CachedItemMeta } from '../../store/musicCacheStore';
import { ArtistListScreen } from '../artist-list';

const db = () => getDb()!;
const artist = (id: string, extra: Partial<ArtistID3> = {}): ArtistID3 => ({
  id,
  name: `Artist ${id}`,
  albumCount: 1,
  ...extra,
});

/** A downloaded album owned by `artistId` — the source the downloaded filter derives
 *  its artist set from. */
const downloadedItem = (id: string, artistId: string): CachedItemMeta => ({
  itemId: id,
  type: 'album',
  name: `Album ${id}`,
  expectedSongCount: 0,
  lastSyncAt: 0,
  downloadedAt: 0,
  songIds: [],
  metaV: 1,
  albumMeta: { name: `Album ${id}`, songCount: 1, artistId, artist: `Artist ${artistId}` },
});

/** The same fact in SQL — the favourites read applies `downloadedOnly` in the query
 *  ("owns any downloaded album"), so a fixture with both filters on has to satisfy the
 *  store AND the database. */
const markDownloadedInDb = (id: string, artistId: string): void => {
  db().runSync(
    'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, ' +
      'downloaded_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, 'album', `Album ${id}`, 0, 0, 0],
  );
  db().runSync('INSERT INTO cached_albums (item_id, artist_id) VALUES (?, ?)', [id, artistId]);
};

/** The last render's props — `mockRenders` grows for the life of a test. */
const latest = (): ArtistRender => mockRenders[mockRenders.length - 1];

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(() => {
  mockRenders.length = 0;
  for (const t of ['artists', 'favorite_artists', 'cached_items', 'cached_albums']) {
    db().runSync(`DELETE FROM ${t}`);
  }
  favoritesStore.setState({ version: 0 });
  musicCacheStore.setState({ cachedItems: {} });
});

describe('ArtistListScreen — favourites filter never flashes the empty state', () => {
  beforeEach(async () => {
    await upsertArtists(db(), [artist('star-a'), artist('plain-b')]);
    await markStarredArtists(db(), [{ id: 'star-a', starredAt: 400 }]);
  });

  it('is already loading on the FIRST render, before the SQL read resolves', () => {
    render(<ArtistListScreen favoritesOnly />);
    // The read runs in an effect, i.e. after this frame is on screen. Loading has to be
    // seeded true or the list falls through to "No artists found" with zero rows.
    expect(mockRenders[0]).toMatchObject({ artists: [], loading: true });
  });

  it('is never handed an empty, non-loading list while the read is in flight', async () => {
    render(<ArtistListScreen favoritesOnly />);
    await waitFor(() => expect(latest().artists).toHaveLength(1));
    // Every frame either has rows or says it is loading — the exact invariant that
    // keeps ArtistListView off its `ListEmptyComponent` branch.
    expect(mockRenders.filter((r) => r.artists.length === 0 && !r.loading)).toEqual([]);
  });

  it('clears loading and renders the starred rows once the read resolves', async () => {
    render(<ArtistListScreen favoritesOnly />);
    await waitFor(() => expect(latest().artists).toHaveLength(1));
    expect(latest().artists.map((a) => a.id)).toEqual(['star-a']);
    expect(latest().loading).toBe(false);
  });

  it('reports a genuinely empty favourites set only AFTER the read completes', async () => {
    db().runSync('DELETE FROM artists');
    render(<ArtistListScreen favoritesOnly />);
    expect(mockRenders[0].loading).toBe(true);
    // The placeholder is correct here — it just must not appear before the answer is known.
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest().artists).toEqual([]);
  });
});

describe('ArtistListScreen — downloaded filter', () => {
  it('shows its own spinner while hydrating, never an empty placeholder', async () => {
    // Unlike albums and songs — whose downloaded lists come from a synchronous store
    // memo — the artist list hydrates via `listArtistsByIds`, which is async. So it
    // needs the same derived-loading treatment as the favourites branch.
    await upsertArtists(db(), [artist('dl-artist')]);
    musicCacheStore.setState({ cachedItems: { al1: downloadedItem('al1', 'dl-artist') } });
    render(<ArtistListScreen downloadedOnly />);
    await waitFor(() => expect(latest().artists.map((a) => a.id)).toEqual(['dl-artist']));

    expect(mockRenders.filter((r) => r.artists.length === 0 && !r.loading)).toEqual([]);
    expect(latest().loading).toBe(false);
  });
});

/** `FilteredArtistList` is mounted for EITHER filter, so switching Favourites on while
 *  Downloaded is already on re-renders the SAME instance — no mount, no fresh state
 *  initialiser. The loading flag has to be derived from the props to cover this. */
describe('ArtistListScreen — toggling Favourites on an already-mounted list', () => {
  beforeEach(async () => {
    await upsertArtists(db(), [artist('star-a')]);
    await markStarredArtists(db(), [{ id: 'star-a', starredAt: 400 }]);
    markDownloadedInDb('al1', 'star-a');
    musicCacheStore.setState({ cachedItems: { al1: downloadedItem('al1', 'star-a') } });
  });

  it('is loading from the very first frame after Favourites goes on', async () => {
    const r = render(<ArtistListScreen downloadedOnly />);
    await waitFor(() => expect(latest().artists).toHaveLength(1));
    mockRenders.length = 0;

    r.rerender(<ArtistListScreen downloadedOnly favoritesOnly />);
    // Before the derived flag this frame was `{ artists: [], loading: false }` — one frame
    // of "No artists found" between the downloaded rows and the favourites rows.
    expect(mockRenders[0]).toMatchObject({ artists: [], loading: true });
    await waitFor(() => expect(latest().artists.map((a) => a.id)).toEqual(['star-a']));
    expect(mockRenders.filter((m) => m.artists.length === 0 && !m.loading)).toEqual([]);
  });

  it('drops the spinner immediately when Favourites goes back off', async () => {
    const r = render(<ArtistListScreen downloadedOnly favoritesOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    mockRenders.length = 0;

    r.rerender(<ArtistListScreen downloadedOnly />);
    await waitFor(() => expect(latest().artists.map((a) => a.id)).toEqual(['star-a']));
    // The downloaded branch may legitimately show its own hydration spinner here. What
    // must never happen is an empty list with no spinner — and the flag must settle,
    // rather than a stale favourites value leaking across the toggle and sticking.
    expect(mockRenders.filter((m) => m.artists.length === 0 && !m.loading)).toEqual([]);
    expect(latest().loading).toBe(false);
  });
});
