import { useEffect, useMemo, useState } from 'react';

import { coverArtForEntity, coverArtForSong } from '../utils/coverArtId';
import { getDb } from '../store/persistence/db';
import { musicCacheStore } from '../store/musicCacheStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { type AlbumID3, type ArtistID3, type Child, type Playlist } from '../services/subsonicService';

/**
 * Bounded `albumId -> coverArt` cache over the normalized `albums` table. Album-mode
 * song cover-art resolves the parent album's `coverArt` without holding the library in
 * memory:
 *   - `albumCoverArtById` is SYNCHRONOUS — a hit returns instantly; a MISS returns
 *     `undefined` (so the caller's `?? song.coverArt` fallback fires) and kicks a
 *     fire-and-forget DB fill for the next lookup.
 *   - imperative callers (lock-screen/RNTP artwork, CarPlay snapshot, prefetch) are
 *     warmed for DOWNLOADED albums at boot via {@link hydrateDownloadedAlbumCoverArt}.
 *   - render sites (`useSongCoverArt`) fetch-and-re-render on a miss (below).
 */
const CACHE_MAX = 6000;
const _cache = new Map<string, string>();
const _pending = new Set<string>();

function cacheSet(id: string, art: string): void {
  // Simple bounded FIFO eviction — cover art is cheap to re-fetch.
  if (_cache.size >= CACHE_MAX && !_cache.has(id)) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(id, art);
}

/** Async DB read for one album's cover art; populates the cache. Returns the art (or
 *  undefined). Deduped so concurrent lookups of the same id issue one query. */
async function fetchAlbumCoverArt(albumId: string): Promise<string | undefined> {
  const cached = _cache.get(albumId);
  if (cached !== undefined) return cached;
  const db = getDb();
  if (!db) return undefined;
  try {
    const row = await db.getFirstAsync<{ cover_art: string | null }>(
      'SELECT cover_art FROM albums WHERE id = ?',
      [albumId],
    );
    const art = row?.cover_art ?? undefined;
    if (art) cacheSet(albumId, art);
    return art;
  } catch {
    return undefined;
  }
}

/** Parent album's `coverArt` for an album id — SYNC, never blocks. Hit → value;
 *  miss → undefined, plus a background fill for next time. */
export function albumCoverArtById(albumId: string | null | undefined): string | undefined {
  if (!albumId) return undefined;
  const hit = _cache.get(albumId);
  if (hit !== undefined) return hit;
  if (!_pending.has(albumId)) {
    _pending.add(albumId);
    void fetchAlbumCoverArt(albumId).finally(() => _pending.delete(albumId));
  }
  return undefined;
}

/** Warm the cache for DOWNLOADED albums so offline imperative callers (lock-screen art,
 *  CarPlay snapshot) resolve album-mode cover art without a live DB round-trip. Call at
 *  boot (idle) after music-cache hydration. */
export async function hydrateDownloadedAlbumCoverArt(): Promise<void> {
  const db = getDb();
  if (!db) return;
  const cachedIds = Object.keys(musicCacheStore.getState().cachedItems);
  if (cachedIds.length === 0) return;
  try {
    const rows = await db.getAllAsync<{ id: string; cover_art: string | null }>(
      'SELECT id, cover_art FROM albums WHERE id IN (SELECT value FROM json_each(?))',
      [JSON.stringify(cachedIds)],
    );
    for (const r of rows) if (r.cover_art) cacheSet(r.id, r.cover_art);
  } catch {
    /* best-effort warm */
  }
}

/** Drop the cache after a sync rewrites album cover art (avoids serving stale art). */
export function clearAlbumCoverArtCache(): void {
  _cache.clear();
  _pending.clear();
}

/**
 * Non-reactive song cover-art value (reads the current mode + cache). For services /
 * headless callers — prefetch, RNTP lock-screen artwork. Album-mode misses fall back to
 * the song's own `coverArt`; downloaded albums are pre-warmed so offline callers hit.
 */
export function resolveSongCoverArt(song: {
  coverArt?: string | null;
  albumId?: string | null;
} | null | undefined): string | undefined {
  if (!song) return undefined;
  return coverArtForSong(song, layoutPreferencesStore.getState().songCoverArtMode, albumCoverArtById);
}

/** Non-reactive polymorphic resolver for prefetch over mixed entities. */
export function resolveEntityCoverArt(
  entity: AlbumID3 | ArtistID3 | Playlist | Child,
): string | undefined {
  return coverArtForEntity(entity, layoutPreferencesStore.getState().songCoverArtMode, albumCoverArtById);
}

/**
 * Reactive song cover-art value for render sites. Re-renders when the mode toggles or
 * the song changes; in album mode, an album-cover cache miss triggers a one-shot DB
 * fetch that re-renders with the parent album's art (bounded, no whole-library map).
 */
export function useSongCoverArt(song: {
  id?: string;
  coverArt?: string | null;
  albumId?: string | null;
} | null | undefined): string | undefined {
  const mode = layoutPreferencesStore((s) => s.songCoverArtMode);
  const albumId = song?.albumId ?? undefined;
  const [albumArt, setAlbumArt] = useState<string | undefined>(() => albumCoverArtById(albumId));

  useEffect(() => {
    let alive = true;
    const cached = albumCoverArtById(albumId);
    setAlbumArt(cached);
    if (mode === 'album' && albumId && cached === undefined) {
      void fetchAlbumCoverArt(albumId).then((art) => {
        if (alive && art) setAlbumArt(art);
      });
    }
    return () => {
      alive = false;
    };
  }, [albumId, mode]);

  return useMemo(
    () => (song ? coverArtForSong(song, mode, () => (mode === 'album' ? albumArt : undefined)) : undefined),
    [song?.id, song?.coverArt, albumId, mode, albumArt],
  );
}
