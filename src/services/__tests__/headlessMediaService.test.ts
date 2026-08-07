jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

// Detail drilldown/playback go through the shared normalized detailFetchService.
jest.mock('../detailFetchService', () => ({
  fetchAlbumDetail: jest.fn(),
  fetchPlaylistDetail: jest.fn(),
}));

import { __test, installHeadlessMediaService } from '../headlessMediaService';
import {
  sectionId,
  listId,
  albumId,
  azLetterId,
  favTrackId,
  playlistId,
} from '../headlessMediaService.helpers';
import { albumListsStore } from '../../store/albumListsStore';
import { favoritesStore } from '../../store/favoritesStore';
import { fetchAlbumDetail, fetchPlaylistDetail } from '../detailFetchService';
import { offlineModeStore } from '../../store/offlineModeStore';
import { musicCacheStore } from '../../store/musicCacheStore';
import { layoutPreferencesStore } from '../../store/layoutPreferencesStore';
import { syncStatusStore } from '../../store/syncStatusStore';
import { getDb } from '../../store/persistence/db';
import { upsertCachedItem } from '../../store/persistence/musicCacheTables';
import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { upsertAlbums } from '../../db/repository/albums';
import { upsertPlaylists } from '../../db/repository/playlists';
import { upsertArtists } from '../../db/repository/artists';
import { upsertSongs } from '../../db/repository/songs';
import {
  markStarredArtists,
  markStarredSongs,
  replaceFavoriteArtists,
  replaceFavoriteSongs,
} from '../../db/repository/favorites';

const album = (id: string, name: string) => ({ id, name, artist: 'Artist' } as any);
const song = (id: string) => ({ id, title: `Song ${id}`, artist: 'Artist', albumId: 'al-1' } as any);
const playlist = (id: string, name: string) => ({ id, name, songCount: 3 } as any);

const db = () => getDb()!;
beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(async () => {
  offlineModeStore.setState({ offlineMode: false } as any);
  musicCacheStore.setState({ cachedItems: {}, cachedSongs: {} } as any);
  layoutPreferencesStore.setState({ includePartialInDownloadedFilter: false } as any);
  // Headless now reads the normalized tables (not the doomed library stores) — seed
  // the DB so the CarPlay/Auto browse + voice vocab resolve.
  db().runSync('DELETE FROM albums');
  db().runSync('DELETE FROM playlists');
  await upsertAlbums(db(), [album('al-a', 'Abbey Road'), album('al-z', 'Zooropa')]);
  await upsertPlaylists(db(), [playlist('p1', 'Roadtrip')]);
  albumListsStore.setState({
    recentlyAdded: [album('al-a', 'Abbey Road')],
    recentlyPlayed: [],
    frequentlyPlayed: [],
    randomSelection: [album('al-z', 'Zooropa')],
  } as any);
  // Favourites read SQL now: `starred` marks on the library rows, newest first — so the
  // marks descend to keep s1, s2, s3 in that order.
  db().runSync('DELETE FROM songs');
  db().runSync('DELETE FROM favorite_songs');
  db().runSync('DELETE FROM artists');
  // Children before parents — `cached_item_songs.song_id` FKs to `cached_songs`.
  db().runSync('DELETE FROM cached_item_songs');
  db().runSync('DELETE FROM cached_albums');
  db().runSync('DELETE FROM cached_playlists');
  db().runSync('DELETE FROM cached_items');
  db().runSync('DELETE FROM cached_songs');
  await upsertSongs(db(), [song('s1'), song('s2'), song('s3')]);
  await markStarredSongs(db(), [
    { id: 's1', starredAt: 3000 },
    { id: 's2', starredAt: 2000 },
    { id: 's3', starredAt: 1000 },
  ]);
  await favoritesStore.getState().refreshFromDb();
});

describe('buildSnapshot', () => {
  it('builds exactly the 4 sections in order', async () => {
    const snap = await __test.buildSnapshot();
    expect(snap.rootId).toBe('root');
    expect(snap.sections.map((s) => s.id)).toEqual([
      sectionId('home'),
      sectionId('favorites'),
      sectionId('albums'),
      sectionId('playlists'),
    ]);
  });

  it('Home lists non-empty curated rows; Favorites are flat playable songs', async () => {
    const snap = await __test.buildSnapshot();
    const home = snap.sections.find((s) => s.id === sectionId('home'))!;
    // recentlyAdded + randomSelection have items; recentlyPlayed/frequently don't.
    expect(home.items.map((i) => i.id)).toEqual([
      listId('recentlyAdded'),
      listId('randomSelection'),
    ]);
    expect(home.items.every((i) => i.hasChildren && !i.playable)).toBe(true);

    const favs = snap.sections.find((s) => s.id === sectionId('favorites'))!;
    expect(favs.items.map((i) => i.id)).toEqual([favTrackId(0), favTrackId(1), favTrackId(2)]);
    expect(favs.items.every((i) => i.playable && !i.hasChildren)).toBe(true);
  });

  it('Albums section is A–Z letter buckets (not flat albums)', async () => {
    const snap = await __test.buildSnapshot();
    const albums = snap.sections.find((s) => s.id === sectionId('albums'))!;
    expect(albums.items.map((i) => i.title)).toEqual(['A', 'Z']);
    expect(albums.items.map((i) => i.id)).toEqual([azLetterId('A'), azLetterId('Z')]);
  });

  it('Playlists shown directly as drill rows', async () => {
    const snap = await __test.buildSnapshot();
    const pls = snap.sections.find((s) => s.id === sectionId('playlists'))!;
    expect(pls.items.map((i) => i.title)).toEqual(['Roadtrip']);
    expect(pls.items[0].hasChildren).toBe(true);
  });
});

/** A downloaded track. `cached_songs` has no FK to `songs`, so this covers a remainder
 *  favourite being on disk too. */
const seedCachedSong = (id: string): void => {
  db().runSync(
    'INSERT INTO cached_songs (song_id, album_id, suffix, bytes, format_captured_at, ' +
      'downloaded_at, title, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, 'al-1', 'mp3', 1, 0, 0, 'T', 100],
  );
};

describe('the car Favorites node', () => {
  it('lists newest-starred first and plays row N as queue index N', async () => {
    // `favTrackId(i)` indexes into the play queue, so the display list and the queue
    // must be ONE ordering — a mismatch means "tap the 5th row, hear a different song".
    // Untestable in the car itself; the SQL ordering + the index contract are not.
    await replaceFavoriteSongs(db(), [song('rem1'), song('rem2')]);
    db().runSync('UPDATE favorite_songs SET starred = 1500 WHERE id = ?', ['rem1']);
    db().runSync('UPDATE favorite_songs SET starred = 500 WHERE id = ?', ['rem2']);
    await favoritesStore.getState().refreshFromDb();

    const snap = await __test.buildSnapshot();
    const favs = snap.sections.find((s) => s.id === sectionId('favorites'))!;
    expect(favs.items.map((i) => i.title)).toEqual([
      'Song s1',
      'Song s2',
      'Song rem1',
      'Song s3',
      'Song rem2',
    ]);

    for (let i = 0; i < favs.items.length; i++) {
      const r = await __test.resolvePlayback(favTrackId(i));
      expect(r.queue[r.startIndex].title).toBe(favs.items[i].title);
    }
  });

  it('OFFLINE lists only downloaded favourites, and plays exactly those', async () => {
    // The offline guarantee: nothing is listed that cannot play. Applies to the
    // remainder half too — `cached_songs` has no FK to `songs`.
    await replaceFavoriteSongs(db(), [song('rem1')]);
    db().runSync('UPDATE favorite_songs SET starred = 1500 WHERE id = ?', ['rem1']);
    await favoritesStore.getState().refreshFromDb();
    seedCachedSong('s2');
    seedCachedSong('rem1');
    offlineModeStore.setState({ offlineMode: true } as any);

    const snap = await __test.buildSnapshot();
    const favs = snap.sections.find((s) => s.id === sectionId('favorites'))!;
    expect(favs.items.map((i) => i.title)).toEqual(['Song s2', 'Song rem1']);

    const r = await __test.resolvePlayback(favTrackId(1));
    expect(r.queue.map((c) => c.id)).toEqual(['s2', 'rem1']);
    expect(r.startIndex).toBe(1);
  });

  it('donates starred artist names to the voice vocabulary', async () => {
    // "Play <a starred artist>" only resolves if the name was donated; the donation
    // reads both halves of the starred set.
    const tp = require('react-native-queue-player').getTrackPlayer();
    await upsertArtists(db(), [{ id: 'ar1', name: 'ABBA', albumCount: 1 }]);
    await markStarredArtists(db(), [{ id: 'ar1', starredAt: 10 }]);
    await replaceFavoriteArtists(db(), [{ id: 'ar2', name: 'Bowie', albumCount: 1 }]);
    tp.donateVoiceVocabulary.mockClear();

    await __test.pushSnapshot();

    const { artists } = tp.donateVoiceVocabulary.mock.calls[0][0] as { artists: string[] };
    expect(artists).toEqual(expect.arrayContaining(['ABBA', 'Bowie']));
  });
});

/**
 * The offline car tree filters on the DOWNLOADED set, which is SQL now
 * (`listDownloadedAlbumIds` / `listDownloadedAlbums`) rather than a walk over
 * `musicCacheStore.cachedItems`. CarPlay is the riskiest consumer of that change: it runs
 * with no UI mounted, so nothing else would notice a read that silently returned nothing.
 */
describe('the car tree OFFLINE — downloaded albums from SQL', () => {
  /** MEMBERSHIP: a `cached_items` row and nothing else. The car's album lists come from the
   *  library table and already carry metadata, so this alone means "downloaded". */
  const seedDownloadedItem = (id: string, expected = 0, present: string[] = []): void => {
    db().runSync(
      'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, ' +
        'downloaded_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, 'album', `Album ${id}`, expected, 0, 0],
    );
    present.forEach((songId, i) => {
      seedCachedSong(songId);
      db().runSync('INSERT INTO cached_item_songs (item_id, position, song_id) VALUES (?, ?, ?)', [
        id,
        i,
        songId,
      ]);
    });
  };

  /** VISIBILITY: the component row that makes an item renderable as a Downloaded Album. */
  const seedAlbumMeta = (id: string): void => {
    db().runSync('INSERT INTO cached_albums (item_id, name) VALUES (?, ?)', [id, `Album ${id}`]);
  };

  beforeEach(() => {
    offlineModeStore.setState({ offlineMode: true } as any);
  });

  it('A–Z buckets list only downloaded albums', async () => {
    seedDownloadedItem('al-a'); // Abbey Road downloaded, Zooropa not
    const albums = (await __test.buildSnapshot()).sections.find(
      (s) => s.id === sectionId('albums'),
    )!;
    expect(albums.items.map((i) => i.title)).toEqual(['A']);
  });

  it('lists nothing when nothing is downloaded — never the whole library', async () => {
    const albums = (await __test.buildSnapshot()).sections.find(
      (s) => s.id === sectionId('albums'),
    )!;
    expect(albums.items).toEqual([]);
  });

  it('filters the Home curated lists to downloaded albums', async () => {
    seedDownloadedItem('al-a');
    albumListsStore.setState({
      recentlyAdded: [album('al-a', 'Abbey Road'), album('al-z', 'Zooropa')],
      recentlyPlayed: [],
      frequentlyPlayed: [],
      randomSelection: [],
    } as any);
    const rows = await __test.resolveBrowseChildren(listId('recentlyAdded'));
    expect(rows.map((r) => r.id)).toEqual([albumId('al-a')]);
  });

  it('omits Downloaded Albums with no component row, while still counting it as downloaded', async () => {
    // Membership vs visibility on one fixture: al-a keeps Recently Added alive but cannot
    // be RENDERED as a Downloaded Album until `cached_albums` is populated.
    seedDownloadedItem('al-a');
    const home = (await __test.buildSnapshot()).sections.find((s) => s.id === sectionId('home'))!;
    expect(home.items.map((i) => i.id)).toContain(listId('recentlyAdded'));
    expect(home.items.map((i) => i.id)).not.toContain(listId('downloadedAlbums'));
  });

  it('shows Downloaded Albums once the component row exists', async () => {
    seedDownloadedItem('al-a');
    seedAlbumMeta('al-a');
    const home = (await __test.buildSnapshot()).sections.find((s) => s.id === sectionId('home'))!;
    expect(home.items.map((i) => i.id)).toContain(listId('downloadedAlbums'));
    const rows = await __test.resolveBrowseChildren(listId('downloadedAlbums'));
    expect(rows.map((r) => r.id)).toEqual([albumId('al-a')]);
  });

  it('honours the partial-download preference', async () => {
    seedDownloadedItem('al-a', 3, ['ps1']); // 1 of 3 on disk
    const hidden = (await __test.buildSnapshot()).sections.find(
      (s) => s.id === sectionId('albums'),
    )!;
    expect(hidden.items).toEqual([]);

    layoutPreferencesStore.setState({ includePartialInDownloadedFilter: true } as any);
    const shown = (await __test.buildSnapshot()).sections.find(
      (s) => s.id === sectionId('albums'),
    )!;
    expect(shown.items.map((i) => i.title)).toEqual(['A']);
  });

  it('ONLINE the tree is unfiltered — the downloaded set gates nothing', async () => {
    offlineModeStore.setState({ offlineMode: false } as any);
    const albums = (await __test.buildSnapshot()).sections.find(
      (s) => s.id === sectionId('albums'),
    )!;
    expect(albums.items.map((i) => i.title)).toEqual(['A', 'Z']);
  });

  /** The car reads the SAME SQL order the phone does, under the phone's own preference —
   *  CarPlay is a direct caller of `listDownloadedAlbums`, not an inheritor. */
  it('orders Downloaded Albums by the phone\'s album-sort preference', async () => {
    // Ids run opposite to both keys, so an unordered read gives the other answer.
    await upsertCachedItem({
      itemId: 'a-zulu',
      type: 'album',
      name: 'Zulu',
      expectedSongCount: 0,
      lastSyncAt: 0,
      downloadedAt: 0,
      albumMeta: { name: 'Zulu', artist: 'Alpaca' },
    });
    await upsertCachedItem({
      itemId: 'z-alpha',
      type: 'album',
      name: 'Alpha',
      expectedSongCount: 0,
      lastSyncAt: 0,
      downloadedAt: 0,
      albumMeta: { name: 'Alpha', artist: 'Zebra' },
    });

    layoutPreferencesStore.setState({ albumSortOrder: 'artist' } as any);
    expect(
      (await __test.resolveBrowseChildren(listId('downloadedAlbums'))).map((r) => r.id),
    ).toEqual([albumId('a-zulu'), albumId('z-alpha')]); // Alpaca, then Zebra

    // …and it FOLLOWS the preference rather than hard-coding one order.
    layoutPreferencesStore.setState({ albumSortOrder: 'title' } as any);
    expect(
      (await __test.resolveBrowseChildren(listId('downloadedAlbums'))).map((r) => r.id),
    ).toEqual([albumId('z-alpha'), albumId('a-zulu')]); // Alpha, then Zulu
  });
});

/**
 * The playlist twin of the block above. It matters that both halves of the offline tree
 * answer from the SAME source: while this filter walked `musicCacheStore.cachedItems` and
 * the album filter read SQL, one browse tree was reading the download tables two ways.
 */
describe('the car Playlists node OFFLINE — downloaded playlists from SQL', () => {
  const seedDownloadedPlaylist = (id: string): void => {
    db().runSync(
      'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, ' +
        'downloaded_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, 'playlist', `Playlist ${id}`, 0, 0, 0],
    );
  };

  beforeEach(async () => {
    await upsertPlaylists(db(), [playlist('p2', 'Commute')]);
    offlineModeStore.setState({ offlineMode: true } as any);
  });

  it('lists only downloaded playlists', async () => {
    seedDownloadedPlaylist('p1');
    const pls = (await __test.buildSnapshot()).sections.find(
      (s) => s.id === sectionId('playlists'),
    )!;
    expect(pls.items.map((i) => i.title)).toEqual(['Roadtrip']);
  });

  it('lists nothing when nothing is downloaded — never the whole library', async () => {
    const pls = (await __test.buildSnapshot()).sections.find(
      (s) => s.id === sectionId('playlists'),
    )!;
    expect(pls.items).toEqual([]);
  });

  it('counts a playlist with no component row — MEMBERSHIP, not visibility', async () => {
    // No `cached_playlists` row: the rendered metadata comes from the `playlists` table,
    // so requiring one would hide a playlist the user has on disk.
    seedDownloadedPlaylist('p1');
    expect(db().getAllSync('SELECT * FROM cached_playlists')).toEqual([]);
    const pls = (await __test.buildSnapshot()).sections.find(
      (s) => s.id === sectionId('playlists'),
    )!;
    expect(pls.items.map((i) => i.title)).toEqual(['Roadtrip']);
  });

  it('applies no partial gate — an album-style under-fill never hides a playlist', async () => {
    db().runSync(
      'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, ' +
        'downloaded_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['p1', 'playlist', 'Playlist p1', 99, 0, 0],
    );
    const pls = (await __test.buildSnapshot()).sections.find(
      (s) => s.id === sectionId('playlists'),
    )!;
    expect(pls.items.map((i) => i.title)).toEqual(['Roadtrip']);
  });

  it('voice "play playlist X" resolves against the same downloaded-only set', async () => {
    // `findPlaylistByName` reads `playlistSet()`, so an undownloaded playlist must not be
    // reachable by voice offline either.
    seedDownloadedPlaylist('p1');
    (fetchPlaylistDetail as jest.Mock).mockResolvedValue({ entry: [song('s1')] });
    expect(await __test.resolveVoice({ playlist: 'Commute', query: 'Commute' } as any)).toEqual([]);
    expect(
      (await __test.resolveVoice({ playlist: 'Roadtrip', query: 'Roadtrip' } as any)).map(
        (s: any) => s.id,
      ),
    ).toEqual(['s1']);
  });

  it('ONLINE both playlists are listed — the downloaded set gates nothing', async () => {
    offlineModeStore.setState({ offlineMode: false } as any);
    const pls = (await __test.buildSnapshot()).sections.find(
      (s) => s.id === sectionId('playlists'),
    )!;
    expect(pls.items.map((i) => i.title).sort()).toEqual(['Commute', 'Roadtrip']);
  });
});

describe('resolveBrowseChildren', () => {
  it('list:* → album drill rows', async () => {
    const rows = await __test.resolveBrowseChildren(listId('recentlyAdded'));
    expect(rows.map((r) => r.id)).toEqual([albumId('al-a')]);
    expect(rows[0].hasChildren).toBe(true);
  });

  it('azLetter → albums under that letter as drill rows (with artist subtitle)', async () => {
    const rows = await __test.resolveBrowseChildren(azLetterId('A'));
    expect(rows.map((r) => r.id)).toEqual([albumId('al-a')]);
    // Album rows always carry the artist as subtitle, matching home-list rows.
    expect(rows[0].subtitle).toBe('Artist');
  });

  it('album:<id> → its tracks as playable rows (via detail store)', async () => {
    (fetchAlbumDetail as jest.Mock).mockResolvedValueOnce({ song: [song('s1'), song('s2')] });
    const rows = await __test.resolveBrowseChildren(albumId('al-a'));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.playable && !r.hasChildren)).toBe(true);
    expect(rows[0].id).toBe('track:album:al-a:0');
  });

  it('playlist:<id> offline → tracks from the persisted detail cache (shared fetchPlaylist)', async () => {
    // Offline: fetchPlaylistDetail returns the persisted normalized detail — the same
    // shared fetch the app's playlist screen uses. No headless-specific fallback.
    // Playlists are never partially downloaded, so their entries are not filtered.
    offlineModeStore.setState({ offlineMode: true } as any);
    (fetchPlaylistDetail as jest.Mock).mockResolvedValueOnce({ id: 'p1', entry: [song('s1'), song('s2')] });
    const rows = await __test.resolveBrowseChildren(playlistId('p1'));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.playable && !r.hasChildren)).toBe(true);
  });

  it('album:<id> offline → tracks from the persisted detail cache (shared fetchAlbum)', async () => {
    offlineModeStore.setState({ offlineMode: true } as any);
    musicCacheStore.setState({ cachedSongs: { s1: {}, s2: {} } } as any);
    (fetchAlbumDetail as jest.Mock).mockResolvedValueOnce({ id: 'al-a', song: [song('s1'), song('s2')] });
    const rows = await __test.resolveBrowseChildren(albumId('al-a'));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.playable && !r.hasChildren)).toBe(true);
  });

  it('album:<id> offline → a PARTIALLY downloaded album lists only its downloaded tracks', async () => {
    // The app greys undownloaded rows out; a car list has no useful disabled state,
    // so it shows only what will actually play. The filter lives in the shared
    // `albumSongs`, so the browse ids stay index-aligned with playback.
    offlineModeStore.setState({ offlineMode: true } as any);
    musicCacheStore.setState({ cachedSongs: { s2: {} } } as any);
    (fetchAlbumDetail as jest.Mock).mockResolvedValueOnce({
      id: 'al-a',
      song: [song('s1'), song('s2'), song('s3')],
    });
    const rows = await __test.resolveBrowseChildren(albumId('al-a'));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('track:album:al-a:0');
  });

  it('album:<id> ONLINE → the full track list, unfiltered', async () => {
    offlineModeStore.setState({ offlineMode: false } as any);
    musicCacheStore.setState({ cachedSongs: {} } as any);
    (fetchAlbumDetail as jest.Mock).mockResolvedValueOnce({
      id: 'al-a',
      song: [song('s1'), song('s2'), song('s3')],
    });
    const rows = await __test.resolveBrowseChildren(albumId('al-a'));
    expect(rows).toHaveLength(3);
  });
});

describe('resolvePlayback', () => {
  it('track:fav:<i> → the full favorites queue at that index', async () => {
    const r = await __test.resolvePlayback(favTrackId(1));
    expect(r.queue.map((c) => c.id)).toEqual(['s1', 's2', 's3']);
    expect(r.startIndex).toBe(1);
    expect(r.sourcePlaylistId).toBeNull();
  });

  it('track:playlist:<id>:<i> → full playlist queue + sourcePlaylistId', async () => {
    (fetchPlaylistDetail as jest.Mock).mockResolvedValueOnce({ entry: [song('s1'), song('s2'), song('s3')] });
    const r = await __test.resolvePlayback('track:playlist:p1:2');
    expect(r.queue).toHaveLength(3);
    expect(r.startIndex).toBe(2);
    expect(r.sourcePlaylistId).toBe('p1');
  });

  it('unknown id → empty queue', async () => {
    const r = await __test.resolvePlayback('bogus');
    expect(r.queue).toEqual([]);
  });
});

/** Flush pending microtasks + one macrotask tick (real timers only). */
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

describe('pushSnapshot — connection gate', () => {
  const tp = require('react-native-queue-player').getTrackPlayer();

  afterEach(() => {
    tp.isCarConnected.mockReturnValue(true);
    tp.setBrowseSnapshot.mockClear();
    tp.donateVoiceVocabulary.mockClear();
  });

  it('builds + pushes the browse snapshot when a car is connected', async () => {
    tp.isCarConnected.mockReturnValue(true);
    tp.setBrowseSnapshot.mockClear();
    await __test.pushSnapshot();
    expect(tp.setBrowseSnapshot).toHaveBeenCalledTimes(1);
  });

  it('skips buildSnapshot/setBrowseSnapshot with no car, but still donates Siri vocab', async () => {
    tp.isCarConnected.mockReturnValue(false);
    tp.setBrowseSnapshot.mockClear();
    tp.donateVoiceVocabulary.mockClear();
    await __test.pushSnapshot();
    expect(tp.setBrowseSnapshot).not.toHaveBeenCalled();
    // Siri vocabulary is phone-side (SiriKit) — never car-gated.
    expect(tp.donateVoiceVocabulary).toHaveBeenCalled();
  });
});

describe('offline flip → snapshot re-push (installHeadlessMediaService subscription)', () => {
  const tp = require('react-native-queue-player').getTrackPlayer();

  beforeEach(() => {
    __test.reset();
    tp.isCarConnected.mockReturnValue(true);
  });
  afterEach(() => {
    __test.reset();
    tp.isCarConnected.mockReturnValue(true);
    tp.setBrowseSnapshot.mockClear();
  });

  it('re-pushes on an offline flip when connected — without any onCarConnect', async () => {
    installHeadlessMediaService();
    await flushAsync(); // settle install-time async pushes
    tp.setBrowseSnapshot.mockClear();

    offlineModeStore.getState().setOfflineMode(true);
    await flushAsync();
    expect(tp.setBrowseSnapshot).toHaveBeenCalled();
  });

  it('does not push on an offline flip when no car is connected', async () => {
    tp.isCarConnected.mockReturnValue(false);
    installHeadlessMediaService();
    await flushAsync();
    tp.setBrowseSnapshot.mockClear();

    offlineModeStore.getState().setOfflineMode(true);
    await flushAsync();
    expect(tp.setBrowseSnapshot).not.toHaveBeenCalled();
  });
});

describe('scheduleRefresh — library-change gate', () => {
  const tp = require('react-native-queue-player').getTrackPlayer();

  beforeEach(() => {
    __test.reset();
    jest.useFakeTimers();
    tp.isCarConnected.mockReturnValue(true);
  });
  afterEach(() => {
    jest.useRealTimers();
    __test.reset();
    tp.isCarConnected.mockReturnValue(true);
    tp.setBrowseSnapshot.mockClear();
  });

  it('coalesces a library change into a push after 30s when connected', async () => {
    installHeadlessMediaService();
    await jest.advanceTimersByTimeAsync(0);
    tp.setBrowseSnapshot.mockClear();

    favoritesStore.setState({ songIds: new Set(['s1']) } as any);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(tp.setBrowseSnapshot).toHaveBeenCalled();
  });

  it('arms a push when the library-updated stamp changes', async () => {
    installHeadlessMediaService();
    await jest.advanceTimersByTimeAsync(0);
    // Assert the install push landed BEFORE clearing: the negative case below depends on
    // that ordering, and advanceTimersByTimeAsync(0) alone does not prove it.
    expect(tp.setBrowseSnapshot).toHaveBeenCalled();
    tp.setBrowseSnapshot.mockClear();

    syncStatusStore.getState().bumpLibraryUpdated();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(tp.setBrowseSnapshot).toHaveBeenCalled();
  });

  it('does NOT arm a push for an unrelated syncStatusStore write', async () => {
    installHeadlessMediaService();
    await jest.advanceTimersByTimeAsync(0);
    expect(tp.setBrowseSnapshot).toHaveBeenCalled();
    // Drain the debounce window first: the headless boot's `rehydrateAllStores` hydrates
    // favouritesStore, which legitimately arms one refresh.
    await jest.advanceTimersByTimeAsync(30_000);
    tp.setBrowseSnapshot.mockClear();

    // A sync writes the cursor constantly; only the library stamp means "data changed".
    syncStatusStore.getState().setLibrarySyncCursor(500);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(tp.setBrowseSnapshot).not.toHaveBeenCalled();
  });

  it('arms a push when the downloaded set changes (the offline tree filters on it)', async () => {
    installHeadlessMediaService();
    await jest.advanceTimersByTimeAsync(0);
    expect(tp.setBrowseSnapshot).toHaveBeenCalled();
    tp.setBrowseSnapshot.mockClear();

    musicCacheStore.setState({ totalFiles: 42, totalBytes: 1234 } as any);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(tp.setBrowseSnapshot).toHaveBeenCalled();
  });

  it('does not arm a refresh when no car is connected', async () => {
    tp.isCarConnected.mockReturnValue(false);
    installHeadlessMediaService();
    await jest.advanceTimersByTimeAsync(0);
    tp.setBrowseSnapshot.mockClear();

    favoritesStore.setState({ songIds: new Set(['s1']) } as any);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(tp.setBrowseSnapshot).not.toHaveBeenCalled();
  });
});
