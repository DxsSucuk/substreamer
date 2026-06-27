import { useEffect, useMemo } from 'react';

import { getLocalTrackUri } from '../services/musicCacheService';
import { favoritesStore } from '../store/favoritesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { songIndexStore } from '../store/songIndexStore';
import { songLibraryStore } from '../store/songLibraryStore';
import type { Child } from '../services/subsonicService';
import { runWhenIdle } from '../utils/runWhenIdle';

interface UseAllSongsByTitleOpts {
  downloadedOnly?: boolean;
  favoritesOnly?: boolean;
}

interface UseAllSongsByTitleResult {
  songs: Child[];
  totalCount: number;
  /** True while the base list is being built (before the first build resolves). */
  loading: boolean;
  refresh: () => void;
}

const EMPTY: Child[] = [];

/**
 * Read all songs from the in-memory `songLibraryStore` base list, with optional
 * in-memory filtering by downloaded/favorited state.
 *
 * **Reactivity model:**
 *  - The unfiltered base list is owned by `songLibraryStore`: built once
 *    (asynchronously, off the JS thread) after startup, and thereafter kept
 *    current by optimistic in-memory patches from `songIndexStore` writes — NOT
 *    rebuilt on every mutation. A pull-to-refresh (`refresh`) forces a clean
 *    rebuild from `song_index`.
 *  - `downloadedOnly` and `favoritesOnly` filters are applied in JS against
 *    live stores (`musicCacheStore.cachedItems`, `favoritesStore.songs` +
 *    `overrides`) so star/download/delete actions from anywhere in the app
 *    refresh the filtered list automatically.
 *  - Per-row star/rating/download badges remain driven by `useIsStarred`,
 *    `useRating`, and `useDownloadStatus` on each row.
 */
export function useAllSongsByTitle(
  opts: UseAllSongsByTitleOpts = {},
): UseAllSongsByTitleResult {
  const downloadedOnly = opts.downloadedOnly === true;
  const favoritesOnly = opts.favoritesOnly === true;
  const totalCount = songIndexStore((s) => s.totalCount);

  const base = songLibraryStore((s) => s.base);
  const building = songLibraryStore((s) => s.building);

  // Live subscriptions — re-fire the filter useMemo when star/download changes.
  const starredSongs = favoritesStore((s) => s.songs);
  const starOverrides = favoritesStore((s) => s.overrides);
  const cachedItems = musicCacheStore((s) => s.cachedItems);

  // Ensure the list is built if it wasn't pre-built at startup (idempotent).
  useEffect(() => {
    if (base === null) void songLibraryStore.getState().build();
  }, [base]);

  const safeBase = base ?? EMPTY;

  const songs = useMemo(() => {
    if (!downloadedOnly && !favoritesOnly) return safeBase;

    let starredIds: Set<string> | null = null;
    if (favoritesOnly) {
      starredIds = new Set(starredSongs.map((s) => s.id));
      // Apply optimistic overrides — newly starred songs land here before
      // they make it into `favoritesStore.songs` (and unstarred songs vanish).
      for (const [id, isStarred] of Object.entries(starOverrides)) {
        if (isStarred) starredIds.add(id);
        else starredIds.delete(id);
      }
    }

    return safeBase.filter((song) => {
      if (favoritesOnly && starredIds && !starredIds.has(song.id)) return false;
      if (downloadedOnly && getLocalTrackUri(song.id) === null) return false;
      return true;
    });
    // cachedItems is a dep so the JS filter re-runs whenever a download
    // completes/is deleted (trackUriMap is synchronised with cachedItems
    // writes, so reading getLocalTrackUri inside the filter sees fresh state).
  }, [safeBase, downloadedOnly, favoritesOnly, starredSongs, starOverrides, cachedItems]);

  const refresh = useMemo(
    () => () => {
      void songLibraryStore.getState().build(true);
    },
    [],
  );

  return { songs, totalCount, loading: base === null && building, refresh };
}

/**
 * Build the songs-library list once, on startup, after the data-load/refresh
 * tasks have settled. Called from the deferred-startup sequence. Idempotent —
 * `songLibraryStore.build()` no-ops once the list is built. Deferred to an idle
 * window so the SQLite read + mapping doesn't compete with first-frame render.
 */
export function initSongLibrary(): void {
  runWhenIdle(() => {
    void songLibraryStore.getState().build();
  });
}
