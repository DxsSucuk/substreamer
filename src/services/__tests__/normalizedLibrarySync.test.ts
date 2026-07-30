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
jest.mock('../subsonicService', () => ({
  probeEmptySearch3: () => Promise.resolve(true),
  searchAlbumsPage: (count: number, offset: number) => Promise.resolve(mockAlbumsData.slice(offset, offset + count)),
  getAlbumsPageByName: (size: number, offset: number) => Promise.resolve(mockAlbumsData.slice(offset, offset + size)),
  searchSongsPage: (count: number, offset: number) => Promise.resolve(mockSongsData.slice(offset, offset + count)),
  // An empty page only means "end of library" when there was an API to ask; the loops
  // consult this to tell that apart from "no usable API, so everything resolves []".
  getApi: () => mockApi,
}));
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: () => ({ offlineMode: false }) },
}));

const db = () => getDb()!;

beforeEach(() => {
  mockApi = {};
  syncStatusStore.setState({ generation: 0, syncStrategy: null });
});

describe('runNormalizedLibrarySync', () => {
  it('populates ONLY the normalized model + reports albums-with-songs / total-albums', async () => {
    await runNormalizedLibrarySync({ full: true });

    // Normalized tables populated.
    expect(await countAlbums(db())).toBe(5);
    expect(await countSongs(db())).toBe(10);

    // Single writer: the legacy blob table was NOT written.
    const blobSongs = db().getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM song_index')?.n ?? 0;
    expect(blobSongs).toBe(0);

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
    db().runSync("INSERT OR REPLACE INTO artists (id, name, biography) VALUES ('ar1', 'A', 'bio')");

    await runNormalizedLibrarySync({ full: true });

    expect(
      db().getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM playlist_songs')?.n,
    ).toBe(1);
    expect(
      db().getFirstSync<{ bio: string }>("SELECT biography AS bio FROM artists WHERE id = 'ar1'")
        ?.bio,
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
