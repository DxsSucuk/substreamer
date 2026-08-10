/**
 * The one-time move of `download_queue.songs_json` into `download_queue_songs`.
 *
 * A queued download is not re-derivable on its own terms — an interrupted "download
 * full library" is hours of transfer — so the blob is NEVER given up. Every row is
 * written, READ BACK and checked against what the blob held, and a row that does not
 * verify has its stored songs deleted again so the per-row gate keeps serving the blob.
 *
 * That gate is why this migration cannot lose a download whatever it does: a row with
 * no stored songs reads through `songs_json` for good, and one whose stored count
 * disagrees with `total_songs` does too. Failing is always the safe direction, so a
 * failure logs and moves on rather than throwing — pinning the counter would stall
 * every later migration for a conversion that is only a memory saving.
 *
 * Idempotent: a verified row is skipped on the next run, an unverified one is retried.
 */
import {
  deleteDownloadQueueSongs,
  parseLegacyQueuePayload,
  readDownloadQueuePayloadRowsAsync,
  readStoredQueueSongIdsAsync,
  replaceDownloadQueueSongs,
  type DownloadQueuePayloadRow,
} from './musicCacheTables';

import type { Child } from 'subsonic-api';

/** The songs the writer will actually store: it drops entries with no id, because
 *  `song_id` is NOT NULL and the worker cannot download a song it cannot name.
 *  Verification has to count the same set the writer wrote. */
const usableSongs = (songs: readonly Child[]): Child[] => songs.filter((s) => !!s?.id);

/** A row is already converted when it holds exactly as many songs as it claims —
 *  the same test the read gate applies. */
const isConverted = (row: DownloadQueuePayloadRow): boolean =>
  row.songRows > 0 && row.songRows === row.totalSongs;

/**
 * Convert one row. Returns true when the stored songs verified, false when the blob
 * stays authoritative — including when the payload cannot satisfy the gate, which
 * would leave rows behind a shut gate for nothing.
 */
async function convertRow(row: DownloadQueuePayloadRow): Promise<boolean> {
  const songs = usableSongs(parseLegacyQueuePayload(row.songsJson));
  if (songs.length === 0 || songs.length !== row.totalSongs) return false;

  if (!(await replaceDownloadQueueSongs(row.queueId, songs))) return false;

  // Read back: `replaceDownloadQueueSongs` swallows its own failures, so "it returned"
  // proves nothing. The ids have to come back, in the order the payload had them.
  const stored = await readStoredQueueSongIdsAsync(row.queueId);
  const ok =
    stored !== null &&
    stored.length === songs.length &&
    stored.every((id, i) => id === songs[i].id);
  if (!ok) await deleteDownloadQueueSongs(row.queueId);
  return ok;
}

/** Move every queue row's payload into rows. See the module docblock. */
export async function migrateDownloadQueueSongs(
  log: (message: string) => void,
): Promise<void> {
  const rows = await readDownloadQueuePayloadRowsAsync();
  if (rows.length === 0) {
    log('[m39] download queue empty — nothing to convert');
    return;
  }
  const pending = rows.filter((r) => !isConverted(r));
  if (pending.length === 0) {
    log(`[m39] all ${rows.length} queue row(s) already store their songs`);
    return;
  }

  let converted = 0;
  for (const row of pending) {
    // Serial: a full-library queue is one row per album, and the batches are large.
    // eslint-disable-next-line no-await-in-loop
    if (await convertRow(row)) converted++;
  }
  log(
    `[m39] converted ${converted}/${pending.length} queue row(s) to stored songs; ` +
      `${pending.length - converted} keep reading songs_json`,
  );
}
