import type { AlbumID3, Child } from 'subsonic-api';

import { countAlbums } from '../../db/repository/albums';
import { countSongs } from '../../db/repository/songs';
import { getDb } from '../../store/persistence/db';
import { syncStatusStore } from '../../store/syncStatusStore';
import { runNormalizedLibrarySync } from '../normalizedLibrarySync';

// Fixed server pages: 5 albums, 10 songs across those 5 albums (2 each). Prefixed
// `mock*` so jest permits referencing them inside the hoisted mock factory.
const mockAlbumsData: AlbumID3[] = Array.from({ length: 5 }, (_, i) => ({
  id: `al${i}`,
  name: `Album ${i}`,
  created: new Date('2020-01-01'),
  duration: 100,
  songCount: 2,
})) as unknown as AlbumID3[];
const mockSongsData: Child[] = Array.from({ length: 10 }, (_, i) => ({
  id: `s${i}`,
  title: `Song ${i}`,
  albumId: `al${Math.floor(i / 2)}`,
  isDir: false,
})) as unknown as Child[];

let mockApi: unknown = {};
let mockPlaylists: Array<Record<string, unknown>> = [];
const mockFetchPlaylistDetail = jest.fn((id: string) =>
  Promise.resolve({ id, entry: [] } as unknown),
);
const mockSyncCachedItemTracks = jest.fn();
jest.mock('../subsonicService', () => ({
  probeEmptySearch3: () => Promise.resolve(true),
  searchAlbumsPage: (count: number, offset: number) => Promise.resolve(mockAlbumsData.slice(offset, offset + count)),
  getAlbumsPageByName: (size: number, offset: number) => Promise.resolve(mockAlbumsData.slice(offset, offset + size)),
  searchSongsPage: (count: number, offset: number) => Promise.resolve(mockSongsData.slice(offset, offset + count)),
  // An empty page only means "end of library" when there was an API to ask; the loops
  // consult this to tell that apart from "no usable API, so everything resolves []".
  getApi: () => mockApi,
  ensureCoverArtAuth: () => Promise.resolve(),
  getAllArtists: () => Promise.resolve([]),
  getAllPlaylists: () => Promise.resolve(mockPlaylists),
}));
jest.mock('../detailFetchService', () => ({
  fetchPlaylistDetail: (id: string) => mockFetchPlaylistDetail(id),
}));
jest.mock('../musicCacheService', () => ({
  syncCachedItemTracks: (...a: unknown[]) => mockSyncCachedItemTracks(...a),
}));
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: () => ({ offlineMode: false }), subscribe: () => () => {} },
}));

const db = () => getDb()!;

/** The playlist detail reconcile is deliberately fire-and-forget, so every test has to
 *  drain it — otherwise one test's fan-out is still in flight (and holding the dedup
 *  promise) when the next one starts. */
const flush = async () => {
  for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 0));
};

afterEach(flush);

beforeEach(() => {
  mockApi = {};
  mockPlaylists = [];
  // mockReset, not mockClear: one test overrides the implementation to drop the API
  // mid-fetch, and mockClear leaves that in place for the next test.
  mockFetchPlaylistDetail.mockReset();
  mockFetchPlaylistDetail.mockImplementation((id: string) =>
    Promise.resolve({ id, entry: [] } as unknown),
  );
  mockSyncCachedItemTracks.mockClear();
  db().runSync('DELETE FROM playlists');
  // Full reset: cursors/completion flags carry between tests otherwise, and a
  // 'complete' library makes the next run short-circuit before the playlist phase.
  syncStatusStore.setState(syncStatusStore.getInitialState(), true);
});

describe('runNormalizedLibrarySync', () => {
  it('populates ONLY the normalized model + reports albums-with-songs / total-albums', async () => {
    await runNormalizedLibrarySync({ full: true });

    // Normalized tables populated.
    expect(await countAlbums(db())).toBe(5);
    expect(await countSongs(db())).toBe(10);

    // Both phases marked complete (the transient detailSync* progress fields are
    // reset to 0 by markSongSyncComplete, so we assert the completion outcome).
    const s = syncStatusStore.getState();
    expect(s.librarySyncComplete).toBe(true);
    expect(s.songSyncComplete).toBe(true);
  });

  it('is idempotent on a full re-run (upserts in place, no duplicates)', async () => {
    await runNormalizedLibrarySync({ full: true });
    await runNormalizedLibrarySync({ full: true });
    expect(await countAlbums(db())).toBe(5);
    expect(await countSongs(db())).toBe(10);
  });

  it('a full re-run does NOT drop rows the sync cannot rebuild', async () => {
    await runNormalizedLibrarySync({ full: true });
    // Playlist membership + artist bio have no sync writer — only the on-demand detail
    // fetch writes them. Dropping the tables on a full resync destroyed them for good.
    db().runSync("INSERT OR REPLACE INTO playlists (id, name) VALUES ('pl1', 'Mix')");
    db().runSync(
      "INSERT OR REPLACE INTO playlist_songs (playlist_id, position, song_id) VALUES ('pl1', 0, 's0')",
    );
    db().runSync("INSERT OR REPLACE INTO artists (id, name) VALUES ('ar1', 'A')");
    db().runSync(
      "INSERT OR REPLACE INTO artist_bio (artist_id, biography, checked_at) VALUES ('ar1', 'bio', 1)",
    );

    await runNormalizedLibrarySync({ full: true });

    expect(
      db().getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM playlist_songs')?.n,
    ).toBe(1);
    expect(
      db().getFirstSync<{ bio: string }>(
        "SELECT biography AS bio FROM artist_bio WHERE artist_id = 'ar1'",
      )?.bio,
    ).toBe('bio');
  });

  it('does not mark the library complete when the API vanishes mid-run', async () => {
    // With no usable API every page fn resolves [] without throwing. Reading that as
    // "end of library" marked a truncated library fully synced.
    mockApi = null;
    syncStatusStore.setState({ librarySyncComplete: false, songSyncComplete: false });
    await runNormalizedLibrarySync({ full: true });
    expect(syncStatusStore.getState().librarySyncComplete).toBe(false);
  });
});

describe('playlist detail reconcile', () => {
  const pl = (id: string, changed: string, songCount: number) =>
    ({ id, name: id, changed, songCount }) as unknown as Record<string, unknown>;
  const marker = (id: string) =>
    db().getFirstSync<{ c: number | null; n: number | null }>(
      `SELECT detail_changed AS c, detail_song_count AS n FROM playlists WHERE id = '${id}'`,
    );

  it('fetches a playlist whose membership was never fetched', async () => {
    mockPlaylists = [pl('p1', '2024-01-01T00:00:00Z', 3)];
    await runNormalizedLibrarySync({ full: true });
    await flush();
    expect(mockFetchPlaylistDetail).toHaveBeenCalledWith('p1');
    // Marker stamped from the LIST envelope, so the next pass skips it.
    expect(marker('p1')?.n).toBe(3);
  });

  it('skips a playlist that has not changed since its last detail fetch', async () => {
    mockPlaylists = [pl('p1', '2024-01-01T00:00:00Z', 3)];
    await runNormalizedLibrarySync({ full: true });
    await flush();
    // mockReset, not mockClear: one test overrides the implementation to drop the API
  // mid-fetch, and mockClear leaves that in place for the next test.
  mockFetchPlaylistDetail.mockReset();
  mockFetchPlaylistDetail.mockImplementation((id: string) =>
    Promise.resolve({ id, entry: [] } as unknown),
  );

    await runNormalizedLibrarySync();
    await flush();
    expect(mockFetchPlaylistDetail).not.toHaveBeenCalled();
  });

  it('refetches when the server reports a changed track count', async () => {
    mockPlaylists = [pl('p1', '2024-01-01T00:00:00Z', 3)];
    await runNormalizedLibrarySync({ full: true });
    await flush();
    // mockReset, not mockClear: one test overrides the implementation to drop the API
  // mid-fetch, and mockClear leaves that in place for the next test.
  mockFetchPlaylistDetail.mockReset();
  mockFetchPlaylistDetail.mockImplementation((id: string) =>
    Promise.resolve({ id, entry: [] } as unknown),
  );

    mockPlaylists = [pl('p1', '2024-01-01T00:00:00Z', 4)];
    await runNormalizedLibrarySync();
    await flush();
    expect(mockFetchPlaylistDetail).toHaveBeenCalledWith('p1');
  });

  it('does not stamp the marker when the fetch found no server', async () => {
    // fetchPlaylistDetail returns LOCAL data on its offline branch, so a non-null
    // result is not proof the server answered — stamping it would suppress the
    // refetch permanently for exactly the playlists that needed it.
    mockPlaylists = [pl('p1', '2024-01-01T00:00:00Z', 3)];
    mockFetchPlaylistDetail.mockImplementation((id: string) => {
      mockApi = null; // API vanishes mid-fetch
      return Promise.resolve({ id, entry: [] } as unknown);
    });
    await runNormalizedLibrarySync({ full: true });
    await flush();
    expect(marker('p1')?.c).toBeNull();
  });

  it('clears the markers on a full resync so membership is re-fetched', async () => {
    mockPlaylists = [pl('p1', '2024-01-01T00:00:00Z', 3)];
    await runNormalizedLibrarySync({ full: true });
    await flush();
    expect(marker('p1')?.n).toBe(3);
    // mockReset, not mockClear: one test overrides the implementation to drop the API
  // mid-fetch, and mockClear leaves that in place for the next test.
  mockFetchPlaylistDetail.mockReset();
  mockFetchPlaylistDetail.mockImplementation((id: string) =>
    Promise.resolve({ id, entry: [] } as unknown),
  );

    // A full resync overwrites rows in place, so without clearing, the markers would
    // survive and the one manual repair the UI offers would skip every playlist.
    await runNormalizedLibrarySync({ full: true });
    await flush();
    expect(mockFetchPlaylistDetail).toHaveBeenCalledWith('p1');
  });
});
