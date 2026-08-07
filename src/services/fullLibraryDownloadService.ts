/**
 * "Download Full Library" — a one-shot that queues every album then every
 * playlist for offline download, reusing the standard download queue (which
 * already handles concurrency, dedup, status, storage limits, retries, resume).
 *
 * Light by design: refresh the album/playlist lists, then loop-enqueue. Each
 * `enqueueAlbumDownload` fetches the album's song list and dedups, so per-album
 * metadata freshens inline and already-cached albums are skipped with no
 * transfer. Playlists go last — their songs are usually already on disk from the
 * albums, so they complete quickly. Re-running is safe (idempotent).
 */

import i18n from '../i18n/i18n';
import { connectivityStore } from '../store/connectivityStore';
import { fullLibraryDownloadStore } from '../store/fullLibraryDownloadStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { refreshPlaylistLibrary } from './normalizedLibrarySync';
import { getDb } from '../store/persistence/db';
import { listAlbumIds } from '../db/repository/albums';
import { listPlaylistIds } from '../db/repository/playlists';
import { enqueueAlbumDownload, enqueuePlaylistDownload } from './musicCacheService';

/** True when the server is reachable and the user isn't in offline mode. */
export function canDownloadFullLibrary(): boolean {
  return (
    !offlineModeStore.getState().offlineMode &&
    connectivityStore.getState().isServerReachable
  );
}

/**
 * Refresh the library lists, then enqueue every album followed by every
 * playlist. Fire-and-forget from the UI — it awaits internally and reports
 * progress through `fullLibraryDownloadStore`. No-op if already running or
 * offline.
 */
export async function enqueueFullLibraryDownload(): Promise<void> {
  const store = fullLibraryDownloadStore.getState();
  if (store.active) return;
  if (!canDownloadFullLibrary()) return;

  store.start();
  let failed = 0;
  let total = 0;
  try {
    // Phase 1 — enumerate what we already know. The album list is deliberately NOT
    // re-fetched: on basic servers that re-pages the whole list off the legacy
    // `library_albums` count, which the normalized sync never writes. Albums added since
    // the last sync arrive via the next sync / change-detect.
    fullLibraryDownloadStore.getState().setPhase('preparing');
    await refreshPlaylistLibrary();

    const db = getDb();
    const albumIds = db ? await listAlbumIds(db) : [];
    const playlistIds = db ? await listPlaylistIds(db) : [];
    total = albumIds.length + playlistIds.length;
    fullLibraryDownloadStore.getState().setTotals(albumIds.length, playlistIds.length);

    // Phase 2 — enqueue. Sequential awaits keep a single album-detail fetch in
    // flight at a time (avoids hundreds of concurrent getAlbum calls) and yield
    // to keep the UI responsive. The queue starts draining after the first item.
    // A single failed item is tolerated and counted; we report the tally at the
    // end so a partial outage doesn't silently drop part of the library.
    fullLibraryDownloadStore.getState().setPhase('queueing');

    // `awaitCover: false` — don't serialize this loop on each item's cover
    // download; the image queue fetches covers in parallel and they're
    // purge-protected, so the offline copy still completes.
    for (const albumId of albumIds) {
      if (!fullLibraryDownloadStore.getState().active) return; // cancelled
      await enqueueAlbumDownload(albumId, { awaitCover: false }).catch(() => { failed += 1; });
      fullLibraryDownloadStore.getState().incAlbum();
    }

    // Playlists last — their songs are mostly already cached from the albums.
    for (const playlistId of playlistIds) {
      if (!fullLibraryDownloadStore.getState().active) return; // cancelled
      await enqueuePlaylistDownload(playlistId, { awaitCover: false }).catch(() => { failed += 1; });
      fullLibraryDownloadStore.getState().incPlaylist();
    }

    if (failed > 0) {
      fullLibraryDownloadStore.getState().fail(
        i18n.t('downloadFullLibraryPartial', { failed, total }),
      );
    }
  } catch {
    // Preparing failed (or an unexpected error) — couldn't queue the library.
    fullLibraryDownloadStore.getState().fail(i18n.t('downloadFullLibraryFailed'));
  } finally {
    fullLibraryDownloadStore.getState().finish();
  }
}
