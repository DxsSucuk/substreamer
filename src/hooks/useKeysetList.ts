import { useCallback, useEffect, useRef, useState } from 'react';

import type { Cursor } from '../db/repository/core';

export interface KeysetPageResult<T> {
  rows: T[];
  nextCursor: Cursor | null;
}

export interface KeysetList<T> {
  rows: T[];
  initialLoading: boolean;
  loadMore: () => void;
  reload: () => void;
}

/**
 * Forward-only keyset pagination for a SQL-backed list.
 *
 * Deliberately narrow: no `loadPrevious` and no `seekLetter`. The Favourites tab is
 * ordered by "when you starred it", so it has no alphabet scroller and therefore never
 * seeks or pages backward — the A–Z browse screens keep their own richer loops.
 *
 * `loadPage` must be stable (a `useCallback`); it is the reload key.
 */
export function useKeysetList<T>(
  loadPage: (cursor: Cursor | null) => Promise<KeysetPageResult<T>>,
): KeysetList<T> {
  const [rows, setRows] = useState<T[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const cursorRef = useRef<Cursor | null>(null);
  const doneRef = useRef(false);
  const busyRef = useRef(false);

  const loadFirstPage = useCallback(async () => {
    busyRef.current = true;
    try {
      const page = await loadPage(null);
      cursorRef.current = page.nextCursor;
      doneRef.current = !page.nextCursor;
      setRows(page.rows);
    } finally {
      busyRef.current = false;
      setInitialLoading(false);
    }
  }, [loadPage]);

  const loadMore = useCallback(() => {
    if (busyRef.current || doneRef.current) return;
    busyRef.current = true;
    void (async () => {
      try {
        const page = await loadPage(cursorRef.current);
        cursorRef.current = page.nextCursor;
        if (!page.nextCursor) doneRef.current = true;
        setRows((r) => [...r, ...page.rows]);
      } finally {
        busyRef.current = false;
      }
    })();
  }, [loadPage]);

  const reload = useCallback(() => {
    cursorRef.current = null;
    doneRef.current = false;
    void loadFirstPage();
  }, [loadFirstPage]);

  useEffect(() => {
    cursorRef.current = null;
    doneRef.current = false;
    setInitialLoading(true);
    void loadFirstPage();
  }, [loadFirstPage]);

  return { rows, initialLoading, loadMore, reload };
}
