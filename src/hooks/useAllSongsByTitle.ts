import { useMemo } from 'react';

import { getLocalTrackUri } from '../services/musicCacheService';
import { favoritesStore } from '../store/favoritesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import type { Child } from '../services/subsonicService';

interface UseAllSongsByTitleOpts {
  downloadedOnly?: boolean;
  favoritesOnly?: boolean;
}

interface UseAllSongsByTitleResult {
  songs: Child[];
  totalCount: number;
  loading: boolean;
  refresh: () => void;
}

const EMPTY: Child[] = [];
const byTitle = (a: Child, b: Child): number => (a.title ?? '').localeCompare(b.title ?? '');

/** Shape a cached_songs row into the `Child` the song rows render. */
function childFromCached(s: {
  id: string;
  title?: string;
  artist?: string;
  albumId?: string;
  duration?: number;
  coverArt?: string;
}): Child {
  return {
    id: s.id,
    title: s.title ?? '',
    artist: s.artist,
    albumId: s.albumId,
    duration: s.duration ?? 0,
    coverArt: s.coverArt,
    isDir: false,
  } as Child;
}

/**
 * Songs for the downloaded/favorites FILTER views, title-sorted. Sourced entirely from
 * the BOUNDED, kept stores — `favoritesStore.songs` (the complete starred set + optimistic
 * overrides) and `musicCacheStore.cachedSongs` (the downloaded set) — so it retires the
 * old whole-library `songLibraryStore.base` / `songIndexStore` read (the OOM risk). This
 * hook is only mounted when a filter is active; the main A–Z browse pages the DB directly.
 */
export function useAllSongsByTitle(opts: UseAllSongsByTitleOpts = {}): UseAllSongsByTitleResult {
  const downloadedOnly = opts.downloadedOnly === true;
  const favoritesOnly = opts.favoritesOnly === true;

  const starredSongs = favoritesStore((s) => s.songs);
  const starOverrides = favoritesStore((s) => s.overrides);
  const cachedItems = musicCacheStore((s) => s.cachedItems);
  const cachedSongs = musicCacheStore((s) => s.cachedSongs);

  const songs = useMemo(() => {
    if (!downloadedOnly && !favoritesOnly) return EMPTY;

    let result: Child[];
    if (favoritesOnly) {
      // Complete starred set, adjusted by optimistic overrides (newly (un)starred rows).
      const starredIds = new Set(starredSongs.map((s) => s.id));
      for (const [id, isStarred] of Object.entries(starOverrides)) {
        if (isStarred) starredIds.add(id);
        else starredIds.delete(id);
      }
      result = starredSongs.filter((s) => starredIds.has(s.id));
      if (downloadedOnly) result = result.filter((s) => getLocalTrackUri(s.id) !== null);
    } else {
      // Downloaded-only: the cached-songs set, deduped by id.
      const seen = new Set<string>();
      result = [];
      for (const cs of Object.values(cachedSongs)) {
        if (!cs || seen.has(cs.id)) continue;
        seen.add(cs.id);
        result.push(childFromCached(cs));
      }
    }
    return [...result].sort(byTitle);
    // `cachedItems` is a dep so the list refreshes when a download completes/is deleted.
  }, [downloadedOnly, favoritesOnly, starredSongs, starOverrides, cachedItems, cachedSongs]);

  return { songs, totalCount: songs.length, loading: false, refresh: () => {} };
}
