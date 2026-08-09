import { type CachedItemRow, type DownloadQueueRow } from './musicCacheTables';

/**
 * True when an album `cached_items` row represents a partial download —
 * fewer songs on disk than the album actually contains.
 *
 * `expectedSongCount` is authoritative: `ensurePartialAlbumEdge` fetches the
 * album from the server when the album-detail store doesn't have it, so the
 * count always reflects the real album size and no heuristic is needed to tell
 * a genuine single-track album from a fallback estimate.
 *
 * Songs and playlists never classify as partial — songs are 1/1 by
 * definition, playlists download atomically in v2.
 *
 * The SQL form of this rule lives in `db/repository/downloads.ts`
 * (`partialGate`), which is what every downloaded FILTER now reads. This
 * copy serves the callers that hold a `CachedItemRow` in hand already —
 * the cache browser and the download-status hook.
 */
export function isPartialAlbum(item: CachedItemRow): boolean {
  if (item.type !== 'album') return false;
  return item.songIds.length < item.expectedSongCount;
}

/**
 * The reader precedence for promoted metadata, stated once so every reader
 * states it identically: `metaV == null && rawJson != null` ⇒ read the legacy
 * envelope (transitional — rows the detached conversion hasn't reached);
 * otherwise read the component row / promoted columns; neither yields anything
 * ⇒ skip. Both halves of the test are load-bearing: a row written by THIS build
 * has `rawJson` and `metaV` both null and must fall through to its columns, not
 * to a null envelope.
 */
export function readsLegacyEnvelope<T extends { metaV?: number; rawJson?: string }>(
  row: T,
): row is T & { rawJson: string } {
  return row.metaV == null && row.rawJson != null;
}

/**
 * Compute album-level progress `(completed, total)` for a download queue
 * item. When the item's target already has a `cached_items` entry (top-up
 * flow), the display should read as `(existing + delta) / expectedSongCount`
 * — e.g. a 5-of-10 partial album progresses 5/10 → 10/10 even though the
 * queue row itself only tracks the 0/5 delta. Fresh downloads collapse to
 * the queue row's raw `completedSongs / totalSongs`.
 */
export function computeQueueItemProgress(
  queueItem: DownloadQueueRow,
  cachedItems: Record<string, CachedItemRow>,
): { completed: number; total: number } {
  const existing = cachedItems[queueItem.itemId];
  if (existing) {
    return {
      completed: existing.songIds.length + queueItem.completedSongs,
      total: existing.expectedSongCount,
    };
  }
  return { completed: queueItem.completedSongs, total: queueItem.totalSongs };
}
