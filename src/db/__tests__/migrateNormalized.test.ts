import type { AlbumID3, Child } from 'subsonic-api';

import { getDb } from '../../store/persistence/db';
import { createLegacyBlobTables } from '../../test-utils/legacyBlobTables';
import { ensureNormalizedSchema } from '../createNormalizedTables';
import { checkpointWalAsync, migrateBlobsToNormalized } from '../migrateNormalized';
import { countAlbums, getAlbumInfoRow, listAlbums } from '../repository/albums';
import { countArtists } from '../repository/artists';
import { countPlaylists } from '../repository/playlists';
import { countSongs } from '../repository/songs';
import {
  getArtistBioRow,
  getArtistInfoRow,
  getArtistTopSongsRow,
  getPlaylistDetail,
} from '../repository/details';

const db = () => getDb()!;

/** Ordered playlist membership, straight from the junction table. */
const playlistSongIds = async (playlistId: string): Promise<string[]> =>
  (
    await db().getAllAsync<{ song_id: string }>(
      'SELECT song_id FROM playlist_songs WHERE playlist_id = ? ORDER BY position',
      [playlistId],
    )
  ).map((r) => r.song_id);

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

const seedAlbumDetail = (id: string, album: Record<string, unknown>) =>
  db().runSync('INSERT OR REPLACE INTO album_details (id, json, retrievedAt) VALUES (?, ?, ?)', [
    id,
    JSON.stringify({ id, name: id, created: '2020-01-01', duration: 1, songCount: 1, ...album }),
    1,
  ]);

const putKv = (key: string, state: unknown) =>
  db().runSync('INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?)', [
    key,
    JSON.stringify({ state, version: 0 }),
  ]);

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  // db.ts no longer creates the legacy blob tables at boot; the suite seeds them, so it
  // creates them. In beforeEach, not beforeAll, so a test that drops one gets it back.
  createLegacyBlobTables(db());
  for (const t of [
    'library_albums', 'song_index', 'album_details', 'albums', 'songs', 'artists', 'playlists',
    'playlist_songs', 'artist_top_songs', 'artist_similar',
    'artist_info',
    'artist_bio',
    'artist_top_songs_state',
    'album_info',
  ]) {
    db().runSync(`DELETE FROM ${t}`);
  }
  for (const k of [
    'substreamer-artist-library',
    'substreamer-artist-details',
    'substreamer-playlist-library',
    'substreamer-playlist-details',
    'substreamer-album-details',
    'substreamer-album-info',
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

  it('skips a row whose blob will not parse, and migrates the rest of the page', async () => {
    // Truncated JSON is what a killed write leaves behind. The ETL counts it as
    // skipped rather than throwing, or one bad row costs the whole library.
    seedAlbum('a1', { name: 'Alpha' });
    db().runSync('INSERT INTO library_albums (id, sortKey, raw_json) VALUES (?, ?, ?)', [
      'a2',
      'bravo',
      '{"id":"a2",',
    ]);

    const result = await migrateBlobsToNormalized(db());

    expect(result.albums).toEqual({ source: 2, migrated: 1, skipped: 1 });
    expect(await countAlbums(db())).toBe(1);
  });

  it('treats a KV value that will not parse as an absent store', async () => {
    db().runSync('INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?)', [
      'substreamer-artist-library',
      'not json at all',
    ]);

    const result = await migrateBlobsToNormalized(db());

    expect(result.artists).toEqual({ source: 0, migrated: 0, skipped: 0 });
    expect(await countArtists(db())).toBe(0);
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
    expect(await playlistSongIds('pl1')).toEqual(['s1', 's2']);
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

  it('fills songs from album_details when the song_index row predates raw_json', async () => {
    // The pre-2026-06-04 shape: a song_index row with no envelope. The song pass skips
    // it, so `album_details.song[]` is the only local source for that track.
    seedAlbum('a1', { name: 'Alpha' });
    db().runSync("INSERT INTO song_index (id, albumId, raw_json) VALUES ('s1', 'a1', NULL)");
    seedAlbumDetail('a1', {
      name: 'Alpha',
      song: [{ id: 's1', albumId: 'a1', title: 'Recovered', genres: ['Rock'], isDir: false }],
    });

    await migrateBlobsToNormalized(db());

    const row = db().getFirstSync<{ title: string }>("SELECT title FROM songs WHERE id = 's1'");
    expect(row?.title).toBe('Recovered');
    // The child tables come along with it, so it isn't a lean reconstruction.
    const genres = db().getAllSync<{ name: string }>(
      "SELECT name FROM song_genres WHERE song_id='s1'",
    );
    expect(genres.map((g) => g.name)).toEqual(['Rock']);
  });

  it('leaves album_details alone when song_index already carries every envelope', async () => {
    // The redundant case: song_index is a superset, so the envelope is never parsed and
    // the already-migrated album row is not rewritten from it.
    seedAlbum('a1', { name: 'Alpha' });
    seedSong('s1', 'a1', { title: 'From song_index' });
    seedAlbumDetail('a1', {
      name: 'Stale detail name',
      song: [{ id: 's1', albumId: 'a1', title: 'From album_details', isDir: false }],
    });

    const result = await migrateBlobsToNormalized(db());

    expect(result.albums).toEqual({ source: 1, migrated: 1, skipped: 0 });
    expect(result.songs).toEqual({ source: 1, migrated: 1, skipped: 0 });
    const album = db().getFirstSync<{ name: string }>("SELECT name FROM albums WHERE id = 'a1'");
    expect(album?.name).toBe('Alpha');
    const song = db().getFirstSync<{ title: string }>("SELECT title FROM songs WHERE id = 's1'");
    expect(song?.title).toBe('From song_index');
  });

  it('recovers an album that only ever reached album_details', async () => {
    seedAlbumDetail('a9', {
      name: 'Detail Only',
      song: [{ id: 's9', albumId: 'a9', title: 'Only Track', isDir: false }],
    });

    const result = await migrateBlobsToNormalized(db());

    expect(result.albums.migrated).toBe(1);
    expect(result.songs.migrated).toBe(1);
    expect(await countAlbums(db())).toBe(1);
    expect(await countSongs(db())).toBe(1);

    // Re-running must not duplicate — the gap is closed, so the envelope is skipped.
    const second = await migrateBlobsToNormalized(db());
    expect(second.albums.migrated).toBe(0);
    expect(await countAlbums(db())).toBe(1);
    expect(await countSongs(db())).toBe(1);
  });

  it('migrates the pre-table album-details KV blob', async () => {
    putKv('substreamer-album-details', {
      albums: {
        a1: {
          album: {
            id: 'a1',
            name: 'From KV',
            created: '2020-01-01',
            duration: 1,
            songCount: 1,
            song: [{ id: 's1', albumId: 'a1', title: 'KV Track', isDir: false }],
          },
          retrievedAt: 1,
        },
      },
    });

    await migrateBlobsToNormalized(db());

    const album = db().getFirstSync<{ name: string }>("SELECT name FROM albums WHERE id = 'a1'");
    expect(album?.name).toBe('From KV');
    const song = db().getFirstSync<{ title: string }>("SELECT title FROM songs WHERE id = 's1'");
    expect(song?.title).toBe('KV Track');
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

  it('migrates artist detail: the getArtistInfo2 envelope + its similar artists', async () => {
    putKv('substreamer-artist-details', {
      artists: {
        ar1: {
          artist: { id: 'ar1', name: 'Solo' },
          artistInfo: {
            biography: 'Server bio.',
            lastFmUrl: 'https://last.fm/x',
            musicBrainzId: 'mb-1',
            smallImageUrl: 'https://img/s',
            mediumImageUrl: 'https://img/m',
            largeImageUrl: 'https://img/l',
            similarArtist: [{ id: 'ar9', name: 'Duo', albumCount: 1, coverArt: 'ca9' }],
          },
        },
      },
    });

    await migrateBlobsToNormalized(db());

    const info = await getArtistInfoRow(db(), 'ar1');
    expect(info).toMatchObject({
      biography: 'Server bio.',
      lastFmUrl: 'https://last.fm/x',
      musicBrainzId: 'mb-1',
      smallImageUrl: 'https://img/s',
      mediumImageUrl: 'https://img/m',
      largeImageUrl: 'https://img/l',
    });
    expect(info?.similarArtist).toEqual([
      { id: 'ar9', name: 'Duo', albumCount: 1, coverArt: 'ca9' },
    ]);
  });

  it('records an empty artistInfo as a fetch that found nothing, not as never-fetched', async () => {
    // The blob's optional fields are all absent on a server that returns a bare
    // envelope. Every one must land as NULL — and a similar artist with no id is
    // dropped rather than written as a reference to nothing.
    putKv('substreamer-artist-details', {
      artists: {
        ar1: {
          artist: { id: 'ar1', name: 'Solo' },
          artistInfo: { similarArtist: [{ name: 'No id' }, { id: 'ar9' }] },
        },
      },
    });

    await migrateBlobsToNormalized(db());

    const info = await getArtistInfoRow(db(), 'ar1');
    expect(info).toMatchObject({
      biography: null,
      lastFmUrl: null,
      musicBrainzId: null,
      smallImageUrl: undefined,
      mediumImageUrl: undefined,
      largeImageUrl: undefined,
    });
    expect(info?.similarArtist).toEqual([
      { id: 'ar9', name: '', albumCount: 0, coverArt: undefined, userRating: undefined },
    ]);
  });

  it('migrates album info + the Wikipedia enrichment from its KV blob', async () => {
    seedAlbum('a1', { name: 'Alpha' });
    putKv('substreamer-album-info', {
      entries: {
        a1: {
          albumInfo: {
            notes: 'Server notes',
            lastFmUrl: 'https://last.fm/a1',
            musicBrainzId: 'mb-a1',
            smallImageUrl: 'https://img/s',
            mediumImageUrl: 'https://img/m',
            largeImageUrl: 'https://img/l',
          },
          enrichedNotes: 'From Wikipedia',
          enrichedNotesUrl: 'https://wiki/a1',
          overrideMbid: 'mb-override',
          retrievedAt: 1_700_000_000_000,
        },
      },
    });

    await migrateBlobsToNormalized(db());

    expect(await getAlbumInfoRow(db(), 'a1')).toEqual({
      notes: 'Server notes',
      lastFmUrl: 'https://last.fm/a1',
      musicBrainzId: 'mb-a1',
      imageUrlSmall: 'https://img/s',
      imageUrlMedium: 'https://img/m',
      imageUrlLarge: 'https://img/l',
      enrichedNotes: 'From Wikipedia',
      enrichedNotesUrl: 'https://wiki/a1',
      overrideMbid: 'mb-override',
      retrievedAt: 1_700_000_000_000,
    });
  });

  it('writes an album-info entry that carries nothing but a timestamp', async () => {
    seedAlbum('a1', { name: 'Alpha' });
    putKv('substreamer-album-info', { entries: { a1: {} } });

    await migrateBlobsToNormalized(db());

    const row = await getAlbumInfoRow(db(), 'a1');
    expect(row).toMatchObject({ notes: null, lastFmUrl: null, enrichedNotes: null });
    expect(row?.retrievedAt).toBeGreaterThan(0); // stamped now — the blob had none
  });

  it('skips album-info entries with no album row and no entry at all', async () => {
    // `album_info.album_id` FKs to `albums`, so an entry for an album the user never
    // synced cannot be written. It must not take the rest of the migration down.
    seedAlbum('a1', { name: 'Alpha' });
    putKv('substreamer-album-info', {
      entries: { a1: { albumInfo: { notes: 'Kept' } }, ghost: { albumInfo: { notes: 'Lost' } }, '': {}, bad: null },
    });

    await migrateBlobsToNormalized(db());

    expect((await getAlbumInfoRow(db(), 'a1'))?.notes).toBe('Kept');
    expect(await getAlbumInfoRow(db(), 'ghost')).toBeNull();
  });
});

// The legacy tables are no longer created at boot, so which of them exist depends on how
// old the install is. The probe is per-table for exactly this reason: an all-or-nothing
// guard would silently discard a v8.0.84-lineage install's entire song catalogue.
describe('migrateBlobsToNormalized — absent legacy tables', () => {
  afterEach(() => {
    createLegacyBlobTables(db());
    db().runSync('DELETE FROM storage WHERE key = ?', ['substreamer-album-library']);
  });

  it('migrates songs + album details when only library_albums is absent (v8.0.84 lineage)', async () => {
    seedSong('s1', 'a1', { title: 'Track One' });
    seedAlbumDetail('a1', { song: [{ id: 's1', title: 'Track One', isDir: false }] });
    // That lineage kept its album list in the KV blob, not the table.
    putKv('substreamer-album-library', { albums: [{ id: 'a1', name: 'Alpha' }] });
    db().execSync('DROP TABLE library_albums');

    const result = await migrateBlobsToNormalized(db());

    expect(result.songs.migrated).toBe(1);
    expect(await countSongs(db())).toBe(1);
    // The KV album source stays unconditional — it is this cohort's only album source.
    expect(await countAlbums(db())).toBe(1);
  });

  it('returns zero counts without throwing when none of the three exist (fresh install)', async () => {
    for (const t of ['library_albums', 'song_index', 'album_details']) {
      db().execSync(`DROP TABLE ${t}`);
    }

    const result = await migrateBlobsToNormalized(db());

    expect(result.albums).toEqual({ source: 0, migrated: 0, skipped: 0 });
    expect(result.songs).toEqual({ source: 0, migrated: 0, skipped: 0 });
    expect(await countAlbums(db())).toBe(0);
    expect(await countSongs(db())).toBe(0);
  });
});

describe('checkpointWalAsync', () => {
  it('truncates the WAL and reports how long it took', async () => {
    const log = jest.fn();
    await expect(checkpointWalAsync(db(), log)).resolves.toBeGreaterThanOrEqual(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('WAL checkpointed'));
  });

  it('logs and returns rather than throwing when the checkpoint fails', async () => {
    // A checkpoint can lose to another connection holding the DB. It runs
    // fire-and-forget behind the migration, so a rejection here would surface as an
    // unhandled one with nothing to catch it.
    const log = jest.fn();
    const failing = {
      ...db(),
      runAsync: () => Promise.reject(new Error('database is locked')),
    } as unknown as ReturnType<typeof db>;
    await expect(checkpointWalAsync(failing, log)).resolves.toBeGreaterThanOrEqual(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('WAL checkpoint failed'));
  });
});
