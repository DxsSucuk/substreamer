/**
 * The incremental album-persist path (upsert/delete of `library_albums`) must ALSO
 * keep the normalized `albums` table current (sub-phase 2.1), so a pull-to-refresh /
 * scan-added or -removed album shows up in the keyset list without a full resync.
 * These run the REAL functions against the better-sqlite3-backed DB — a green run also
 * proves the normalized write is serialized correctly (the mock throws on a nested
 * transaction, so a txn-in-txn regression would fail here).
 */
import { getDb } from '../db';
import { countAlbums, getAlbum } from '../../../db/repository/albums';
import { deleteLibraryAlbumsAsync, upsertLibraryAlbumsAsync } from '../libraryAlbumsTable';

const db = () => getDb()!;
const sortKey = (a: { name?: string }) => (a.name ?? '').toLowerCase();
const album = (id: string, name: string) => ({ id, name, artist: 'X' }) as never;

beforeEach(() => {
  db().runSync('DELETE FROM albums');
  db().runSync('DELETE FROM library_albums');
});

describe('libraryAlbumsTable → normalized dual-write (incremental authoritative)', () => {
  it('upsert also populates the normalized albums table', async () => {
    await upsertLibraryAlbumsAsync([album('a1', 'Alpha'), album('a2', 'Bravo')], sortKey);
    expect(await countAlbums(db())).toBe(2);
    expect((await getAlbum(db(), 'a1'))?.name).toBe('Alpha');
  });

  it('skips the normalized write when syncNormalized=false (play-stats path)', async () => {
    await upsertLibraryAlbumsAsync([album('a1', 'Alpha')], sortKey, { syncNormalized: false });
    // blob written, but normalized untouched
    expect(await countAlbums(db())).toBe(0);
    expect(db().getFirstSync("SELECT id FROM library_albums WHERE id='a1'")).toBeTruthy();
  });

  it('delete removes the normalized row too (no ghost albums)', async () => {
    await upsertLibraryAlbumsAsync([album('a1', 'Alpha'), album('a2', 'Bravo')], sortKey);
    await deleteLibraryAlbumsAsync(['a1']);
    expect(await countAlbums(db())).toBe(1);
    expect(await getAlbum(db(), 'a1')).toBeNull();
    expect(await getAlbum(db(), 'a2')).not.toBeNull();
  });
});
