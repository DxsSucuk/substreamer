jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

import React from 'react';
import { render, act, waitFor } from '@testing-library/react-native';

let artistProps: { items: { id: string }[]; onEndReached?: () => void };
jest.mock('../ArtistListView', () => ({
  ArtistListView: (p: typeof artistProps) => {
    artistProps = p;
    return null;
  },
}));

import type { ArtistID3 } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { markStarredArtists, replaceFavoriteArtists } from '../../db/repository/favorites';
import { upsertArtists } from '../../db/repository/artists';
import { getDb } from '../../store/persistence/db';
import { favoritesStore } from '../../store/favoritesStore';
import { StarredArtistList } from '../StarredArtistList';

const db = () => getDb()!;
const artist = (id: string, extra: Partial<ArtistID3> = {}): ArtistID3 => ({
  id,
  name: `Artist ${id}`,
  albumCount: 1,
  ...extra,
});

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(async () => {
  for (const t of ['artists', 'favorite_artists', 'cached_albums', 'cached_items']) {
    db().runSync(`DELETE FROM ${t}`);
  }
  favoritesStore.setState({ version: 0 });
  await upsertArtists(db(), [artist('lib-a'), artist('lib-b')]);
  await markStarredArtists(db(), [
    { id: 'lib-a', starredAt: 400 },
    { id: 'lib-b', starredAt: 100 },
  ]);
  await replaceFavoriteArtists(db(), [artist('rem-a', { starred: new Date(300) })]);
});

describe('StarredArtistList', () => {
  it('renders the merged first page, newest favourite first', async () => {
    render(<StarredArtistList />);
    await waitFor(() => expect(artistProps.items).toHaveLength(3));
    expect(artistProps.items.map((a) => a.id)).toEqual(['lib-a', 'rem-a', 'lib-b']);
  });

  it('reloads when the membership version bumps', async () => {
    render(<StarredArtistList />);
    await waitFor(() => expect(artistProps.items).toHaveLength(3));

    db().runSync("DELETE FROM artists WHERE id='lib-b'");
    await act(async () => {
      favoritesStore.setState({ version: 1 });
    });
    await waitFor(() => expect(artistProps.items).toHaveLength(2));
  });

  // Artists cannot be downloaded, so this list takes no downloaded filter — owning a
  // downloaded album must NOT narrow it. The Favourites screen hides the Artists segment
  // under that filter instead; `favorites.tsx`'s suite owns that gate.
  it('ignores downloaded albums entirely — the full starred set still renders', async () => {
    db().runSync(
      'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, ' +
        'downloaded_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['al1', 'album', 'A', 0, 0, 0],
    );
    db().runSync('INSERT INTO cached_albums (item_id, artist_id) VALUES (?, ?)', ['al1', 'lib-b']);
    render(<StarredArtistList />);
    await waitFor(() => expect(artistProps.items).toHaveLength(3));
    expect(artistProps.items.map((a) => a.id)).toEqual(['lib-a', 'rem-a', 'lib-b']);
  });
});
