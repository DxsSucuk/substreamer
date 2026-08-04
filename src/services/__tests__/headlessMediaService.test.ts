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
import { syncStatusStore } from '../../store/syncStatusStore';
import { getDb } from '../../store/persistence/db';
import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { upsertAlbums } from '../../db/repository/albums';
import { upsertPlaylists } from '../../db/repository/playlists';

const album = (id: string, name: string) => ({ id, name, artist: 'Artist' } as any);
const song = (id: string) => ({ id, title: `Song ${id}`, artist: 'Artist', albumId: 'al-1' } as any);
const playlist = (id: string, name: string) => ({ id, name, songCount: 3 } as any);

const db = () => getDb()!;
beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(async () => {
  offlineModeStore.setState({ offlineMode: false } as any);
  musicCacheStore.setState({ cachedItems: {}, cachedSongs: {} } as any);
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
  favoritesStore.setState({
    songs: [song('s1'), song('s2'), song('s3')],
    albums: [],
    artists: [],
  } as any);
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

    favoritesStore.setState({ songs: [song('s1')], albums: [], artists: [] } as any);
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

    favoritesStore.setState({ songs: [song('s1')], albums: [], artists: [] } as any);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(tp.setBrowseSnapshot).not.toHaveBeenCalled();
  });
});
