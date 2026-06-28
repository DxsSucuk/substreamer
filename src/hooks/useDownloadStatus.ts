/**
 * Hook that checks the download status of a song, album, or playlist
 * by looking up `musicCacheStore` and the in-memory track URI map –
 * the single source of truth for offline cache state.
 *
 * Mirrors the `useIsStarred` pattern: subscribes reactively to the
 * store so consumers re-render automatically when status changes.
 */

import { useCallback } from 'react';

import { getTrackQueueStatus } from '../services/musicCacheService';
import { musicCacheStore, type MusicCacheState } from '../store/musicCacheStore';
import { isPartialAlbum } from '../store/persistence/cachedItemHelpers';

export type DownloadStatus =
  | 'none'
  | 'queued'
  | 'downloading'
  | 'partial'
  | 'complete';

/**
 * Returns the download status for the given item.
 *
 * - **song:** a cached_songs row means `'complete'`, then falls back to
 *   queue membership for `'queued'`/`'downloading'`.
 * - **album/playlist:** a complete cached row wins outright. A partial album
 *   row with an active queue entry (top-up in flight) reports as
 *   `'downloading'` / `'queued'` so the download button reflects in-progress
 *   work. A partial album with no queue entry reports `'partial'`. Falls
 *   back to the queue when there's no cached row at all.
 */
export function useDownloadStatus(
  type: 'song' | 'album' | 'playlist',
  id: string,
): DownloadStatus {
  return musicCacheStore(
    useCallback(
      (s: MusicCacheState): DownloadStatus => {
        if (!id) return 'none';

        if (type === 'song') {
          // Read the store row, NOT the in-memory `trackUriMap`, so this
          // selector re-runs reactively. `removeCachedItem` drops the
          // cached_songs row synchronously with its store notification,
          // whereas `trackUriMap.delete` runs afterwards (off-thread delete
          // path) and wouldn't re-trigger subscribers — which left a stale
          // "downloaded" icon until the next unrelated cache change.
          if (s.cachedSongs[id]) return 'complete';
          const queueStatus = getTrackQueueStatus(id);
          if (queueStatus) return queueStatus;
          return 'none';
        }

        // Album or playlist
        const item = s.cachedItems[id];
        const queueItem = s.downloadQueue.find((q) => q.itemId === id);
        if (item) {
          if (isPartialAlbum(item)) {
            // Top-up in flight — surface the queue status so the button
            // switches from the orange partial badge to a progress ring.
            if (queueItem) {
              return queueItem.status === 'downloading' ? 'downloading' : 'queued';
            }
            return 'partial';
          }
          return 'complete';
        }
        if (queueItem) {
          return queueItem.status === 'downloading' ? 'downloading' : 'queued';
        }
        return 'none';
      },
      [type, id],
    ),
  );
}
