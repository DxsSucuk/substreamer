jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

/** The list view has its own suite; record what it is handed on EVERY render. The
 *  regression is a single frame, so the render history — not the final state — is
 *  the assertion. */
interface AlbumRender {
  albums: { id: string }[];
  loading?: boolean;
}
const mockRenders: AlbumRender[] = [];
jest.mock('../../components/AlbumListView', () => ({
  AlbumListView: (p: AlbumRender) => {
    mockRenders.push(p);
    return null;
  },
}));

import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';

import type { AlbumID3 } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { upsertAlbums } from '../../db/repository/albums';
import { markStarredAlbums } from '../../db/repository/favorites';
import { getDb } from '../../store/persistence/db';
import { favoritesStore } from '../../store/favoritesStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import { AlbumLibraryListScreen } from '../album-library-list';

const db = () => getDb()!;
const album = (id: string, extra: Partial<AlbumID3> = {}): AlbumID3 =>
  ({ id, name: `Album ${id}`, duration: 0, songCount: 0, ...extra }) as AlbumID3;

/**
 * A complete (non-partial) download, in SQL: the item row that makes it a MEMBER of the
 * downloaded set plus the `cached_albums` component row that makes it RENDERABLE. Both
 * filters read the download tables now, so one fixture serves the downloaded branch and
 * the `downloadedOnly` clause inside the favourites query.
 */
const seedDownloadedAlbum = (id: string): void => {
  db().runSync(
    'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, ' +
      'downloaded_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, 'album', `Album ${id}`, 0, 0, 0],
  );
  db().runSync('INSERT INTO cached_albums (item_id, name) VALUES (?, ?)', [id, `Album ${id}`]);
};

/** What a completing download does to the store: bump the counter the SQL readers key on. */
const bumpRevision = (): void => {
  act(() => {
    musicCacheStore.setState((s) => ({ revision: s.revision + 1 }));
  });
};

/** The last render's props — `mockRenders` grows for the life of a test. */
const latest = (): AlbumRender => mockRenders[mockRenders.length - 1];

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(() => {
  mockRenders.length = 0;
  for (const t of ['albums', 'favorite_albums', 'cached_albums', 'cached_items']) {
    db().runSync(`DELETE FROM ${t}`);
  }
  favoritesStore.setState({ version: 0 });
  musicCacheStore.setState({ cachedItems: {}, revision: 0 });
});

describe('AlbumLibraryListScreen — favourites filter never flashes the empty state', () => {
  beforeEach(async () => {
    await upsertAlbums(db(), [album('star-a'), album('plain-b')]);
    await markStarredAlbums(db(), [{ id: 'star-a', starredAt: 400 }]);
  });

  it('is already loading on the FIRST render, before the SQL read resolves', () => {
    render(<AlbumLibraryListScreen favoritesOnly />);
    // The read runs in an effect, i.e. after this frame is on screen. Loading has to be
    // seeded true or the list falls through to "No albums found" with zero rows.
    expect(mockRenders[0]).toMatchObject({ albums: [], loading: true });
  });

  it('is never handed an empty, non-loading list while the read is in flight', async () => {
    render(<AlbumLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().albums).toHaveLength(1));
    // Every frame either has rows or says it is loading — the exact invariant that
    // keeps AlbumListView off its `ListEmptyComponent` branch.
    expect(mockRenders.filter((r) => r.albums.length === 0 && !r.loading)).toEqual([]);
  });

  it('clears loading and renders the starred rows once the read resolves', async () => {
    render(<AlbumLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().albums).toHaveLength(1));
    expect(latest().albums.map((a) => a.id)).toEqual(['star-a']);
    expect(latest().loading).toBe(false);
  });

  it('reports a genuinely empty favourites set only AFTER the read completes', async () => {
    db().runSync('DELETE FROM albums');
    render(<AlbumLibraryListScreen favoritesOnly />);
    expect(mockRenders[0].loading).toBe(true);
    // The placeholder is correct here — it just must not appear before the answer is known.
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest().albums).toEqual([]);
  });
});

/** The downloaded branch reads SQL too now, so it carries exactly the same hazard the
 *  favourites branch does: the answer arrives a frame late. */
describe('AlbumLibraryListScreen — downloaded filter never flashes the empty state', () => {
  beforeEach(() => seedDownloadedAlbum('dl1'));

  it('is already loading on the FIRST render, before the SQL read resolves', () => {
    render(<AlbumLibraryListScreen downloadedOnly />);
    expect(mockRenders[0]).toMatchObject({ albums: [], loading: true });
  });

  it('is never handed an empty, non-loading list while the read is in flight', async () => {
    render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().albums.map((a) => a.id)).toEqual(['dl1']));
    expect(mockRenders.filter((r) => r.albums.length === 0 && !r.loading)).toEqual([]);
    expect(latest().loading).toBe(false);
  });

  it('reports a genuinely empty downloaded set only AFTER the read completes', async () => {
    db().runSync('DELETE FROM cached_items');
    render(<AlbumLibraryListScreen downloadedOnly />);
    expect(mockRenders[0].loading).toBe(true);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest().albums).toEqual([]);
  });

  it('hides a download whose component row was never populated', async () => {
    // The VISIBILITY predicate: an item row alone cannot be rendered. Parity with the
    // `if (item.albumMeta)` test in the store helper this replaces.
    db().runSync('DELETE FROM cached_albums');
    render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest().albums).toEqual([]);
  });
});

/** The reactivity `cachedItems` used to give away free: SQL has no Zustand subscription,
 *  so without keying on `revision` the list goes stale under a completing download. */
describe('AlbumLibraryListScreen — downloaded filter tracks musicCacheStore.revision', () => {
  it('re-reads when a download completes while the list is on screen', async () => {
    seedDownloadedAlbum('dl1');
    render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().albums.map((a) => a.id)).toEqual(['dl1']));

    seedDownloadedAlbum('dl2');
    // Without the bump the row is on disk and invisible — the silent-staleness bug.
    expect(latest().albums.map((a) => a.id)).toEqual(['dl1']);

    bumpRevision();
    await waitFor(() => expect(latest().albums.map((a) => a.id)).toEqual(['dl1', 'dl2']));
  });

  it('keeps the rows it has on screen while the re-read is in flight', async () => {
    seedDownloadedAlbum('dl1');
    render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().albums).toHaveLength(1));
    mockRenders.length = 0;

    seedDownloadedAlbum('dl2');
    bumpRevision();
    await waitFor(() => expect(latest().albums).toHaveLength(2));
    // A refresh must not blank the list: `AlbumListView` only shows its spinner when the
    // list is empty, so every frame here still has rows.
    expect(mockRenders.filter((r) => r.albums.length === 0)).toEqual([]);
  });

  it('drops a deleted download on the next bump', async () => {
    seedDownloadedAlbum('dl1');
    render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().albums).toHaveLength(1));

    db().runSync('DELETE FROM cached_items');
    db().runSync('DELETE FROM cached_albums');
    bumpRevision();
    await waitFor(() => expect(latest().albums).toEqual([]));
    expect(latest().loading).toBe(false);
  });
});

/** `FilteredAlbumList` is mounted for EITHER filter, so switching Favourites on while
 *  Downloaded is already on re-renders the SAME instance — no mount, no fresh state
 *  initialiser. The loading flag has to be derived from the props to cover this. */
describe('AlbumLibraryListScreen — toggling Favourites on an already-mounted list', () => {
  beforeEach(async () => {
    await upsertAlbums(db(), [album('star-a')]);
    await markStarredAlbums(db(), [{ id: 'star-a', starredAt: 400 }]);
    seedDownloadedAlbum('star-a');
  });

  it('is loading from the very first frame after Favourites goes on', async () => {
    const r = render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().albums).toHaveLength(1));
    mockRenders.length = 0;

    r.rerender(<AlbumLibraryListScreen downloadedOnly favoritesOnly />);
    // Before the derived flag this frame was `{ albums: [], loading: false }` — one frame
    // of "No albums found" between the downloaded rows and the favourites rows.
    expect(mockRenders[0]).toMatchObject({ albums: [], loading: true });
    await waitFor(() => expect(latest().albums.map((a) => a.id)).toEqual(['star-a']));
    expect(mockRenders.filter((m) => m.albums.length === 0 && !m.loading)).toEqual([]);
  });

  it('is loading from the very first frame after Favourites goes back OFF', async () => {
    const r = render(<AlbumLibraryListScreen downloadedOnly favoritesOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    mockRenders.length = 0;

    r.rerender(<AlbumLibraryListScreen downloadedOnly />);
    // The downloaded read is asynchronous too, so this direction needs the derived flag
    // just as much as the other one — the favourites rows are dropped this frame and the
    // downloaded rows have not arrived.
    expect(mockRenders[0]).toMatchObject({ albums: [], loading: true });
    await waitFor(() => expect(latest().albums.map((a) => a.id)).toEqual(['star-a']));
    expect(mockRenders.filter((m) => m.albums.length === 0 && !m.loading)).toEqual([]);
  });
});
