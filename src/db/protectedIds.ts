/**
 * Download-protected entity ids, read straight from the music-cache tables.
 *
 * Every reconcile/prune path must exclude content the user has downloaded — those
 * tables are the sole offline source for it. Derived by SQL rather than from
 * `musicCacheStore` because boot hydration swallows its own per-store failures, so the
 * store can legitimately be empty while the rows exist; reaping on that basis would
 * delete exactly what the protection is for.
 */
import type { InternalDb } from './client';

export interface ProtectedIds {
  /** Albums downloaded as albums — never reap the row or its songs. */
  downloadedAlbumIds: Set<string>;
  /** Albums that merely PARENT a downloaded/favorited song, rather than being downloaded
   *  as albums themselves — their detail must survive a prune, but they must not
   *  resurrect in the browse list. */
  parentAlbumIds: Set<string>;
  /** Downloaded playlists — never prune. */
  playlistIds: Set<string>;
}

const idSet = async (db: InternalDb, sql: string): Promise<Set<string>> =>
  new Set(
    (await db.getAllAsync<{ id: string | null }>(sql))
      .map((r) => r.id)
      .filter((v): v is string => !!v),
  );

/**
 * Throws if the tables can't be read. Callers MUST treat that as "skip the reconcile":
 * an empty protected set is indistinguishable from "nothing is downloaded", so
 * proceeding on a failed read would reap the user's offline library.
 */
export async function getProtectedIds(db: InternalDb): Promise<ProtectedIds> {
  const [downloadedAlbumIds, parentAlbumIds, playlistIds] = await Promise.all([
    idSet(db, "SELECT item_id AS id FROM cached_items WHERE type = 'album'"),
    idSet(
      db,
      `SELECT parent_album_id AS id FROM cached_items
         WHERE type = 'song' AND parent_album_id IS NOT NULL
       UNION
       SELECT cs.album_id AS id FROM cached_item_songs e
         JOIN cached_items ci ON ci.item_id = e.item_id
         JOIN cached_songs cs ON cs.song_id = e.song_id
        WHERE ci.type IN ('favorites', 'playlist')`,
    ),
    idSet(db, "SELECT item_id AS id FROM cached_items WHERE type = 'playlist'"),
  ]);
  return { downloadedAlbumIds, parentAlbumIds, playlistIds };
}
