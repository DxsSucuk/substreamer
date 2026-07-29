import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { countAlbums } from '../../db/repository/albums';
import { countSongs } from '../../db/repository/songs';
import { getDb } from '../../store/persistence/db';
import { syncStatusStore } from '../../store/syncStatusStore';
import { runNormalizedMigrationIfNeeded } from '../normalizedMigrationService';

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
  syncStatusStore.setState({
    inFlight: new Map(),
    normalizedMigrationPhase: 'idle',
    normalizedMigrationDone: 0,
    normalizedMigrationTotal: 0,
  });
});

describe('runNormalizedMigrationIfNeeded', () => {
  it('migrates when the blobs hold rows the normalized tables lack, then settles', async () => {
    seedAlbum('a1');
    seedSong('s1', 'a1');
    seedSong('s2', 'a1');

    await runNormalizedMigrationIfNeeded();

    expect(await countAlbums(db())).toBe(1);
    expect(await countSongs(db())).toBe(2);
    // phase returns to idle so the banner/card clear
    expect(syncStatusStore.getState().normalizedMigrationPhase).toBe('idle');
  });

  it('is a no-op when the tables are already in step (no drift)', async () => {
    // both blob + normalized empty → no drift → nothing migrated
    await runNormalizedMigrationIfNeeded();
    expect(await countSongs(db())).toBe(0);
    expect(syncStatusStore.getState().normalizedMigrationPhase).toBe('idle');
  });

  it('does not race an in-flight library sync', async () => {
    seedAlbum('a1');
    seedSong('s1', 'a1');
    syncStatusStore.getState().setInFlight('song-sync', Promise.resolve());

    await runNormalizedMigrationIfNeeded();

    // skipped while the sync holds the lock; drift is picked up on a later pass
    expect(await countSongs(db())).toBe(0);
    syncStatusStore.getState().clearInFlight('song-sync');
  });
});
