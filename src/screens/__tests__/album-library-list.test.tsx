jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

/** The list view has its own suite; record what it is handed on EVERY render. The
 *  regression is a single frame, so the render history — not the final state — is
 *  the assertion. */
interface AlbumRender {
  items: { id: string }[];
  loading?: boolean;
  emptyMessage?: string;
  emptySubtitle?: string;
}
const mockRenders: AlbumRender[] = [];
/** Mounts, not renders: the filtered screen picks its adapter per branch, so it renders
 *  two different `AlbumListView` calls. They must reconcile as one instance — a remount
 *  would drop the list's scroll position on every filter toggle. */
const mockMounts: string[] = [];
jest.mock('../../components/AlbumListView', () => {
  const React = require('react');
  return {
    AlbumListView: (p: AlbumRender) => {
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
  mockMounts.length = 0;
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
    expect(mockRenders[0]).toMatchObject({ items: [], loading: true });
  });

  it('is never handed an empty, non-loading list while the read is in flight', async () => {
    render(<AlbumLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(1));
    // Every frame either has rows or says it is loading — the exact invariant that
    // keeps AlbumListView off its `ListEmptyComponent` branch.
    expect(mockRenders.filter((r) => r.items.length === 0 && !r.loading)).toEqual([]);
  });

  it('clears loading and renders the starred rows once the read resolves', async () => {
    render(<AlbumLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(1));
    expect(latest().items.map((a) => a.id)).toEqual(['star-a']);
    expect(latest().loading).toBe(false);
  });

  it('reports a genuinely empty favourites set only AFTER the read completes', async () => {
    db().runSync('DELETE FROM albums');
    render(<AlbumLibraryListScreen favoritesOnly />);
    expect(mockRenders[0].loading).toBe(true);
    // The placeholder is correct here — it just must not appear before the answer is known.
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest().items).toEqual([]);
  });
});

/** The downloaded branch reads SQL too now, so it carries exactly the same hazard the
 *  favourites branch does: the answer arrives a frame late. */
describe('AlbumLibraryListScreen — downloaded filter never flashes the empty state', () => {
  beforeEach(() => seedDownloadedAlbum('dl1'));

  it('is already loading on the FIRST render, before the SQL read resolves', () => {
    render(<AlbumLibraryListScreen downloadedOnly />);
    expect(mockRenders[0]).toMatchObject({ items: [], loading: true });
  });

  it('is never handed an empty, non-loading list while the read is in flight', async () => {
    render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items.map((a) => a.id)).toEqual(['dl1']));
    expect(mockRenders.filter((r) => r.items.length === 0 && !r.loading)).toEqual([]);
    expect(latest().loading).toBe(false);
  });

  it('reports a genuinely empty downloaded set only AFTER the read completes', async () => {
    db().runSync('DELETE FROM cached_items');
    render(<AlbumLibraryListScreen downloadedOnly />);
    expect(mockRenders[0].loading).toBe(true);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest().items).toEqual([]);
  });

  it('hides a download whose component row was never populated', async () => {
    // The VISIBILITY predicate: an item row alone cannot be rendered. Parity with the
    // `if (item.albumMeta)` test in the store helper this replaces.
    db().runSync('DELETE FROM cached_albums');
    render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest().items).toEqual([]);
  });
});

/** The reactivity `cachedItems` used to give away free: SQL has no Zustand subscription,
 *  so without keying on `revision` the list goes stale under a completing download. */
describe('AlbumLibraryListScreen — downloaded filter tracks musicCacheStore.revision', () => {
  it('re-reads when a download completes while the list is on screen', async () => {
    seedDownloadedAlbum('dl1');
    render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items.map((a) => a.id)).toEqual(['dl1']));

    seedDownloadedAlbum('dl2');
    // Without the bump the row is on disk and invisible — the silent-staleness bug.
    expect(latest().items.map((a) => a.id)).toEqual(['dl1']);

    bumpRevision();
    await waitFor(() => expect(latest().items.map((a) => a.id)).toEqual(['dl1', 'dl2']));
  });

  it('keeps the rows it has on screen while the re-read is in flight', async () => {
    seedDownloadedAlbum('dl1');
    render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(1));
    mockRenders.length = 0;

    seedDownloadedAlbum('dl2');
    bumpRevision();
    await waitFor(() => expect(latest().items).toHaveLength(2));
    // A refresh must not blank the list: `AlbumListView` only shows its spinner when the
    // list is empty, so every frame here still has rows.
    expect(mockRenders.filter((r) => r.items.length === 0)).toEqual([]);
  });

  it('drops a deleted download on the next bump', async () => {
    seedDownloadedAlbum('dl1');
    render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(1));

    db().runSync('DELETE FROM cached_items');
    db().runSync('DELETE FROM cached_albums');
    bumpRevision();
    await waitFor(() => expect(latest().items).toEqual([]));
    expect(latest().loading).toBe(false);
  });
});

/**
 * A list emptied BY A FILTER is a different statement from a library with nothing in it,
 * and the two get different copy. Both branches are asserted: it is easy to make every
 * empty state say "check your filters", which would be the worse bug.
 */
describe('AlbumLibraryListScreen — empty-state copy', () => {
  it('says the FILTER emptied it, under Favourites', async () => {
    render(<AlbumLibraryListScreen favoritesOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest()).toMatchObject({
      items: [],
      emptyMessage: 'Nothing matches your filters',
      emptySubtitle: 'Try adjusting your filters, or pull to refresh',
    });
  });

  it('says the FILTER emptied it, under Downloaded', async () => {
    render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(latest()).toMatchObject({
      items: [],
      emptyMessage: 'Nothing matches your filters',
      emptySubtitle: 'Try adjusting your filters, or pull to refresh',
    });
  });

  it('leaves the empty message to the list view when NO filter is on', async () => {
    // The regression guard: with no filter the library really is empty, so
    // `AlbumListView`'s own `noAlbumsFound` copy stands.
    render(<AlbumLibraryListScreen />);
    await waitFor(() => expect(latest().loading).toBe(false));
    expect(mockRenders.every((r) => r.emptyMessage === undefined)).toBe(true);
    expect(mockRenders.every((r) => r.emptySubtitle === undefined)).toBe(true);
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
    await waitFor(() => expect(latest().items).toHaveLength(1));
    mockRenders.length = 0;

    r.rerender(<AlbumLibraryListScreen downloadedOnly favoritesOnly />);
    // Before the derived flag this frame was `{ items: [], loading: false }` — one frame
    // of "No albums found" between the downloaded rows and the favourites rows.
    expect(mockRenders[0]).toMatchObject({ items: [], loading: true });
    await waitFor(() => expect(latest().items.map((a) => a.id)).toEqual(['star-a']));
    expect(mockRenders.filter((m) => m.items.length === 0 && !m.loading)).toEqual([]);
  });

  it('is loading from the very first frame after Favourites goes back OFF', async () => {
    const r = render(<AlbumLibraryListScreen downloadedOnly favoritesOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    mockRenders.length = 0;

    r.rerender(<AlbumLibraryListScreen downloadedOnly />);
    // The downloaded read is asynchronous too, so this direction needs the derived flag
    // just as much as the other one — the favourites rows are dropped this frame and the
    // downloaded rows have not arrived.
    expect(mockRenders[0]).toMatchObject({ items: [], loading: true });
    await waitFor(() => expect(latest().items.map((a) => a.id)).toEqual(['star-a']));
    expect(mockRenders.filter((m) => m.items.length === 0 && !m.loading)).toEqual([]);
  });

  it('reuses the same list instance across the toggle in both directions', async () => {
    const r = render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(1));

    r.rerender(<AlbumLibraryListScreen downloadedOnly favoritesOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));
    r.rerender(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().loading).toBe(false));

    // The two branches hand the view different item shapes and different adapters, but
    // they are the same component in the same slot, so React updates rather than remounts.
    expect(mockMounts).toHaveLength(1);
  });
});

/**
 * The downloaded branch now sorts SQL rows and converts only the rows it draws, so the
 * keys it sorts on are a projection rather than the envelope. These pin that the answer
 * is unchanged — a row must not sort somewhere other than where its label puts it.
 */
describe('AlbumLibraryListScreen — the downloaded filter sort order', () => {
  const seedSorted = (id: string, name: string, artist: string | null): void => {
    db().runSync(
      'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, ' +
        'downloaded_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, 'album', name, 0, 0, 0],
    );
    db().runSync(
      'INSERT INTO cached_albums (item_id, name, artist, display_artist) VALUES (?, ?, ?, ?)',
      [id, name, artist, 'Zzz Display'],
    );
  };

  it('orders by the artist tag under the default sort order', async () => {
    seedSorted('dl-z', 'Album Z', 'Zebra');
    seedSorted('dl-a', 'Album A', 'Alpha');
    render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(2));
    expect(latest().items.map((a) => a.id)).toEqual(['dl-a', 'dl-z']);
  });

  it('falls back to display_artist when the artist tag is absent, as the envelope does', async () => {
    seedSorted('dl-tagged', 'Album T', 'Alpha');
    seedSorted('dl-display', 'Album D', null); // display_artist 'Zzz Display' is all it has
    render(<AlbumLibraryListScreen downloadedOnly />);
    await waitFor(() => expect(latest().items).toHaveLength(2));
    expect(latest().items.map((a) => a.id)).toEqual(['dl-tagged', 'dl-display']);
  });
});
