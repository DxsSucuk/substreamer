/**
 * Per-row SQLite persistence for `pendingScrobbleStore` — query helpers
 * only. Mirrors `scrobbleTable.ts` (completed scrobbles) so the pair
 * stays on a single consistent model.
 *
 * A pending row carries the SAME `Child` snapshot as a completed one, minus the
 * time-derived `hour`/`day_key` buckets: `processScrobbles` hands the reconstructed
 * song straight to `addCompleted`, which derives the completed row's columns from it,
 * so anything dropped here is dropped from the history too.
 *
 * Writes become silent no-ops when `getDb()` returns null (DB init failed)
 * — callers don't need to handle exceptions.
 */
import { getDb, type BatchCommand } from './db';
import { childSnapshotArrayCommands } from '../../db/childSnapshot';
import { type PendingScrobble } from '../pendingScrobbleStore';
import {
  deriveScrobbleColumns,
  scrobbleColumnValues,
  PENDING_SCROBBLE_COLUMN_NAMES,
} from './scrobbleColumns';
import {
  backfillSnapshotColumnsAsync,
  SCROBBLE_SELECT,
  scrobblesWithArrays,
  type ScrobbleSnapshotRow,
} from './scrobbleSnapshot';

/** Full INSERT with the snapshot columns (see scrobbleColumns.ts). */
const INSERT_SQL =
  `INSERT OR IGNORE INTO pending_scrobble_events ` +
  `(id, song_json, time, ${PENDING_SCROBBLE_COLUMN_NAMES.join(', ')}) ` +
  `VALUES (${new Array(3 + PENDING_SCROBBLE_COLUMN_NAMES.length).fill('?').join(', ')});`;

/** `song_json` is written EMPTY. The typed columns plus the five
 *  `pending_scrobble_*` child tables are the record now and the reader reconstructs
 *  from them; the column stays NOT NULL only until a shadow-table rebuild can drop it. */
const insertParams = (s: PendingScrobble): (string | number | null)[] => [
  s.id,
  '',
  s.time,
  ...scrobbleColumnValues(deriveScrobbleColumns(s.song, s.time), PENDING_SCROBBLE_COLUMN_NAMES),
];

/**
 * INSERT tuples for a bulk write, skipping invalid records and duplicate ids. Each
 * parent row is followed by its five `pending_scrobble_*` child writes — parent
 * FIRST, or the FK rejects the children under `PRAGMA foreign_keys = ON`.
 *
 * The child commands delete-then-insert, which is what makes an `INSERT OR IGNORE`
 * over an id that already exists safe: without the DELETEs the child INSERT would hit
 * the `(scrobble_id, pos)` PK and abort the batch.
 */
function insertCommands(scrobbles: readonly PendingScrobble[]): BatchCommand[] {
  const seen = new Set<string>();
  const commands: BatchCommand[] = [];
  for (const s of scrobbles) {
    if (!s?.id || !s.song?.id || !s.song.title) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    commands.push(
      [INSERT_SQL, insertParams(s)],
      ...childSnapshotArrayCommands({
        tablePrefix: 'pending_scrobble',
        key: { scrobble_id: s.id },
        child: s.song,
      }),
    );
  }
  return commands;
}

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

/** Rows reconstructed per macrotask yield during async hydration. */
const PENDING_HYDRATE_CHUNK = 1000;

/**
 * Populate the snapshot columns and the five `pending_scrobble_*` child tables for
 * queued rows written before the columns existed. Shared implementation with
 * `scrobble_events`, so the stamp/termination rules are identical.
 */
export async function backfillPendingScrobbleColumnsAsync(): Promise<void> {
  await backfillSnapshotColumnsAsync({
    table: 'pending_scrobble_events',
    columnNames: PENDING_SCROBBLE_COLUMN_NAMES,
    tablePrefix: 'pending_scrobble',
  });
}

/**
 * Read every pending scrobble row in time order, reconstructing each song from the
 * typed columns and the five `pending_scrobble_*` child tables — one child query per
 * table per chunk, never one per row.
 *
 * The column backfill runs FIRST: rows queued by a version that only wrote the
 * envelope have no columns, and an offline play dropped here is never submitted and
 * never deleted from the queue. Rows still missing `song_id`/`title` after it are
 * skipped, which is what the backfill's `''` title stamp exists for.
 *
 * Chunked with `setTimeout(0)` yields so the boot path can't freeze the JS thread
 * (setTimeout, not rAF — rAF can stall on RN 0.85/Fabric). Used by `rehydrateAllStores`.
 */
export async function hydratePendingScrobblesAsync(): Promise<PendingScrobble[]> {
  const db = getDb();
  if (db === null) return [];
  await backfillPendingScrobbleColumnsAsync();
  try {
    const rows = await db.getAllAsync<ScrobbleSnapshotRow>(
      `SELECT ${SCROBBLE_SELECT} FROM pending_scrobble_events ORDER BY time ASC;`,
    );
    const out: PendingScrobble[] = [];
    for (let i = 0; i < rows.length; i += PENDING_HYDRATE_CHUNK) {
      if (i > 0) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      // eslint-disable-next-line no-await-in-loop
      const chunk = await scrobblesWithArrays(
        db,
        'pending_scrobble',
        rows.slice(i, i + PENDING_HYDRATE_CHUNK),
      );
      for (const s of chunk) out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Writes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Insert one pending scrobble and its five `pending_scrobble_*` child rows as ONE
 * atomic batch — the children FK to the parent, so the pair can never half-apply.
 * Uses INSERT OR IGNORE so re-inserting the same id is a silent no-op (the store
 * already dedupes in memory but this protects against concurrent-call edge cases
 * without throwing). An invalid record produces no commands and is dropped by
 * `insertCommands`.
 */
export async function insertPendingScrobble(scrobble: PendingScrobble): Promise<void> {
  const db = getDb();
  if (db === null) return;
  const commands = insertCommands([scrobble]);
  if (commands.length === 0) return;
  try {
    await db.runAtomicBatchAsync(commands);
  } catch {
    /* dropped */
  }
}

/**
 * Remove a single pending scrobble row. Called from
 * `scrobbleService.processScrobbles` after a successful server
 * submission (or when the item is already in the completed store).
 * The five child tables cascade with it.
 */
export async function deletePendingScrobble(id: string): Promise<void> {
  const db = getDb();
  if (db === null || !id) return;
  try {
    await db.runAsync('DELETE FROM pending_scrobble_events WHERE id = ?;', [id]);
  } catch {
    /* dropped */
  }
}

/**
 * Wipe and bulk-insert the full pending set as ONE atomic batch.
 * Used by the one-shot blob → per-row migration.
 * Invalid/duplicate records are filtered before insertion.
 *
 * The DELETE cascades the old child rows away, including those of an id that is about
 * to be re-inserted — so the re-INSERT has to bring its arrays back with it.
 */
export async function replaceAllPendingScrobbles(
  scrobbles: readonly PendingScrobble[],
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAtomicBatchAsync([
      ['DELETE FROM pending_scrobble_events;', []],
      ...insertCommands(scrobbles),
    ]);
  } catch {
    /* dropped */
  }
}

/** Remove every row. Used on logout via resetAllStores. */
export async function clearPendingScrobbles(): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAsync('DELETE FROM pending_scrobble_events;');
  } catch {
    /* dropped */
  }
}
