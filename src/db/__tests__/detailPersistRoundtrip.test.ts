/**
 * Round-trip: the detail dual-writes must PERSIST so a re-open reads the data back from
 * the normalized tables (the "no data on return" bug). Verifies write→read for album,
 * playlist (membership), and artist (albums + bio).
 */
import type { AlbumWithSongsID3, ArtistInfo2, ArtistWithAlbumsID3, Child, Playlist } from 'subsonic-api';

import { getDb } from '../../store/persistence/db';
import { ensureNormalizedSchema } from '../createNormalizedTables';
import {
  writeAlbumDetailToNormalized,
  writeArtistDetailToNormalized,
  writePlaylistDetailToNormalized,
} from '../normalizedSyncWriter';
import { getAlbumDetail, getArtistDetail, getPlaylistDetail } from '../repository/details';

const db = () => getDb()!;
const song = (id: string, extra: Partial<Child> = {}): Child => ({ id, title: id, isDir: false, ...extra });

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

it('album detail persists songs → getAlbumDetail reads them back', async () => {
  await writeAlbumDetailToNormalized(db(), {
    id: 'al1',
    name: 'Rocks',
    song: [song('s1', { albumId: 'al1', track: 1 }), song('s2', { albumId: 'al1', track: 2 })],
  } as AlbumWithSongsID3);
  const d = await getAlbumDetail(db(), 'al1');
  expect(d?.songs.map((s) => s.id).sort()).toEqual(['s1', 's2']);
});

it('playlist detail persists MEMBERSHIP → getPlaylistDetail reads tracks back', async () => {
  await writePlaylistDetailToNormalized(db(), {
    id: 'p1',
    name: 'Mix',
    entry: [song('s2'), song('s1')],
  } as Playlist & { entry: Child[] });
  const d = await getPlaylistDetail(db(), 'p1');
  expect(d?.entry.map((e) => e.id)).toEqual(['s2', 's1']); // position order
});

it('artist detail persists albums + RESOLVED bio + topSongs + similar → getArtistDetail reads them back', async () => {
  await writeArtistDetailToNormalized(
    db(),
    {
      id: 'ar1',
      name: 'Aerosmith',
      albumCount: 1,
      album: [{ id: 'al1', name: 'Rocks', artistId: 'ar1' }],
    } as ArtistWithAlbumsID3,
    {
      biography: 'A server bio that should be overridden.',
      similarArtist: [{ id: 'ar2', name: 'Kiss', coverArt: 'ca2', albumCount: 3 }],
    } as ArtistInfo2,
    {
      biography: 'An American rock band.',
      resolvedMbid: 'mbid-123',
      bioCheckedAt: 1_700_000_000_000,
      topSongs: [song('t1', { title: 'Dream On' }), song('t2', { title: 'Walk This Way' })],
    },
  );
  const d = await getArtistDetail(db(), 'ar1');
  expect(d?.albums.map((a) => a.id)).toEqual(['al1']);
  // The RESOLVED bio (MB-or-Subsonic) wins over the server info bio.
  expect(d?.biography).toBe('An American rock band.');
  expect(d?.resolvedMbid).toBe('mbid-123');
  expect(d?.bioCheckedAt).toBe(1_700_000_000_000);
  // Top songs persist in stored order via the artist_top_songs junction.
  expect(d?.topSongs.map((s) => s.id)).toEqual(['t1', 't2']);
  // Similar artists keep denormalized art + album count for the cards.
  expect(
    d?.similarArtist.map((s) => ({ id: s.id, name: s.name, coverArt: s.coverArt, albumCount: s.albumCount })),
  ).toEqual([{ id: 'ar2', name: 'Kiss', coverArt: 'ca2', albumCount: 3 }]);
});
