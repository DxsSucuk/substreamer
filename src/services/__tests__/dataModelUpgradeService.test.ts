import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { countAlbums } from '../../db/repository/albums';
import { countArtists } from '../../db/repository/artists';
import { countSongs } from '../../db/repository/songs';
import { getDb } from '../../store/persistence/db';
import { syncStatusStore } from '../../store/syncStatusStore';
import { runDataModelUpgradeIfNeeded } from '../dataModelUpgradeService';

const db = () => getDb()!;

const seedAlbum = (id: string) =>
  db().runSync('INSERT OR REPLACE INTO library_albums (id, sortKey, raw_json) VALUES (?, ?, ?)', [
    id,
    id,
    JSON.stringify({ id, name: id, created: '2020-01-01', duration: 1, songCount: 1 }),
  ]);
const seedSong = (id: string, albumId: string) =>
  db().runSync('INSERT OR REPLACE INTO song_index (id, albumId, raw_json) VALUES (?, ?, ?)', [
    id,
    albumId,
    JSON.stringify({ id, albumId, title: id, isDir: false }),
  ]);

beforeEach(() => {
  ensureNormalizedSchema(db());
  for (const t of ['library_albums', 'song_index', 'albums', 'songs', 'artists', 'playlists']) {
    db().runSync(`DELETE FROM ${t}`);
  }
  // Reset the one-time completion flag + any seeded KV so each test starts unstamped.
  db().runSync("DELETE FROM storage WHERE key IN ('substreamer-normalized-migration-complete', 'substreamer-artist-library')");
  syncStatusStore.setState({
    inFlight: new Map(),
    normalizedMigrationPhase: 'idle',
    normalizedMigrationDone: 0,
    normalizedMigrationTotal: 0,
  });
});

describe('runDataModelUpgradeIfNeeded', () => {
  it('migrates when the blobs hold rows the normalized tables lack, then settles', async () => {
    seedAlbum('a1');
    seedSong('s1', 'a1');
    seedSong('s2', 'a1');

    await runDataModelUpgradeIfNeeded();

    expect(await countAlbums(db())).toBe(1);
    expect(await countSongs(db())).toBe(2);
    // phase returns to idle so the banner/card clear
    expect(syncStatusStore.getState().normalizedMigrationPhase).toBe('idle');
  });

  it('is a no-op when there is nothing in the blob caches to migrate', async () => {
    await runDataModelUpgradeIfNeeded();
    expect(await countSongs(db())).toBe(0);
    expect(syncStatusStore.getState().normalizedMigrationPhase).toBe('idle');
  });

  it('never re-imports the frozen blob tables after the normalized model shrinks', async () => {
    // The trigger used to be a drift check (blobs hold more rows than normalized).
    // Nothing writes the blob tables any more, so their counts are a permanent
    // high-water mark: any later shrink — a reap, an interrupted resync, or the wipe on
    // a server switch — would re-import that stale library, in the switch case into a
    // different account's tables.
    seedAlbum('a1');
    seedSong('s1', 'a1');
    await runDataModelUpgradeIfNeeded();
    expect(await countSongs(db())).toBe(1);

    // Normalized emptied (e.g. server switch); the blob rows are still sitting there.
    db().runSync('DELETE FROM songs');
    db().runSync('DELETE FROM albums');
    await runDataModelUpgradeIfNeeded();
    expect(await countSongs(db())).toBe(0);
  });

  it('runs the one-time artist/playlist migration even when albums/songs are in step, then stamps', async () => {
    // Simulate a live sync having already populated albums/songs, while the artist KV
    // blob has never been migrated. The stamp guarantees this runs exactly once.
    db().runSync("INSERT OR REPLACE INTO storage (key, value) VALUES ('substreamer-artist-library', ?)", [
      JSON.stringify({ state: { artists: [{ id: 'ar1', name: 'Solo' }] }, version: 0 }),
    ]);

    await runDataModelUpgradeIfNeeded();
    expect(await countArtists(db())).toBe(1);

    // Now stamped: a second pass with no album/song drift is a true no-op (not re-run).
    db().runSync('DELETE FROM artists');
    await runDataModelUpgradeIfNeeded();
    expect(await countArtists(db())).toBe(0);
  });

  it('does not race an in-flight library sync', async () => {
    seedAlbum('a1');
    seedSong('s1', 'a1');
    syncStatusStore.getState().setInFlight('song-sync', Promise.resolve());

    await runDataModelUpgradeIfNeeded();

    // skipped while the sync holds the lock; drift is picked up on a later pass
    expect(await countSongs(db())).toBe(0);
    syncStatusStore.getState().clearInFlight('song-sync');
  });
});
