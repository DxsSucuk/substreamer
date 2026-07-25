import type { AlbumID3, ArtistID3, Child, Playlist } from 'subsonic-api';

import { getDb } from '../../../store/persistence/db';
import { ensureNormalizedSchema } from '../../createNormalizedTables';
import { countAlbums, getAlbum, listAlbums, upsertAlbums } from '../albums';
import { countArtists, getArtist, listArtists, upsertArtistInfo, upsertArtists } from '../artists';
import {
  countPlaylists,
  listPlaylistSongIds,
  listPlaylists,
  setPlaylistSongs,
  upsertPlaylists,
} from '../playlists';
import { countSongs, listSongs, listSongsByAlbum, upsertSongs } from '../songs';
import { keysetPageBefore } from '../core';

const db = () => getDb()!;

const album = (id: string, name: string, extra: Partial<AlbumID3> = {}): AlbumID3 => ({
  id,
  name,
  created: new Date('2020-01-01'),
  duration: 100,
  songCount: 10,
  ...extra,
});
const song = (id: string, title: string, extra: Partial<Child> = {}): Child => ({
  id,
  title,
  isDir: false,
  ...extra,
});

const artist = (id: string, name: string, extra: Partial<ArtistID3> = {}): ArtistID3 => ({
  id,
  name,
  albumCount: 1,
  ...extra,
});
const playlist = (id: string, name: string, extra: Partial<Playlist> = {}): Playlist => ({
  id,
  name,
  changed: new Date('2020-01-01'),
  created: new Date('2020-01-01'),
  duration: 0,
  songCount: 0,
  ...extra,
});

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  for (const t of ['albums', 'songs', 'artists', 'playlists']) {
    db().runSync(`DELETE FROM ${t}`);
  }
});

describe('albums repository', () => {
  it('upserts rows + children (id-sorted) and counts them', async () => {
    await upsertAlbums(db(), [
      album('a2', 'Bravo', {
        genres: ['Rock', 'Pop'],
        artists: [{ id: 'ar1', name: 'Band', albumCount: 1 }],
        recordLabels: [{ name: 'Label X' }],
      }),
      album('a1', 'Alpha'),
    ]);
    expect(await countAlbums(db())).toBe(2);

    const genres = db().getAllSync<{ name: string }>(
      "SELECT name FROM album_genres WHERE album_id='a2' ORDER BY pos",
    );
    expect(genres.map((g) => g.name)).toEqual(['Rock', 'Pop']);
    const labels = db().getAllSync<{ name: string }>(
      "SELECT name FROM album_record_labels WHERE album_id='a2'",
    );
    expect(labels.map((l) => l.name)).toEqual(['Label X']);
    expect((await getAlbum(db(), 'a1'))?.name).toBe('Alpha');
  });

  it('keyset-paginates in sort order', async () => {
    await upsertAlbums(db(), [
      album('a1', 'Cherry'),
      album('a2', 'Apple'),
      album('a3', 'Banana'),
      album('a4', 'Date'),
    ]);
    const p1 = await listAlbums(db(), { limit: 2 });
    expect(p1.rows.map((r) => r.name)).toEqual(['Apple', 'Banana']);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listAlbums(db(), { cursor: p1.nextCursor, limit: 2 });
    expect(p2.rows.map((r) => r.name)).toEqual(['Cherry', 'Date']);
    expect(p2.nextCursor).toBeNull();
  });

  it('seeks to a letter and filters favorites', async () => {
    await upsertAlbums(db(), [
      album('a1', 'Apple'),
      album('a2', 'Mango', { starred: new Date() }),
      album('a3', 'Zebra'),
    ]);
    const fromM = await listAlbums(db(), { letter: 'm', limit: 10 });
    expect(fromM.rows.map((r) => r.name)).toEqual(['Mango', 'Zebra']);
    const fav = await listAlbums(db(), { limit: 10, starredOnly: true });
    expect(fav.rows.map((r) => r.name)).toEqual(['Mango']);
  });

  it('re-upsert replaces children without duplicating', async () => {
    await upsertAlbums(db(), [album('a1', 'Alpha', { genres: ['Rock'] })]);
    await upsertAlbums(db(), [album('a1', 'Alpha', { genres: ['Jazz', 'Blues'] })]);
    const genres = db().getAllSync<{ name: string }>(
      "SELECT name FROM album_genres WHERE album_id='a1' ORDER BY pos",
    );
    expect(genres.map((g) => g.name)).toEqual(['Jazz', 'Blues']);
    expect(await countAlbums(db())).toBe(1);
  });

  it('accepts object-shaped genres (real OpenSubsonic ItemGenre), not just strings', async () => {
    await upsertAlbums(db(), [
      // real servers return genres as {name}[] even though our type says string[]
      album('a1', 'Alpha', { genres: [{ name: 'Rock' }, { name: 'Pop' }] as unknown as string[] }),
    ]);
    const genres = db().getAllSync<{ name: string }>(
      "SELECT name FROM album_genres WHERE album_id='a1' ORDER BY pos",
    );
    expect(genres.map((g) => g.name)).toEqual(['Rock', 'Pop']);
  });
});

describe('songs repository', () => {
  it('upserts + A–Z lists + orders album detail by disc/track', async () => {
    await upsertSongs(db(), [
      song('s1', 'Zed', { albumId: 'a1', track: 2, discNumber: 1 }),
      song('s2', 'Ache', { albumId: 'a1', track: 1, discNumber: 1 }),
    ]);
    expect(await countSongs(db())).toBe(2);
    const page = await listSongs(db(), { limit: 10 });
    expect(page.rows.map((r) => r.title)).toEqual(['Ache', 'Zed']);
    const byAlbum = await listSongsByAlbum(db(), 'a1');
    expect(byAlbum.map((r) => r.title)).toEqual(['Ache', 'Zed']);
  });

  it('flattens ReplayGain and stores child genres', async () => {
    await upsertSongs(db(), [
      song('s1', 'Track', {
        genres: ['Rock'],
        replayGain: { trackGain: -6, albumGain: -5, trackPeak: 1, albumPeak: 1, baseGain: 0, fallbackGain: 0 },
      }),
    ]);
    const row = db().getFirstSync<{ rg_track_gain: number }>(
      "SELECT rg_track_gain FROM songs WHERE id='s1'",
    );
    expect(row?.rg_track_gain).toBe(-6);
    const g = db().getAllSync<{ name: string }>("SELECT name FROM song_genres WHERE song_id='s1'");
    expect(g.map((x) => x.name)).toEqual(['Rock']);
  });
});

describe('artists repository', () => {
  it('upserts rows + roles, lists A–Z, and merges bio without clobbering base fields', async () => {
    await upsertArtists(db(), [
      artist('ar2', 'Beatles', { roles: ['artist', 'composer'], coverArt: 'c2' }),
      artist('ar1', 'ABBA'),
    ]);
    expect(await countArtists(db())).toBe(2);

    const roles = db().getAllSync<{ role: string }>(
      "SELECT role FROM artist_roles WHERE artist_id='ar2' ORDER BY pos",
    );
    expect(roles.map((r) => r.role)).toEqual(['artist', 'composer']);

    const page = await listArtists(db(), { limit: 10 });
    expect(page.rows.map((r) => r.name)).toEqual(['ABBA', 'Beatles']);

    // bio merge is a partial upsert — the base field (name) must survive
    upsertArtistInfo(db(), 'ar1', {
      biography: 'Swedish pop',
      similarArtist: [{ id: 'ar2', name: 'Beatles', albumCount: 1 }],
    });
    const full = await getArtist(db(), 'ar1');
    expect(full?.name).toBe('ABBA');
    expect(full?.biography).toBe('Swedish pop');
    const similar = db().getAllSync<{ name: string }>(
      "SELECT name FROM artist_similar WHERE artist_id='ar1'",
    );
    expect(similar.map((s) => s.name)).toEqual(['Beatles']);
  });

  it('filters favorites', async () => {
    await upsertArtists(db(), [
      artist('ar1', 'ABBA', { starred: new Date() }),
      artist('ar2', 'Beatles'),
    ]);
    const fav = await listArtists(db(), { limit: 10, starredOnly: true });
    expect(fav.rows.map((r) => r.name)).toEqual(['ABBA']);
  });
});

describe('playlists repository', () => {
  it('upserts rows + allowed users, lists by name, counts', async () => {
    await upsertPlaylists(db(), [
      playlist('p1', 'Chill', { allowedUser: ['alice', 'bob'], owner: 'me' }),
      playlist('p2', 'Bangers'),
    ]);
    expect(await countPlaylists(db())).toBe(2);
    const users = db().getAllSync<{ username: string }>(
      "SELECT username FROM playlist_allowed_users WHERE playlist_id='p1' ORDER BY pos",
    );
    expect(users.map((u) => u.username)).toEqual(['alice', 'bob']);
    const page = await listPlaylists(db(), { limit: 10 });
    expect(page.rows.map((r) => r.name)).toEqual(['Bangers', 'Chill']);
  });

  it('sets + reads ordered song membership (replace preserves order)', async () => {
    await upsertPlaylists(db(), [playlist('p1', 'Mix')]);
    setPlaylistSongs(db(), 'p1', ['s3', 's1', 's2']);
    expect(await listPlaylistSongIds(db(), 'p1')).toEqual(['s3', 's1', 's2']);
    setPlaylistSongs(db(), 'p1', ['s2', 's3']);
    expect(await listPlaylistSongIds(db(), 'p1')).toEqual(['s2', 's3']);
  });
});

describe('bidirectional keyset paging', () => {
  it('pages backward (keysetPageBefore) so an A–Z jump can scroll both ways', async () => {
    await upsertSongs(
      db(),
      ['Apple', 'Boat', 'Car', 'Duck', 'Egg'].map((t, i) => song(`s${i}`, t)),
    );
    // forward into the middle of the list
    const p1 = await listSongs(db(), { limit: 2 }); // Apple, Boat
    const p2 = await listSongs(db(), { cursor: p1.nextCursor, limit: 2 }); // Car, Duck
    expect(p2.rows.map((r) => r.title)).toEqual(['Car', 'Duck']);

    // now page BACKWARD from the first row of p2 (before 'Car')
    const back = await keysetPageBefore<{ id: string; title: string; sort_title: string }>(db(), {
      table: 'songs',
      sortCol: 'sort_title',
      columns: '"id", "title", "sort_title"',
      limit: 2,
      before: { sortKey: p2.rows[0].sort_title ?? '', id: p2.rows[0].id },
      sortKeyOf: (r) => r.sort_title,
    });
    expect(back.rows.map((r) => r.title)).toEqual(['Apple', 'Boat']); // ascending
    expect(back.prevCursor).toBeNull(); // reached the start
  });
});
