/**
 * Hook that checks whether an item is starred (favorited) by probing the id sets on
 * `favoritesStore` — the in-memory mirror of SQL membership (marked library rows ∪ the
 * `favorite_*` remainder).
 *
 * Synchronous and O(1) on purpose: this runs per starred icon, per row, per render
 * across a dozen call sites, so a per-row SQL query would be 120 round trips and a
 * star-icon flicker on every page.
 *
 * Supports optimistic overrides so the UI updates instantly after a toggle,
 * before the server round-trip completes.
 */

import { useCallback } from 'react';

import { favoritesStore, type FavoritesState } from '../store/favoritesStore';

/**
 * Returns `true` when the item identified by `type` + `id` is starred.
 *
 * The hook subscribes to `favoritesStore` so re-renders happen automatically
 * when the starred state changes (including optimistic overrides).
 */
export function useIsStarred(type: 'song' | 'album' | 'artist', id: string): boolean {
  return favoritesStore(
    useCallback(
      (s: FavoritesState) => {
        if (!id) return false;
        if (id in s.overrides) return s.overrides[id];
        switch (type) {
          case 'song':
            return s.songIds.has(id);
          case 'album':
            return s.albumIds.has(id);
          case 'artist':
            return s.artistIds.has(id);
        }
      },
      [type, id],
    ),
  );
}
