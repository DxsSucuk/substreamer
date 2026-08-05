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

import { getDb, serializeDbWrite } from '../../../store/persistence/db';
import { ensureNormalizedSchema } from '../../createNormalizedTables';
import { upsertAlbums } from '../albums';
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

  it('holds the write mutex across the batch, so the chain still runs afterwards', async () => {
    await upsertAlbums(db(), [album('a1', 'Alpha')]);
    await expect(serializeDbWrite(() => Promise.resolve('chain alive'))).resolves.toBe('chain alive');
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
