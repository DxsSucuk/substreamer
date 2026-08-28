/**
 * The one-time move of the `genres` and `shares` KV blobs into their tables.
 *
 * **Both are MIGRATED, not dropped and refilled.** The rule this step draws out: a cache
 * may be dropped and refilled only when the refill happens invisibly on a path the user
 * is already taking. The lyrics cache qualified — the player fetches them on the path
 * the user is already on. These do not: the share browser renders its empty state off
 * `shares.length === 0`, so a dropped blob shows "no shares" until a fetch completes,
 * and shows it indefinitely offline, where today the cached list appears. Genres feed
 * the Tuned In mixes the same way.
 *
 * Rows are written, READ BACK and only then is the blob's copy given up. A verification
 * failure THROWS, which leaves the migration counter where it was: the blob is
 * untouched, both stores keep hydrating from it, and the next launch retries. Nothing
 * that could poison a batch is written — an entry whose key is not a non-empty string is
 * dropped on the way in and every other column is coerced to text/number/null — so a
 * throw can only mean a transient DB failure, which is the case a retry fixes.
 *
 * Idempotent: re-running rewrites the same rows, and a blob already stripped has nothing
 * left to migrate.
 *
 * Both halves write with the same REPLACE the stores use, rather than the union write
 * bookmarks needed. Bookmarks are user-authored with no source to refetch from, so the
 * migration there may add but never remove; a genre list and a share set are server-owned
 * and the next fetch restores either whole.
 */
import { readGenres, replaceGenres } from './genresTable';
import { readShares, replaceShares, storableEntries, storableShares } from './sharesTable';
import { kvStorage } from './kvStorage';

import type { Genre, Share } from '../../services/subsonicService';

const GENRES_KEY = 'substreamer-genres';
const SHARES_KEY = 'substreamer-shares';

/** Zustand's persist envelope. Only the migrated field is removed — anything else
 *  sharing the key has no table and must survive. */
interface PersistBlob {
  state?: Record<string, unknown>;
  version?: number;
}

/** Read one persist envelope's array field. `null` means there is nothing to do:
 *  the key is absent, unparseable, or the field is not an array. */
async function readBlobArray<T>(
  key: string,
  field: string,
  log: (message: string) => void,
): Promise<{ blob: PersistBlob; items: T[] } | null> {
  const raw = await kvStorage.getItem(key);
  if (!raw) {
    log(`[m38] no ${field} blob — nothing to migrate`);
    return null;
  }
  let blob: PersistBlob;
  try {
    blob = JSON.parse(raw) as PersistBlob;
  } catch {
    // Unparseable is unrecoverable, and throwing would retry it on every launch
    // forever. Left in place rather than deleted, in case it is salvageable by hand.
    log(`[m38] ${field} blob unparseable — left in place`);
    return null;
  }
  const stored = blob.state?.[field];
  if (!Array.isArray(stored)) {
    log(`[m38] ${field} blob holds no array — nothing to migrate`);
    return null;
  }
  return { blob, items: stored as T[] };
}

/** Rewrite the envelope without the migrated field, keeping everything else. */
async function stripField(key: string, field: string, blob: PersistBlob): Promise<void> {
  if (blob.state) delete blob.state[field];
  await kvStorage.setItem(key, JSON.stringify(blob));
}

/**
 * Genres: blob → rows, then read the rows back and only then drop the blob's copy.
 *
 * @throws when a genre the blob holds is not readable back from the rows.
 */
async function migrateGenres(log: (message: string) => void): Promise<void> {
  const found = await readBlobArray<Genre>(GENRES_KEY, 'genres', log);
  if (found === null) return;
  const migratable = found.items.filter(
    (g) => !!g && typeof g.value === 'string' && g.value.length > 0,
  );
  if (migratable.length === 0) {
    log(`[m38] genres blob holds none to migrate (${found.items.length} entries)`);
    return;
  }

  await replaceGenres(migratable);

  // Read back. `replaceGenres` swallows its own failures, so "it returned" proves
  // nothing.
  const stored = await readGenres();
  if (stored === null) {
    throw new Error('[m38] genre rows unreadable after the write');
  }
  const storedNames = new Set(stored.map((g) => g.value));
  const unstored = migratable.filter((g) => !storedNames.has(g.value));
  if (unstored.length > 0) {
    throw new Error(
      `[m38] ${unstored.length}/${migratable.length} genres did not store; blob kept`,
    );
  }

  await stripField(GENRES_KEY, 'genres', found.blob);
  log(`[m38] migrated ${migratable.length} genres into rows; blob copy removed`);
}

/**
 * Shares: blob → rows, then read the rows back and only then drop the blob's copy.
 * The entries are verified per share, not just the parent rows — a share whose entries
 * were lost renders with no title and no artwork.
 *
 * @throws when a share the blob holds is not readable back from the rows.
 */
async function migrateShares(log: (message: string) => void): Promise<void> {
  const found = await readBlobArray<Share>(SHARES_KEY, 'shares', log);
  if (found === null) return;
  const migratable = storableShares(found.items);
  if (migratable.length === 0) {
    log(`[m38] shares blob holds none to migrate (${found.items.length} entries)`);
    return;
  }

  await replaceShares(migratable);

  const stored = await readShares();
  if (stored === null) {
    throw new Error('[m38] share rows unreadable after the write');
  }
  const counts = new Map(stored.map((s) => [s.id, s.entry?.length ?? 0]));
  const unstored = migratable.filter(
    (s) => !counts.has(s.id) || (counts.get(s.id) ?? 0) !== storableEntries(s).length,
  );
  if (unstored.length > 0) {
    throw new Error(
      `[m38] ${unstored.length}/${migratable.length} shares did not store; blob kept`,
    );
  }

  await stripField(SHARES_KEY, 'shares', found.blob);
  log(`[m38] migrated ${migratable.length} shares into rows; blob copy removed`);
}

/** Genres first — a failure in either half leaves both blobs readable, and the retry
 *  re-runs the pair. */
export async function migrateGenresAndSharesFromKv(
  log: (message: string) => void,
): Promise<void> {
  await migrateGenres(log);
  await migrateShares(log);
}
