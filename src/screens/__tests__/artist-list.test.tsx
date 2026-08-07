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
import { ArtistListScreen } from '../artist-list';

const db = () => getDb()!;
const artist = (id: string, extra: Partial<ArtistID3> = {}): ArtistID3 => ({
  id,
  name: `Artist ${id}`,
  albumCount: 1,
  ...extra,
});

/** A downloaded album owned by `artistId`, in SQL — used to prove that owning one pulls
 *  an artist into NO list on this screen. */
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

/** `ArtistListScreen` has NO downloaded branch: artists cannot be downloaded, so the
 *  Downloaded filter hides the Artists segment outright and this screen is never mounted
 *  under it. `library.tsx`'s suite owns that gate. */
describe('ArtistListScreen — no downloaded filter exists', () => {
  it('takes no downloadedOnly prop, so favourites is the only filtered mode', async () => {
    await upsertArtists(db(), [artist('star-a'), artist('plain-b')]);
    await markStarredArtists(db(), [{ id: 'star-a', starredAt: 400 }]);
    // A downloaded album owned by `plain-b` must not pull it into ANY list here.
    markDownloadedInDb('al1', 'plain-b');

    render(<ArtistListScreen favoritesOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest().artists.map((a) => a.id)).toEqual(['star-a']);
  });
});
