import { useMemo, useState } from 'react';

import { getLocalTrackUri } from '../services/musicCacheService';
import { favoritesStore } from '../store/favoritesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { fetchAllSongsByTitle } from '../store/persistence/detailTables';
import { songIndexStore } from '../store/songIndexStore';
import type { Child } from '../services/subsonicService';

interface UseAllSongsByTitleOpts {
  downloadedOnly?: boolean;
  favoritesOnly?: boolean;
}

interface UseAllSongsByTitleResult {
  songs: Child[];
  totalCount: number;
  refresh: () => void;
}

/**
 * Module-level cache for the unfiltered base list keyed by mutationCounter
 * (+ pull-to-refresh nonce). Filtering is applied in the hook against live
 * stores so star/download changes anywhere in the app reflect immediately.
 */
let cachedBase: Child[] | null = null;
let cachedKey = -1;

function getBaseList(counter: number, refreshNonce: number): Child[] {
  const effectiveKey = counter + refreshNonce * 1e9;
  if (cachedBase === null || cachedKey !== effectiveKey) {
    cachedBase = fetchAllSongsByTitle();
    cachedKey = effectiveKey;
  }
  return cachedBase;
}

/**
 * Read all songs from `song_index` sorted A→Z by title, with optional
 * in-memory filtering by downloaded/favorited state.
 *
 * **Reactivity model:**
 *  - The unfiltered base list is cached at module scope keyed by
 *    `songIndexStore.mutationCounter` (advances on album sync writes and
 *    orphan reaps) plus a pull-to-refresh nonce.
 *  - `downloadedOnly` and `favoritesOnly` filters are applied in JS against
 *    live stores (`musicCacheStore.cachedItems`, `favoritesStore.songs` +
 *    `overrides`) so star/download/delete actions from anywhere in the app
 *    refresh the filtered list automatically — no manual invalidation, no
 *    waiting for a sync to overwrite the stale `starred` column.
 *  - Per-row star/rating/download badges remain driven by `useIsStarred`,
 *    `useRating`, and `useDownloadStatus` on each row, so a row icon updates
 *    instantly even if its place in the *filtered* list is unaffected.
 */
export function useAllSongsByTitle(
  opts: UseAllSongsByTitleOpts = {},
): UseAllSongsByTitleResult {
  const downloadedOnly = opts.downloadedOnly === true;
  const favoritesOnly = opts.favoritesOnly === true;
  const mutationCounter = songIndexStore((s) => s.mutationCounter);
  const totalCount = songIndexStore((s) => s.totalCount);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Live subscriptions — re-fire useMemo when star/download state changes.
  const starredSongs = favoritesStore((s) => s.songs);
  const starOverrides = favoritesStore((s) => s.overrides);
  const cachedItems = musicCacheStore((s) => s.cachedItems);

  const base = useMemo(
    () => getBaseList(mutationCounter, refreshNonce),
    [mutationCounter, refreshNonce],
  );

  const songs = useMemo(() => {
    if (!downloadedOnly && !favoritesOnly) return base;

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

    return base.filter((song) => {
      if (favoritesOnly && starredIds && !starredIds.has(song.id)) return false;
      if (downloadedOnly && getLocalTrackUri(song.id) === null) return false;
      return true;
    });
    // cachedItems is a dep so the JS filter re-runs whenever a download
    // completes/is deleted (trackUriMap is synchronised with cachedItems
    // writes, so reading getLocalTrackUri inside the filter sees fresh state).
  }, [base, downloadedOnly, favoritesOnly, starredSongs, starOverrides, cachedItems]);

  const refresh = useMemo(
    () => () => setRefreshNonce((n) => n + 1),
    [],
  );

  return { songs, totalCount, refresh };
}

/**
 * Populate the module-level base cache without rendering anything. Called
 * once after SQLite rehydration so the first tap on the Songs library
 * segment finds a hot cache. Safe to call multiple times — subsequent
 * calls are a cache-hit no-op.
 */
export function warmSongLibraryCache(): void {
  const mc = songIndexStore.getState().mutationCounter;
  getBaseList(mc, 0);
}
