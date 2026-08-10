/**
 * Physically drop the two legacy `song_json` envelope columns, once per install.
 *
 * Both tables carry the whole `Child` snapshot in typed columns plus five positional
 * child tables; `song_json` is written EMPTY and read by nothing but the backfill that
 * populates those columns for rows written before them.
 * `ALTER TABLE … DROP COLUMN` is available (op-SQLite vendors SQLite
 * 3.51.3 on both platforms), so this needs no shadow-table rebuild — which would in
 * fact be destructive here, because under `PRAGMA foreign_keys = ON` a `DROP TABLE`
 * cascades the five child tables empty.
 *
 * ORDER IS THE WHOLE SAFETY ARGUMENT. The backfill swallows every error and writes
 * through the non-atomic `runBatchAsync`, so "it ran" is not "it finished". It is run
 * to completion here and the remaining work set asserted EMPTY before the column that
 * feeds it is destroyed; anything else is unrecoverable scrobble loss.
 *
 * OFF the boot path (idle-scheduled from `_layout.tsx`). No cursor and no KV state:
 * the schema is its own progress marker, so a kill mid-run just re-reads
 * `PRAGMA table_info` next launch and skips what is already gone.
 */
import { completedScrobbleStore } from '../store/completedScrobbleStore';
import { errMessage } from '../utils/errorMessage';
import { getDb, type InternalDb } from '../store/persistence/db';
import { backfillPendingScrobbleColumnsAsync } from '../store/persistence/pendingScrobbleTable';
import {
  envelopeColumnPresent,
  resetEnvelopeColumnCache,
} from '../store/persistence/scrobbleSnapshot';
import { backfillScrobbleColumnsAsync } from '../store/persistence/scrobbleTable';
import { syncStatusStore } from '../store/syncStatusStore';
import { migrationChainComplete } from './migrationService';

/** The two tables and the backfill that clears each one's work set. */
const SPECS = [
  { table: 'scrobble_events', backfill: backfillScrobbleColumnsAsync },
  { table: 'pending_scrobble_events', backfill: backfillPendingScrobbleColumnsAsync },
] as const;

/** Rows the backfill has not (or could not) resolve. `title` is the marker for
 *  "carries the current column set" — `song_id` alone would pass rows an earlier,
 *  narrower backfill stamped. */
async function unbackfilledRows(db: InternalDb, table: string): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM ${table} WHERE song_id IS NULL OR title IS NULL;`,
  );
  return row?.c ?? -1;
}

let inFlight: Promise<void> | null = null;

/**
 * Drop the columns if this install still has them and the backfill can be proved
 * complete. Safe to call on every launch: once the columns are gone the whole pass is
 * a single `PRAGMA table_info` per table.
 */
export function runLegacyColumnDropIfNeeded(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const db = getDb();
      if (!db) return;

      const pending: (typeof SPECS)[number][] = [];
      for (const spec of SPECS) {
        // eslint-disable-next-line no-await-in-loop
        if (await envelopeColumnPresent(db, spec.table)) pending.push(spec);
      }
      if (pending.length === 0) return;

      // A half-run chain leaves rows its later tasks were meant to backfill, and
      // migration task 3 runs this very backfill — let the chain finish first.
      if (!(await migrationChainComplete())) return;
      // Don't add a whole-table rewrite to the pool queue while a sync is draining it.
      const sync = syncStatusStore.getState();
      if (sync.getInFlight('song-sync') ?? sync.getInFlight('full-walk')) return;

      for (const spec of pending) {
        // eslint-disable-next-line no-await-in-loop
        await spec.backfill();
      }
      for (const spec of SPECS) {
        // eslint-disable-next-line no-await-in-loop
        if ((await unbackfilledRows(db, spec.table)) !== 0) return;
      }

      // One statement at a time in autocommit: each is a whole-table rewrite, and
      // wrapping them would hold a savepoint across both on the single pool thread.
      // The writers' cached column set is invalidated per table, not once at the end,
      // so a failure on the second drop cannot leave the first one's writes naming a
      // column that is already gone.
      for (const spec of pending) {
        // eslint-disable-next-line no-await-in-loop
        await db.runAsync(`ALTER TABLE ${spec.table} DROP COLUMN song_json;`);
        resetEnvelopeColumnCache();
      }

      // The store hydrated before the backfill ran, so its analytics and recent list
      // are missing whatever the backfill just recovered. Recompute rather than make
      // the user relaunch for their own history.
      await completedScrobbleStore.getState().refreshFromDb();

      // eslint-disable-next-line no-console
      console.log('[legacy-column-drop] done', { tables: pending.map((s) => s.table) });
    } catch (e) {
      // The columns that survived are re-detected next launch; nothing to unwind.
      // eslint-disable-next-line no-console
      console.warn('[legacy-column-drop] failed', errMessage(e));
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Test-only: drop the shared in-flight promise between cases. */
export const __resetLegacyColumnDropForTests = (): void => {
  inFlight = null;
};
