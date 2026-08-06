/**
 * The four detail-fetch write blocks against the REAL repository layer and real SQL.
 *
 * The file is named for the write mutex it was written to defend — a caller that
 * wrapped a `bulkUpsert` in its own (non-re-entrant) acquire wedged the write chain for
 * the life of the process. The mutex is gone, but this is still the ONLY place these
 * write paths run against the real repository: the sibling `detailFetchService.test.ts`
 * stubs the whole repository layer, so `bulkUpsert` is never reached there. Here only
 * the network and the image cache are stubbed.
 *
 * A regression can HANG rather than fail, so every test carries a short timeout.
 */
import type { Child } from 'subsonic-api';

import {
  fetchAlbumDetail,
  fetchArtistBase,
  fetchArtistTopSongs,
  fetchPlaylistDetail,
} from '../detailFetchService';

const mockGetAlbum = jest.fn();
const mockGetArtist = jest.fn();
const mockGetPlaylist = jest.fn();
const mockGetTopSongs = jest.fn();
jest.mock('../subsonicService', () => ({
  ensureCoverArtAuth: () => Promise.resolve(),
  getAlbum: (id: string) => mockGetAlbum(id),
  getArtist: (id: string) => mockGetArtist(id),
  getArtistInfo2: jest.fn(async () => null),
  getPlaylist: (id: string) => mockGetPlaylist(id),
  getTopSongs: (...a: unknown[]) => mockGetTopSongs(...a),
  getVariousArtistsBio: () => 'VA bio',
  isVariousArtists: () => false,
  VARIOUS_ARTISTS_COVER_ART_ID: 'va',
}));
jest.mock('../musicbrainzService', () => ({
  getArtistBiography: jest.fn(async () => null),
  searchArtistMBID: jest.fn(async () => null),
}));
jest.mock('../imageCacheService', () => ({
  ensureCached: () => Promise.resolve(),
  prefetchCoverArt: jest.fn(),
}));
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: () => ({ offlineMode: false }) },
}));
jest.mock('../../store/ratingStore', () => ({
  ratingStore: { getState: () => ({ reconcileRatings: jest.fn() }) },
}));
jest.mock('../../store/layoutPreferencesStore', () => ({
  layoutPreferencesStore: { getState: () => ({ listLength: 2 }) },
}));
jest.mock('../../store/mbidOverrideStore', () => ({
  getOverride: () => undefined,
  mbidOverrideStore: { getState: () => ({ overrides: {} }) },
}));

// Imported AFTER the mocks so the real modules resolve against them.
import { getDb } from '../../store/persistence/db';
import { getAlbumDetail, getPlaylistDetail } from '../../db/repository/details';

const db = () => getDb()!;

const song = (id: string, albumId?: string): Child =>
  ({ id, title: `Song ${id}`, isDir: false, albumId }) as Child;

/** Every test must finish well inside this; a wedged write never resolves. */
const DEADLINE_MS = 5000;

const count = (table: string, where: string, param: string): number =>
  db().getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, [param])!.n;

beforeEach(() => {
  for (const t of ['albums', 'songs', 'artists', 'playlists']) db().runSync(`DELETE FROM ${t}`);
  mockGetAlbum.mockReset();
  mockGetArtist.mockReset();
  mockGetPlaylist.mockReset();
  mockGetTopSongs.mockReset();
});

describe('detail fetch writes against the real repository', () => {
  it(
    'fetchAlbumDetail writes the album, its songs and the not-in prune',
    async () => {
      mockGetAlbum.mockResolvedValue({
        id: 'al1',
        name: 'Album One',
        created: new Date('2020-01-01'),
        duration: 100,
        songCount: 2,
        song: [song('s1', 'al1'), song('s2', 'al1')],
      });
      // A track the server no longer lists — `deleteAlbumSongsNotIn` must drop it.
      db().runSync('INSERT INTO songs (id, title, album_id) VALUES (?, ?, ?)', [
        'stale',
        'Stale',
        'al1',
      ]);

      const result = await fetchAlbumDetail('al1', { prefetchCovers: false, force: true });

      expect(result?.id).toBe('al1');
      const detail = await getAlbumDetail(db(), 'al1');
      expect(detail?.songs.map((s) => s.id).sort()).toEqual(['s1', 's2']);
    },
    DEADLINE_MS,
  );

  it(
    'fetchArtistBase writes the artist and its albums',
    async () => {
      mockGetArtist.mockResolvedValue({
        id: 'ar1',
        name: 'Band',
        albumCount: 1,
        album: [
          { id: 'al2', name: 'Album Two', created: new Date('2020-01-01'), duration: 1, songCount: 1 },
        ],
      });

      const base = await fetchArtistBase('ar1', { prefetchCovers: false, force: true });

      expect(base?.albums.map((a) => a.id)).toEqual(['al2']);
      expect(count('artists', 'id = ?', 'ar1')).toBe(1);
      expect(count('albums', 'id = ?', 'al2')).toBe(1);
    },
    DEADLINE_MS,
  );

  it(
    'fetchArtistTopSongs writes the songs then the membership',
    async () => {
      mockGetArtist.mockResolvedValue({ id: 'ar2', name: 'Other Band', albumCount: 0 });
      mockGetTopSongs.mockResolvedValue([song('t1'), song('t2')]);

      const row = await fetchArtistTopSongs('ar2', { prefetchCovers: false, force: true });

      expect(row?.songs.map((s) => s.id)).toEqual(['t1', 't2']);
      expect(count('artist_top_songs', 'artist_id = ?', 'ar2')).toBe(2);
    },
    DEADLINE_MS,
  );

  it(
    'fetchPlaylistDetail writes the playlist, its songs and the ordered membership',
    async () => {
      mockGetPlaylist.mockResolvedValue({
        id: 'pl1',
        name: 'Playlist One',
        changed: new Date('2020-01-01'),
        created: new Date('2020-01-01'),
        duration: 0,
        songCount: 2,
        entry: [song('p1'), song('p2')],
      });

      const result = await fetchPlaylistDetail('pl1', { prefetchCovers: false, force: true });

      expect(result?.id).toBe('pl1');
      const detail = await getPlaylistDetail(db(), 'pl1');
      expect(detail?.entry.map((e) => e.id)).toEqual(['p1', 'p2']);
    },
    DEADLINE_MS,
  );
});
