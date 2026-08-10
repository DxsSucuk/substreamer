/**
 * Per-row SQLite persistence for `scrobbleExclusionStore` — the albums, artists and
 * playlists the user has opted out of scrobbling. The shared handle, PRAGMAs, schema and
 * test injection live in `./db.ts`.
 *
 * ONE table with a `type` discriminator, `(type, entity_id)` PK. The store holds three
 * maps only because a KV blob has no other way to express a discriminated set; the rows
 * carry the type, and {@link readScrobbleExclusions} splits them back out.
 *
 * There is nowhere on the server for an exclusion to live, so this is the only copy: the
 * set is never capped, evicted or pruned, and the read separates "no rows" from "could
 * not read".
 *
 * Writes become silent no-ops when `getDb()` returns null (DB init failed) — callers
 * don't need to handle exceptions.
 */
import { getDb, type BatchCommand } from './db';

import {
  type ScrobbleExclusion,
  type ScrobbleExclusionType,
} from '../scrobbleExclusionStore';

/** One exclusion with the type the row carries — the store keeps that in the map it
 *  lives in, the table keeps it in a column. */
export interface TypedScrobbleExclusion extends ScrobbleExclusion {
  type: ScrobbleExclusionType;
}

/** The three maps as the store holds them, and as a backup file carries them. */
export interface ScrobbleExclusionMaps {
  excludedAlbums: Record<string, ScrobbleExclusion>;
  excludedArtists: Record<string, ScrobbleExclusion>;
  excludedPlaylists: Record<string, ScrobbleExclusion>;
}

/** Which map each type lives in. The single source for both directions, so a new type
 *  cannot be added to one and forgotten in the other. */
export const EXCLUSION_FIELDS = {
  album: 'excludedAlbums',
  artist: 'excludedArtists',
  playlist: 'excludedPlaylists',
} as const satisfies Record<ScrobbleExclusionType, keyof ScrobbleExclusionMaps>;

export const EXCLUSION_TYPES = Object.keys(EXCLUSION_FIELDS) as ScrobbleExclusionType[];

const UPSERT_SQL =
  'INSERT INTO scrobble_exclusions (type, entity_id, name) VALUES (?, ?, ?) ' +
  'ON CONFLICT(type, entity_id) DO UPDATE SET name = excluded.name;';

/** Display text only: anything that is not a string normalises to `''`, so nothing
 *  unbindable reaches the batch. The hydration gate normalises the in-memory side through
 *  this same function, so a hand-edited backup entry cannot leave the store stranded on
 *  KV forever. (The column stays nullable, and the read maps NULL to `''` for a row
 *  written by anything but this module.) */
export const exclusionName = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The exclusions that will actually store. `type` and `entity_id` are NOT NULL, so an
 *  entry without them is dropped rather than aborting the batch. */
export const storableTypedExclusions = (
  list: readonly TypedScrobbleExclusion[],
): TypedScrobbleExclusion[] =>
  list.filter(
    (e) =>
      !!e &&
      typeof e === 'object' &&
      EXCLUSION_FIELDS[e.type] !== undefined &&
      typeof e.id === 'string' &&
      e.id.length > 0,
  );

/** The same, taking the three maps the store and a backup file carry. */
export const storableExclusions = (
  maps: Partial<ScrobbleExclusionMaps>,
): TypedScrobbleExclusion[] => {
  const flat: TypedScrobbleExclusion[] = [];
  for (const type of EXCLUSION_TYPES) {
    const map = maps[EXCLUSION_FIELDS[type]];
    if (!map || typeof map !== 'object') continue;
    for (const value of Object.values(map)) {
      if (!value || typeof value !== 'object') continue;
      flat.push({ type, id: value.id, name: value.name });
    }
  }
  return storableTypedExclusions(flat);
};

const upsertCommand = (e: TypedScrobbleExclusion): BatchCommand => [
  UPSERT_SQL,
  [e.type, e.id, exclusionName(e.name)],
];

/**
 * Add or update `exclusions` without touching any other row — the write behind
 * `addExclusion` and behind a merge-mode restore, which may only ADD.
 *
 * Filtering happens HERE rather than at the call sites, so there is no way to write an
 * entry that would fail a NOT NULL column and abort the batch.
 */
export async function writeScrobbleExclusions(
  exclusions: readonly TypedScrobbleExclusion[],
): Promise<void> {
  const db = getDb();
  const storable = storableTypedExclusions(exclusions);
  if (db === null || storable.length === 0) return;
  try {
    await db.runAtomicBatchAsync(storable.map(upsertCommand));
  } catch {
    /* dropped */
  }
}

/**
 * Make the table exactly `exclusions`, as ONE atomic batch (`runAtomicBatchAsync` —
 * `runBatchAsync` is not atomic). The leading DELETE is what a replace-mode restore
 * needs, and keeping it in the same batch is why a failure part-way leaves the old set
 * rather than a mixture of both.
 */
export async function replaceScrobbleExclusions(
  exclusions: readonly TypedScrobbleExclusion[],
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  const commands: BatchCommand[] = [['DELETE FROM scrobble_exclusions;', []]];
  for (const e of storableTypedExclusions(exclusions)) commands.push(upsertCommand(e));
  try {
    await db.runAtomicBatchAsync(commands);
  } catch {
    /* dropped */
  }
}

/** Remove one exclusion. */
export async function deleteScrobbleExclusion(
  type: ScrobbleExclusionType,
  id: string,
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAsync('DELETE FROM scrobble_exclusions WHERE type = ? AND entity_id = ?;', [
      type,
      id,
    ]);
  } catch {
    /* dropped */
  }
}

interface ExclusionRow {
  type: string;
  entity_id: string;
  name: string | null;
}

const emptyMaps = (): ScrobbleExclusionMaps => ({
  excludedAlbums: {},
  excludedArtists: {},
  excludedPlaylists: {},
});

/**
 * Every stored exclusion, split back into the three maps the store and the scrobble
 * check read (`song.albumId in excludedAlbums`).
 *
 * **Null means "could not read", empty maps mean "no exclusions".** The caller replaces
 * its whole state from this, and a failed DB open answering empty would start scrobbling
 * everything the user opted out of — and persist that blank over the KV copy.
 */
export async function readScrobbleExclusions(): Promise<ScrobbleExclusionMaps | null> {
  const db = getDb();
  if (db === null) return null;
  try {
    const rows = await db.getAllAsync<ExclusionRow>(
      'SELECT type, entity_id, name FROM scrobble_exclusions ORDER BY type, entity_id;',
    );
    const maps = emptyMaps();
    for (const row of rows) {
      const field = EXCLUSION_FIELDS[row.type as ScrobbleExclusionType];
      // A row whose type is not one of the three cannot be shown or matched; skipping it
      // is what keeps a hand-edited DB from producing a fourth, invisible map.
      if (field === undefined) continue;
      maps[field][row.entity_id] = { id: row.entity_id, name: row.name ?? '' };
    }
    return maps;
  } catch {
    return null;
  }
}
