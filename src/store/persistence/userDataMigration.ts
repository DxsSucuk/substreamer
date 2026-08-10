/**
 * The one-time move of the `mbid-overrides` and `scrobble-exclusions` KV blobs into their
 * tables.
 *
 * Both are user-AUTHORED with nowhere on the server to live: a correction the user looked
 * up by hand and an opt-out they set deliberately have no source to refetch from, so
 * neither may be dropped and refilled the way a server-owned cache can. Rows are written,
 * READ BACK and only then is the blob's copy given up. A verification failure THROWS,
 * which leaves the migration counter where it was: the blob is untouched, both stores keep
 * hydrating from it, and the next launch retries. Nothing that could poison a batch is
 * written — an entry missing a NOT NULL column is dropped on the way in and the display
 * text is coerced to text/null — so a throw can only mean a transient DB failure, which is
 * the case a retry fixes.
 *
 * Idempotent: re-running upserts the same rows by key, and a blob already stripped has
 * nothing left to migrate.
 */
import { kvStorage } from './kvStorage';
import {
  overrideName,
  readMbidOverrides,
  storableOverrides,
  writeMbidOverrides,
} from './mbidOverrideTable';
import {
  exclusionName,
  readScrobbleExclusions,
  storableExclusions,
  writeScrobbleExclusions,
  type ScrobbleExclusionMaps,
} from './scrobbleExclusionTable';

import type { MbidOverride } from '../mbidOverrideStore';

const OVERRIDES_KEY = 'substreamer-mbid-overrides';
const EXCLUSIONS_KEY = 'substreamer-scrobble-exclusions';

/** Zustand's persist envelope. Only the migrated fields are removed — anything else
 *  sharing the key has no table and must survive. */
interface PersistBlob {
  state?: Record<string, unknown>;
  version?: number;
}

/** Read one persist envelope. `null` means there is nothing to do: the key is absent or
 *  unparseable. */
async function readBlob(
  key: string,
  label: string,
  log: (message: string) => void,
): Promise<PersistBlob | null> {
  const raw = await kvStorage.getItem(key);
  if (!raw) {
    log(`[m42] no ${label} blob — nothing to migrate`);
    return null;
  }
  try {
    return JSON.parse(raw) as PersistBlob;
  } catch {
    // Unparseable is unrecoverable, and throwing would retry it on every launch forever.
    // Left in place rather than deleted, in case it is salvageable by hand.
    log(`[m42] ${label} blob unparseable — left in place`);
    return null;
  }
}

/** Rewrite the envelope without the migrated fields, keeping everything else. */
async function stripFields(
  key: string,
  fields: readonly string[],
  blob: PersistBlob,
): Promise<void> {
  if (blob.state) for (const field of fields) delete blob.state[field];
  await kvStorage.setItem(key, JSON.stringify(blob));
}

/**
 * MBID overrides: blob → rows, then read the rows back and only then drop the blob's
 * copy. The mbid is verified, not just the key — it is the whole content of the entry.
 *
 * @throws when an override the blob holds is not readable back from the rows.
 */
async function migrateOverrides(log: (message: string) => void): Promise<void> {
  const blob = await readBlob(OVERRIDES_KEY, 'mbid-overrides', log);
  if (blob === null) return;
  const stored = blob.state?.overrides;
  const held = stored && typeof stored === 'object' ? Object.values(stored) : [];
  const migratable = storableOverrides(held as MbidOverride[]);
  if (migratable.length === 0) {
    log(`[m42] mbid-overrides blob holds none to migrate (${held.length} entries)`);
    return;
  }

  // A UNION write, never a replacing one. These are user-authored with no source to
  // refetch from, so the migration may ADD but never remove: an override saved after the
  // upgrade but before this runs exists as a row while the blob still lags behind it, and
  // a replacing write would delete it.
  await writeMbidOverrides(migratable);

  // Read back. `writeMbidOverrides` swallows its own failures, so "it returned" proves
  // nothing.
  const rows = await readMbidOverrides();
  if (rows === null) {
    throw new Error('[m42] mbid_overrides unreadable after the write');
  }
  const byKey = new Map(rows.map((o) => [`${o.type}:${o.entityId}`, o]));
  const unstored = migratable.filter((o) => {
    const row = byKey.get(`${o.type}:${o.entityId}`);
    return row?.mbid !== o.mbid || row.entityName !== overrideName(o.entityName);
  });
  if (unstored.length > 0) {
    throw new Error(
      `[m42] ${unstored.length}/${migratable.length} mbid overrides did not store; blob kept`,
    );
  }

  await stripFields(OVERRIDES_KEY, ['overrides'], blob);
  log(`[m42] migrated ${migratable.length} mbid overrides into rows; blob copy removed`);
}

/**
 * Scrobble exclusions: blob → rows, then read the rows back and only then drop the blob's
 * copy. The three maps collapse onto one table with a `type` discriminator.
 *
 * @throws when an exclusion the blob holds is not readable back from the rows.
 */
async function migrateExclusions(log: (message: string) => void): Promise<void> {
  const blob = await readBlob(EXCLUSIONS_KEY, 'scrobble-exclusions', log);
  if (blob === null) return;
  const migratable = storableExclusions((blob.state ?? {}) as Partial<ScrobbleExclusionMaps>);
  if (migratable.length === 0) {
    log('[m42] scrobble-exclusions blob holds none to migrate');
    return;
  }

  // A UNION write, for the same reason the overrides half uses one.
  await writeScrobbleExclusions(migratable);

  const maps = await readScrobbleExclusions();
  if (maps === null) {
    throw new Error('[m42] scrobble_exclusions unreadable after the write');
  }
  const stored = new Map(
    storableExclusions(maps).map((e) => [`${e.type}:${e.id}`, e]),
  );
  const unstored = migratable.filter(
    (e) => stored.get(`${e.type}:${e.id}`)?.name !== exclusionName(e.name),
  );
  if (unstored.length > 0) {
    throw new Error(
      `[m42] ${unstored.length}/${migratable.length} scrobble exclusions did not store; blob kept`,
    );
  }

  await stripFields(
    EXCLUSIONS_KEY,
    ['excludedAlbums', 'excludedArtists', 'excludedPlaylists'],
    blob,
  );
  log(`[m42] migrated ${migratable.length} scrobble exclusions into rows; blob copy removed`);
}

/** Overrides first — a failure in either half leaves both blobs readable, and the retry
 *  re-runs the pair. */
export async function migrateUserDataFromKv(
  log: (message: string) => void,
): Promise<void> {
  await migrateOverrides(log);
  await migrateExclusions(log);
}
