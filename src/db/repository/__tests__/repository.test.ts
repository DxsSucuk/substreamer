import type { AlbumID3, ArtistInfo2, ArtistID3, Child, Playlist } from 'subsonic-api';

import { getDb } from '../../../store/persistence/db';
import { ensureNormalizedSchema } from '../../createNormalizedTables';
import {
  ALBUM_LIST_COLS,
  albumCursorOf,
  albumIdsPresent,
  albumListRowToAlbumID3,
  countAlbums,
  getAlbum,
  listAlbums,
  listAlbumsBefore,
  listAllAlbums,
  clearAlbumInfo,
  getAlbumInfoRow,
  upsertAlbumInfoRow,
  upsertAlbums,
} from '../albums';
import {
  ARTIST_LIST_COLS,
  artistCursorOf,
  artistListRowToArtistID3,
  countArtists,
  deleteArtistsNotIn,
  getArtist,
  listArtists,
  listArtistsBefore,
  listArtistsByIds,
  upsertArtistInfo,
  upsertArtists,
} from '../artists';
import {
  PLAYLIST_LIST_COLS,
  clearPlaylistDetailMarkers,
  countPlaylists,
  listAllPlaylists,
  listPlaylistDetailState,
  stampPlaylistDetailSynced,
  deletePlaylist,
  deletePlaylistsNotIn,
  listPlaylistSongIds,
  listPlaylists,
  listPlaylistsBefore,
  playlistCursorOf,
  playlistListRowToPlaylist,
  setPlaylistSongs,
  upsertPlaylists,
} from '../playlists';
import {
  SONG_LIST_COLS,
  countSongs,
  deleteAlbumSongsNotIn,
  listSongs,
  songListRowToChild,
  listSongsBefore,
  songCursorOf,
  upsertSongs,
  type SongListRow,
} from '../songs';
import { keysetPageBefore } from '../core';
import { getAlbumDetail } from '../details';
import { searchAlbums, searchArtists, searchSongs } from '../search';

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

  it('sorts by artist (compound key) — groups by artist then album title, both directions', async () => {
    await upsertAlbums(db(), [
      album('a1', 'Revolver', { artist: 'The Beatles' }),
      album('a2', 'Abbey Road', { artist: 'The Beatles' }),
      album('a3', 'Waterloo', { artist: 'ABBA' }),
      album('a4', 'Arrival', { artist: 'ABBA' }),
    ]);
    // "The" is stripped → ABBA (abba) before Beatles (beatles); within each
    // artist, albums order by title.
    const full = await listAlbums(db(), { limit: 10, sortOrder: 'artist' });
    expect(full.rows.map((r) => r.name)).toEqual(['Arrival', 'Waterloo', 'Abbey Road', 'Revolver']);

    // forward paging keeps the same order across the page boundary
    const p1 = await listAlbums(db(), { limit: 2, sortOrder: 'artist' });
    expect(p1.rows.map((r) => r.name)).toEqual(['Arrival', 'Waterloo']);
    const p2 = await listAlbums(db(), { cursor: p1.nextCursor, limit: 2, sortOrder: 'artist' });
    expect(p2.rows.map((r) => r.name)).toEqual(['Abbey Road', 'Revolver']);
    expect(p2.nextCursor).toBeNull();

    // backward paging from the first row of p2 recovers p1
    const back = await listAlbumsBefore(db(), {
      before: albumCursorOf(p2.rows[0], 'artist'),
      limit: 2,
      sortOrder: 'artist',
    });
    expect(back.rows.map((r) => r.name)).toEqual(['Arrival', 'Waterloo']);

    // A–Z seek on the artist primary key ('a' → ABBA albums first)
    const fromA = await listAlbums(db(), { letter: 'a', limit: 10, sortOrder: 'artist' });
    expect(fromA.rows.map((r) => r.name)).toEqual(['Arrival', 'Waterloo', 'Abbey Road', 'Revolver']);
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

  it('maps a projected row to AlbumID3, array children and all', async () => {
    await upsertAlbums(db(), [
      album('a1', 'Abbey Road', {
        artist: 'The Beatles',
        artistId: 'ar1',
        year: 1969,
        playCount: 4,
        version: 'Remaster',
        musicBrainzId: 'mb-a1',
        isCompilation: false,
        explicitStatus: 'clean',
        originalReleaseDate: { year: 1969, month: 9, day: 26 },
        genres: ['Rock', 'Folk, World, & Country'],
        artists: [{ id: 'ar1', name: 'The Beatles', albumCount: 0 }],
        recordLabels: [{ name: 'Apple' }],
        releaseTypes: ['album'],
        moods: ['upbeat'],
        discTitles: [
          { disc: 2, title: 'Side B' },
          { disc: 1, title: 'Side A' },
        ],
      }),
    ]);
    const a = albumListRowToAlbumID3((await listAlbums(db(), { limit: 1 })).rows[0]);
    expect(a).toMatchObject({
      id: 'a1',
      name: 'Abbey Road',
      artist: 'The Beatles',
      artistId: 'ar1',
      year: 1969,
      playCount: 4,
      version: 'Remaster',
      musicBrainzId: 'mb-a1',
      isCompilation: false,
      explicitStatus: 'clean',
      genres: ['Rock', 'Folk, World, & Country'],
      recordLabels: [{ name: 'Apple' }],
      releaseTypes: ['album'],
      moods: ['upbeat'],
    });
    expect(a.originalReleaseDate).toEqual({ year: 1969, month: 9, day: 26 });
    expect(a.created).toEqual(new Date('2020-01-01'));
    // Disc titles are keyed (album_id, disc), so they come back in disc order.
    expect(a.discTitles).toEqual([
      { disc: 1, title: 'Side A' },
      { disc: 2, title: 'Side B' },
    ]);
  });

  it('leaves `created` undefined rather than defaulting to the epoch', async () => {
    // `new Date(0)` is truthy, so the details sheet rendered "Added 1 January 1970"
    // instead of omitting the row.
    db().runSync("INSERT INTO albums (id, name, sort_title) VALUES ('a9', 'Undated', 'undated')");
    const row = (await listAlbums(db(), { limit: 10 })).rows.find((r) => r.id === 'a9');
    expect(albumListRowToAlbumID3(row!).created).toBeUndefined();
  });

  it('omits empty array children and keeps per-row hydration correct across a page', async () => {
    await upsertAlbums(db(), [
      album('a1', 'Alpha', { genres: ['Rock'] }),
      album('a2', 'Bravo'),
    ]);
    const rows = (await listAlbums(db(), { limit: 10 })).rows;
    expect(rows.map((r) => r.genres)).toEqual([['Rock'], undefined]);
    expect(rows.every((r) => r.moods === undefined)).toBe(true);
  });

  it('albumIdsPresent answers presence without fetching a row', async () => {
    await upsertAlbums(db(), [album('a1', 'Alpha'), album('a2', 'Bravo')]);
    expect([...(await albumIdsPresent(db(), ['a1', 'a3']))]).toEqual(['a1']);
    expect((await albumIdsPresent(db(), [])).size).toBe(0);
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
  it('the list projection carries every field a consumer downstream reads', async () => {
    // The lean projection dropped most of these, and each omission surfaced as a
    // consumer silently rendering less: `artistId` gated 'Go to artist' and 'More by
    // this artist', `suffix`/`bitRate` emptied the details sheets, `genre`/`year`
    // scrobbled NULL.
    await upsertSongs(db(), [
      song('s1', 'Song', {
        artistId: 'ar1',
        albumId: 'al1',
        suffix: 'flac',
        bitRate: 1411,
        bitDepth: 16,
        samplingRate: 44100,
        size: 12345,
        contentType: 'audio/flac',
        genre: 'Rock',
        year: 1994,
        playCount: 3,
        path: 'Artist/Album/01.flac',
        musicBrainzId: 'mb-s1',
        comment: 'a note',
        bpm: 120,
        replayGain: { trackGain: -6.5 } as Child['replayGain'],
      }),
    ]);
    const page = await listSongs(db(), { limit: 10 });
    const c = songListRowToChild(page.rows[0]);
    expect(c).toMatchObject({
      id: 's1',
      artistId: 'ar1',
      albumId: 'al1',
      suffix: 'flac',
      bitRate: 1411,
      bitDepth: 16,
      samplingRate: 44100,
      size: 12345,
      contentType: 'audio/flac',
      genre: 'Rock',
      year: 1994,
      playCount: 3,
      path: 'Artist/Album/01.flac',
      musicBrainzId: 'mb-s1',
      comment: 'a note',
      bpm: 120,
    });
    // A ReplayGain member the server never sent stays ABSENT — a fabricated 0 would
    // print as a real 0.0 dB in the track details sheet.
    expect(c.replayGain?.trackGain).toBe(-6.5);
    expect(c.replayGain?.albumGain).toBeUndefined();
  });

  it('never defaults `created` to the epoch (the "Added 1 January 1970" bug)', async () => {
    await upsertSongs(db(), [song('s1', 'Dated', { created: new Date('2021-03-04') })]);
    await upsertSongs(db(), [song('s2', 'Undated')]);
    const rows = (await listSongs(db(), { limit: 10 })).rows;
    const byId = Object.fromEntries(rows.map((r) => [r.id, songListRowToChild(r)]));
    expect(byId.s1.created?.getTime()).toBe(new Date('2021-03-04').getTime());
    expect(byId.s2.created).toBeUndefined();
  });

  it('round-trips the array children in order, commas and all', async () => {
    await upsertSongs(db(), [
      song('s1', 'Track', {
        // A single genre name that itself contains commas — it must survive as ONE
        // element, which a joined-string column could not express.
        genres: ['Folk, World, & Country', 'Rock'],
        artists: [
          { id: 'ar2', name: 'Second', albumCount: 0 },
          { id: 'ar1', name: 'First', albumCount: 0 },
        ],
        albumArtists: [{ id: 'aa1', name: 'Album Artist', albumCount: 0 }],
        contributors: [
          { role: 'composer', subRole: 'lyrics', artist: { id: 'c1', name: 'Writer', albumCount: 0 } },
          { role: 'producer' },
        ],
        moods: ['mellow', 'brooding'],
      }),
    ]);
    const c = songListRowToChild((await listSongs(db(), { limit: 10 })).rows[0]);
    expect(c.genres).toEqual(['Folk, World, & Country', 'Rock']);
    // Server order, not id order.
    expect(c.artists?.map((a) => a.id)).toEqual(['ar2', 'ar1']);
    expect(c.albumArtists?.map((a) => a.name)).toEqual(['Album Artist']);
    expect(c.contributors?.[0]).toEqual({
      role: 'composer',
      subRole: 'lyrics',
      // A reference stub: the child table holds no album count of its own.
      artist: { id: 'c1', name: 'Writer', albumCount: 0 },
    });
    // A contributor with no artist keeps the role and omits the artist entirely.
    expect(c.contributors?.[1]).toEqual({ role: 'producer', subRole: undefined, artist: undefined });
    expect(c.moods).toEqual(['mellow', 'brooding']);
  });

  it('omits an empty array child rather than materialising []', async () => {
    // Most songs have one genre and no contributors; `getGenreNames` and friends test
    // `.length > 0`, so absent and empty read identically — absent costs nothing.
    await upsertSongs(db(), [song('s1', 'Bare')]);
    const row = (await listSongs(db(), { limit: 10 })).rows[0];
    expect(row.genres).toBeUndefined();
    expect(row.contributors).toBeUndefined();
    expect(songListRowToChild(row).moods).toBeUndefined();
  });

  it('hydrates children for a whole page in one query per table, keyed per row', async () => {
    await upsertSongs(db(), [
      song('s1', 'Alpha', { genres: ['Rock'], moods: ['loud'] }),
      song('s2', 'Bravo', { genres: ['Jazz', 'Blues'] }),
      song('s3', 'Charlie'),
    ]);
    const rows = (await listSongs(db(), { limit: 10 })).rows;
    expect(rows.map((r) => r.genres)).toEqual([['Rock'], ['Jazz', 'Blues'], undefined]);
    expect(rows.map((r) => r.moods)).toEqual([['loud'], undefined, undefined]);
  });


  it('upserts + A–Z lists + orders album detail by disc/track', async () => {
    await upsertAlbums(db(), [album('a1', 'Alpha')]);
    await upsertSongs(db(), [
      song('s1', 'Zed', { albumId: 'a1', track: 2, discNumber: 1 }),
      song('s2', 'Ache', { albumId: 'a1', track: 1, discNumber: 1 }),
    ]);
    expect(await countSongs(db())).toBe(2);
    const page = await listSongs(db(), { limit: 10 });
    expect(page.rows.map((r) => r.title)).toEqual(['Ache', 'Zed']);
    // Track order comes from the album detail read (disc, then track) — the songs
    // above are deliberately upserted in the opposite order.
    const detail = await getAlbumDetail(db(), 'a1');
    expect(detail?.songs.map((s) => s.title)).toEqual(['Ache', 'Zed']);
  });

  it('sorts by artist (compound key) — groups by artist then title, both directions', async () => {
    await upsertSongs(db(), [
      song('s1', 'Yesterday', { artist: 'The Beatles' }),
      song('s2', 'Come Together', { artist: 'The Beatles' }),
      song('s3', 'Dancing Queen', { artist: 'ABBA' }),
      song('s4', 'Mamma Mia', { artist: 'ABBA' }),
    ]);
    // title mode: flat A–Z by song title
    const byTitle = await listSongs(db(), { limit: 10, sortOrder: 'title' });
    expect(byTitle.rows.map((r) => r.title)).toEqual([
      'Come Together',
      'Dancing Queen',
      'Mamma Mia',
      'Yesterday',
    ]);

    // artist mode: "The" stripped → ABBA before Beatles; within artist, by title
    const byArtist = await listSongs(db(), { limit: 10, sortOrder: 'artist' });
    expect(byArtist.rows.map((r) => r.title)).toEqual([
      'Dancing Queen',
      'Mamma Mia',
      'Come Together',
      'Yesterday',
    ]);

    // forward paging across the boundary, then backward recovers the first page
    const p1 = await listSongs(db(), { limit: 2, sortOrder: 'artist' });
    expect(p1.rows.map((r) => r.title)).toEqual(['Dancing Queen', 'Mamma Mia']);
    const p2 = await listSongs(db(), { cursor: p1.nextCursor, limit: 2, sortOrder: 'artist' });
    expect(p2.rows.map((r) => r.title)).toEqual(['Come Together', 'Yesterday']);
    const back = await listSongsBefore(db(), {
      before: songCursorOf(p2.rows[0], 'artist'),
      limit: 2,
      sortOrder: 'artist',
    });
    expect(back.rows.map((r) => r.title)).toEqual(['Dancing Queen', 'Mamma Mia']);
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

    // Info lives in its own table now, so it cannot clobber the base row at all.
    upsertArtistInfo(
      db(),
      'ar1',
      {
        biography: 'Swedish pop',
        lastFmUrl: null,
        musicBrainzId: null,
        imageUrlSmall: null,
        imageUrlMedium: null,
        imageUrlLarge: null,
        retrievedAt: 1,
      },
      { similarArtist: [{ id: 'ar2', name: 'Beatles', albumCount: 1 }] } as ArtistInfo2,
    );
    const full = await getArtist(db(), 'ar1');
    expect(full?.name).toBe('ABBA');
    const info = db().getFirstSync<{ biography: string }>(
      "SELECT biography FROM artist_info WHERE artist_id='ar1'",
    );
    expect(info?.biography).toBe('Swedish pop');
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

  it('strips articles in the sort key and pages backward', async () => {
    await upsertArtists(db(), [
      artist('ar1', 'The Beatles'),
      artist('ar2', 'ABBA'),
      artist('ar3', 'Zombies'),
    ]);
    // "The" stripped → ABBA (abba), Beatles (beatles), Zombies (zombies)
    const p1 = await listArtists(db(), { limit: 2 });
    expect(p1.rows.map((r) => r.name)).toEqual(['ABBA', 'The Beatles']);
    const p2 = await listArtists(db(), { cursor: p1.nextCursor, limit: 2 });
    expect(p2.rows.map((r) => r.name)).toEqual(['Zombies']);
    // backward from the first row of p2 recovers p1
    const back = await listArtistsBefore(db(), { before: artistCursorOf(p2.rows[0]), limit: 2 });
    expect(back.rows.map((r) => r.name)).toEqual(['ABBA', 'The Beatles']);
  });

  it('maps a projected row to ArtistID3, roles and all', async () => {
    await upsertArtists(db(), [
      artist('ar1', 'Radiohead', {
        coverArt: 'c1',
        albumCount: 9,
        artistImageUrl: 'https://img/ar1',
        musicBrainzId: 'mb-ar1',
        sortName: 'Radiohead',
        roles: ['artist', 'albumartist'],
      }),
    ]);
    const page = await listArtists(db(), { limit: 1 });
    const a = artistListRowToArtistID3(page.rows[0]);
    expect(a).toMatchObject({
      id: 'ar1',
      name: 'Radiohead',
      coverArt: 'c1',
      albumCount: 9,
      artistImageUrl: 'https://img/ar1',
      musicBrainzId: 'mb-ar1',
      sortName: 'Radiohead',
      roles: ['artist', 'albumartist'],
    });
  });

  it('listArtistsByIds returns full rows for a set of ids (downloaded-artist hydrate)', async () => {
    await upsertArtists(db(), [
      artist('ar1', 'ABBA', { albumCount: 3, roles: ['artist'] }),
      artist('ar2', 'Beatles', { albumCount: 12 }),
      artist('ar3', 'Cure'),
    ]);
    const rows = await listArtistsByIds(db(), ['ar1', 'ar3', 'missing']);
    expect(rows.map((r) => r.id).sort()).toEqual(['ar1', 'ar3']);
    // The by-ids read hydrates children too — it feeds offline search, not a lean list.
    expect(rows.find((r) => r.id === 'ar1')?.roles).toEqual(['artist']);
    expect(rows.find((r) => r.id === 'ar3')?.roles).toBeUndefined();
    expect(await listArtistsByIds(db(), [])).toEqual([]);
  });
});

describe('playlists repository', () => {
  it('upserts rows + allowed users, article-stripped A–Z, letter seek, counts', async () => {
    await upsertPlaylists(db(), [
      playlist('p1', 'Chill', {
        allowedUser: ['alice', 'bob'],
        owner: 'me',
        duration: 120,
        songCount: 5,
        comment: 'summer mix',
        public: true,
      }),
      playlist('p2', 'Bangers'),
      playlist('p3', 'The Best Of'), // "The" stripped → sorts under B (between Bangers and Chill)
    ]);
    expect(await countPlaylists(db())).toBe(3);
    const users = db().getAllSync<{ username: string }>(
      "SELECT username FROM playlist_allowed_users WHERE playlist_id='p1' ORDER BY pos",
    );
    expect(users.map((u) => u.username)).toEqual(['alice', 'bob']);
    // article-stripped: bangers, best of, chill
    const page = await listPlaylists(db(), { limit: 10 });
    expect(page.rows.map((r) => r.name)).toEqual(['Bangers', 'The Best Of', 'Chill']);
    // the projection carries everything the row/card + detail header render
    const chill = page.rows.find((r) => r.name === 'Chill');
    expect(playlistListRowToPlaylist(chill!)).toMatchObject({
      name: 'Chill',
      duration: 120,
      songCount: 5,
      owner: 'me',
      comment: 'summer mix',
      public: true,
      created: new Date('2020-01-01'),
      changed: new Date('2020-01-01'),
    });
    // A–Z letter seek on 'c'
    const fromC = await listPlaylists(db(), { letter: 'c', limit: 10 });
    expect(fromC.rows.map((r) => r.name)).toEqual(['Chill']);
  });

  it('leaves created/changed undefined rather than defaulting to the epoch', async () => {
    // `new Date(0)` is truthy, so the epoch default rendered as a real "1 January 1970"
    // rather than being omitted.
    db().runSync("INSERT INTO playlists (id, name, sort_title) VALUES ('p9', 'Undated', 'undated')");
    const row = (await listPlaylists(db(), { limit: 10 })).rows.find((r) => r.id === 'p9');
    const pl = playlistListRowToPlaylist(row!);
    expect(pl.created).toBeUndefined();
    expect(pl.changed).toBeUndefined();
  });

  it('pages backward and prunes/deletes', async () => {
    await upsertPlaylists(db(), [
      playlist('p1', 'Alpha'),
      playlist('p2', 'Bravo'),
      playlist('p3', 'Charlie'),
    ]);
    const p1 = await listPlaylists(db(), { limit: 2 });
    const p2 = await listPlaylists(db(), { cursor: p1.nextCursor, limit: 2 });
    expect(p2.rows.map((r) => r.name)).toEqual(['Charlie']);
    const back = await listPlaylistsBefore(db(), { before: playlistCursorOf(p2.rows[0]), limit: 2 });
    expect(back.rows.map((r) => r.name)).toEqual(['Alpha', 'Bravo']);

    await deletePlaylist(db(), 'p2');
    expect(await countPlaylists(db())).toBe(2);
    // prune keeps only the given ids
    await deletePlaylistsNotIn(db(), ['p1']);
    const rest = await listPlaylists(db(), { limit: 10 });
    expect(rest.rows.map((r) => r.name)).toEqual(['Alpha']);
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

describe('search (tiered candidate generation)', () => {
  it('matches exact / prefix / infix over the normalized norm_* columns', async () => {
    await upsertSongs(db(), [
      song('s1', 'Hey Jude', { artist: 'The Beatles' }),
      song('s2', 'Hey There Delilah', { artist: 'Plain White Ts' }),
      song('s3', 'Jude Law Biography', { artist: 'Someone' }),
    ]);

    // exact norm_title
    expect((await searchSongs(db(), 'hey jude', ['hey', 'jude'], [])).map((r) => r.id)).toContain('s1');
    // prefix 'hey' → both hey* titles
    expect(
      (await searchSongs(db(), 'hey', ['hey'], [])).map((r) => r.title).sort(),
    ).toEqual(['Hey Jude', 'Hey There Delilah']);
    // infix token 'jude' → titles containing jude
    expect(
      (await searchSongs(db(), 'jude', ['jude'], [])).map((r) => r.title).sort(),
    ).toEqual(['Hey Jude', 'Jude Law Biography']);
    // empty query short-circuits
    expect(await searchSongs(db(), '', [], [])).toEqual([]);
  });

  it('searches albums + artists over their norm columns', async () => {
    await upsertAlbums(db(), [album('al1', 'Abbey Road'), album('al2', 'Let It Be')]);
    await upsertArtists(db(), [artist('ar1', 'Abba'), artist('ar2', 'Beatles')]);
    expect((await searchAlbums(db(), 'abbey', ['abbey'], [])).map((r) => r.name)).toEqual(['Abbey Road']);
    expect((await searchArtists(db(), 'abba', ['abba'], [])).map((r) => r.name)).toEqual(['Abba']);
  });
});

describe('projection totality (the widened reads select every column)', () => {
  /** The columns a projection string actually names. */
  const projected = (cols: string): string[] => cols.split(', ').map((c) => c.replace(/"/g, ''));

  /** The table's real columns minus the internal derivatives, which deliberately have
   *  no API counterpart: the `norm_*`/`dmeta_*` accent-folded search copies, and
   *  `playlists.detail_*`, whose own read is `listPlaylistDetailState`. */
  const apiColumns = (table: string): string[] =>
    db()
      .getAllSync<{ name: string }>(`PRAGMA table_info(${table})`)
      .map((c) => c.name)
      .filter((n) => !/^(norm_|dmeta_|detail_)/.test(n));

  // The failure this guards: a column added to the schema but not to the field list
  // is `undefined` at runtime with no type error — the bug class that shipped three
  // times (artistId, sortName, suffix/bitRate).
  it.each([
    ['songs', () => SONG_LIST_COLS],
    ['albums', () => ALBUM_LIST_COLS],
    ['artists', () => ARTIST_LIST_COLS],
    ['playlists', () => PLAYLIST_LIST_COLS],
  ])('%s: the projection names every non-derivative column', (table, cols) => {
    expect(projected(cols()).sort()).toEqual(apiColumns(table).sort());
  });

  it('the whole-table browse reads stay NARROW (they have no LIMIT)', async () => {
    // `listAllAlbums`/`listAllPlaylists` run over every row in the table on the
    // headless boot path. Widening them would mean ~28 columns plus six child-table
    // hydrations per row at a ~200k-album target.
    await upsertAlbums(db(), [album('a1', 'Alpha', { artist: 'Band', genres: ['Rock'] })]);
    await upsertPlaylists(db(), [playlist('p1', 'Mix', { owner: 'me', comment: 'c' })]);

    const [albumRow] = await listAllAlbums(db());
    expect(Object.keys(albumRow).sort()).toEqual(['cover_art', 'display_artist', 'id', 'name']);
    const [playlistRow] = await listAllPlaylists(db());
    expect(Object.keys(playlistRow).sort()).toEqual(['cover_art', 'id', 'name', 'song_count']);
  });
});

describe('schema completeness (all typed metadata captured)', () => {
  it('stores the Child video/folder fields (parent, originalWidth/Height, isDir)', async () => {
    await upsertSongs(db(), [
      song('v1', 'Clip', { parent: 'folder9', originalWidth: 1920, originalHeight: 1080, isDir: false, isVideo: true }),
    ]);
    const row = db().getFirstSync<{
      parent: string; original_width: number; original_height: number; is_dir: number; is_video: number;
    }>('SELECT parent, original_width, original_height, is_dir, is_video FROM songs WHERE id = ?', ['v1']);
    expect(row).toEqual({ parent: 'folder9', original_width: 1920, original_height: 1080, is_dir: 0, is_video: 1 });
  });

  it('stores album info in its own row without touching the album', async () => {
    await upsertAlbums(db(), [album('al9', 'Kind of Blue', { artist: 'Miles Davis' })]);
    await upsertAlbumInfoRow(db(), 'al9', {
      notes: 'A landmark album.',
      lastFmUrl: 'https://last.fm/al9',
      musicBrainzId: 'mb-9',
      imageUrlSmall: null,
      imageUrlMedium: null,
      imageUrlLarge: 'l.jpg',
      enrichedNotes: 'From Wikipedia.',
      enrichedNotesUrl: 'https://en.wikipedia.org/al9',
      overrideMbid: 'rg-9',
      retrievedAt: 1234,
    });

    const info = await getAlbumInfoRow(db(), 'al9');
    expect(info?.notes).toBe('A landmark album.');
    // The enrichment + override + timestamp are exactly what the old album columns
    // could not hold — the reason this is its own table.
    expect(info?.enrichedNotes).toBe('From Wikipedia.');
    expect(info?.overrideMbid).toBe('rg-9');
    expect(info?.retrievedAt).toBe(1234);
    const row = (await getAlbum(db(), 'al9')) as Record<string, unknown>;
    expect(row.name).toBe('Kind of Blue');
  });

  it('cascades album info away with its album, and clears on demand', async () => {
    const blank = {
      notes: null, lastFmUrl: null, musicBrainzId: null,
      imageUrlSmall: null, imageUrlMedium: null, imageUrlLarge: null,
      enrichedNotes: null, enrichedNotesUrl: null, overrideMbid: null, retrievedAt: 1,
    };
    await upsertAlbums(db(), [album('al1', 'A'), album('al2', 'B')]);
    await upsertAlbumInfoRow(db(), 'al1', blank);
    await upsertAlbumInfoRow(db(), 'al2', blank);

    db().runSync("DELETE FROM albums WHERE id = 'al1'");
    expect(await getAlbumInfoRow(db(), 'al1')).toBeNull();
    expect(await getAlbumInfoRow(db(), 'al2')).not.toBeNull();

    await clearAlbumInfo(db());
    expect(await getAlbumInfoRow(db(), 'al2')).toBeNull();
  });
});

describe('deleteAlbumSongsNotIn', () => {
  const song = (id: string, albumId: string): Child =>
    ({ id, title: id, albumId, isDir: false }) as unknown as Child;

  /** Read the album's surviving tracks back the way `getAlbumDetail` does. These cases
   *  only write song rows, so they assert on membership rather than on an album row. */
  const songsOfAlbum = (albumId: string): Promise<SongListRow[]> =>
    db().getAllAsync<SongListRow>(
      `SELECT ${SONG_LIST_COLS} FROM songs WHERE album_id = ? ORDER BY disc_number, track, sort_title`,
      [albumId],
    );

  beforeEach(async () => {
    db().runSync('DELETE FROM songs');
    db().runSync('DELETE FROM cached_songs');
  });

  it('drops only this album\'s tracks the server no longer lists', async () => {
    await upsertSongs(db(), [song('s1', 'alA'), song('s2', 'alA'), song('s3', 'alB')]);
    // Server re-tagged alA and re-keyed its ids: s1 stays, s2 is gone, s9 is new.
    await upsertSongs(db(), [song('s9', 'alA')]);
    await deleteAlbumSongsNotIn(db(), 'alA', ['s1', 's9']);

    const remaining = (await songsOfAlbum('alA')).map((s) => s.id).sort();
    expect(remaining).toEqual(['s1', 's9']);
    // A different album is untouched.
    expect((await songsOfAlbum('alB')).map((s) => s.id)).toEqual(['s3']);
  });

  it('never deletes a downloaded track', async () => {
    await upsertSongs(db(), [song('s1', 'alA'), song('s2', 'alA')]);
    db().runSync(
      `INSERT OR REPLACE INTO cached_songs
         (song_id, title, album_id, bytes, duration, suffix, format_captured_at, downloaded_at)
       VALUES ('s2', 's2', 'alA', 0, 0, 'mp3', 0, 0)`,
    );
    // s2 vanished from the server, but its file is on disk and backs the offline list.
    await deleteAlbumSongsNotIn(db(), 'alA', ['s1']);
    expect((await songsOfAlbum('alA')).map((s) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('is a no-op for songs with a null album_id', async () => {
    await upsertSongs(db(), [{ id: 'sx', title: 'sx', isDir: false } as unknown as Child]);
    await deleteAlbumSongsNotIn(db(), 'alA', []);
    expect(await countSongs(db())).toBe(1);
  });
});

describe('deleteArtistsNotIn', () => {
  it('prunes artists the server no longer lists', async () => {
    await upsertArtists(db(), [artist('ar1', 'Alpha'), artist('ar2', 'Beta')]);
    await deleteArtistsNotIn(db(), ['ar1']);
    expect(await countArtists(db())).toBe(1);
  });

  it('refuses an empty keep-set', async () => {
    // getAllArtists resolves [] rather than throwing when there is no usable API, so an
    // empty set means "couldn't ask" far more often than "the server has no artists".
    await upsertArtists(db(), [artist('ar1', 'Alpha')]);
    await deleteArtistsNotIn(db(), []);
    expect(await countArtists(db())).toBe(1);
  });
});

describe('playlist detail markers', () => {
  it('round-trips, defaults to null, and clears in bulk', async () => {
    await upsertPlaylists(db(), [playlist('p1', 'Mix'), playlist('p2', 'Other')]);
    // Never fetched → null, which is what makes "fetch it" the default.
    let state = await listPlaylistDetailState(db());
    expect(state.find((r) => r.id === 'p1')?.detail_changed).toBeNull();

    await stampPlaylistDetailSynced(db(), 'p1', 1700000000000, 7);
    state = await listPlaylistDetailState(db());
    const p1 = state.find((r) => r.id === 'p1');
    expect(p1?.detail_changed).toBe(1700000000000);
    expect(p1?.detail_song_count).toBe(7);
    expect(state.find((r) => r.id === 'p2')?.detail_changed).toBeNull();

    await clearPlaylistDetailMarkers(db());
    state = await listPlaylistDetailState(db());
    expect(state.every((r) => r.detail_changed === null)).toBe(true);
  });

  it('a list upsert does not touch the markers', async () => {
    await upsertPlaylists(db(), [playlist('p1', 'Mix')]);
    await stampPlaylistDetailSynced(db(), 'p1', 42, 3);
    // The whole point of separate columns: `upsertPlaylists` (and the detail fetch,
    // which also upserts) must not clobber the sync marker.
    await upsertPlaylists(db(), [playlist('p1', 'Mix Renamed')]);
    const row = (await listPlaylistDetailState(db())).find((r) => r.id === 'p1');
    expect(row?.detail_changed).toBe(42);
    expect(row?.detail_song_count).toBe(3);
  });
});
