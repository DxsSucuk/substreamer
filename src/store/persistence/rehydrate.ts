import { albumDetailStore } from '../albumDetailStore';
import { completedScrobbleStore } from '../completedScrobbleStore';
import { imageCacheStore } from '../imageCacheStore';
import { imageDownloadQueueStore } from '../imageDownloadQueueStore';
import { musicCacheStore } from '../musicCacheStore';
import { pendingScrobbleStore } from '../pendingScrobbleStore';
import { songIndexStore } from '../songIndexStore';

export interface RehydrationResult {
  succeeded: string[];
  failed: Array<{ store: string; error: string }>;
}

/**
 * Single entry point for rehydrating every per-row SQLite-backed Zustand
 * store. Each store hydrates in its own try/catch so a corrupt row in one
 * store cannot block the others from loading; the caller receives a
 * structured result describing which succeeded and which failed.
 *
 * Called from exactly two sites: the `rehydrated && isLoggedIn` useEffect
 * in `src/app/_layout.tsx` and the splash post-migration callback in
 * `src/components/AnimatedSplashScreen.tsx`. Both calls are idempotent —
 * each store's `hydrateFromDb()` re-reads the current SQL state and
 * replaces its in-memory mirror, safe under our write-through semantics.
 *
 * Order is stable but has no FK-style dependency; each store hydrates
 * independently. Keep the current order so new stores have an obvious
 * place to plug in.
 *
 * **Not exported from `./index.ts`.** This module imports stores; stores
 * import from `./index.ts` for table helpers. Re-exporting here would
 * create a cycle. Consumers import directly from
 * `'../store/persistence/rehydrate'`.
 *
 * kvStorage-backed stores (favorites, ratings, theme, etc.) aren't covered
 * by this helper — Zustand's `persist` middleware auto-rehydrates them on
 * store creation.
 */
export function rehydrateAllStores(): RehydrationResult {
  const result: RehydrationResult = { succeeded: [], failed: [] };
  const stores: Array<[string, () => void]> = [
    ['albumDetail', () => albumDetailStore.getState().hydrateFromDb()],
    ['songIndex', () => songIndexStore.getState().hydrateFromDb()],
    ['completedScrobble', () => completedScrobbleStore.getState().hydrateFromDb()],
    ['pendingScrobble', () => pendingScrobbleStore.getState().hydrateFromDb()],
    ['musicCache', () => musicCacheStore.getState().hydrateFromDb()],
    ['imageCache', () => imageCacheStore.getState().hydrateFromDb()],
    ['imageDownloadQueue', () => imageDownloadQueueStore.getState().hydrateFromDb()],
  ];
  for (const [name, hydrate] of stores) {
    try {
      hydrate();
      result.succeeded.push(name);
    } catch (e) {
      result.failed.push({
        store: name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (result.failed.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[rehydrateAllStores] partial failure', result.failed);
  }
  // The songs-library cache warm-up is owned by `startSongLibraryCacheAutoWarm`
  // (started from the deferred-startup chain). A one-shot warm here was
  // invalidated by the post-startup album-detail sync advancing
  // `songIndexStore.mutationCounter`, so it's been moved to a resilient
  // debounced auto-warmer that survives that churn.
  return result;
}
