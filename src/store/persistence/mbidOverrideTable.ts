/**
 * Per-row SQLite persistence for `mbidOverrideStore` — the user's manual MusicBrainz
 * corrections. The shared handle, PRAGMAs, schema and test injection live in `./db.ts`.
 *
 * `(type, entity_id)` is the PK, which is exactly what the store's `"artist:id"` map key
 * encodes, so the map rebuilds from the columns rather than from a stored string.
 *
 * There is nowhere on the server for an override to live, so this is the only copy: the
 * set is never capped, evicted or pruned, and `readMbidOverrides` separates "no rows"
 * from "could not read".
 *
 * Writes become silent no-ops when `getDb()` returns null (DB init failed) — callers
 * don't need to handle exceptions.
 */
import { getDb, type BatchCommand } from './db';

import { type MbidOverride, type MbidOverrideType } from '../mbidOverrideStore';

const UPSERT_SQL =
  'INSERT INTO mbid_overrides (type, entity_id, entity_name, mbid) VALUES (?, ?, ?, ?) ' +
  'ON CONFLICT(type, entity_id) DO UPDATE SET entity_name = excluded.entity_name, ' +
  'mbid = excluded.mbid;';

/** Display text only: anything that is not a string normalises to `''`, so nothing
 *  unbindable reaches the batch. The hydration gate normalises the in-memory side through
 *  this same function, so a hand-edited backup entry cannot leave the store stranded on
 *  KV forever. (The column stays nullable, and the read maps NULL to `''` for a row
 *  written by anything but this module.) */
export const overrideName = (v: unknown): string => (typeof v === 'string' ? v : '');

const isType = (v: unknown): v is MbidOverrideType => v === 'artist' || v === 'album';

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * The overrides that will actually store. `type`, `entity_id` and `mbid` are the NOT NULL
 * columns, and an override with no mbid has nothing to override with — dropping it here
 * costs that entry rather than aborting the whole batch.
 */
export const storableOverrides = (
  overrides: readonly MbidOverride[],
): MbidOverride[] =>
  overrides.filter(
    (o): o is MbidOverride =>
      !!o && typeof o === 'object' && isType(o.type) && isId(o.entityId) && isId(o.mbid),
  );

const upsertCommand = (o: MbidOverride): BatchCommand => [
  UPSERT_SQL,
  [o.type, o.entityId, overrideName(o.entityName), o.mbid],
];

/**
 * Add or update `overrides` without touching any other row — the write behind
 * `setOverride` and behind a merge-mode restore, which may only ADD.
 *
 * Filtering happens HERE rather than at the call sites, so there is no way to write an
 * entry that would fail a NOT NULL column and abort the batch.
 */
export async function writeMbidOverrides(
  overrides: readonly MbidOverride[],
): Promise<void> {
  const db = getDb();
  const storable = storableOverrides(overrides);
  if (db === null || storable.length === 0) return;
  try {
    await db.runAtomicBatchAsync(storable.map(upsertCommand));
  } catch {
    /* dropped */
  }
}

/**
 * Make the table exactly `overrides`, as ONE atomic batch (`runAtomicBatchAsync` —
 * `runBatchAsync` is not atomic). The leading DELETE is what a replace-mode restore
 * needs, and keeping it in the same batch is why a failure part-way leaves the old set
 * rather than a mixture of both.
 */
export async function replaceMbidOverrides(
  overrides: readonly MbidOverride[],
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  const commands: BatchCommand[] = [['DELETE FROM mbid_overrides;', []]];
  for (const o of storableOverrides(overrides)) commands.push(upsertCommand(o));
  try {
    await db.runAtomicBatchAsync(commands);
  } catch {
    /* dropped */
  }
}

/** Remove one override. */
export async function deleteMbidOverride(
  type: MbidOverrideType,
  entityId: string,
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAsync('DELETE FROM mbid_overrides WHERE type = ? AND entity_id = ?;', [
      type,
      entityId,
    ]);
  } catch {
    /* dropped */
  }
}

interface OverrideRow {
  type: string;
  entity_id: string;
  entity_name: string | null;
  mbid: string;
}

/**
 * Every stored override.
 *
 * **Null means "could not read", `[]` means "no overrides".** The caller replaces its
 * whole map from this, and a failed DB open answering `[]` would blank a set the user
 * typed by hand — and persist that blank straight back over the KV copy.
 */
export async function readMbidOverrides(): Promise<MbidOverride[] | null> {
  const db = getDb();
  if (db === null) return null;
  try {
    const rows = await db.getAllAsync<OverrideRow>(
      'SELECT type, entity_id, entity_name, mbid FROM mbid_overrides ORDER BY type, entity_id;',
    );
    return rows.map((r) => ({
      type: r.type as MbidOverrideType,
      entityId: r.entity_id,
      entityName: r.entity_name ?? '',
      mbid: r.mbid,
    }));
  } catch {
    return null;
  }
}
