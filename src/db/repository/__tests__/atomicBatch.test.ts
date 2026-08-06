/**
 * Bulk writes are all-or-nothing per chunk.
 *
 * `bulkUpsert` emits, per entity, a parent upsert plus a `DELETE … WHERE parent = ?`
 * and N INSERTs per child table. Shipped in autocommit, a statement that throws
 * part-way (a server sending a duplicate or title-less disc is enough — no process
 * kill required) left the parent row alive with its children deleted and never
 * reinserted, which several sites read as "we have this album's detail".
 *
 * Real SQL against the better-sqlite3-backed op-SQLite seam, so the SAVEPOINT and the
 * constraint violations are the real ones.
 */
import type { AlbumID3, ArtistID3, Child } from 'subsonic-api';

import { getDb } from '../../../store/persistence/db';
import { ensureNormalizedSchema } from '../../createNormalizedTables';
import { listAlbumListRows, replaceAlbumList, upsertAlbums } from '../albums';
import { setArtistTopSongs, upsertArtists } from '../artists';
import { bulkUpsert } from '../core';
import { albumDiscTitleRows, albumRow } from '../mappers';
import { upsertSongs } from '../songs';

const db = () => getDb()!;

const album = (id: string, name: string, extra: Partial<AlbumID3> = {}): AlbumID3 => ({
  id,
  name,
  created: new Date('2020-01-01'),
  duration: 100,
  songCount: 1,
  ...extra,
});
const artist = (id: string, name: string): ArtistID3 => ({ id, name, albumCount: 1 });
const song = (id: string): Child => ({ id, title: `Song ${id}`, isDir: false }) as Child;

/** Two disc titles on the same disc number — `PRIMARY KEY(album_id, disc)` rejects the
 *  second, mid-batch, exactly as a real server's duplicate `discTitles` entry does. */
const duplicateDiscs = [
  { disc: 1, title: 'One' },
  { disc: 1, title: 'One again' },
];

const genresOf = (albumId: string): string[] =>
  db()
    .getAllSync<{ name: string }>('SELECT name FROM album_genres WHERE album_id = ? ORDER BY pos', [
      albumId,
    ])
    .map((r) => r.name);

const albumIds = (): string[] =>
  db().getAllSync<{ id: string }>('SELECT id FROM albums ORDER BY id').map((r) => r.id);

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  for (const t of ['albums', 'songs', 'artists']) db().runSync(`DELETE FROM ${t}`);
});

describe('bulkUpsert atomicity', () => {
  it('a failing chunk leaves the PREVIOUS children in place, never an empty set', async () => {
    await upsertAlbums(db(), [album('a1', 'Alpha', { genres: ['Rock', 'Pop'] })]);
    expect(genresOf('a1')).toEqual(['Rock', 'Pop']);

    await expect(
      upsertAlbums(db(), [
        album('a1', 'Alpha', { genres: ['Jazz'], discTitles: duplicateDiscs }),
      ]),
    ).rejects.toThrow();

    // The genre DELETE + the 'Jazz' INSERT both ran before the disc-title conflict.
    // Without the savepoint this reads as [] — an album that looks like it has detail
    // and has none.
    expect(genresOf('a1')).toEqual(['Rock', 'Pop']);
    expect(
      db().getAllSync<{ disc: number }>('SELECT disc FROM album_disc_titles WHERE album_id = ?', [
        'a1',
      ]),
    ).toEqual([]);
  });

  it('recovery leaves no open savepoint — the next upsert commits normally', async () => {
    await expect(
      upsertAlbums(db(), [album('bad', 'Bad', { discTitles: duplicateDiscs })]),
    ).rejects.toThrow();

    await upsertAlbums(db(), [album('a2', 'Bravo', { genres: ['Folk'] })]);
    expect(genresOf('a2')).toEqual(['Folk']);
    // A stranded savepoint makes any later `withTransactionSync` BEGIN a hard error.
    db().withTransactionSync(() => {
      db().runSync("UPDATE albums SET name = 'Bravo!' WHERE id = 'a2'");
    });
    expect(albumIds()).toEqual(['a2']);
  });

  it('stops at the failing chunk: earlier chunks are committed, later ones never run', async () => {
    // chunkSize 1 → one album per batch. §7.4 of the plan predicted "1 and 3 written";
    // the loop drains the previous chunk BEFORE kicking the next, so the rejection
    // surfaces while chunk 3 is still un-issued. That is the behaviour the library sync
    // depends on — a failing page must fail so its cursor cannot advance.
    const items = [
      album('a1', 'Alpha'),
      album('a2', 'Bravo', { discTitles: duplicateDiscs }),
      album('a3', 'Charlie'),
    ];
    await expect(
      bulkUpsert(
        db(),
        {
          table: 'albums',
          idOf: (a: AlbumID3) => a.id,
          rowOf: (a: AlbumID3) => albumRow(a),
          children: [
            { table: 'album_disc_titles', parentCol: 'album_id', rows: albumDiscTitleRows },
          ],
          chunkSize: 1,
        },
        items,
      ),
    ).rejects.toThrow();

    expect(albumIds()).toEqual(['a1']);
  });
});

describe('setArtistTopSongs atomicity', () => {
  const topSongIds = (artistId: string): string[] =>
    db()
      .getAllSync<{ song_id: string }>(
        'SELECT song_id FROM artist_top_songs WHERE artist_id = ? ORDER BY pos',
        [artistId],
      )
      .map((r) => r.song_id);

  it('a mid-batch failure leaves the previous list intact and the state row unstamped', async () => {
    await upsertArtists(db(), [artist('ar1', 'Band')]);
    await upsertSongs(db(), [song('s1'), song('s2'), song('s3')]);
    await setArtistTopSongs(db(), 'ar1', ['s1', 's2'], { listLength: 2 });
    expect(topSongIds('ar1')).toEqual(['s1', 's2']);

    // `song_id` is NOT NULL — the second INSERT fails after the DELETE and the first
    // INSERT have already run.
    await expect(
      setArtistTopSongs(db(), 'ar1', ['s3', null as unknown as string], { listLength: 9 }),
    ).rejects.toThrow();

    expect(topSongIds('ar1')).toEqual(['s1', 's2']);
    const state = db().getFirstSync<{ list_length: number }>(
      'SELECT list_length FROM artist_top_songs_state WHERE artist_id = ?',
      ['ar1'],
    );
    expect(state?.list_length).toBe(2);
  });
});

/**
 * Supplementary writers must not blank what a fuller writer already stored.
 *
 * `getArtist` returns a partial album view, and `detailFetchService` upserts it over rows
 * the library sync populated in full. With the authoritative policy that wiped genre, year
 * and MBID — and the child DELETE wiped `album_genres` outright — every time the user
 * opened an artist, until the next full sync.
 */
describe('merge upsert (supplementary writers)', () => {
  const albumRowOf = (id: string) =>
    db().getFirstSync<{ year: number | null; genre: string | null; music_brainz_id: string | null }>(
      'SELECT year, genre, music_brainz_id FROM albums WHERE id = ?',
      [id],
    );

  it('keeps columns a partial payload does not carry, and overwrites the ones it does', async () => {
    await upsertAlbums(db(), [
      album('m1', 'Full', { year: 1969, genre: 'Rock', musicBrainzId: 'mb-1' }),
    ]);

    // A lean payload: no year, no genre, no MBID — and a changed name.
    await upsertAlbums(db(), [album('m1', 'Renamed')], undefined, undefined, { merge: true });

    const row = albumRowOf('m1');
    expect(row?.year).toBe(1969);
    expect(row?.genre).toBe('Rock');
    expect(row?.music_brainz_id).toBe('mb-1');
    expect(
      db().getFirstSync<{ name: string }>('SELECT name FROM albums WHERE id = ?', ['m1'])?.name,
    ).toBe('Renamed');
  });

  it('leaves child rows alone when the payload carries none', async () => {
    await upsertAlbums(db(), [album('m2', 'Full', { genres: ['Rock', 'Pop'] })]);
    expect(genresOf('m2')).toEqual(['Rock', 'Pop']);

    await upsertAlbums(db(), [album('m2', 'Full')], undefined, undefined, { merge: true });

    // The COALESCE cannot protect a child table — only skipping the replace can.
    expect(genresOf('m2')).toEqual(['Rock', 'Pop']);
  });

  it('still replaces child rows when the payload DOES carry them', async () => {
    await upsertAlbums(db(), [album('m3', 'Full', { genres: ['Rock'] })]);

    await upsertAlbums(db(), [album('m3', 'Full', { genres: ['Jazz'] })], undefined, undefined, {
      merge: true,
    });

    expect(genresOf('m3')).toEqual(['Jazz']);
  });

  it('the default policy still overwrites authoritatively', async () => {
    await upsertAlbums(db(), [album('m4', 'Full', { year: 1969, genres: ['Rock'] })]);

    await upsertAlbums(db(), [album('m4', 'Full')]);

    expect(albumRowOf('m4')?.year).toBeNull();
    expect(genresOf('m4')).toEqual([]);
  });
});

/**
 * The home-screen album lists as ordered ids over `albums` (A2).
 *
 * The blob they replace held whole `AlbumID3` envelopes captured at fetch time, so a
 * star or a rating applied anywhere else left the home row showing a stale copy.
 */
describe('album list entries', () => {
  it('stores order, reads it back joined to the album rows, and replaces atomically', async () => {
    await upsertAlbums(db(), [album('L1', 'One'), album('L2', 'Two'), album('L3', 'Three')]);

    await replaceAlbumList(db(), 'recentlyAdded', ['L3', 'L1']);
    expect((await listAlbumListRows(db(), 'recentlyAdded')).map((r) => r.id)).toEqual(['L3', 'L1']);

    // Replacing is wholesale, and ordered by position rather than id.
    await replaceAlbumList(db(), 'recentlyAdded', ['L2', 'L3', 'L1']);
    expect((await listAlbumListRows(db(), 'recentlyAdded')).map((r) => r.id)).toEqual([
      'L2',
      'L3',
      'L1',
    ]);
  });

  it('keeps the four lists independent', async () => {
    await upsertAlbums(db(), [album('L1', 'One'), album('L2', 'Two')]);
    await replaceAlbumList(db(), 'recentlyAdded', ['L1']);
    await replaceAlbumList(db(), 'randomSelection', ['L2']);

    expect((await listAlbumListRows(db(), 'recentlyAdded')).map((r) => r.id)).toEqual(['L1']);
    expect((await listAlbumListRows(db(), 'randomSelection')).map((r) => r.id)).toEqual(['L2']);
  });

  it('drops a list entry when its album leaves the library', async () => {
    await upsertAlbums(db(), [album('L1', 'One')]);
    await replaceAlbumList(db(), 'recentlyAdded', ['L1']);

    // The FK cascade is the point: a reaped album must not linger in a home list.
    db().runSync('DELETE FROM albums WHERE id = ?', ['L1']);

    expect(await listAlbumListRows(db(), 'recentlyAdded')).toEqual([]);
  });

  it('reads the live album row, not a snapshot taken at list time', async () => {
    await upsertAlbums(db(), [album('L1', 'Original')]);
    await replaceAlbumList(db(), 'recentlyAdded', ['L1']);

    await upsertAlbums(db(), [album('L1', 'Renamed')]);

    // This is the whole point of A2 — the blob would still say "Original".
    expect((await listAlbumListRows(db(), 'recentlyAdded'))[0].name).toBe('Renamed');
  });
});
