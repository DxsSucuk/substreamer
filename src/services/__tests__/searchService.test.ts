jest.mock('../subsonicService');
jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));
jest.mock('../imageCacheService', () => ({
  ensureCached: jest.fn().mockResolvedValue(undefined),
  prefetchCoverArt: jest.fn(),
}));
// The full-library candidate layer is the repository search module. Mock it so the
// routing / ranking / result-mapping logic under test is isolated from the candidate
// SQL (which has its own real-DB tests in repository.test.ts). The OFFLINE path reads
// the REAL repository/albums + repository/playlists against the seeded better-sqlite3
// DB (those modules are NOT mocked).
jest.mock('../../db/repository/search');

import { ensureCoverArtAuth, search3 } from '../subsonicService';
import { musicCacheStore } from '../../store/musicCacheStore';
import { offlineModeStore } from '../../store/offlineModeStore';
import { syncStatusStore } from '../../store/syncStatusStore';
import { connectivityStore } from '../../store/connectivityStore';
import { getDb } from '../../store/persistence/db';
import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { upsertAlbums } from '../../db/repository/albums';
import { upsertPlaylists } from '../../db/repository/playlists';
import { hasLocalCorpus, searchAlbums, searchArtists, searchSongs } from '../../db/repository/search';
import {
  performOnlineSearch,
  performOfflineSearch,
  getOfflineSongsByGenre,
  searchLibrary,
  findAlbum,
  findArtistSongs,
} from '../searchService';

const mockSearch3 = search3 as jest.MockedFunction<typeof search3>;
const mockEnsureCoverArtAuth = ensureCoverArtAuth as jest.MockedFunction<typeof ensureCoverArtAuth>;
const mockSearchSongs = searchSongs as jest.MockedFunction<typeof searchSongs>;
const mockSearchAlbums = searchAlbums as jest.MockedFunction<typeof searchAlbums>;
const mockSearchArtists = searchArtists as jest.MockedFunction<typeof searchArtists>;
const mockHasLocalCorpus = hasLocalCorpus as jest.MockedFunction<typeof hasLocalCorpus>;

const db = () => getDb()!;

/** Valid AlbumID3 for seeding the normalized `albums` table (offline path). */
const albumFixture = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, created: new Date('2020-01-01'), duration: 100, songCount: 10, ...extra }) as never;
/** Valid Playlist for seeding the normalized `playlists` table (offline path). */
const playlistFixture = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name,
    created: new Date('2020-01-01'),
    changed: new Date('2020-01-01'),
    duration: 1000,
    songCount: 5,
    ...extra,
  }) as never;

function resetStores() {
  musicCacheStore.setState({ cachedItems: {}, cachedSongs: {} } as any);
}

/**
 * Seed `musicCacheStore` from a compact {itemId: {name, tracks: [...]}}
 * description. Each track may carry genre / genres which get serialised
 * into the rawJson envelope so the production path can read them via
 * `getSongEnvelope()` exactly as it does at runtime.
 */
function seedCache(
  oldItems: Record<string, { name: string; tracks: any[] }>,
) {
  const cachedItems: Record<string, any> = {};
  const cachedSongs: Record<string, any> = {};
  for (const [itemId, item] of Object.entries(oldItems)) {
    const songIds: string[] = [];
    for (const t of item.tracks) {
      if (!t?.id) continue;
      if (!songIds.includes(t.id)) songIds.push(t.id);
      if (!cachedSongs[t.id]) {
        cachedSongs[t.id] = {
          id: t.id,
          title: t.title,
          artist: t.artist,
          albumId: t.albumId ?? itemId,
          duration: t.duration ?? 0,
          rawJson: JSON.stringify({
            id: t.id,
            title: t.title,
            artist: t.artist,
            albumId: t.albumId ?? itemId,
            duration: t.duration ?? 0,
            isDir: false,
            ...(t.genre ? { genre: t.genre } : {}),
            ...(t.genres ? { genres: t.genres } : {}),
          }),
        };
      }
    }
    cachedItems[itemId] = {
      itemId,
      name: item.name,
      songIds,
    };
  }
  musicCacheStore.setState({ cachedItems, cachedSongs } as any);
}

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(() => {
  jest.clearAllMocks();
  resetStores();
  for (const t of ['albums', 'playlists', 'songs', 'artists']) db().runSync(`DELETE FROM ${t}`);
  // Auto-mocked candidate fns default to undefined; give them empty resolutions so
  // the ranking maps run. Individual tests override.
  mockSearchSongs.mockResolvedValue([]);
  mockSearchAlbums.mockResolvedValue([]);
  mockSearchArtists.mockResolvedValue([]);
  mockHasLocalCorpus.mockResolvedValue(true);
});

describe('performOnlineSearch', () => {
  it('calls ensureCoverArtAuth then search3', async () => {
    const results = {
      albums: [{ id: 'a1', name: 'Album' }],
      artists: [{ id: 'ar1', name: 'Artist' }],
      songs: [{ id: 's1', title: 'Song' }],
    };
    mockSearch3.mockResolvedValue(results as any);

    const result = await performOnlineSearch('test');

    expect(mockEnsureCoverArtAuth).toHaveBeenCalled();
    expect(mockSearch3).toHaveBeenCalledWith('test');
    expect(result).toEqual(results);
  });

  it('propagates errors from search3', async () => {
    mockSearch3.mockRejectedValue(new Error('Network error'));
    await expect(performOnlineSearch('test')).rejects.toThrow('Network error');
  });
});

describe('performOfflineSearch', () => {
  it('searches cached albums by name', async () => {
    seedCache({ a1: { name: 'Test Album', tracks: [] } });
    await upsertAlbums(db(), [albumFixture('a1', 'Test Album', { artist: 'Artist' })]);

    const result = await performOfflineSearch('test');

    expect(result.albums).toHaveLength(1);
    expect(result.albums[0].id).toBe('a1');
  });

  it('searches cached albums by artist name', async () => {
    seedCache({ a1: { name: 'Album', tracks: [] } });
    await upsertAlbums(db(), [albumFixture('a1', 'Album', { artist: 'Radiohead' })]);

    expect((await performOfflineSearch('radiohead')).albums).toHaveLength(1);
  });

  it('excludes non-cached albums', async () => {
    // Album exists in the library but is NOT downloaded (no cached item) → excluded.
    await upsertAlbums(db(), [albumFixture('a1', 'Test Album', { artist: 'Artist' })]);

    expect((await performOfflineSearch('test')).albums).toHaveLength(0);
  });

  it('includes cached playlists as album-shaped results', async () => {
    seedCache({ p1: { name: 'My Playlist', tracks: [] } });
    await upsertPlaylists(db(), [
      playlistFixture('p1', 'My Playlist', { owner: 'user', coverArt: 'c1' }),
    ]);

    expect((await performOfflineSearch('my')).albums.some((a) => a.id === 'p1')).toBe(true);
  });

  it('preserves the playlist owner on the album-shaped result artist line', async () => {
    seedCache({ p1: { name: 'My Playlist', tracks: [] } });
    await upsertPlaylists(db(), [playlistFixture('p1', 'My Playlist', { owner: 'dave' })]);

    const hit = (await performOfflineSearch('my')).albums.find((a) => a.id === 'p1');
    expect(hit?.artist).toBe('dave');
  });

  it('searches cached songs by title', async () => {
    seedCache({
      a1: {
        name: 'Album',
        tracks: [
          { id: 't1', title: 'Matching Song', artist: 'Artist', duration: 200 },
          { id: 't2', title: 'Other', artist: 'Nobody', duration: 180 },
        ],
      },
    });

    const result = await performOfflineSearch('matching');

    expect(result.songs).toHaveLength(1);
    expect(result.songs[0].title).toBe('Matching Song');
  });

  it('fuzzy: phonetic typo in artist ("corn") still finds Korn', async () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Freak on a Leash', artist: 'Korn', duration: 200 }] },
    });
    expect((await performOfflineSearch('corn')).songs.map((s) => s.id)).toContain('t1');
  });

  it('fuzzy: out-of-order tokens ("leash freak") match "Freak on a Leash"', async () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Freak on a Leash', artist: 'Korn', duration: 200 }] },
    });
    expect((await performOfflineSearch('leash freak')).songs.map((s) => s.id)).toContain('t1');
  });

  it('empty / whitespace query returns nothing (no match-everything)', async () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200 }] },
    });
    expect((await performOfflineSearch('   ')).songs).toHaveLength(0);
  });

  it('searches cached songs by artist', async () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Song', artist: 'Radiohead', duration: 200 }] },
    });

    expect((await performOfflineSearch('radiohead')).songs).toHaveLength(1);
  });

  it('deduplicates songs by id across multiple cached items', async () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Dup Song', artist: 'A', duration: 200 }] },
      p1: { name: 'Playlist', tracks: [{ id: 't1', title: 'Dup Song', artist: 'A', duration: 200 }] },
    });

    expect((await performOfflineSearch('dup')).songs).toHaveLength(1);
  });

  it('populates albumId on returned songs so cover-art lookup resolves via entity ID', async () => {
    seedCache({
      a1: {
        name: 'Album',
        tracks: [{ id: 't1', title: 'Track', artist: 'A', duration: 200, albumId: 'parent-album' }],
      },
    });

    expect((await performOfflineSearch('track')).songs[0].albumId).toBe('parent-album');
  });

  it('populates album name from parent item', async () => {
    seedCache({
      a1: { name: 'Parent Item Name', tracks: [{ id: 't1', title: 'Track', artist: 'A', duration: 200 }] },
    });

    expect((await performOfflineSearch('track')).songs[0].album).toBe('Parent Item Name');
  });

  it('always returns empty artists array', async () => {
    expect((await performOfflineSearch('anything')).artists).toEqual([]);
  });

  it('returns empty results for no matches', async () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Song', artist: 'Artist', duration: 200 }] },
    });
    await upsertAlbums(db(), [albumFixture('a1', 'Album', { artist: 'Artist' })]);

    const result = await performOfflineSearch('zzzznotfound');
    expect(result.albums).toHaveLength(0);
    expect(result.songs).toHaveLength(0);
  });

  it('handles album with undefined artist gracefully', async () => {
    seedCache({ a1: { name: 'Album', tracks: [] } });
    await upsertAlbums(db(), [albumFixture('a1', 'Album')]);

    expect((await performOfflineSearch('someartist')).albums).toHaveLength(0);
  });
});

describe('getOfflineSongsByGenre', () => {
  it('returns cached songs matching genre (via genre field)', () => {
    seedCache({
      a1: {
        name: 'Album',
        tracks: [
          { id: 't1', title: 'Song', artist: 'A', duration: 200, genre: 'Rock' },
          { id: 't2', title: 'Other', artist: 'B', duration: 180, genre: 'Jazz' },
        ],
      },
    });

    const result = getOfflineSongsByGenre('Rock');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('t1');
  });

  it('matches genre case-insensitively', () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200, genre: 'ROCK' }] },
    });

    expect(getOfflineSongsByGenre('rock')).toHaveLength(1);
  });

  it('matches via genres array with {name} objects (OpenSubsonic)', () => {
    seedCache({
      a1: {
        name: 'Album',
        tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200, genres: [{ name: 'Electronic' }, { name: 'Ambient' }] }],
      },
    });

    expect(getOfflineSongsByGenre('ambient')).toHaveLength(1);
  });

  it('matches via genres array with plain strings (defensive)', () => {
    seedCache({
      a1: {
        name: 'Album',
        tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200, genres: ['Electronic', 'Ambient'] }],
      },
    });

    expect(getOfflineSongsByGenre('ambient')).toHaveLength(1);
  });

  it('only includes songs present in cachedSongs', () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Cached', artist: 'A', duration: 200, genre: 'Rock' }] },
    });
    // Stamp a stray songId onto the cached item that has no matching cachedSongs row.
    const state = musicCacheStore.getState();
    musicCacheStore.setState({
      ...state,
      cachedItems: {
        ...state.cachedItems,
        a1: { ...state.cachedItems.a1, songIds: ['t1', 't99'] },
      },
    } as any);

    const result = getOfflineSongsByGenre('Rock');
    expect(result.map((s) => s.id)).toEqual(['t1']);
  });

  it('deduplicates songs across multiple cached items', () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200, genre: 'Rock' }] },
      p1: { name: 'Playlist', tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200, genre: 'Rock' }] },
    });

    expect(getOfflineSongsByGenre('Rock')).toHaveLength(1);
  });

  it('returns empty array when no songs match genre', () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200, genre: 'Rock' }] },
    });

    expect(getOfflineSongsByGenre('Classical')).toHaveLength(0);
  });

  it('returns empty array when no cached items', () => {
    expect(getOfflineSongsByGenre('Rock')).toHaveLength(0);
  });

  it('does not match songs without genre or genres field', () => {
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Song', artist: 'A', duration: 200 }] },
    });

    expect(getOfflineSongsByGenre('Rock')).toHaveLength(0);
  });
});

describe('searchLibrary — data-state routing', () => {
  // Lean SongListRow shape — searchFullLibraryScored ranks r.title/r.artist and maps
  // the row to a Child via songListRowToChild.
  const localSong = (id: string, title = 'Test Song') =>
    ({ id, album_id: 'a1', title, artist: 'A', duration: 200 }) as any;

  beforeEach(() => {
    // Sane online + fully-synced + reachable defaults; each test overrides.
    offlineModeStore.setState({ offlineMode: false });
    syncStatusStore.setState({ librarySyncComplete: true, songSyncComplete: true });
    connectivityStore.setState({ hasConnection: true, isServerReachable: true });
  });

  it('empty query short-circuits to empty with no queries', async () => {
    const res = await searchLibrary('   ');
    expect(res).toEqual({ albums: [], artists: [], songs: [] });
    expect(mockHasLocalCorpus).not.toHaveBeenCalled();
    expect(mockSearch3).not.toHaveBeenCalled();
  });

  it('offlineMode ON → downloaded-only scan, never the full-library path or server', async () => {
    offlineModeStore.setState({ offlineMode: true });
    seedCache({
      a1: { name: 'Album', tracks: [{ id: 't1', title: 'Freak on a Leash', artist: 'Korn', duration: 200 }] },
    });
    const res = await searchLibrary('freak on a leash');
    expect(res.songs.map((s) => s.id)).toContain('t1');
    expect(mockSearch3).not.toHaveBeenCalled();
    expect(mockSearchSongs).not.toHaveBeenCalled();
  });

  it('online + fully synced + confident local hit → local authoritative, no server', async () => {
    mockSearchSongs.mockResolvedValue([localSong('s1')]);
    const res = await searchLibrary('test song');
    expect(res.songs.map((s) => s.id)).toEqual(['s1']);
    expect(mockSearch3).not.toHaveBeenCalled();
  });

  it('returns matching ARTISTS from the synced artist library (search3 parity)', async () => {
    // Regression: local search used to hardcode artists:[] — "pearl" showed
    // albums + songs but never the Pearl Jam artist row.
    mockSearchArtists.mockResolvedValue([
      { id: 'ar1', name: 'Pearl Jam', album_count: 57, cover_art: null, sort_name: null, sort_title: 'pearl jam', starred: null, user_rating: null },
      { id: 'ar2', name: 'Metallica', album_count: 12, cover_art: null, sort_name: null, sort_title: 'metallica', starred: null, user_rating: null },
    ]);
    const res = await searchLibrary('pearl');
    expect(res.artists.map((a) => a.id)).toEqual(['ar1']);
    expect(mockSearch3).not.toHaveBeenCalled();
  });

  it('online + fully synced + weak/empty local hit → local only, NEVER the server (no blocking)', async () => {
    mockSearchSongs.mockResolvedValue([]); // nothing local
    const res = await searchLibrary('test song');
    // Fully synced ⇒ local is complete; an interactive search must not block on
    // the network for a weak hit.
    expect(mockSearch3).not.toHaveBeenCalled();
    expect(res).toEqual({ albums: [], artists: [], songs: [] });
  });

  it('online + partially synced + reachable → local-first MERGED with server', async () => {
    syncStatusStore.setState({ librarySyncComplete: false, songSyncComplete: false });
    mockSearchSongs.mockResolvedValue([localSong('loc')]);
    mockSearch3.mockResolvedValue({ albums: [], artists: [], songs: [{ id: 'srv', title: 'Server' }] } as any);
    const res = await searchLibrary('test song');
    expect(mockSearch3).toHaveBeenCalled();
    expect(res.songs.map((s) => s.id)).toEqual(['loc', 'srv']); // local ranked first
  });

  it('online + partially synced → surfaces local via onLocalResults BEFORE merging the server', async () => {
    syncStatusStore.setState({ librarySyncComplete: false, songSyncComplete: false });
    mockSearchSongs.mockResolvedValue([localSong('loc')]);
    mockSearch3.mockResolvedValue({ albums: [], artists: [], songs: [{ id: 'srv', title: 'Server' }] } as any);
    const surfaced: string[][] = [];
    const res = await searchLibrary('test song', {
      onLocalResults: (r) => surfaced.push(r.songs.map((s) => s.id)),
    });
    expect(surfaced).toEqual([['loc']]); // local delivered first, before the server call
    expect(res.songs.map((s) => s.id)).toEqual(['loc', 'srv']);
  });

  it('online + partially synced + unreachable → local only, no server', async () => {
    syncStatusStore.setState({ librarySyncComplete: false, songSyncComplete: false });
    connectivityStore.setState({ hasConnection: false, isServerReachable: false });
    mockSearchSongs.mockResolvedValue([localSong('loc')]);
    const res = await searchLibrary('test song');
    expect(mockSearch3).not.toHaveBeenCalled();
    expect(res.songs.map((s) => s.id)).toEqual(['loc']);
  });

  it('online + no local corpus + reachable → straight to the server', async () => {
    mockHasLocalCorpus.mockResolvedValue(false);
    mockSearch3.mockResolvedValue({ albums: [], artists: [], songs: [{ id: 'srv', title: 'S' }] } as any);
    const res = await searchLibrary('anything');
    expect(mockSearch3).toHaveBeenCalled();
    expect(res.songs.map((s) => s.id)).toEqual(['srv']);
    expect(mockSearchSongs).not.toHaveBeenCalled();
  });

  it('online + no local corpus + unreachable → empty (no hang)', async () => {
    mockHasLocalCorpus.mockResolvedValue(false);
    connectivityStore.setState({ hasConnection: false, isServerReachable: false });
    const res = await searchLibrary('anything');
    expect(mockSearch3).not.toHaveBeenCalled();
    expect(res).toEqual({ albums: [], artists: [], songs: [] });
  });
});

describe('findAlbum (voice album intent)', () => {
  // Lean AlbumListRow shape — findAlbum scores r.name/r.display_artist and maps the
  // winner to an AlbumID3 via albumListRowToAlbumID3.
  it('prefers the album by the given artist among same-named albums', async () => {
    mockSearchAlbums.mockResolvedValue([
      { id: 'a-x', name: 'Ten', display_artist: 'Somebody Else' },
      { id: 'a-pj', name: 'Ten', display_artist: 'Pearl Jam' },
    ] as any);
    // "Ten by Pearl Jam" must pick Pearl Jam's Ten, not the other "Ten".
    expect((await findAlbum('Ten', 'Pearl Jam'))?.id).toBe('a-pj');
  });

  it('returns null when there are no candidates', async () => {
    mockSearchAlbums.mockResolvedValue([]);
    expect(await findAlbum('Nonexistent', 'Nobody')).toBeNull();
  });

  it('matches on name alone when no artist is given', async () => {
    mockSearchAlbums.mockResolvedValue([{ id: 'a1', name: 'Ten', display_artist: 'Pearl Jam' }] as any);
    expect((await findAlbum('Ten'))?.id).toBe('a1');
  });
});

describe('findArtistSongs (voice artist intent)', () => {
  beforeEach(() => {
    offlineModeStore.setState({ offlineMode: false });
    syncStatusStore.setState({ librarySyncComplete: true, songSyncComplete: true });
    connectivityStore.setState({ hasConnection: true, isServerReachable: true });
  });

  it('keeps songs whose ARTIST confidently matches, drops title-only noise', async () => {
    mockSearchSongs.mockResolvedValue([
      { id: 's1', album_id: 'a1', title: 'Blind', artist: 'Korn' },
      { id: 's2', album_id: 'a2', title: 'Korn Tribute', artist: 'Cover Band' },
    ] as any);
    const songs = await findArtistSongs('Korn');
    expect(songs.map((s) => s.id)).toEqual(['s1']);
  });
});
