/**
 * Data-model upgrade migration — migrates a user's data from the OLD blob model
 * (`library_albums`/`song_index`/`album_details` + the artist/playlist KV blobs) into
 * the NEW normalized model, once, on the first launch after they upgrade to a build that
 * reads normalized. Background orchestrator.
 *
 * Runs POST-splash via the idle scheduler — NEVER on the blocking splash (on a
 * 200k-album library the migration is minutes long). It is completeness-agnostic:
 * it converts whatever the legacy blob caches (`library_albums`, `song_index`,
 * `album_details`) + the KV blobs they replaced currently hold. A partial prior sync is
 * fine — the user manually re-syncs if songs are missing.
 *
 * Gated on the migration chain having completed: it reads the legacy tables directly,
 * and a chain halted part-way leaves rows later tasks were meant to backfill.
 *
 * Trigger = a ONE-SHOT flag. Upserts are idempotent, so a kill mid-run just re-runs
 * next launch (the flag is only stamped on success). Progress surfaces on the
 * library-sync chrome.
 */
import { checkpointWalAsync, migrateBlobsToNormalized } from '@/db/migrateNormalized';
import { getDb } from '@/store/persistence/db';
import { kvStorage } from '@/store/persistence';
import { syncStatusStore } from '@/store/syncStatusStore';
import { LATEST_MIGRATION_ID } from './migrationService';

/** Stamped after a successful full migration; the sole trigger gate.
 *
 * VERSIONED rather than a boolean: when the migration gains a step, bump this so
 * already-stamped installs re-run (`migrateBlobsToNormalized` is idempotent upserts)
 * rather than stacking a second migration on top of the first. */
const MIGRATION_VERSION = '3';
const MIGRATION_DONE_KEY = 'substreamer-normalized-migration-complete';

/** `migrationStore`'s persisted KV row — read directly rather than through the store,
 *  which may not have rehydrated yet (the splash reads it the same way). */
const MIGRATION_VERSION_KEY = 'substreamer-migration';

let inFlight: Promise<void> | null = null;

/**
 * Has the migration chain run to the end? `runMigrations` stops at the FIRST failure and
 * persists the version of the last success, so a halted chain leaves legacy rows the
 * later tasks never backfilled — the ETL would read those as empty, count them
 * `skipped`, and stamp itself complete. Defer instead; the next launch retries the chain.
 * `>=`, not `==`: a downgrade leaves the counter above this build's latest id, and that
 * chain is complete by definition. A fresh install passes — the runner fast-tracks the
 * counter to the latest id.
 */
async function migrationChainComplete(): Promise<boolean> {
  try {
    const raw = await kvStorage.getItem(MIGRATION_VERSION_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { state?: { completedVersion?: number } };
    return (parsed?.state?.completedVersion ?? 0) >= LATEST_MIGRATION_ID;
  } catch {
    return false;
  }
}

/**
 * Convert any un-migrated legacy blob/KV data into the normalized tables, in the
 * background. Safe to call on every launch — returns immediately when the tables
 * are already in step, a run is in flight, or a live library sync is active (we
 * don't race the sync; the next idle pass picks up the drift).
 */
export function runDataModelUpgradeIfNeeded(): Promise<void> {
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
          void runDataModelUpgradeIfNeeded();
        });
        return;
      }

      // The ETL reads the legacy tables directly, so it must not run against
      // half-migrated legacy data — see `migrationChainComplete`.
      if (!(await migrationChainComplete())) return;

      // ONE-SHOT, never a drift check ("blobs hold more rows than normalized"). The blob
      // tables are frozen, so their counts are a permanent high-water mark: any later
      // shrink in normalized (a reap, an interrupted resync) would re-migrate that stale
      // library back in on top of current data.
      if ((await kvStorage.getItem(MIGRATION_DONE_KEY)) === MIGRATION_VERSION) return;

      syncStatusStore.getState().setNormalizedMigration('migrating', 0, 0);
      const result = await migrateBlobsToNormalized(db, undefined, undefined, (done, total) =>
        syncStatusStore.getState().setNormalizedMigration('migrating', done, total),
      );
      await kvStorage.setItem(MIGRATION_DONE_KEY, MIGRATION_VERSION);
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
      // Leave the tables as-is; the flag is unstamped, so the next launch retries.
      syncStatusStore.getState().setNormalizedMigration('idle', 0, 0);
      // eslint-disable-next-line no-console
      console.warn('[normalized-migration] failed', e);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
