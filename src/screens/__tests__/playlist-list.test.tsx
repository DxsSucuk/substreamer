jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

/** The list view has its own suite; record what it is handed on EVERY render. The
 *  regression is a single frame, so the render history — not the final state — is
 *  the assertion. */
interface PlaylistRender {
  playlists: { id: string }[];
  loading?: boolean;
}
const mockRenders: PlaylistRender[] = [];
jest.mock('../../components/PlaylistListView', () => ({
  PlaylistListView: (p: PlaylistRender) => {
    mockRenders.push(p);
    return null;
  },
}));

import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { getDb } from '../../store/persistence/db';
import { musicCacheStore } from '../../store/musicCacheStore';
import { PlaylistListScreen } from '../playlist-list';

const db = () => getDb()!;

/**
 * A downloaded playlist in SQL: the item row that makes it a member of the downloaded
 * set plus the `cached_playlists` component row that makes it renderable. Playlists
 * download atomically, so there is no partial state to seed.
 */
const seedDownloadedPlaylist = (id: string): void => {
  db().runSync(
    'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, ' +
      'downloaded_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, 'playlist', `Playlist ${id}`, 0, 0, 0],
  );
  db().runSync('INSERT INTO cached_playlists (item_id, name, song_count) VALUES (?, ?, ?)', [
    id,
    `Playlist ${id}`,
    2,
  ]);
};

/** What a completing download does to the store: bump the counter the SQL readers key on. */
const bumpRevision = (): void => {
  act(() => {
    musicCacheStore.setState((s) => ({ revision: s.revision + 1 }));
  });
};

const latest = (): PlaylistRender => mockRenders[mockRenders.length - 1];

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(() => {
  mockRenders.length = 0;
  for (const t of ['cached_playlists', 'cached_items']) db().runSync(`DELETE FROM ${t}`);
  musicCacheStore.setState({ cachedItems: {}, revision: 0 });
});

describe('PlaylistListScreen — downloaded filter never flashes the empty state', () => {
  beforeEach(() => seedDownloadedPlaylist('pl1'));

  it('is already loading on the FIRST render, before the SQL read resolves', () => {
    render(<PlaylistListScreen downloadedOnly />);
    // The read runs in an effect, i.e. after this frame is on screen. Loading has to be
    // derived-true or the list falls through to its empty placeholder with zero rows.
    expect(mockRenders[0]).toMatchObject({ playlists: [], loading: true });
  });

  it('is never handed an empty, non-loading list while the read is in flight', async () => {
    render(<PlaylistListScreen downloadedOnly />);
    await waitFor(() => expect(latest().playlists.map((p) => p.id)).toEqual(['pl1']));
    expect(mockRenders.filter((r) => r.playlists.length === 0 && !r.loading)).toEqual([]);
    expect(latest().loading).toBe(false);
  });

  it('reports a genuinely empty downloaded set only AFTER the read completes', async () => {
    db().runSync('DELETE FROM cached_items');
    render(<PlaylistListScreen downloadedOnly />);
    expect(mockRenders[0].loading).toBe(true);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest().playlists).toEqual([]);
  });

  it('hides a download whose component row was never populated', async () => {
    db().runSync('DELETE FROM cached_playlists');
    render(<PlaylistListScreen downloadedOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest().playlists).toEqual([]);
  });

  it('never returns an album', async () => {
    db().runSync(
      'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, ' +
        'downloaded_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['al1', 'album', 'Album al1', 0, 0, 0],
    );
    render(<PlaylistListScreen downloadedOnly />);
    await waitFor(() => expect(latest().playlists.map((p) => p.id)).toEqual(['pl1']));
  });
});

/** The reactivity `cachedItems` used to give away free: SQL has no Zustand subscription,
 *  so without keying on `revision` the list goes stale under a completing download. */
describe('PlaylistListScreen — downloaded filter tracks musicCacheStore.revision', () => {
  it('re-reads when a download completes while the list is on screen', async () => {
    seedDownloadedPlaylist('pl1');
    render(<PlaylistListScreen downloadedOnly />);
    await waitFor(() => expect(latest().playlists.map((p) => p.id)).toEqual(['pl1']));

    seedDownloadedPlaylist('pl2');
    // Without the bump the row is on disk and invisible — the silent-staleness bug.
    expect(latest().playlists.map((p) => p.id)).toEqual(['pl1']);

    bumpRevision();
    await waitFor(() => expect(latest().playlists.map((p) => p.id)).toEqual(['pl1', 'pl2']));
  });

  it('keeps the rows it has on screen while the re-read is in flight', async () => {
    seedDownloadedPlaylist('pl1');
    render(<PlaylistListScreen downloadedOnly />);
    await waitFor(() => expect(latest().playlists).toHaveLength(1));
    mockRenders.length = 0;

    seedDownloadedPlaylist('pl2');
    bumpRevision();
    await waitFor(() => expect(latest().playlists).toHaveLength(2));
    expect(mockRenders.filter((r) => r.playlists.length === 0)).toEqual([]);
  });

  it('drops a deleted download on the next bump', async () => {
    seedDownloadedPlaylist('pl1');
    render(<PlaylistListScreen downloadedOnly />);
    await waitFor(() => expect(latest().playlists).toHaveLength(1));

    db().runSync('DELETE FROM cached_items');
    db().runSync('DELETE FROM cached_playlists');
    bumpRevision();
    await waitFor(() => expect(latest().playlists).toEqual([]));
    expect(latest().loading).toBe(false);
  });
});
