/**
 * Everything the two scrobble tables share about their `Child` snapshot: the SELECT
 * list, the row → scrobble reconstruction, the batched child-table fetch and the
 * one-time backfill of rows written before the columns existed.
 *
 * `scrobble_events` and `pending_scrobble_events` hold the same snapshot columns
 * (pending drops only the time-derived `hour`/`day_key` buckets) and the same five
 * positional child tables, so all of it is parameterised by table name and child-table
 * prefix instead of being written twice. A pending row becomes a completed one via
 * `addCompleted`, so any drift between the two would silently lose fields at that
 * hand-off.
 */
import { getDb, type BatchCommand, type InternalDb } from './db';
import {
  childFromSnapshotRow,
  childSnapshotArrayCommands,
  type ChildSnapshotArrays,
  type ChildSnapshotRow,
} from '../../db/childSnapshot';
import {
  deriveScrobbleColumns,
  scrobbleColumnValues,
  type ScrobbleColumns,
} from './scrobbleColumns';

import type { Child } from 'subsonic-api';

/** A stored scrobble, reconstructed. Structurally the `CompletedScrobble` /
 *  `PendingScrobble` both stores declare — the row shape is the same on both sides
 *  of the queue. */
export interface ScrobbleSnapshot {
  id: string;
  song: Child;
  time: number;
}

/** The child tables' key column, the same in both families. */
const CHILD_KEY_COLUMN = 'scrobble_id';

/** Snapshot column → the `ChildSnapshotRow` key it restores. Aliasing in SQL means a
 *  selected row IS the shape `childFromSnapshotRow` takes, so there is no second
 *  column-name mapping to drift. `hour`/`day_key` are derived from `time` and belong
 *  to no `Child` field, so they are absent — which is also why this list is valid for
 *  the pending table, whose columns are the full set minus exactly those two. */
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

/** A scrobble row as {@link SCROBBLE_SELECT} returns it. `id`/`title` are nullable in
 *  SQL — a row the backfill could not decode carries `''` — so the readers filter
 *  before reconstructing. */
export interface ScrobbleSnapshotRow extends Partial<ChildSnapshotRow> {
  scrobbleId: string;
  time: number;
}

const NO_ARRAYS: ChildSnapshotArrays = {};

/**
 * The ONE reconstruction, shared by every reader: a selected row plus its child-table
 * arrays back into a scrobble. Callers filter for validity first — every consumer
 * needs `song_id`, and the readers whose rows are rendered and played need `title` as
 * well. Omit `arrays` where the consumer reads none of the five.
 */
export function rowToScrobble(
  row: ScrobbleSnapshotRow,
  arrays: ChildSnapshotArrays = NO_ARRAYS,
): ScrobbleSnapshot {
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
 * The five child tables for a page of scrobble ids: ONE query per table, grouped in
 * JS. A per-row query would be 5×N round trips on a read `addCompleted` triggers after
 * every completed play. The id list binds as JSON through `json_each` rather than an
 * N-wide `IN (…)`, the pattern `existingScrobbleIds` already uses.
 */
async function loadScrobbleArrays(
  db: InternalDb,
  tablePrefix: string,
  ids: readonly string[],
): Promise<Map<string, ChildSnapshotArrays>> {
  const out = new Map<string, MutableArrays>();
  if (ids.length === 0) return out;
  const params = [JSON.stringify([...ids])];
  const select = (table: string, cols: string): string =>
    `SELECT ${CHILD_KEY_COLUMN}, ${cols} FROM ${tablePrefix}_${table} ` +
    `WHERE ${CHILD_KEY_COLUMN} IN (SELECT value FROM json_each(?)) ` +
    `ORDER BY ${CHILD_KEY_COLUMN}, pos;`;
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
 * Rows → scrobbles for the readers whose output is rendered and played: drops rows
 * missing `song_id`/`title`, then hydrates the five arrays in one query per table for
 * the whole page.
 */
export async function scrobblesWithArrays(
  db: InternalDb,
  tablePrefix: string,
  rows: readonly ScrobbleSnapshotRow[],
): Promise<ScrobbleSnapshot[]> {
  const valid = rows.filter((r) => !!r.id && !!r.title);
  if (valid.length === 0) return [];
  const arrays = await loadScrobbleArrays(
    db,
    tablePrefix,
    valid.map((r) => r.scrobbleId),
  );
  return valid.map((r) => rowToScrobble(r, arrays.get(r.scrobbleId) ?? NO_ARRAYS));
}

/* ------------------------------------------------------------------ */
/*  Backfill                                                           */
/* ------------------------------------------------------------------ */

/** Rows-per-chunk for the one-time backfill of derived columns on existing rows. */
const BACKFILL_CHUNK = 500;

/**
 * Populate the snapshot columns and the five child tables for rows that predate them.
 * Chunked to keep the JS thread responsive on a large upgrade history. Parses each
 * row's `song_json` and derives the same columns the write path stores.
 *
 * The predicate is `song_id IS NULL OR title IS NULL`: `song_id` alone would skip
 * every row an earlier app version already backfilled under a narrower column set.
 * `title` is the marker for "carries the current set" — which is why every path below
 * must leave it non-NULL, or the row is selected forever.
 *
 * `runBatchAsync` is NOT atomic, so a chunk can half-apply. Each row's child rows are
 * written before its scalar UPDATE, and the child commands delete-then-insert: an
 * abort leaves `title` NULL, the row is re-selected next pass, and the DELETEs clear
 * whatever partial rows landed. No duplicates, no stale tail.
 *
 * No DDL here: both tables are declared in `src/db/schema.ts`, so
 * `ensureNormalizedSchema` adds any missing column and only then creates the indexes —
 * which is what stops an `hour` index being created before the `hour` column exists.
 */
export async function backfillSnapshotColumnsAsync(spec: {
  table: string;
  columnNames: readonly (keyof ScrobbleColumns)[];
  tablePrefix: string;
}): Promise<void> {
  const { table, columnNames, tablePrefix } = spec;
  const db = getDb();
  if (db === null) return;
  try {
    // Loop until no un-backfilled rows remain (each pass takes a bounded chunk).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await db.getAllAsync<{ id: string; song_json: string; time: number }>(
        `SELECT id, song_json, time FROM ${table} WHERE song_id IS NULL OR title IS NULL LIMIT ?;`,
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
            `UPDATE ${table} SET song_id = ?, title = '' WHERE id = ?;`,
            [row.id, row.id],
          ]);
          continue;
        }
        const child = song as Child;
        updates.push(
          ...childSnapshotArrayCommands({
            tablePrefix,
            key: { [CHILD_KEY_COLUMN]: row.id },
            child,
          }),
        );
        const cols = deriveScrobbleColumns(child, row.time);
        updates.push([
          `UPDATE ${table} SET ${columnNames.map((c) => `${c} = ?`).join(', ')} WHERE id = ?;`,
          [...scrobbleColumnValues(cols, columnNames), row.id],
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
    /* best-effort — consumers degrade gracefully on any unbackfilled rows */
  }
}
