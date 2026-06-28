import { useCallback, useEffect, useState } from 'react';

import { minDelay } from '../utils/stringHelpers';

interface DetailFetchOptions {
  /** Route param id; a missing id surfaces `missingIdMessage` instead of fetching. */
  id: string | undefined;
  /** True when a cached store entry already populated the screen — skips the mount fetch. */
  hasCache: boolean;
  /** Error shown when `id` is missing. */
  missingIdMessage: string;
  /** Fallback error shown when the fetch throws a non-`Error`. */
  failedMessage: string;
  /**
   * Performs the fetch and applies the result to the screen's own state.
   * Returns a "not found" message to surface as the error, or null on success.
   * Throwing is caught and surfaced via `failedMessage` / the error's message.
   */
  load: (id: string, isRefresh: boolean) => Promise<string | null>;
}

/**
 * Shared data-loading shell for the album / artist / playlist detail screens.
 * Owns the `loading` / `refreshing` / `error` lifecycle and the mount + pull
 * triggers; the screen supplies `load`, which fetches and applies its own
 * (single- or multi-) state. Mirrors the previously-inlined `fetchData`
 * skeleton 1:1 — a plain open fetches only when uncached, a pull always
 * refetches with a minimum spinner delay.
 */
export function useDetailFetch({
  id,
  hasCache,
  missingIdMessage,
  failedMessage,
  load,
}: DetailFetchOptions) {
  const [loading, setLoading] = useState(!hasCache);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(
    async (isRefresh = false) => {
      if (!id) {
        setError(missingIdMessage);
        if (!isRefresh) setLoading(false);
        return;
      }
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const delay = isRefresh ? minDelay() : null;
        const notFound = await load(id, isRefresh);
        if (notFound) setError(notFound);
        await delay;
      } catch (e) {
        setError(e instanceof Error ? e.message : failedMessage);
      } finally {
        if (isRefresh) setRefreshing(false);
        else setLoading(false);
      }
    },
    [id, load, missingIdMessage, failedMessage],
  );

  // Only fetch on mount if no cached data.
  useEffect(() => {
    if (!hasCache) fetchData();
  }, [fetchData, hasCache]);

  const onRefresh = useCallback(() => fetchData(true), [fetchData]);

  return { loading, refreshing, error, setError, fetchData, onRefresh };
}
