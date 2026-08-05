import { useMemo } from 'react';

import { musicCacheStore } from '../store/musicCacheStore';
import type { Child } from '../services/subsonicService';
import { byTitle } from '../utils/librarySort';

interface UseAllSongsByTitleOpts {
  downloadedOnly?: boolean;
}

interface UseAllSongsByTitleResult {
  songs: Child[];
  totalCount: number;
  loading: boolean;
  refresh: () => void;
}

const EMPTY: Child[] = [];

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
 * Songs for the DOWNLOADED filter view, title-sorted. Sourced from
 * `musicCacheStore.cachedSongs` — the bounded, never-reaped download set — so it
 * carries no whole-library read. Only mounted when that filter is active; the main
 * A–Z browse pages the DB directly, and the favourites filter reads SQL
 * (`listAllStarredSongs`).
 */
export function useAllSongsByTitle(opts: UseAllSongsByTitleOpts = {}): UseAllSongsByTitleResult {
  const downloadedOnly = opts.downloadedOnly === true;

  const cachedItems = musicCacheStore((s) => s.cachedItems);
  const cachedSongs = musicCacheStore((s) => s.cachedSongs);

  const songs = useMemo(() => {
    if (!downloadedOnly) return EMPTY;
    const seen = new Set<string>();
    const result: Child[] = [];
    for (const cs of Object.values(cachedSongs)) {
      if (!cs || seen.has(cs.id)) continue;
      seen.add(cs.id);
      result.push(childFromCached(cs));
    }
    return result.sort(byTitle);
    // `cachedItems` is a dep so the list refreshes when a download completes/is deleted.
  }, [downloadedOnly, cachedItems, cachedSongs]);

  return { songs, totalCount: songs.length, loading: false, refresh: () => {} };
}
