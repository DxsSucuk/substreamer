jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

import React from 'react';
import { render, act, waitFor } from '@testing-library/react-native';

let albumProps: { items: { id: string }[]; onEndReached?: () => void; loading?: boolean };
jest.mock('../AlbumListView', () => ({
  AlbumListView: (p: typeof albumProps) => {
    albumProps = p;
    return null;
  },
}));

import type { AlbumID3 } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { markStarredAlbums, replaceFavoriteAlbums } from '../../db/repository/favorites';
import { upsertAlbums } from '../../db/repository/albums';
import { getDb } from '../../store/persistence/db';
import { favoritesStore } from '../../store/favoritesStore';
import { StarredAlbumList } from '../StarredAlbumList';

const db = () => getDb()!;
const album = (id: string, extra: Partial<AlbumID3> = {}): AlbumID3 =>
  ({ id, name: `Album ${id}`, duration: 0, songCount: 0, ...extra }) as AlbumID3;

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(async () => {
  for (const t of ['albums', 'favorite_albums', 'cached_items', 'cached_item_songs']) {
    db().runSync(`DELETE FROM ${t}`);
  }
  favoritesStore.setState({ version: 0 });
  await upsertAlbums(db(), [album('lib-a'), album('lib-b')]);
  await markStarredAlbums(db(), [
    { id: 'lib-a', starredAt: 400 },
    { id: 'lib-b', starredAt: 100 },
  ]);
  await replaceFavoriteAlbums(db(), [album('rem-a', { starred: new Date(300) })]);
});

describe('StarredAlbumList', () => {
  it('renders the merged first page, newest favourite first', async () => {
    render(<StarredAlbumList downloadedOnly={false} includePartial={false} />);
    await waitFor(() => expect(albumProps.items).toHaveLength(3));
    expect(albumProps.items.map((a) => a.id)).toEqual(['lib-a', 'rem-a', 'lib-b']);
  });

  it('reloads when the membership version bumps', async () => {
    render(<StarredAlbumList downloadedOnly={false} includePartial={false} />);
    await waitFor(() => expect(albumProps.items).toHaveLength(3));

    db().runSync('DELETE FROM favorite_albums');
    await act(async () => {
      favoritesStore.setState({ version: 1 });
    });
    await waitFor(() => expect(albumProps.items).toHaveLength(2));
  });

  it('applies the downloaded filter to the remainder half too', async () => {
    db().runSync(
      'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, ' +
        'downloaded_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['rem-a', 'album', 'A', 0, 0, 0],
    );
    render(<StarredAlbumList downloadedOnly includePartial={false} />);
    await waitFor(() => expect(albumProps.items.map((a) => a.id)).toEqual(['rem-a']));
  });

  it('surfaces the store loading flag alongside its own', async () => {
    render(<StarredAlbumList downloadedOnly={false} includePartial={false} loading />);
    await waitFor(() => expect(albumProps.items).toHaveLength(3));
    expect(albumProps.loading).toBe(true);
  });
});
