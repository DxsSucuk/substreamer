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
/** The song pager and the per-album fetch are jest.fn()s so a test can inject a
 *  transient empty page, a hole in the library, or assert exactly which albums the gap
 *  repair asked the server about. */
const mockSearchAlbumsPage = jest.fn((count: number, offset: number) =>
  Promise.resolve(mockAlbumsData.slice(offset, offset + count)),
);
const mockSearchSongsPage = jest.fn((count: number, offset: number) =>
  Promise.resolve(mockSongsData.slice(offset, offset + count)),
);
const mockGetAlbum = jest.fn((id: string) =>
  Promise.resolve({
    ...mockAlbumsData.find((a) => a.id === id),
    song: mockSongsData.filter((s) => (s as { albumId?: string }).albumId === id),
  } as unknown),
);
jest.mock('../subsonicService', () => ({
  probeEmptySearch3: () => Promise.resolve(true),
  searchAlbumsPage: (count: number, offset: number) => mockSearchAlbumsPage(count, offset),
  getAlbumsPageByName: (size: number, offset: number) => Promise.resolve(mockAlbumsData.slice(offset, offset + size)),
  searchSongsPage: (count: number, offset: number) => mockSearchSongsPage(count, offset),
  getAlbum: (id: string) => mockGetAlbum(id),
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
  mockSearchAlbumsPage.mockReset();
  mockSearchAlbumsPage.mockImplementation((count: number, offset: number) =>
    Promise.resolve(mockAlbumsData.slice(offset, offset + count)),
  );
  mockSearchSongsPage.mockReset();
  mockSearchSongsPage.mockImplementation((count: number, offset: number) =>
    Promise.resolve(mockSongsData.slice(offset, offset + count)),
  );
  mockGetAlbum.mockReset();
  mockGetAlbum.mockImplementation((id: string) =>
    Promise.resolve({
      ...mockAlbumsData.find((a) => a.id === id),
      song: mockSongsData.filter((s) => (s as { albumId?: string }).albumId === id),
    } as unknown),
  );
  db().runSync('DELETE FROM playlists');
  db().runSync('DELETE FROM songs');
  db().runSync('DELETE FROM albums');
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

  it('leaves no phase stuck when the ALBUM phase throws', async () => {
    // The album phase is the one that can strand it: a throw there never reaches
    // `markLibrarySyncComplete`, which is the only other thing that clears the phase.
    mockSearchAlbumsPage.mockImplementation(() => Promise.reject(new Error('boom')));

    await runNormalizedLibrarySync({ full: true });

    const s = syncStatusStore.getState();
    expect(s.detailSyncPhase).toBe('error');
    // `librarySyncPhase` is PERSISTED: left on 'fetching' it survives the relaunch and
    // shows "Fetching library…" with nothing fetching.
    expect(s.librarySyncPhase).toBe('idle');
  });
});

/** Serve only the first `n` songs of the library, in pages of 4. Everything after that
 *  never arrives, so the albums those songs belong to end the walk with no tracks — the
 *  album-shaped hole this whole area exists to stop latching. */
const serveSongs = (n: number) =>
  mockSearchSongsPage.mockImplementation((count: number, offset: number) =>
    Promise.resolve(mockSongsData.slice(0, n).slice(offset, Math.min(offset + count, offset + 4))),
  );

describe('an empty song page must be corroborated', () => {
  it('retries an empty page mid-walk instead of ending the library there', async () => {
    let asksAtFour = 0;
    mockSearchSongsPage.mockImplementation((count: number, offset: number) => {
      // One hiccup at offset 4: a 200 with no searchResult3 is indistinguishable from
      // exhaustion, and believing it used to cost every song after this offset.
      if (offset === 4 && (asksAtFour += 1) === 1) return Promise.resolve([]);
      return Promise.resolve(mockSongsData.slice(offset, Math.min(offset + count, offset + 4)));
    });

    await runNormalizedLibrarySync({ full: true });

    expect(asksAtFour).toBeGreaterThan(1); // it asked again rather than believing the []
    expect(await countSongs(db())).toBe(10);
    expect(syncStatusStore.getState().songSyncCursor).toBe(10);
    expect(syncStatusStore.getState().songSyncComplete).toBe(true);
    // The pager itself recovered — no per-album repair was needed.
    expect(mockGetAlbum).not.toHaveBeenCalled();
    // The budget is CONSECUTIVE empties, not empties-per-walk: the hiccup at offset 4
    // must not eat the corroboration the real end of the library gets.
    expect(mockSearchSongsPage.mock.calls.filter(([, offset]) => offset === 10)).toHaveLength(4);
  });

  it('still terminates on a genuinely exhausted library, with bounded retries', async () => {
    await runNormalizedLibrarySync({ full: true });

    const asksPastTheEnd = mockSearchSongsPage.mock.calls.filter(([, offset]) => offset === 10);
    expect(asksPastTheEnd.length).toBeGreaterThan(1); // corroborated
    expect(asksPastTheEnd.length).toBeLessThanOrEqual(4); // and bounded
    expect(syncStatusStore.getState().songSyncComplete).toBe(true);
  });
});

describe('song-gap repair', () => {
  it('costs one indexed probe and no per-album request when the library is healthy', async () => {
    const getAll = jest.spyOn(db(), 'getAllAsync');
    try {
      await runNormalizedLibrarySync({ full: true });

      expect(mockGetAlbum).not.toHaveBeenCalled();
      expect(syncStatusStore.getState().songSyncComplete).toBe(true);
      // The gate is `hasAlbumWithoutSongs` — a `LIMIT 1` probe that stops at the first
      // hit. Materialising the two id lists the walk diffs is exactly what it exists to
      // avoid, on a library that can hold 200k albums.
      const idListReads = getAll.mock.calls.filter(([sql]) =>
        /^SELECT id FROM albums$|DISTINCT album_id/.test(String(sql)),
      );
      expect(idListReads).toHaveLength(0);
    } finally {
      getAll.mockRestore();
    }
  });

  it('fetches ONLY the albums left without songs, never the library', async () => {
    serveSongs(6); // al0..al2 populated; al3 and al4 end the walk empty

    await runNormalizedLibrarySync({ full: true });

    // A full resync leaves `fullWalkPending` set until completion; the repair must
    // ignore it, or two holes turn into a whole-library re-fetch.
    expect(mockGetAlbum.mock.calls.map(([id]) => id).sort()).toEqual(['al3', 'al4']);
    expect(await countSongs(db())).toBe(10);
    expect(syncStatusStore.getState().songSyncComplete).toBe(true);
    expect(syncStatusStore.getState().songGapRepairAttempted).toBe(false);
  });

  it('does not mark the song sync complete when the repair could not run', async () => {
    serveSongs(6);
    mockGetAlbum.mockImplementation(() => Promise.resolve(null)); // every repair fetch fails

    await runNormalizedLibrarySync({ full: true });

    // Reaching the last page is necessary, not sufficient: the gap is still there and
    // nothing has established that the server has no tracks for it.
    expect(syncStatusStore.getState().songSyncComplete).toBe(false);
    expect(syncStatusStore.getState().songGapRepairAttempted).toBe(false);
  });

  it('stops re-triggering once the server says the gapped albums have no tracks', async () => {
    serveSongs(6);
    mockGetAlbum.mockImplementation((id: string) =>
      Promise.resolve({ ...mockAlbumsData.find((a) => a.id === id), song: [] } as unknown),
    );

    await runNormalizedLibrarySync({ full: true });

    // Asked and answered — the albums are track-less on the server, not victims of a
    // lost page. Without recording that, the gate re-fires this run on every launch.
    expect(syncStatusStore.getState().songGapRepairAttempted).toBe(true);
    expect(syncStatusStore.getState().songSyncComplete).toBe(true);

    mockGetAlbum.mockClear();
    await runNormalizedLibrarySync();
    expect(mockGetAlbum).not.toHaveBeenCalled();
  });

  it('asks again after the user forces a full resync', async () => {
    syncStatusStore.setState({ songGapRepairAttempted: true });
    syncStatusStore.getState().resetSongSync();
    expect(syncStatusStore.getState().songGapRepairAttempted).toBe(false);
  });
});

describe('the per-album walk', () => {
  it('runs the albumId sanity check on the first page of a RESUMED walk', async () => {
    // A server that stops populating `albumId` part-way writes rows with album_id NULL:
    // the album reads empty while countSongs stays right, so nothing downstream sees it.
    // Gating the check on offset 0 meant a resumed walk never looked.
    mockSearchSongsPage.mockImplementation((count: number, offset: number) =>
      Promise.resolve(
        mockSongsData
          .slice(offset, Math.min(offset + count, offset + 4))
          .map((s) => ({ ...s, albumId: undefined })),
      ),
    );
    syncStatusStore.setState({ songSyncCursor: 4 });

    await runNormalizedLibrarySync();

    expect(syncStatusStore.getState().songSyncStrategy).toBe('basic');
    expect(mockGetAlbum).toHaveBeenCalled();
  });

  it('does not count an album the server returned no songs for as walked', async () => {
    mockGetAlbum.mockImplementation((id: string) => {
      if (id === 'al4') return Promise.resolve(null); // fetch failed → the walk bails
      const album = mockAlbumsData.find((a) => a.id === id);
      // al3 exists on the server but has no tracks at all.
      const song = id === 'al3' ? [] : mockSongsData.filter((s) => (s as { albumId?: string }).albumId === id);
      return Promise.resolve({ ...album, song } as unknown);
    });

    await runNormalizedLibrarySync({ full: true, forceStrategy: 'basic' });

    // al0, al1, al2 were walked. al3 answered empty and al4 failed — neither counts,
    // or the progress bar reads 100% over a library that still has holes in it.
    expect(syncStatusStore.getState().detailSyncCompleted).toBe(3);
    expect(syncStatusStore.getState().songSyncComplete).toBe(false);
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
