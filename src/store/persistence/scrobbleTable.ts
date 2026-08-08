/**
 * Per-row SQLite persistence for `completedScrobbleStore` — query helpers
 * only. The shared handle, PRAGMAs, schema, health reporting, and test
 * injection live in `./db.ts`.
 *
 * Writes become silent no-ops when `getDb()` returns null (DB init failed)
 * — callers don't need to handle exceptions.
 */
import { getDb, type BatchCommand } from './db';
import { childSnapshotArrayCommands } from '../../db/childSnapshot';
import { type CompletedScrobble } from '../completedScrobbleStore';
import {
  deriveScrobbleColumns,
  scrobbleColumnValues,
  SCROBBLE_COLUMN_NAMES,
} from './scrobbleColumns';
import {
  backfillSnapshotColumnsAsync,
  SCROBBLE_SELECT,
  scrobblesWithArrays,
  type ScrobbleSnapshotRow,
} from './scrobbleSnapshot';

/** Full INSERT with the structured analytics columns (see scrobbleColumns.ts). */
const INSERT_SQL =
  `INSERT OR IGNORE INTO scrobble_events (id, song_json, time, ${SCROBBLE_COLUMN_NAMES.join(', ')}) ` +
  `VALUES (${new Array(3 + SCROBBLE_COLUMN_NAMES.length).fill('?').join(', ')});`;

/** `song_json` is written EMPTY. The typed columns plus the five `scrobble_*` child
 *  tables are the record now and every reader reconstructs from them; the column
 *  stays NOT NULL only until a shadow-table rebuild can drop it. */
const insertParams = (s: CompletedScrobble): (string | number | null)[] => [
  s.id,
  '',
  s.time,
  ...scrobbleColumnValues(deriveScrobbleColumns(s.song, s.time)),
];

/**
 * INSERT tuples for a bulk write, skipping invalid records and duplicate ids. Each
 * parent row is followed by its five `scrobble_*` child writes — parent FIRST, or
 * the FK rejects the children under `PRAGMA foreign_keys = ON`. (The backfill's
 * order is the opposite, and for a different reason: there the parent already
 * exists and the scalar UPDATE is what clears the re-select marker.)
 *
 * The child commands delete-then-insert, which is what makes an `INSERT OR IGNORE`
 * over an id that already exists safe: without the DELETEs the child INSERT would
 * hit the `(scrobble_id, pos)` PK and abort the batch.
 */
function insertCommands(scrobbles: readonly CompletedScrobble[]): BatchCommand[] {
  const seen = new Set<string>();
  const commands: BatchCommand[] = [];
  for (const s of scrobbles) {
    if (!s?.id || !s.song?.id || !s.song.title) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    commands.push(
      [INSERT_SQL, insertParams(s)],
      ...childSnapshotArrayCommands({
        tablePrefix: 'scrobble',
        keyColumn: 'scrobble_id',
        keyValue: s.id,
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
const SCROBBLE_HYDRATE_CHUNK = 1000;

/**
 * Read every scrobble row in time order, skipping rows missing the `song_id` /
 * `title` a restored row needs to render. Rows are reconstructed from the typed
 * columns and the five `scrobble_*` child tables — one child query per table per
 * chunk, so a full history costs a bounded number of round trips, not one per row.
 * Chunked with `setTimeout(0)` yields so a large history can't freeze the JS thread
 * at boot; setTimeout, not rAF — rAF can stall on RN 0.85/Fabric.
 */
export async function hydrateScrobblesAsync(): Promise<CompletedScrobble[]> {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = await db.getAllAsync<ScrobbleSnapshotRow>(
      `SELECT ${SCROBBLE_SELECT} FROM scrobble_events ORDER BY time ASC;`,
    );
    const out: CompletedScrobble[] = [];
    for (let i = 0; i < rows.length; i += SCROBBLE_HYDRATE_CHUNK) {
      if (i > 0) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      // eslint-disable-next-line no-await-in-loop
      const chunk = await scrobblesWithArrays(
        db,
        'scrobble',
        rows.slice(i, i + SCROBBLE_HYDRATE_CHUNK),
      );
      for (const s of chunk) out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Which of the given ids already exist as completed scrobbles. Used by the
 * scrobble processor to skip pending items already committed as completed.
 */
export async function existingScrobbleIds(ids: readonly string[]): Promise<Set<string>> {
  const db = getDb();
  if (db === null || ids.length === 0) return new Set<string>();
  try {
    const rows = await db.getAllAsync<{ id: string }>(
      'SELECT id FROM scrobble_events WHERE id IN (SELECT value FROM json_each(?));',
      [JSON.stringify([...ids])],
    );
    return new Set(rows.map((r) => r.id));
  } catch {
    return new Set<string>();
  }
}

/** Return the total scrobble row count. Used by diagnostics. */
export async function countScrobbles(): Promise<number> {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM scrobble_events;');
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Writes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Insert one scrobble and its five `scrobble_*` child rows as ONE atomic batch —
 * the children FK to the parent, so the pair can never half-apply. Uses INSERT OR
 * IGNORE so re-inserting the same id is a silent no-op (the store already dedupes
 * in memory but this protects against concurrent-call edge cases without throwing).
 * An invalid record produces no commands and is dropped by `insertCommands`.
 */
export async function insertScrobble(scrobble: CompletedScrobble): Promise<void> {
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
 * Merge the given scrobbles into the existing set, INSERT OR IGNORE per row.
 * Used by merge-mode backup restore so a backup from another device unifies
 * with locally-accumulated scrobbles instead of replacing them.
 *
 * Invalid records are filtered before insertion. Returns `{ added, skipped }`
 * where `added` is the number of rows actually inserted (not already present)
 * and `skipped` is the number of inputs ignored (duplicates or invalid).
 */
export async function mergeScrobbles(
  scrobbles: readonly CompletedScrobble[],
): Promise<{ added: number; skipped: number }> {
  const db = getDb();
  if (db === null) return { added: 0, skipped: scrobbles.length };
  try {
    const before = await countScrobbles();
    await db.runAtomicBatchAsync(insertCommands(scrobbles));
    const after = await countScrobbles();
    const added = Math.max(0, after - before);
    return { added, skipped: scrobbles.length - added };
  } catch {
    return { added: 0, skipped: scrobbles.length };
  }
}

/**
 * Wipe and bulk-insert the full scrobble set as ONE atomic batch.
 * Used by backup restore and the one-shot blob → per-row migration (task #13).
 * Invalid/duplicate records are filtered before insertion.
 */
export async function replaceAllScrobbles(scrobbles: readonly CompletedScrobble[]): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAtomicBatchAsync([
      ['DELETE FROM scrobble_events;', []],
      ...insertCommands(scrobbles),
    ]);
  } catch {
    /* dropped */
  }
}

/**
 * Populate the snapshot columns and the five `scrobble_*` child tables for rows that
 * predate them. Shared implementation — `pending_scrobble_events` runs the same pass
 * over its own tables.
 */
export async function backfillScrobbleColumnsAsync(): Promise<void> {
  await backfillSnapshotColumnsAsync({
    table: 'scrobble_events',
    columnNames: SCROBBLE_COLUMN_NAMES,
    tablePrefix: 'scrobble',
  });
}

/** Remove every row. Used on logout via resetAllStores. */
export async function clearScrobbles(): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAsync('DELETE FROM scrobble_events;');
  } catch {
    /* dropped */
  }
}
