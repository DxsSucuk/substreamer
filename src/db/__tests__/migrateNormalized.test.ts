import type { AlbumID3, Child } from 'subsonic-api';

import { getDb } from '../../store/persistence/db';
import { ensureNormalizedSchema } from '../createNormalizedTables';
import { migrateBlobsToNormalized } from '../migrateNormalized';
import { countAlbums, listAlbums } from '../repository/albums';
import { countArtists } from '../repository/artists';
import { countPlaylists, listPlaylistSongIds } from '../repository/playlists';
import { countSongs } from '../repository/songs';
import { getArtistBioRow, getArtistTopSongsRow, getPlaylistDetail } from '../repository/details';

const db = () => getDb()!;

const seedAlbum = (id: string, a: Partial<AlbumID3>) =>
  db().runSync('INSERT OR REPLACE INTO library_albums (id, sortKey, raw_json) VALUES (?, ?, ?)', [
    id,
    (a.name ?? id).toLowerCase(),
    JSON.stringify({ id, name: id, created: '2020-01-01', duration: 1, songCount: 1, ...a }),
  ]);

const seedSong = (id: string, albumId: string, c: Partial<Child>) =>
  db().runSync('INSERT OR REPLACE INTO song_index (id, albumId, raw_json) VALUES (?, ?, ?)', [
    id,
    albumId,
    JSON.stringify({ id, albumId, title: id, isDir: false, ...c }),
  ]);

const putKv = (key: string, state: unknown) =>
  db().runSync('INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?)', [
    key,
    JSON.stringify({ state, version: 0 }),
  ]);

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  for (const t of [
    'library_albums', 'song_index', 'albums', 'songs', 'artists', 'playlists',
    'playlist_songs', 'artist_top_songs', 'artist_similar',
    'artist_info',
    'artist_bio',
    'artist_top_songs_state',
  ]) {
    db().runSync(`DELETE FROM ${t}`);
  }
  for (const k of [
    'substreamer-artist-library',
    'substreamer-artist-details',
    'substreamer-playlist-library',
    'substreamer-playlist-details',
  ]) {
    db().runSync('DELETE FROM storage WHERE key = ?', [k]);
  }
});

describe('migrateBlobsToNormalized', () => {
  it('migrates album + song blobs into the normalized tables with children', async () => {
    seedAlbum('a1', { name: 'Alpha', genres: ['Rock', 'Pop'] });
    seedAlbum('a2', { name: 'Bravo' });
    seedSong('s1', 'a1', { title: 'Track One', genres: ['Rock'] });
    seedSong('s2', 'a1', { title: 'Track Two' });

    const result = await migrateBlobsToNormalized(db());

    expect(result.albums).toEqual({ source: 2, migrated: 2, skipped: 0 });
    expect(result.songs).toEqual({ source: 2, migrated: 2, skipped: 0 });
    expect(await countAlbums(db())).toBe(2);
    expect(await countSongs(db())).toBe(2);

    const genres = db().getAllSync<{ name: string }>(
      "SELECT name FROM album_genres WHERE album_id='a1' ORDER BY pos",
    );
    expect(genres.map((g) => g.name)).toEqual(['Rock', 'Pop']);

    const page = await listAlbums(db(), { limit: 10 });
    expect(page.rows.map((r) => r.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('skips rows with no raw_json and is re-runnable (idempotent)', async () => {
    seedAlbum('a1', { name: 'Alpha' });
    db().runSync("INSERT INTO song_index (id, albumId, raw_json) VALUES ('s0', 'a1', NULL)");
    seedSong('s1', 'a1', { title: 'Good' });

    const first = await migrateBlobsToNormalized(db());
    expect(first.songs).toEqual({ source: 2, migrated: 1, skipped: 1 });

    // second run must not duplicate
    const second = await migrateBlobsToNormalized(db());
    expect(second.albums.migrated).toBe(1);
    expect(await countAlbums(db())).toBe(1);
    expect(await countSongs(db())).toBe(1);
  });

  it('migrates artists + playlists (rows + song membership) from the persisted KV blobs', async () => {
    putKv('substreamer-artist-library', {
      artists: [
        { id: 'ar1', name: 'Alpha Artist' },
        { id: 'ar2', name: 'Bravo Artist' },
      ],
    });
    putKv('substreamer-playlist-library', { playlists: [{ id: 'pl1', name: 'My Mix' }] });
    putKv('substreamer-playlist-details', {
      playlists: {
        pl1: { playlist: { id: 'pl1', name: 'My Mix', entry: [{ id: 's1' }, { id: 's2' }] } },
      },
    });

    const result = await migrateBlobsToNormalized(db());

    expect(result.artists.migrated).toBe(2);
    expect(result.playlists.migrated).toBe(1);
    expect(await countArtists(db())).toBe(2);
    expect(await countPlaylists(db())).toBe(1);
    expect(await listPlaylistSongIds(db(), 'pl1')).toEqual(['s1', 's2']);
  });

  it('handles absent artist/playlist KV gracefully (0 migrated, no throw)', async () => {
    const result = await migrateBlobsToNormalized(db());
    expect(result.artists).toEqual({ source: 0, migrated: 0, skipped: 0 });
    expect(result.playlists).toEqual({ source: 0, migrated: 0, skipped: 0 });
  });

  it('migrates the playlist entry SONGS so the detail JOIN resolves (not just membership)', async () => {
    // s1/s2 belong to album a9, which is NOT in library_albums/song_index — the songs
    // exist ONLY in the cached playlist detail. The old migration recorded membership but
    // never upserted the songs, so `getPlaylistDetail`'s `playlist_songs JOIN songs`
    // dropped them, leaving an empty offline playlist.
    putKv('substreamer-playlist-details', {
      playlists: {
        pl1: {
          playlist: {
            id: 'pl1',
            name: 'My Mix',
            entry: [
              { id: 's1', title: 'One', albumId: 'a9' },
              { id: 's2', title: 'Two', albumId: 'a9' },
            ],
          },
        },
      },
    });

    await migrateBlobsToNormalized(db());

    const detail = await getPlaylistDetail(db(), 'pl1');
    expect(detail?.entry.map((e) => e.id)).toEqual(['s1', 's2']);
    expect(detail?.entry.map((e) => e.title)).toEqual(['One', 'Two']);
  });

  it('migrates artist detail: top songs + resolved bio & negative-cache markers', async () => {
    putKv('substreamer-artist-details', {
      artists: {
        ar1: {
          artist: { id: 'ar1', name: 'Solo' },
          biography: 'A resolved bio',
          resolvedMbid: 'mbid-123',
          bioCheckedAt: 1_700_000_000_000,
          topSongs: [
            { id: 't1', title: 'Hit One' },
            { id: 't2', title: 'Hit Two' },
          ],
        },
      },
    });

    await migrateBlobsToNormalized(db());

    const top = await getArtistTopSongsRow(db(), 'ar1');
    expect(top?.songs.map((sg) => sg.id)).toEqual(['t1', 't2']);
    // A state row must be stamped too, or the migrated artist reads as never-fetched.
    expect(top?.songCount).toBe(2);
    const bio = await getArtistBioRow(db(), 'ar1');
    expect(bio?.biography).toBe('A resolved bio');
    expect(bio?.resolvedMbid).toBe('mbid-123');
    expect(bio?.checkedAt).toBe(1_700_000_000_000);
  });
});
