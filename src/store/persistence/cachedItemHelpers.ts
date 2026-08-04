import type { AlbumID3, ItemDate, Playlist } from 'subsonic-api';

import {
  type CachedAlbumMeta,
  type CachedItemRow,
  type CachedPlaylistMeta,
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

const dateFrom = (epochMs?: number): Date | undefined =>
  epochMs === undefined ? undefined : new Date(epochMs);

const itemDate = (year?: number, month?: number, day?: number): ItemDate | undefined =>
  year === undefined && month === undefined && day === undefined
    ? undefined
    : { year, month, day };

/** Rebuild the captured `AlbumID3` from a `cached_albums` component row. The
 *  item id IS the album id, so it is not stored a second time. */
function albumFromMeta(itemId: string, meta: CachedAlbumMeta): AlbumID3 {
  return {
    id: itemId,
    name: meta.name ?? '',
    artist: meta.artist,
    artistId: meta.artistId,
    displayArtist: meta.displayArtist,
    coverArt: meta.coverArt,
    songCount: meta.songCount ?? 0,
    duration: meta.duration ?? 0,
    playCount: meta.playCount,
    created: dateFrom(meta.created) ?? new Date(0),
    starred: dateFrom(meta.starred),
    year: meta.year,
    genre: meta.genre,
    played: meta.played,
    userRating: meta.userRating,
    version: meta.version,
    musicBrainzId: meta.musicBrainzId,
    sortName: meta.sortName,
    isCompilation: meta.isCompilation,
    explicitStatus: meta.explicitStatus,
    originalReleaseDate: itemDate(
      meta.originalReleaseYear,
      meta.originalReleaseMonth,
      meta.originalReleaseDay,
    ),
    releaseDate: itemDate(meta.releaseYear, meta.releaseMonth, meta.releaseDay),
  };
}

/** Rebuild the captured `Playlist` from a `cached_playlists` component row. */
function playlistFromMeta(itemId: string, meta: CachedPlaylistMeta): Playlist {
  return {
    id: itemId,
    name: meta.name ?? '',
    comment: meta.comment,
    coverArt: meta.coverArt,
    created: dateFrom(meta.created) ?? new Date(0),
    changed: dateFrom(meta.changed) ?? new Date(0),
    duration: meta.duration ?? 0,
    owner: meta.owner,
    public: meta.public,
    songCount: meta.songCount ?? 0,
  };
}

/**
 * The DOWNLOADED albums, rebuilt from each `cached_items` row's self-cached
 * metadata — the never-reaped source of truth for downloaded metadata,
 * independent of the (paged) library. Honours the partial-download preference via
 * the same `isPartialAlbum` rule the library filter uses.
 *
 * Precedence per {@link readsLegacyEnvelope}; a row with neither a component row
 * nor an envelope (and a corrupt envelope) is skipped, which keeps the derived
 * partial-album rows that carry no metadata hidden. Never fall back to
 * `cached_items.name`/`artist` — those are always populated and would surface
 * rows that are hidden today.
 */
export function downloadedAlbumsFromCache(
  cachedItems: Record<string, CachedItemRow>,
  includePartial: boolean,
): AlbumID3[] {
  const out: AlbumID3[] = [];
  for (const item of Object.values(cachedItems)) {
    if (item.type !== 'album') continue;
    if (!includePartial && isPartialAlbum(item)) continue;
    if (readsLegacyEnvelope(item)) {
      try {
        out.push(JSON.parse(item.rawJson) as AlbumID3);
      } catch {
        /* skip a corrupt envelope */
      }
      continue;
    }
    if (item.albumMeta) out.push(albumFromMeta(item.itemId, item.albumMeta));
  }
  return out;
}

/** The DOWNLOADED playlists, rebuilt from each `cached_items` row's metadata —
 *  same precedence and same skip rule as {@link downloadedAlbumsFromCache}. */
export function downloadedPlaylistsFromCache(
  cachedItems: Record<string, CachedItemRow>,
): Playlist[] {
  const out: Playlist[] = [];
  for (const item of Object.values(cachedItems)) {
    if (item.type !== 'playlist') continue;
    if (readsLegacyEnvelope(item)) {
      try {
        out.push(JSON.parse(item.rawJson) as Playlist);
      } catch {
        /* skip a corrupt envelope */
      }
      continue;
    }
    if (item.playlistMeta) out.push(playlistFromMeta(item.itemId, item.playlistMeta));
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
