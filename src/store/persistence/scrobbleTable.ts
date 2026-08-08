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

/** Full INSERT with the structured analytics columns (see scrobbleColumns.ts). */
const INSERT_SQL =
  `INSERT OR IGNORE INTO scrobble_events (id, song_json, time, ${SCROBBLE_COLUMN_NAMES.join(', ')}) ` +
  `VALUES (${new Array(3 + SCROBBLE_COLUMN_NAMES.length).fill('?').join(', ')});`;

const insertParams = (s: CompletedScrobble): (string | number | null)[] => [
  s.id,
  JSON.stringify(s.song),
  s.time,
  ...scrobbleColumnValues(deriveScrobbleColumns(s.song, s.time)),
];

/** INSERT tuples for a bulk write, skipping invalid records and duplicate ids. */
function insertCommands(scrobbles: readonly CompletedScrobble[]): BatchCommand[] {
  const seen = new Set<string>();
  const commands: BatchCommand[] = [];
  for (const s of scrobbles) {
    if (!s?.id || !s.song?.id || !s.song.title) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    commands.push([INSERT_SQL, insertParams(s)]);
  }
  return commands;
}

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

/** Scrobble rows parsed per macrotask yield during async hydration. */
const SCROBBLE_PARSE_CHUNK = 1000;

/**
 * Read every scrobble row in time order, skipping unparseable rows and rows
 * whose decoded song is invalid (missing id / title). The read runs on
 * expo-sqlite's background thread (`getAllAsync`) and the per-row
 * `JSON.parse(song_json)` is chunked with `setTimeout(0)` yields so a large
 * scrobble history doesn't freeze the JS thread at boot. setTimeout, not
 * rAF — rAF can stall on RN 0.85/Fabric.
 */
export async function hydrateScrobblesAsync(): Promise<CompletedScrobble[]> {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = await db.getAllAsync<{ id: string; song_json: string; time: number }>(
      'SELECT id, song_json, time FROM scrobble_events ORDER BY time ASC;',
    );
    const out: CompletedScrobble[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (i > 0 && i % SCROBBLE_PARSE_CHUNK === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (!row.id || seen.has(row.id)) continue;
      let song: unknown;
      try {
        song = JSON.parse(row.song_json);
      } catch {
        continue;
      }
      if (
        !song ||
        typeof song !== 'object' ||
        !(song as { id?: unknown }).id ||
        !(song as { title?: unknown }).title
      ) {
        continue;
      }
      seen.add(row.id);
      out.push({ id: row.id, song: song as CompletedScrobble['song'], time: row.time });
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
 * Insert one scrobble. Uses INSERT OR IGNORE so re-inserting the same id is a
 * silent no-op (the store already dedupes in memory but this protects against
 * concurrent-call edge cases without throwing).
 */
export async function insertScrobble(scrobble: CompletedScrobble): Promise<void> {
  const db = getDb();
  if (db === null) return;
  if (!scrobble.id || !scrobble.song?.id || !scrobble.song.title) return;
  try {
    await db.runAsync(INSERT_SQL, insertParams(scrobble));
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

/** Rows-per-chunk for the one-time backfill of derived columns on existing rows. */
const BACKFILL_CHUNK = 500;

/**
 * Populate the derived columns and the five `scrobble_*` child tables for rows
 * that predate them. Chunked to keep the JS thread responsive on a large upgrade
 * history. Parses each row's `song_json` and derives the same columns the write
 * path stores.
 *
 * The predicate is `song_id IS NULL OR title IS NULL`: `song_id` alone would skip
 * every row an earlier app version already backfilled under the narrower column
 * set. `title` is the marker for "carries the current set" — which is why every
 * path below must leave it non-NULL, or the row is selected forever.
 *
 * `runBatchAsync` is NOT atomic, so a chunk can half-apply. Each row's child rows
 * are written before its scalar UPDATE, and the child commands delete-then-insert:
 * an abort leaves `title` NULL, the row is re-selected next pass, and the DELETEs
 * clear whatever partial rows landed. No duplicates, no stale tail.
 *
 * No DDL here: `scrobble_events` is declared in `src/db/schema.ts`, so
 * `ensureNormalizedSchema` adds any missing column and only then creates the indexes —
 * which is what stops an `hour` index being created before the `hour` column exists.
 */
export async function backfillScrobbleColumnsAsync(): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    // Loop until no un-backfilled rows remain (each pass takes a bounded chunk).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await db.getAllAsync<{ id: string; song_json: string; time: number }>(
        'SELECT id, song_json, time FROM scrobble_events WHERE song_id IS NULL OR title IS NULL LIMIT ?;',
        [BACKFILL_CHUNK],
      );
      if (rows.length === 0) break;
      const updates: BatchCommand[] = [];
      for (const row of rows) {
        let song: unknown;
        try {
          song = JSON.parse(row.song_json);
        } catch {
          song = null;
        }
        if (
          !song ||
          typeof song !== 'object' ||
          !(song as { id?: unknown }).id ||
          !(song as { title?: unknown }).title
        ) {
          // Unparseable, or missing the id/title every reader requires. Stamp BOTH
          // markers — a `song_id` alone still matches `title IS NULL` — with a ''
          // title, which no reader accepts, so the row stays invisible.
          updates.push([
            "UPDATE scrobble_events SET song_id = ?, title = '' WHERE id = ?;",
            [row.id, row.id],
          ]);
          continue;
        }
        const child = song as CompletedScrobble['song'];
        updates.push(
          ...childSnapshotArrayCommands({
            tablePrefix: 'scrobble',
            keyColumn: 'scrobble_id',
            keyValue: row.id,
            child,
          }),
        );
        const cols = deriveScrobbleColumns(child, row.time);
        updates.push([
          `UPDATE scrobble_events SET ${SCROBBLE_COLUMN_NAMES.map((c) => `${c} = ?`).join(', ')} WHERE id = ?;`,
          [...scrobbleColumnValues(cols), row.id],
        ]);
      }
      // eslint-disable-next-line no-await-in-loop
      await db.runBatchAsync(updates);
      if (rows.length < BACKFILL_CHUNK) break;
      // Yield between chunks so a large history can't freeze the JS thread.
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } catch {
    /* best-effort — analytics degrade gracefully on any unbackfilled rows */
  }
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
