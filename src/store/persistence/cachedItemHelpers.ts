import type { AlbumID3, Playlist } from 'subsonic-api';

import {
  type CachedItemRow,
  type DownloadQueueRow,
} from './musicCacheTables';

/**
 * True when an album `cached_items` row represents a partial download —
 * fewer songs on disk than the album actually contains.
 *
 * `expectedSongCount` is authoritative: `ensurePartialAlbumEdge` now
 * fetches the album from the server when the album-detail store doesn't
 * yet have it, so the count always reflects the real album size. No
 * heuristic is needed to distinguish a real single-track album from a
 * fallback estimate — fixes #159.
 *
 * Songs and playlists never classify as partial — songs are 1/1 by
 * definition, playlists download atomically in v2.
 */
export function isPartialAlbum(item: CachedItemRow): boolean {
  if (item.type !== 'album') return false;
  return item.songIds.length < item.expectedSongCount;
}

/** Convenience inverse of `isPartialAlbum` for albums. */
export function isCompleteAlbum(item: CachedItemRow): boolean {
  return item.type === 'album' && !isPartialAlbum(item);
}

interface MinimalAlbum {
  id: string;
}

/**
 * Predicate shared by every screen that exposes a "Downloaded" album filter.
 * An album passes iff it has a `cached_items` entry, and — when
 * `includePartial` is false — is not a partial download. Centralizing this
 * keeps the filter behaviour consistent across home, library, favorites,
 * search, and the artist list.
 */
export function albumPassesDownloadedFilter(
  album: MinimalAlbum,
  cachedItems: Record<string, CachedItemRow>,
  includePartial: boolean,
): boolean {
  const item = cachedItems[album.id];
  if (!item) return false;
  if (!includePartial && isPartialAlbum(item)) return false;
  return true;
}

/**
 * The DOWNLOADED albums, rebuilt from each `cached_items` row's self-cached
 * `rawJson` envelope — the never-reaped source of truth for downloaded metadata,
 * independent of the (paged) library. Honours the partial-download preference via
 * the same `isPartialAlbum` rule the library filter uses. A row with no envelope or
 * a corrupt one is skipped.
 */
export function downloadedAlbumsFromCache(
  cachedItems: Record<string, CachedItemRow>,
  includePartial: boolean,
): AlbumID3[] {
  const out: AlbumID3[] = [];
  for (const item of Object.values(cachedItems)) {
    if (item.type !== 'album') continue;
    if (!includePartial && isPartialAlbum(item)) continue;
    if (!item.rawJson) continue;
    try {
      out.push(JSON.parse(item.rawJson) as AlbumID3);
    } catch {
      /* skip a corrupt envelope */
    }
  }
  return out;
}

/** The DOWNLOADED playlists, rebuilt from each `cached_items` row's `rawJson`. */
export function downloadedPlaylistsFromCache(
  cachedItems: Record<string, CachedItemRow>,
): Playlist[] {
  const out: Playlist[] = [];
  for (const item of Object.values(cachedItems)) {
    if (item.type !== 'playlist') continue;
    if (!item.rawJson) continue;
    try {
      out.push(JSON.parse(item.rawJson) as Playlist);
    } catch {
      /* skip a corrupt envelope */
    }
  }
  return out;
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
