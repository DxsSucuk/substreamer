/**
 * Per-row SQLite persistence for `completedScrobbleStore` — query helpers
 * only. The shared handle, PRAGMAs, schema, health reporting, and test
 * injection live in `./db.ts`.
 *
 * Writes become silent no-ops when `getDb()` returns null (DB init failed)
 * — callers don't need to handle exceptions.
 */
import { getDb, type BatchCommand, type InternalDb } from './db';
import {
  childFromSnapshotRow,
  childSnapshotArrayCommands,
  type ChildSnapshotArrays,
  type ChildSnapshotRow,
} from '../../db/childSnapshot';
import { type CompletedScrobble } from '../completedScrobbleStore';
import {
  deriveScrobbleColumns,
  scrobbleColumnValues,
  SCROBBLE_COLUMN_NAMES,
  type ScrobbleColumns,
} from './scrobbleColumns';

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
/*  Row → CompletedScrobble                                            */
/* ------------------------------------------------------------------ */

/** `scrobble_events` column → the `ChildSnapshotRow` key it restores. Aliasing in
 *  SQL means a selected row IS the shape `childFromSnapshotRow` takes, so there is
 *  no second column-name mapping to drift. `hour`/`day_key` are derived from `time`
 *  and belong to no `Child` field, so they are absent. */
const SNAPSHOT_COLUMNS = {
  song_id: 'id',
  title: 'title',
  artist: 'artist',
  album: 'album',
  cover_art: 'coverArt',
  duration: 'duration',
  album_id: 'albumId',
  artist_id: 'artistId',
  display_artist: 'displayArtist',
  display_composer: 'displayComposer',
  track: 'track',
  disc_number: 'discNumber',
  year: 'year',
  genre: 'genre',
  suffix: 'suffix',
  bit_rate: 'bitRate',
  size: 'size',
  content_type: 'contentType',
  bpm: 'bpm',
  path: 'path',
  parent: 'parent',
  sort_name: 'sortName',
  music_brainz_id: 'musicBrainzId',
  explicit_status: 'explicitStatus',
  user_rating: 'userRating',
  average_rating: 'averageRating',
  play_count: 'playCount',
  created: 'created',
  starred: 'starred',
  played: 'played',
  rg_track_gain: 'rgTrackGain',
  rg_track_peak: 'rgTrackPeak',
  // `satisfies`, not an annotation: both sides are checked, so a column that is not
  // in `ScrobbleColumns` or a key that is not on `ChildSnapshotRow` fails to compile.
} as const satisfies Partial<Record<keyof ScrobbleColumns, keyof ChildSnapshotRow>>;

/** The reader SELECT list: the event's own id + time, then every snapshot column
 *  under its `ChildSnapshotRow` key. */
export const SCROBBLE_SELECT = [
  'id AS scrobbleId',
  'time',
  ...Object.entries(SNAPSHOT_COLUMNS).map(([col, key]) => (col === key ? col : `${col} AS ${key}`)),
].join(', ');

/** A `scrobble_events` row as {@link SCROBBLE_SELECT} returns it. `id`/`title` are
 *  nullable in SQL — a row the backfill could not decode carries `''` — so the
 *  readers filter before reconstructing. */
export interface ScrobbleSnapshotRow extends Partial<ChildSnapshotRow> {
  scrobbleId: string;
  time: number;
}

const NO_ARRAYS: ChildSnapshotArrays = {};

/**
 * The ONE reconstruction, shared by every reader: a selected row plus its child-table
 * arrays back into a `CompletedScrobble`. Callers filter for validity first — every
 * consumer needs `song_id`, and the readers whose rows are rendered and played need
 * `title` as well. Omit `arrays` where the consumer reads none of the five.
 */
export function rowToScrobble(
  row: ScrobbleSnapshotRow,
  arrays: ChildSnapshotArrays = NO_ARRAYS,
): CompletedScrobble {
  return {
    id: row.scrobbleId,
    song: childFromSnapshotRow({ ...row, id: row.id ?? '', title: row.title ?? '' }, arrays),
    time: row.time,
  };
}

/** Mutable twin of `ChildSnapshotArrays`, built by pushing the grouped rows. */
interface MutableArrays {
  genres?: string[];
  artists?: { artistId: string | null; artistName: string | null }[];
  albumArtists?: { artistId: string | null; artistName: string | null }[];
  contributors?: {
    role: string;
    subRole: string | null;
    artistId: string | null;
    artistName: string | null;
  }[];
  moods?: string[];
}

interface CreditRow {
  scrobble_id: string;
  artist_id: string | null;
  artist_name: string | null;
}

/**
 * The five `scrobble_*` child tables for a page of scrobble ids: ONE query per table,
 * grouped in JS. A per-row query would be 5×N round trips on a read `addCompleted`
 * triggers after every completed play. The id list binds as JSON through `json_each`
 * rather than an N-wide `IN (…)`, the pattern `existingScrobbleIds` already uses.
 */
async function loadScrobbleArrays(
  db: InternalDb,
  ids: readonly string[],
): Promise<Map<string, ChildSnapshotArrays>> {
  const out = new Map<string, MutableArrays>();
  if (ids.length === 0) return out;
  const params = [JSON.stringify([...ids])];
  const select = (table: string, cols: string): string =>
    `SELECT scrobble_id, ${cols} FROM scrobble_${table} ` +
    'WHERE scrobble_id IN (SELECT value FROM json_each(?)) ORDER BY scrobble_id, pos;';
  const [genres, artists, albumArtists, contributors, moods] = await Promise.all([
    db.getAllAsync<{ scrobble_id: string; name: string }>(select('genres', 'name'), params),
    db.getAllAsync<CreditRow>(select('artists', 'artist_id, artist_name'), params),
    db.getAllAsync<CreditRow>(select('album_artists', 'artist_id, artist_name'), params),
    db.getAllAsync<CreditRow & { role: string; sub_role: string | null }>(
      select('contributors', 'role, sub_role, artist_id, artist_name'),
      params,
    ),
    db.getAllAsync<{ scrobble_id: string; mood: string }>(select('moods', 'mood'), params),
  ]);
  const bucket = (id: string): MutableArrays => {
    const existing = out.get(id);
    if (existing !== undefined) return existing;
    const fresh: MutableArrays = {};
    out.set(id, fresh);
    return fresh;
  };
  const credit = (r: CreditRow): { artistId: string | null; artistName: string | null } => ({
    artistId: r.artist_id,
    artistName: r.artist_name,
  });
  for (const r of genres) (bucket(r.scrobble_id).genres ??= []).push(r.name);
  for (const r of artists) (bucket(r.scrobble_id).artists ??= []).push(credit(r));
  for (const r of albumArtists) (bucket(r.scrobble_id).albumArtists ??= []).push(credit(r));
  for (const r of contributors) {
    (bucket(r.scrobble_id).contributors ??= []).push({
      role: r.role,
      subRole: r.sub_role,
      ...credit(r),
    });
  }
  for (const r of moods) (bucket(r.scrobble_id).moods ??= []).push(r.mood);
  return out;
}

/**
 * Rows → scrobbles for the three readers whose output is rendered and played: drops
 * rows missing `song_id`/`title`, then hydrates the five arrays in one query per
 * table for the whole page.
 */
export async function scrobblesWithArrays(
  db: InternalDb,
  rows: readonly ScrobbleSnapshotRow[],
): Promise<CompletedScrobble[]> {
  const valid = rows.filter((r) => !!r.id && !!r.title);
  if (valid.length === 0) return [];
  const arrays = await loadScrobbleArrays(
    db,
    valid.map((r) => r.scrobbleId),
  );
  return valid.map((r) => rowToScrobble(r, arrays.get(r.scrobbleId) ?? NO_ARRAYS));
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
      const chunk = await scrobblesWithArrays(db, rows.slice(i, i + SCROBBLE_HYDRATE_CHUNK));
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
