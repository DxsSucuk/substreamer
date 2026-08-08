import { useEffect, useState } from 'react';

import { listDownloadedSongs, type DownloadedSongRow } from '../db/repository/downloads';
import { getDb } from '../store/persistence/db';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { musicCacheStore } from '../store/musicCacheStore';

interface UseAllSongsByTitleOpts {
  downloadedOnly?: boolean;
}

interface UseAllSongsByTitleResult {
  rows: DownloadedSongRow[];
  totalCount: number;
  loading: boolean;
  refresh: () => void;
}

const EMPTY: DownloadedSongRow[] = [];

/**
 * Songs for the DOWNLOADED filter view, read straight from the never-reaped
 * `cached_songs` table — no whole-library read — and ORDERED by the same stored `sort_*`
 * keys the main browse list's keyset uses, under the user's song sort order. Only that
 * filter uses this hook: the main A–Z browse pages the DB directly, and the favourites
 * filter reads SQL (`listAllStarredSongs`).
 *
 * Returns the ROWS, not envelopes: the list view converts one row per rendered row, and
 * the row carries the `sort_*` key the A–Z scroller letters on.
 */
export function useAllSongsByTitle(opts: UseAllSongsByTitleOpts = {}): UseAllSongsByTitleResult {
  const downloadedOnly = opts.downloadedOnly === true;
  // `revision` is the download tables' change signal, and a dep of the read below. A SQL
  // read has no Zustand subscription, so without it a completing download (or a
  // deletion) leaves the list stale.
  const revision = musicCacheStore((s) => s.revision);
  const sortOrder = layoutPreferencesStore((s) => s.songSortOrder);

  const [rows, setRows] = useState<DownloadedSongRow[]>(EMPTY);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  // DERIVED, not seeded — the read runs in an effect, i.e. after the first frame is on
  // screen, and `SongListView` falls through to "No songs found" on any empty frame that
  // does not say it is loading. `sortOrder` is part of the key because the ORDER BY is
  // the DB's: changing the preference has to re-read, not re-sort what we hold.
  // The rows themselves stay on screen across a re-read: the view only draws its spinner
  // when the list is empty, so a completing download never blanks a populated list.
  const wantedKey = `${revision}:${sortOrder}`;
  const loading = downloadedOnly && loadedKey !== wantedKey;

  useEffect(() => {
    // The unfiltered list never mounts this read — the main browse pages `songs` instead.
    if (!downloadedOnly) return;
    let alive = true;
    void (async () => {
      const db = getDb();
      const next = db ? await listDownloadedSongs(db, { sortOrder }) : [];
      if (alive) {
        setRows(next);
        setLoadedKey(wantedKey);
      }
    })();
    return () => {
      alive = false;
    };
  }, [downloadedOnly, revision, sortOrder, wantedKey]);

  // Nothing to re-fetch: the source is the local download tables, and every write to them
  // bumps `revision`, which re-runs the effect above.
  return {
    rows: downloadedOnly ? rows : EMPTY,
    totalCount: downloadedOnly ? rows.length : 0,
    loading,
    refresh: () => {},
  };
}
