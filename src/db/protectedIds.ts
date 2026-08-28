/**
 * Download-protected playlist ids, read straight from the music-cache tables.
 *
 * The playlist prune must exclude playlists the user has downloaded — those tables are
 * the sole offline source for them. Derived by SQL rather than from `musicCacheStore`
 * because boot hydration swallows its own per-store failures, so the store can
 * legitimately be empty while the rows exist; reaping on that basis would delete exactly
 * what the protection is for.
 */
import type { InternalDb } from './client';

/**
 * Throws if the table can't be read. Callers MUST treat that as "skip the reconcile":
 * an empty protected set is indistinguishable from "nothing is downloaded", so
 * proceeding on a failed read would reap the user's offline library.
 */
export async function getProtectedPlaylistIds(db: InternalDb): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ id: string | null }>(
    "SELECT item_id AS id FROM cached_items WHERE type = 'playlist'",
  );
  return new Set(rows.map((r) => r.id).filter((v): v is string => !!v));
}
