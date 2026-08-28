/**
 * The sync's id-enumeration primitives — the two sets the basic song walk diffs to
 * decide which albums still need their tracks.
 */
import type { AlbumID3, Child } from 'subsonic-api';

import { getDb } from '../../../store/persistence/db';
import { ensureNormalizedSchema } from '../../createNormalizedTables';
import { listAlbumIds, upsertAlbums } from '../albums';
import { listSongAlbumIds, upsertSongs } from '../songs';

const db = () => getDb()!;
const album = (id: string): AlbumID3 => ({ id, name: id, created: new Date(0), duration: 0, songCount: 0 });
const song = (id: string, albumId: string): Child => ({ id, title: id, albumId, isDir: false });

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  db().runSync('DELETE FROM albums');
  db().runSync('DELETE FROM songs');
});

it('listAlbumIds returns every album id', async () => {
  await upsertAlbums(db(), [album('a1'), album('a2'), album('a3')]);
  expect((await listAlbumIds(db())).sort()).toEqual(['a1', 'a2', 'a3']);
});

it('listSongAlbumIds returns the distinct albums that already have songs', async () => {
  await upsertSongs(db(), [song('s1', 'a1'), song('s2', 'a1'), song('s3', 'a2')]);
  expect((await listSongAlbumIds(db())).sort()).toEqual(['a1', 'a2']);
});
