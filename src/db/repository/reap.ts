/**
 * The epoch reap: delete library rows the server no longer has.
 *
 * A `full` resync that enumerated both halves mints an epoch `E` before its first write
 * and every writer stamps `synced_at` (`bulkUpsert`), so a row carrying `synced_at < E`
 * is one that run did not see. A row written out-of-band during or after the run is
 * never older than it, which is why no writer needs enumerating.
 *
 * A NULL `synced_at` — a row written before the stamp shipped — is NEVER reaped:
 * `NULL < E` is NULL, not true.
 *
 * The exclusions below are predicates on the DELETE itself, not id sets read up front,
 * so they are re-evaluated at delete time: a row starred or downloaded between the scan
 * and the delete survives, and an unreadable download table fails the statement rather
 * than reading as "nothing is protected".
 *
 * NO NETWORK. This is a local cache reconcile — it never calls the API, so server-side
 * favourites, playlists and shares cannot be affected by it.
 */
import type { InternalDb } from '../client';

/** One chunk of a reap pass. */
export interface ReapChunk {
  /** Resume point — the last id the scan reached. `null` = the table is exhausted. */
  cursor: string | null;
  deleted: number;
}

/** Rows per chunk, matching `bulkUpsert`: op-SQLite runs one pool thread, so a
 *  1–3M-row table has to be walked in pieces with a yield between them. */
export const REAP_CHUNK = 500;

/**
 * Songs: never reap one that backs a downloaded file, sits in a playlist, or is starred.
 *
 * `playlist_songs.song_id` has NO FK and `getPlaylistDetail` INNER JOINs `songs`, so
 * without that clause a reap returns a silently SHORTER playlist — no error, no gap.
 * `starred` lives on the row; `favorite_songs` is the remainder table for starred songs
 * with no library row, so a reaped starred song does not fall back to it.
 */
const SONG_EXCLUSIONS =
  'synced_at < ? AND starred IS NULL ' +
  'AND id NOT IN (SELECT song_id FROM cached_songs) ' +
  'AND id NOT IN (SELECT song_id FROM playlist_songs)';

/**
 * Albums: the download exclusion is NOT the mirror of the song one.
 *
 * A user who downloaded three tracks of an album has no `cached_items` row for the album,
 * but reaping the album row still empties their offline detail screen and CarPlay track
 * list (both read `getAlbumDetail` → `albums` + `songs`) while the album still LISTS under
 * Downloaded, which reads `cached_*`. So the exclusion is the union of three sources —
 * the album downloaded as an album, the album parenting any downloaded song, and the
 * parent recorded on a single-song download. The third is needed because
 * `cached_songs.album_id` does not always reach it.
 *
 * `parent_album_id IS NOT NULL` is required, not cosmetic: a NULL anywhere in a `NOT IN`
 * subquery makes the whole predicate NULL, and the reap would silently delete nothing.
 */
const ALBUM_EXCLUSIONS =
  'synced_at < ? AND starred IS NULL ' +
  "AND id NOT IN (SELECT item_id FROM cached_items WHERE type = 'album') " +
  'AND id NOT IN (SELECT album_id FROM cached_songs) ' +
  'AND id NOT IN (SELECT parent_album_id FROM cached_items WHERE parent_album_id IS NOT NULL)';

/**
 * Scan forward from `afterId` for up to `REAP_CHUNK` reapable rows and delete them.
 *
 * Keyset on the primary key, so the whole pass is ONE ordered walk of the table however
 * many chunks it takes — `id > ?` after the last row examined, never an offset. Rows
 * skipped between the cursor and the last match failed the exclusions and are behind the
 * cursor, which is why advancing to the last MATCH is correct.
 */
async function reapChunk(
  db: InternalDb,
  table: 'albums' | 'songs',
  exclusions: string,
  epoch: number,
  afterId: string,
): Promise<ReapChunk> {
  const stale = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM ${table} WHERE id > ? AND ${exclusions} ORDER BY id LIMIT ${REAP_CHUNK}`,
    [afterId, epoch],
  );
  if (stale.length === 0) return { cursor: null, deleted: 0 };
  const ids = stale.map((r) => r.id);
  const result = await db.runAsync(
    `DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?)) AND ${exclusions}`,
    [JSON.stringify(ids), epoch],
  );
  return { cursor: ids[ids.length - 1], deleted: result.changes };
}

/** One chunk of the song reap. Children cascade via FK. */
export const reapStaleSongs = (
  db: InternalDb,
  epoch: number,
  afterId: string,
): Promise<ReapChunk> => reapChunk(db, 'songs', SONG_EXCLUSIONS, epoch, afterId);

/** One chunk of the album reap. Run it AFTER the songs, so an album's tracks are gone
 *  before the row they hang off. Children cascade via FK. */
export const reapStaleAlbums = (
  db: InternalDb,
  epoch: number,
  afterId: string,
): Promise<ReapChunk> => reapChunk(db, 'albums', ALBUM_EXCLUSIONS, epoch, afterId);
