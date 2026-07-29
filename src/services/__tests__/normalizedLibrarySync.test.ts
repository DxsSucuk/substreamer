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

jest.mock('../subsonicService', () => ({
  probeEmptySearch3: () => Promise.resolve(true),
  searchAlbumsPage: (count: number, offset: number) => Promise.resolve(mockAlbumsData.slice(offset, offset + count)),
  getAlbumsPageByName: (size: number, offset: number) => Promise.resolve(mockAlbumsData.slice(offset, offset + size)),
  searchSongsPage: (count: number, offset: number) => Promise.resolve(mockSongsData.slice(offset, offset + count)),
}));
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: () => ({ offlineMode: false }) },
}));

const db = () => getDb()!;

beforeEach(() => {
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

  it('is idempotent on a full re-run (drops + repopulates, no duplicates)', async () => {
    await runNormalizedLibrarySync({ full: true });
    await runNormalizedLibrarySync({ full: true });
    expect(await countAlbums(db())).toBe(5);
    expect(await countSongs(db())).toBe(10);
  });
});
