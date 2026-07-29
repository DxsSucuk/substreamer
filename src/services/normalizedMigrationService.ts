/**
 * Background orchestrator for the blob→normalized migration.
 *
 * Runs POST-splash via the idle scheduler — NEVER on the blocking splash (on a
 * 200k-album library the migration is minutes long). It is completeness-agnostic:
 * it converts whatever the legacy blob caches (`library_albums`, `song_index`) +
 * the artist/playlist KV blobs currently hold. A partial prior sync is fine — the
 * user manually re-syncs if songs are missing (see the plan's deferred
 * "reliable-completeness" item; the sync-complete flags are known to lie at scale).
 *
 * Trigger = a DRIFT CHECK, not a one-shot flag: it runs only when the blob tables
 * hold more rows than the normalized tables (the initial upgrade, or a manual
 * re-sync that grew the blobs). Once the live sync dual-writes both (next phase),
 * they stay in step and this is a cheap no-op. Upserts are idempotent, so a kill
 * mid-run just re-runs next launch. Progress surfaces on the library-sync chrome.
 */
import { ensureNormalizedSchema } from '@/db/createNormalizedTables';
import { checkpointWalAsync, migrateBlobsToNormalized } from '@/db/migrateNormalized';
import type { InternalDb } from '@/db/client';
import { getDb } from '@/store/persistence/db';
import { syncStatusStore } from '@/store/syncStatusStore';

let inFlight: Promise<void> | null = null;

const countTable = async (db: InternalDb, table: string): Promise<number> => {
  try {
    return (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0;
  } catch {
    return 0; // table may not exist yet
  }
};

/**
 * Convert any un-migrated legacy blob/KV data into the normalized tables, in the
 * background. Safe to call on every launch — returns immediately when the tables
 * are already in step, a run is in flight, or a live library sync is active (we
 * don't race the sync; the next idle pass picks up the drift).
 */
export function runNormalizedMigrationIfNeeded(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const db = getDb();
      if (!db) return;

      // Don't race an active library/song sync — but don't just skip for the whole
      // session either: wait for it to settle (blobs will be fuller then), then run.
      const sync = syncStatusStore.getState();
      const activeSync = sync.getInFlight('song-sync') ?? sync.getInFlight('full-walk');
      if (activeSync) {
        void activeSync.finally(() => {
          void runNormalizedMigrationIfNeeded();
        });
        return;
      }

      ensureNormalizedSchema(db);
      const [blobAlbums, normAlbums, blobSongs, normSongs] = await Promise.all([
        countTable(db, 'library_albums'),
        countTable(db, 'albums'),
        countTable(db, 'song_index'),
        countTable(db, 'songs'),
      ]);
      // Nothing un-migrated → no-op (steady state once the sync dual-writes both).
      if (blobAlbums <= normAlbums && blobSongs <= normSongs) return;

      syncStatusStore.getState().setNormalizedMigration('migrating', 0, 0);
      const result = await migrateBlobsToNormalized(db, undefined, undefined, (done, total) =>
        syncStatusStore.getState().setNormalizedMigration('migrating', done, total),
      );
      syncStatusStore.getState().setNormalizedMigration('idle', 0, 0);
      // Fold the (large) WAL in the background — does NOT block completion.
      void checkpointWalAsync(db);

      // eslint-disable-next-line no-console
      console.log('[normalized-migration] done', {
        albums: result.albums.migrated,
        songs: result.songs.migrated,
        artists: result.artists.migrated,
        playlists: result.playlists.migrated,
        ms: result.ms,
      });
    } catch (e) {
      // Leave the tables as-is; the drift check re-triggers next launch.
      syncStatusStore.getState().setNormalizedMigration('idle', 0, 0);
      // eslint-disable-next-line no-console
      console.warn('[normalized-migration] failed', e);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
