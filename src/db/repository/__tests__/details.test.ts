/**
 * Normalized detail reads (`getAlbumDetail`/`getArtistDetail`/`getPlaylistDetail`) —
 * the relationship queries that replace the legacy detail blob stores. Run against the
 * real better-sqlite3-backed DB (real SQL, real joins).
 */
import type { AlbumID3, ArtistID3, ArtistInfo2, Child, Playlist } from 'subsonic-api';

import { getDb } from '../../../store/persistence/db';
import { ensureNormalizedSchema } from '../../createNormalizedTables';
import { upsertAlbums } from '../albums';
import { setArtistDetailMeta, setArtistTopSongs, upsertArtistInfo, upsertArtists } from '../artists';
import { setPlaylistSongs, upsertPlaylists } from '../playlists';
import { upsertSongs } from '../songs';
import { getAlbumDetail, getArtistDetail, getPlaylistDetail } from '../details';

const db = () => getDb()!;

const album = (id: string, name: string, extra: Partial<AlbumID3> = {}): AlbumID3 => ({
  id, name, created: new Date('2020-01-01'), duration: 100, songCount: 2, ...extra,
});
const song = (id: string, title: string, extra: Partial<Child> = {}): Child => ({
  id, title, isDir: false, ...extra,
});
const artist = (id: string, name: string, extra: Partial<ArtistID3> = {}): ArtistID3 => ({
  id, name, albumCount: 0, ...extra,
});
const playlist = (id: string, name: string, extra: Partial<Playlist> = {}): Playlist => ({
  id, name, created: new Date('2020-01-01'), changed: new Date('2020-01-01'), duration: 0, songCount: 0, ...extra,
});

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  for (const t of [
    'albums',
    'songs',
    'artists',
    'playlists',
    'playlist_songs',
    'artist_similar',
    'artist_top_songs',
  ]) {
    db().runSync(`DELETE FROM ${t}`);
  }
});

describe('getAlbumDetail', () => {
  it('returns the album + its songs in disc/track order', async () => {
    await upsertAlbums(db(), [album('al1', 'Abbey Road', { artist: 'The Beatles', artistId: 'ar1', year: 1969 })]);
    await upsertSongs(db(), [
      song('s2', 'Something', { albumId: 'al1', discNumber: 1, track: 2, artist: 'The Beatles' }),
      song('s1', 'Come Together', { albumId: 'al1', discNumber: 1, track: 1, artist: 'The Beatles' }),
      song('sx', 'Other', { albumId: 'alX', track: 1 }),
    ]);

    const detail = await getAlbumDetail(db(), 'al1');
    expect(detail?.album.name).toBe('Abbey Road');
    expect(detail?.album.artistId).toBe('ar1');
    expect(detail?.album.year).toBe(1969);
    expect(detail?.songs.map((s) => s.id)).toEqual(['s1', 's2']); // track order, album-scoped
  });

  it('returns null for an un-synced album', async () => {
    expect(await getAlbumDetail(db(), 'nope')).toBeNull();
  });
});

describe('getArtistDetail', () => {
  it('returns the artist + its albums (newest first) + similar + bio + topSongs', async () => {
    await upsertArtists(db(), [artist('ar1', 'The Beatles', { albumCount: 2 })]);
    await upsertAlbums(db(), [
      album('al1', 'Please Please Me', { artistId: 'ar1', year: 1963 }),
      album('al2', 'Abbey Road', { artistId: 'ar1', year: 1969 }),
      album('alX', 'Not Theirs', { artistId: 'ar2', year: 1970 }),
    ]);
    upsertArtistInfo(db(), 'ar1', {
      biography: 'The Beatles were an English rock band.',
      similarArtist: [{ id: 'ar9', name: 'The Rolling Stones', albumCount: 1, coverArt: 'ca9' }],
    } as ArtistInfo2);
    // Persist top songs (junction) + resolved bio meta.
    await upsertSongs(db(), [song('t1', 'Hey Jude'), song('t2', 'Let It Be')]);
    await setArtistTopSongs(db(), 'ar1', ['t2', 't1']); // deliberate non-id order
    await setArtistDetailMeta(db(), 'ar1', {
      biography: 'Resolved bio.',
      bioCheckedAt: 42,
      resolvedMbid: 'mbid-beatles',
    });

    const detail = await getArtistDetail(db(), 'ar1');
    expect(detail?.artist.name).toBe('The Beatles');
    expect(detail?.albums.map((a) => a.id)).toEqual(['al2', 'al1']); // year DESC (newest first)
    expect(detail?.biography).toBe('Resolved bio.'); // detail meta wins
    expect(detail?.bioCheckedAt).toBe(42);
    expect(detail?.resolvedMbid).toBe('mbid-beatles');
    expect(detail?.similarArtist.map((s) => ({ id: s.id, name: s.name, coverArt: s.coverArt, albumCount: s.albumCount })))
      .toEqual([{ id: 'ar9', name: 'The Rolling Stones', coverArt: 'ca9', albumCount: 1 }]);
    expect(detail?.topSongs.map((s) => s.id)).toEqual(['t2', 't1']); // junction position order
  });

  it('returns null for an un-synced artist', async () => {
    expect(await getArtistDetail(db(), 'nope')).toBeNull();
  });
});

describe('getPlaylistDetail', () => {
  it('returns the playlist + its tracks in membership (position) order', async () => {
    await upsertPlaylists(db(), [
      playlist('p1', 'Roadtrip', { owner: 'dave', comment: 'summer', public: true, songCount: 2, duration: 400 }),
    ]);
    await upsertSongs(db(), [
      song('s1', 'First', { artist: 'A' }),
      song('s2', 'Second', { artist: 'B' }),
    ]);
    setPlaylistSongs(db(), 'p1', ['s2', 's1']); // deliberate non-id order

    const detail = await getPlaylistDetail(db(), 'p1');
    expect(detail?.playlist.name).toBe('Roadtrip');
    expect(detail?.playlist.owner).toBe('dave');
    expect(detail?.playlist.comment).toBe('summer');
    expect(detail?.entry.map((e) => e.id)).toEqual(['s2', 's1']); // position order, not id order
  });

  it('returns null for an un-synced playlist', async () => {
    expect(await getPlaylistDetail(db(), 'nope')).toBeNull();
  });
});
