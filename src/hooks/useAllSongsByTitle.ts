import { useEffect, useState } from 'react';

import { downloadedSongRowToChild, listDownloadedSongs } from '../db/repository/downloads';
import { getDb } from '../store/persistence/db';
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

/**
 * Songs for the DOWNLOADED filter view, title-sorted, read straight from the
 * never-reaped `cached_songs` table — no whole-library read. Only that filter uses this
 * hook: the main A–Z browse pages the DB directly, and the favourites filter reads SQL
 * (`listAllStarredSongs`).
 */
export function useAllSongsByTitle(opts: UseAllSongsByTitleOpts = {}): UseAllSongsByTitleResult {
  const downloadedOnly = opts.downloadedOnly === true;
  // `revision` is the download tables' change signal, and a dep of the read below. A SQL
  // read has no Zustand subscription, so without it a completing download (or a
  // deletion) leaves the list stale.
  const revision = musicCacheStore((s) => s.revision);

  const [songs, setSongs] = useState<Child[]>(EMPTY);
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);
  // DERIVED, not seeded — the read runs in an effect, i.e. after the first frame is on
  // screen, and `SongListView` falls through to "No songs found" on any empty frame that
  // does not say it is loading. Seeded `null` so that very first frame is already loading.
  // The rows themselves stay on screen across a re-read: the view only draws its spinner
  // when the list is empty, so a completing download never blanks a populated list.
  const loading = downloadedOnly && loadedRevision !== revision;

  useEffect(() => {
    // The unfiltered list never mounts this read — the main browse pages `songs` instead.
    if (!downloadedOnly) return;
    let alive = true;
    void (async () => {
      const db = getDb();
      const rows = db ? await listDownloadedSongs(db) : [];
      if (alive) {
        setSongs(rows.map(downloadedSongRowToChild).sort(byTitle));
        setLoadedRevision(revision);
      }
    })();
    return () => {
      alive = false;
    };
  }, [downloadedOnly, revision]);

  // Nothing to re-fetch: the source is the local download tables, and every write to them
  // bumps `revision`, which re-runs the effect above.
  return {
    songs: downloadedOnly ? songs : EMPTY,
    totalCount: downloadedOnly ? songs.length : 0,
    loading,
    refresh: () => {},
  };
}
