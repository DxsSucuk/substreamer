import { useEffect, useMemo, useState } from 'react';
import { InteractionManager } from 'react-native';

import { getLocalTrackUri } from '../services/musicCacheService';
import { favoritesStore } from '../store/favoritesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import { fetchAllSongsByTitleAsync } from '../store/persistence/detailTables';
import { songIndexStore } from '../store/songIndexStore';
import type { Child } from '../services/subsonicService';

interface UseAllSongsByTitleOpts {
  downloadedOnly?: boolean;
  favoritesOnly?: boolean;
}

interface UseAllSongsByTitleResult {
  songs: Child[];
  totalCount: number;
  /** True while the base list is being fetched (cold cache); false once warm. */
  loading: boolean;
  refresh: () => void;
}

const EMPTY: Child[] = [];

/**
 * Module-level cache for the unfiltered base list keyed by mutationCounter
 * (+ pull-to-refresh nonce). Filtering is applied in the hook against live
 * stores so star/download changes anywhere in the app reflect immediately.
 *
 * The fetch is async (SQLite read off the JS thread, chunked mapping), so the
 * cache is filled in the background. A warm hit is returned synchronously and
 * instantly; a cold miss resolves asynchronously while the UI shows a spinner.
 */
let cachedBase: Child[] | null = null;
let cachedKey = -1;
/** Key currently being fetched + its promise, so concurrent callers (e.g. the
 *  auto-warmer and a cold mount) share one fetch and all await its result. */
let inFlightKey = -1;
let inFlightPromise: Promise<void> | null = null;

const keyOf = (counter: number, refreshNonce: number): number =>
  counter + refreshNonce * 1e9;

/** True when the module cache already holds the list for this key. */
function isWarm(counter: number, refreshNonce: number): boolean {
  return cachedBase !== null && cachedKey === keyOf(counter, refreshNonce);
}

/**
 * Fill the module cache for the given key. Resolves once `cachedBase` reflects
 * this key. If a fetch for the same key is already in flight, awaits it rather
 * than starting a second one (so a cold mount that races the auto-warmer still
 * sees the populated cache when it resolves).
 */
async function fillBaseAsync(counter: number, refreshNonce: number): Promise<void> {
  const key = keyOf(counter, refreshNonce);
  if (cachedBase !== null && cachedKey === key) return;
  if (inFlightKey === key && inFlightPromise) {
    await inFlightPromise;
    return;
  }
  inFlightKey = key;
  const run = async () => {
    try {
      const list = await fetchAllSongsByTitleAsync();
      // Commit only if this is still the key we set out to fetch — a newer
      // mutation may have superseded us mid-flight.
      if (inFlightKey === key) {
        cachedBase = list;
        cachedKey = key;
      }
    } finally {
      if (inFlightKey === key) {
        inFlightKey = -1;
        inFlightPromise = null;
      }
    }
  };
  const p = run();
  inFlightPromise = p;
  await p;
}

/**
 * Read all songs from `song_index` sorted A→Z by title, with optional
 * in-memory filtering by downloaded/favorited state.
 *
 * **Reactivity model:**
 *  - The unfiltered base list is cached at module scope keyed by
 *    `songIndexStore.mutationCounter` (advances on album sync writes and
 *    orphan reaps) plus a pull-to-refresh nonce. It's fetched asynchronously,
 *    so a cold cache shows a brief spinner rather than freezing the JS thread.
 *    `startSongLibraryCacheAutoWarm` keeps it warm so the common path is a
 *    synchronous instant hit.
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

  // Live subscriptions — re-fire the filter useMemo when star/download changes.
  const starredSongs = favoritesStore((s) => s.songs);
  const starOverrides = favoritesStore((s) => s.overrides);
  const cachedItems = musicCacheStore((s) => s.cachedItems);

  // Seed from a warm cache synchronously so the common (pre-warmed) path
  // renders the list instantly with no spinner and no async round-trip.
  const warmAtMount = isWarm(mutationCounter, refreshNonce);
  const [base, setBase] = useState<Child[] | null>(warmAtMount ? cachedBase : null);
  const [loading, setLoading] = useState<boolean>(!warmAtMount);

  useEffect(() => {
    let cancelled = false;
    if (isWarm(mutationCounter, refreshNonce)) {
      setBase(cachedBase);
      setLoading(false);
      return;
    }
    setLoading(true);
    void fillBaseAsync(mutationCounter, refreshNonce).then(() => {
      if (cancelled) return;
      setBase(cachedBase);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [mutationCounter, refreshNonce]);

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
    () => () => setRefreshNonce((n) => n + 1),
    [],
  );

  return { songs, totalCount, loading, refresh };
}

/**
 * Populate the module-level base cache without rendering anything. Idempotent —
 * a call for an already-warm key is a no-op. Async so the SQLite read stays off
 * the JS thread; callers may ignore the returned promise.
 */
export function warmSongLibraryCache(): Promise<void> {
  const mc = songIndexStore.getState().mutationCounter;
  return fillBaseAsync(mc, 0);
}

/* ------------------------------------------------------------------ */
/*  Background auto-warmer                                             */
/* ------------------------------------------------------------------ */

let autoWarmStarted = false;
let warmDebounce: ReturnType<typeof setTimeout> | null = null;
/**
 * Wait for song-index writes to settle before re-warming. The startup
 * album-detail walk bumps `mutationCounter` per album; debouncing means a long
 * write burst triggers a single rebuild once it quiets, not one per album.
 */
const WARM_DEBOUNCE_MS = 2000;

/**
 * Keep the songs-library cache hot across the app's lifetime so the first tap
 * on the Songs segment is an instant warm hit.
 *
 * Warms once after startup interactions settle, then re-warms (debounced, on
 * idle) whenever `songIndexStore.mutationCounter` changes. This is the fix for
 * the first-browse lag: the old one-shot warm was invalidated by the
 * post-startup album-detail sync that advances the counter, re-arming the cold
 * fetch before the user ever reached the segment.
 *
 * Idempotent — safe to call more than once; only the first call wires up.
 * Returns a disposer (unused in normal app flow; the subscription lives for the
 * app's lifetime).
 */
export function startSongLibraryCacheAutoWarm(): () => void {
  if (autoWarmStarted) return () => {};
  autoWarmStarted = true;

  const scheduleWarm = () => {
    if (warmDebounce) clearTimeout(warmDebounce);
    warmDebounce = setTimeout(() => {
      warmDebounce = null;
      InteractionManager.runAfterInteractions(() => {
        void warmSongLibraryCache();
      });
    }, WARM_DEBOUNCE_MS);
  };

  // Initial warm once startup interactions have settled.
  InteractionManager.runAfterInteractions(() => {
    void warmSongLibraryCache();
  });

  // Re-warm on any song-index mutation (album walk, orphan reap, manual scan).
  // songIndexStore has no subscribeWithSelector middleware, so diff manually.
  let lastCounter = songIndexStore.getState().mutationCounter;
  const unsub = songIndexStore.subscribe((s) => {
    if (s.mutationCounter !== lastCounter) {
      lastCounter = s.mutationCounter;
      scheduleWarm();
    }
  });

  return () => {
    unsub();
    if (warmDebounce) {
      clearTimeout(warmDebounce);
      warmDebounce = null;
    }
    autoWarmStarted = false;
  };
}
