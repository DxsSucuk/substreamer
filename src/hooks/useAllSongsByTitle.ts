import { useEffect, useState } from 'react';

import { downloadedSongRowToChild, listDownloadedSongs } from '../db/repository/downloads';
import { getDb } from '../store/persistence/db';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { musicCacheStore } from '../store/musicCacheStore';
import type { Child } from '../services/subsonicService';

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

/**
 * Songs for the DOWNLOADED filter view, read straight from the never-reaped
 * `cached_songs` table — no whole-library read — and ORDERED by the same stored `sort_*`
 * keys the main browse list's keyset uses, under the user's song sort order. Only that
 * filter uses this hook: the main A–Z browse pages the DB directly, and the favourites
 * filter reads SQL (`listAllStarredSongs`).
 */
export function useAllSongsByTitle(opts: UseAllSongsByTitleOpts = {}): UseAllSongsByTitleResult {
  const downloadedOnly = opts.downloadedOnly === true;
  // `revision` is the download tables' change signal, and a dep of the read below. A SQL
  // read has no Zustand subscription, so without it a completing download (or a
  // deletion) leaves the list stale.
  const revision = musicCacheStore((s) => s.revision);
  const sortOrder = layoutPreferencesStore((s) => s.songSortOrder);

  const [songs, setSongs] = useState<Child[]>(EMPTY);
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
      const rows = db ? await listDownloadedSongs(db, { sortOrder }) : [];
      if (alive) {
        setSongs(rows.map(downloadedSongRowToChild));
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
    songs: downloadedOnly ? songs : EMPTY,
    totalCount: downloadedOnly ? songs.length : 0,
    loading,
    refresh: () => {},
  };
}
