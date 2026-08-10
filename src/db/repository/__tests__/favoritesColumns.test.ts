/**
 * The `favorite_*` remainder against REAL SQL on the better-sqlite3-backed op-SQLite
 * substitute: the entity round trip through the columns, and — the load-bearing part — the
 * per-row gate that decides whether an item comes from its columns or from the legacy
 * `json` envelope.
 *
 * The remainder is the only local copy of a starred item the library has no row for, and
 * these rows feed Play All, Shuffle All, CarPlay, the voice vocabulary and the
 * `__starred__` download. Reading a row through columns it does not have yet is a user's
 * favourites silently vanishing, so the gate is asserted directly rather than inferred.
 *
 * Per AGENTS.md §11 the substitute proves SQL semantics, never concurrency.
 */
import type { AlbumID3, ArtistID3, Child } from 'subsonic-api';

import { getDb } from '../../../store/persistence/db';
import { ensureNormalizedSchema } from '../../createNormalizedTables';
import { migrateFavoritesToColumns } from '../../favoritesColumnsMigration';
import { upsertAlbums } from '../albums';
import { upsertArtists } from '../artists';
import { upsertSongs } from '../songs';
import {
  convertFavoriteRow,
  listAllStarredAlbums,
  listAllStarredArtists,
  listAllStarredSongs,
  listStarredArtistNames,
  randomStarredSong,
  readUnconvertedFavorites,
  replaceFavoriteAlbums,
  replaceFavoriteArtists,
  replaceFavoriteSongs,
  starredAlbumsPage,
  starredSongTotals,
  starredSongsPage,
  starredItemOf,
} from '../favorites';

const db = () => getDb()!;
const logs: string[] = [];
const log = (m: string): void => {
  logs.push(m);
};

/** Every column the `Child` snapshot carries plus the five arrays, so "fields intact"
 *  is a real assertion and not a check on an empty payload. */
const fullSong = {
  id: 'fs1',
  title: 'Full Song',
  artist: 'The Artist',
  album: 'The Album',
  isDir: false,
  isVideo: false,
  coverArt: 'cov-1',
  duration: 210,
  albumId: 'al-1',
  artistId: 'ar-1',
  year: 1999,
  track: 4,
  discNumber: 2,
  suffix: 'flac',
  bitRate: 960,
  bitDepth: 24,
  samplingRate: 96_000,
  channelCount: 2,
  transcodedContentType: 'audio/mpeg',
  transcodedSuffix: 'mp3',
  size: 12_345_678,
  contentType: 'audio/flac',
  bpm: 128,
  comment: 'a comment',
  genre: 'Rock',
  type: 'music',
  bookmarkPosition: 12,
  originalWidth: 1000,
  originalHeight: 1000,
  path: 'The Artist/The Album/04 Full Song.flac',
  parent: 'al-1',
  sortName: 'Full Song, The',
  musicBrainzId: 'mb-1',
  explicitStatus: 'clean',
  userRating: 4,
  averageRating: 4.5,
  playCount: 12,
  created: new Date('2020-05-06T07:08:09.000Z'),
  starred: new Date(900),
  played: '2024-01-02T03:04:05Z',
  displayArtist: 'The Artist feat. Feature',
  displayAlbumArtist: 'Various',
  displayComposer: 'Composer',
  replayGain: {
    trackGain: -7.5,
    albumGain: -6.5,
    trackPeak: 0.98,
    albumPeak: 0.99,
    baseGain: 1,
    fallbackGain: -2,
  },
  // Real OpenSubsonic servers return `{name}[]` here despite the `string[]` type.
  genres: [{ name: 'Rock' }, { name: 'Indie' }],
  artists: [
    { id: 'ar-1', name: 'The Artist' },
    { id: 'ar-2', name: 'Feature' },
  ],
  albumArtists: [{ id: 'ar-3', name: 'Various' }],
  contributors: [
    { role: 'composer', subRole: 'lyrics', artist: { id: 'ar-4', name: 'Composer' } },
    { role: 'producer' },
  ],
  moods: ['energetic', 'happy'],
} as unknown as Child;

const fullAlbum = {
  id: 'fa1',
  name: 'Full Album',
  artist: 'The Artist',
  artistId: 'ar-1',
  displayArtist: 'The Artist & Friends',
  coverArt: 'cov-2',
  songCount: 11,
  duration: 2400,
  playCount: 7,
  created: new Date('2019-04-05T06:07:08.000Z'),
  starred: new Date(800),
  year: 1997,
  genre: 'Rock',
  played: '2024-02-03T04:05:06Z',
  userRating: 5,
  version: 'Deluxe',
  musicBrainzId: 'mb-2',
  sortName: 'Full Album, A',
  isCompilation: true,
  explicitStatus: 'explicit',
  originalReleaseDate: { year: 1997, month: 3, day: 2 },
  releaseDate: { year: 2007, month: 11, day: 5 },
  genres: ['Rock', 'Prog'],
  artists: [{ id: 'ar-1', name: 'The Artist', albumCount: 0 }],
  moods: ['brooding'],
  recordLabels: [{ name: 'A Label' }],
  releaseTypes: ['album'],
  discTitles: [{ disc: 1, title: 'Disc One' }],
} as unknown as AlbumID3;

const fullArtist = {
  id: 'far1',
  name: 'Full Artist',
  sortName: 'Artist, Full',
  coverArt: 'cov-3',
  artistImageUrl: 'https://example.invalid/a.jpg',
  albumCount: 9,
  starred: new Date(700),
  userRating: 3,
  musicBrainzId: 'mb-3',
  roles: ['artist', 'composer'],
} as unknown as ArtistID3;

const TABLES = ['songs', 'albums', 'artists', 'favorite_songs', 'favorite_albums', 'favorite_artists'];

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  logs.length = 0;
  for (const t of TABLES) db().runSync(`DELETE FROM ${t}`);
});

/* ------------------------------------------------------------------ */
/*  Legacy seeding — a row exactly as a pre-columns build left it      */
/* ------------------------------------------------------------------ */

const seedLegacySong = (song: Child, starred: number, keys = ['song', 'artist']): void => {
  db().runSync(
    'INSERT INTO favorite_songs (id, starred, duration, sort_title, sort_artist, json) ' +
      'VALUES (?, ?, ?, ?, ?, ?)',
    [song.id, starred, song.duration ?? null, keys[0], keys[1], JSON.stringify(song)],
  );
};

const seedLegacyAlbum = (album: AlbumID3, starred: number): void => {
  db().runSync(
    'INSERT INTO favorite_albums (id, starred, sort_title, sort_artist, json) VALUES (?, ?, ?, ?, ?)',
    [album.id, starred, 'album', 'artist', JSON.stringify(album)],
  );
};

const seedLegacyArtist = (artist: ArtistID3, starred: number): void => {
  db().runSync('INSERT INTO favorite_artists (id, starred, sort_title, json) VALUES (?, ?, ?, ?)', [
    artist.id,
    starred,
    'artist',
    JSON.stringify(artist),
  ]);
};

const gateOf = (table: string, col: string, id: string): string | null =>
  db().getFirstSync<{ v: string | null }>(`SELECT "${col}" AS v FROM ${table} WHERE id = ?`, [id])
    ?.v ?? null;

const jsonOf = (table: string, id: string): string =>
  db().getFirstSync<{ json: string }>(`SELECT json FROM ${table} WHERE id = ?`, [id])?.json ?? '';

const childCount = (table: string, col: string, id: string): number =>
  db().getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, [id])?.n ??
  0;

/* ------------------------------------------------------------------ */

describe('the entity round trip', () => {
  it('carries every stored song field and all five arrays back out of the columns', async () => {
    await replaceFavoriteSongs(db(), [fullSong]);
    const [entry] = await listAllStarredSongs(db());
    const item = entry.item;

    // The remainder owns `starred`: epoch-or-0, never the envelope's copy.
    expect(item.starred).toEqual(new Date(900));
    expect(item.created).toEqual(new Date('2020-05-06T07:08:09.000Z'));
    expect(item.replayGain).toEqual(fullSong.replayGain);
    expect(item.genres).toEqual(['Rock', 'Indie']);
    expect(item.artists).toEqual([
      { id: 'ar-1', name: 'The Artist', albumCount: 0 },
      { id: 'ar-2', name: 'Feature', albumCount: 0 },
    ]);
    expect(item.albumArtists).toEqual([{ id: 'ar-3', name: 'Various', albumCount: 0 }]);
    expect(item.contributors).toEqual([
      { role: 'composer', subRole: 'lyrics', artist: { id: 'ar-4', name: 'Composer', albumCount: 0 } },
      { role: 'producer' },
    ]);
    expect(item.moods).toEqual(['energetic', 'happy']);
    for (const key of [
      'title', 'artist', 'album', 'coverArt', 'duration', 'albumId', 'artistId', 'year', 'track',
      'discNumber', 'suffix', 'bitRate', 'bitDepth', 'samplingRate', 'channelCount',
      'transcodedContentType', 'transcodedSuffix', 'size', 'contentType', 'bpm', 'comment', 'genre',
      'type', 'bookmarkPosition', 'originalWidth', 'originalHeight', 'path', 'parent', 'sortName',
      'musicBrainzId', 'explicitStatus', 'userRating', 'averageRating', 'playCount', 'played',
      'displayArtist', 'displayAlbumArtist', 'displayComposer', 'isVideo', 'isDir',
    ] as const) {
      expect([key, item[key]]).toEqual([key, fullSong[key]]);
    }
  });

  it('carries every stored album field and all six child arrays', async () => {
    await replaceFavoriteAlbums(db(), [fullAlbum]);
    const [entry] = await listAllStarredAlbums(db());
    const item = entry.item;

    expect(item.starred).toEqual(new Date(800));
    expect(item.created).toEqual(new Date('2019-04-05T06:07:08.000Z'));
    expect(item.originalReleaseDate).toEqual({ year: 1997, month: 3, day: 2 });
    expect(item.releaseDate).toEqual({ year: 2007, month: 11, day: 5 });
    expect(item.genres).toEqual(['Rock', 'Prog']);
    expect(item.artists).toEqual([{ id: 'ar-1', name: 'The Artist', albumCount: 0 }]);
    expect(item.moods).toEqual(['brooding']);
    expect(item.recordLabels).toEqual([{ name: 'A Label' }]);
    expect(item.releaseTypes).toEqual(['album']);
    expect(item.discTitles).toEqual([{ disc: 1, title: 'Disc One' }]);
    for (const key of [
      'name', 'artist', 'artistId', 'displayArtist', 'coverArt', 'songCount', 'duration',
      'playCount', 'year', 'genre', 'played', 'userRating', 'version', 'musicBrainzId', 'sortName',
      'isCompilation', 'explicitStatus',
    ] as const) {
      expect([key, item[key]]).toEqual([key, fullAlbum[key]]);
    }
  });

  it('carries every stored artist field and its roles', async () => {
    await replaceFavoriteArtists(db(), [fullArtist]);
    const [entry] = await listAllStarredArtists(db());
    expect(entry.item).toEqual({
      id: 'far1',
      name: 'Full Artist',
      sortName: 'Artist, Full',
      coverArt: 'cov-3',
      artistImageUrl: 'https://example.invalid/a.jpg',
      albumCount: 9,
      starred: new Date(700),
      userRating: 3,
      musicBrainzId: 'mb-3',
      roles: ['artist', 'composer'],
    });
  });

  it('drops the previous rows AND their child arrays on a rebuild', async () => {
    await replaceFavoriteSongs(db(), [fullSong]);
    expect(childCount('favorite_song_genres', 'song_id', 'fs1')).toBe(2);
    await replaceFavoriteSongs(db(), []);
    expect(childCount('favorite_song_genres', 'song_id', 'fs1')).toBe(0);
  });

  it('keeps the LAST copy when the server repeats an id, rather than losing its arrays', async () => {
    await replaceFavoriteSongs(db(), [
      { ...fullSong, title: 'First', moods: [] } as unknown as Child,
      { ...fullSong, title: 'Second' } as unknown as Child,
    ]);
    const [entry] = await listAllStarredSongs(db());
    expect(entry.item.title).toBe('Second');
    expect(entry.item.moods).toEqual(['energetic', 'happy']);
  });
});

/* ------------------------------------------------------------------ */

describe('the read gate — a row the columns have not reached', () => {
  it('returns a legacy song from its envelope, NOT an empty item', async () => {
    seedLegacySong(fullSong, 900);
    expect(gateOf('favorite_songs', 'title', 'fs1')).toBeNull();

    const [entry] = await listAllStarredSongs(db());
    // The data-loss guard: everything Play All / CarPlay / `__starred__` need is here.
    expect(entry.item.id).toBe('fs1');
    expect(entry.item.title).toBe('Full Song');
    expect(entry.item.artist).toBe('The Artist');
    expect(entry.item.duration).toBe(210);
    expect(entry.item.suffix).toBe('flac');
    expect(entry.item.starred).toEqual(new Date(900));
    expect(entry.item.genres).toEqual([{ name: 'Rock' }, { name: 'Indie' }]);
  });

  it('returns a legacy album and artist from their envelopes', async () => {
    seedLegacyAlbum(fullAlbum, 800);
    seedLegacyArtist(fullArtist, 700);

    const [album] = await listAllStarredAlbums(db());
    expect(album.item.name).toBe('Full Album');
    expect(album.item.coverArt).toBe('cov-2');
    expect(album.item.starred).toEqual(new Date(800));

    const [artist] = await listAllStarredArtists(db());
    expect(artist.item.name).toBe('Full Artist');
    expect(artist.item.albumCount).toBe(9);
  });

  it('reads each row from its OWN source when the two coexist', async () => {
    seedLegacySong(fullSong, 900);
    db().runSync(
      'INSERT INTO favorite_songs (id, starred, duration, sort_title, sort_artist, json, title) ' +
        "VALUES ('fs2', 800, 120, 'b', 'b', '', 'Converted')",
    );
    const rows = await listAllStarredSongs(db());
    expect(rows.map((r) => [r.id, r.item.title])).toEqual([
      ['fs1', 'Full Song'],
      ['fs2', 'Converted'],
    ]);
  });

  it('pages a legacy row the same as a converted one', async () => {
    seedLegacySong(fullSong, 900);
    const page = await starredSongsPage(db(), { limit: 10 });
    expect(page.rows.map((r) => r.item.title)).toEqual(['Full Song']);

    seedLegacyAlbum(fullAlbum, 800);
    const albums = await starredAlbumsPage(db(), { limit: 10 });
    expect(albums.rows.map((r) => r.item.name)).toEqual(['Full Album']);
  });

  it('donates a legacy artist name to the voice vocabulary', async () => {
    seedLegacyArtist(fullArtist, 700);
    expect(await listStarredArtistNames(db())).toEqual(['Full Artist']);
    await migrateFavoritesToColumns(db(), log);
    expect(await listStarredArtistNames(db())).toEqual(['Full Artist']);
  });

  it('names a legacy song from `randomStarredSong`', async () => {
    seedLegacySong(fullSong, 900);
    expect(await randomStarredSong(db())).toEqual({ id: 'fs1', title: 'Full Song' });
    await migrateFavoritesToColumns(db(), log);
    expect(await randomStarredSong(db())).toEqual({ id: 'fs1', title: 'Full Song' });
  });

  it('yields an item rather than throwing when the envelope is corrupt', async () => {
    seedLegacySong(fullSong, 900);
    db().runSync("UPDATE favorite_songs SET json = 'not json' WHERE id = 'fs1'");
    const rows = await listAllStarredSongs(db());
    expect(rows.map((r) => r.id)).toEqual(['fs1']);
    expect(rows[0].item.title).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */

describe('Migration 40', () => {
  it('converts a legacy row and keeps its epoch, its sort keys and its envelope', async () => {
    seedLegacySong(fullSong, 900, ['stored title key', 'stored artist key']);
    await migrateFavoritesToColumns(db(), log);

    const row = db().getFirstSync<{
      starred: number;
      sort_title: string;
      sort_artist: string;
      json: string;
      title: string;
    }>('SELECT starred, sort_title, sort_artist, json, title FROM favorite_songs');
    expect(row?.starred).toBe(900);
    expect(row?.sort_title).toBe('stored title key');
    expect(row?.sort_artist).toBe('stored artist key');
    expect(row?.json).toBe(JSON.stringify(fullSong));
    expect(row?.title).toBe('Full Song');
    expect(childCount('favorite_song_genres', 'song_id', 'fs1')).toBe(2);
  });

  it('produces the same item through the columns as the envelope did', async () => {
    seedLegacySong(fullSong, 900);
    const before = (await listAllStarredSongs(db())).map(starredItemOf);
    await migrateFavoritesToColumns(db(), log);
    const after = (await listAllStarredSongs(db())).map(starredItemOf);

    // The arrays are the only difference, and in both cases the stored form is the
    // NORMALIZED one the library half also produces: `{name}[]` off the wire becomes
    // `string[]`, and a nested artist becomes a real `ArtistID3` stub.
    const arrays = ['genres', 'artists', 'albumArtists', 'contributors', 'moods'] as const;
    const scalars = (c: Child): Partial<Child> => {
      const out = { ...c };
      for (const k of arrays) delete out[k];
      return out;
    };
    expect(scalars(after[0])).toEqual(scalars(before[0]));
    expect(after[0].genres).toEqual(['Rock', 'Indie']);
    expect(after[0].artists?.every((a) => a.albumCount === 0)).toBe(true);
    expect(after[0].moods).toEqual(before[0].moods);
  });

  it('converts albums and artists with their child arrays', async () => {
    seedLegacyAlbum(fullAlbum, 800);
    seedLegacyArtist(fullArtist, 700);
    await migrateFavoritesToColumns(db(), log);

    expect(gateOf('favorite_albums', 'name', 'fa1')).toBe('Full Album');
    expect(childCount('favorite_album_genres', 'album_id', 'fa1')).toBe(2);
    expect(childCount('favorite_album_disc_titles', 'album_id', 'fa1')).toBe(1);
    expect(childCount('favorite_artist_roles', 'artist_id', 'far1')).toBe(2);

    const [album] = await listAllStarredAlbums(db());
    expect(album.item.recordLabels).toEqual([{ name: 'A Label' }]);
    const [artist] = await listAllStarredArtists(db());
    expect(artist.item.roles).toEqual(['artist', 'composer']);
  });

  it('is idempotent — a second run leaves the rows byte-identical', async () => {
    seedLegacySong(fullSong, 900);
    seedLegacyAlbum(fullAlbum, 800);
    seedLegacyArtist(fullArtist, 700);
    await migrateFavoritesToColumns(db(), log);
    const first = db().getAllSync('SELECT * FROM favorite_songs');
    const firstGenres = db().getAllSync('SELECT * FROM favorite_song_genres');

    logs.length = 0;
    await migrateFavoritesToColumns(db(), log);
    expect(db().getAllSync('SELECT * FROM favorite_songs')).toEqual(first);
    expect(db().getAllSync('SELECT * FROM favorite_song_genres')).toEqual(firstGenres);
    // Nothing left in the work set, so nothing is even reported.
    expect(logs).toEqual([]);
  });

  it('leaves the envelope intact and the gate SHUT when the write fails', async () => {
    seedLegacySong(fullSong, 900);
    const real = db().runAtomicBatchAsync.bind(db());
    (db() as unknown as { runAtomicBatchAsync: unknown }).runAtomicBatchAsync = (
      commands: Parameters<typeof real>[0],
    ) => real([...commands, ['INSERT INTO no_such_table (x) VALUES (1)', []]]);
    try {
      await migrateFavoritesToColumns(db(), log);
    } finally {
      (db() as unknown as { runAtomicBatchAsync: unknown }).runAtomicBatchAsync = real;
    }

    expect(gateOf('favorite_songs', 'title', 'fs1')).toBeNull();
    expect(jsonOf('favorite_songs', 'fs1')).toBe(JSON.stringify(fullSong));
    expect(logs.some((m) => m.includes('keeping its envelope'))).toBe(true);
    // And the row still reads — the whole point of failing shut.
    expect((await listAllStarredSongs(db()))[0].item.title).toBe('Full Song');
  });

  it('leaves a row alone when its envelope yields no entity', async () => {
    seedLegacySong(fullSong, 900);
    db().runSync("UPDATE favorite_songs SET json = 'not json' WHERE id = 'fs1'");
    await migrateFavoritesToColumns(db(), log);
    expect(gateOf('favorite_songs', 'title', 'fs1')).toBeNull();
    expect(jsonOf('favorite_songs', 'fs1')).toBe('not json');
  });

  it('does not list a converted row as work', async () => {
    await replaceFavoriteSongs(db(), [fullSong]);
    expect(await readUnconvertedFavorites(db(), 'songs')).toEqual([]);
    seedLegacyAlbum(fullAlbum, 800);
    expect((await readUnconvertedFavorites(db(), 'albums')).map((r) => r.id)).toEqual(['fa1']);
  });

  it('reports false for a row it refuses to convert', async () => {
    seedLegacyAlbum(fullAlbum, 800);
    const [row] = await readUnconvertedFavorites(db(), 'albums');
    expect(await convertFavoriteRow(db(), 'albums', { ...row, json: '{}' })).toBe(false);
    expect(gateOf('favorite_albums', 'name', 'fa1')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe('behaviour the columns must not change', () => {
  it('still hides a remainder row the library has a marked row for, from either source', async () => {
    seedLegacySong(fullSong, 900);
    await replaceFavoriteAlbums(db(), [fullAlbum]);
    expect((await listAllStarredSongs(db())).map((r) => r.id)).toEqual(['fs1']);
    expect((await listAllStarredAlbums(db())).map((r) => r.id)).toEqual(['fa1']);

    await upsertSongs(db(), [{ ...fullSong, starred: new Date(900) } as Child]);
    await upsertAlbums(db(), [{ ...fullAlbum, starred: new Date(800) } as AlbumID3]);

    // One entry each, from the LIBRARY half — the remainder rows are still on disk.
    expect((await listAllStarredSongs(db())).length).toBe(1);
    expect((await listAllStarredAlbums(db())).length).toBe(1);
    expect(
      db().getFirstSync<{ n: number }>('SELECT COUNT(*) AS n FROM favorite_songs')?.n,
    ).toBe(1);
  });

  it('excludes an artist the library holds from the voice vocabulary donation', async () => {
    seedLegacyArtist(fullArtist, 700);
    await upsertArtists(db(), [{ ...fullArtist, name: 'Library Artist' } as ArtistID3]);
    db().runSync('UPDATE artists SET starred = 700 WHERE id = ?', ['far1']);
    expect(await listStarredArtistNames(db())).toEqual(['Library Artist']);
  });

  it('aggregates the action-bar duration in SQL across both halves and both sources', async () => {
    seedLegacySong(fullSong, 900); // 210s, still on its envelope
    db().runSync(
      'INSERT INTO favorite_songs (id, starred, duration, sort_title, sort_artist, json, title) ' +
        "VALUES ('fs2', 800, 90, 'b', 'b', '', 'Converted')",
    );
    await upsertSongs(db(), [{ id: 'lib1', title: 'Lib', duration: 30 } as Child]);
    db().runSync('UPDATE songs SET starred = 700 WHERE id = ?', ['lib1']);

    expect(await starredSongTotals(db())).toEqual({ count: 3, duration: 330 });
  });
});
