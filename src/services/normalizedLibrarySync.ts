/**
 * Target-state remote library sync — writes ONLY the normalized model (`albums`
 * and `songs` + children, via the repository). Single writer, bounded memory:
 * page → upsert → free. NO blob tables (`library_albums`/`song_index`), NO
 * in-memory whole-library arrays, NO `rebuildFromDb`, NO reconcile fan-out.
 *
 * Progress = albums-whose-songs-we-have / total-albums, both DB-derived
 * (`COUNT(DISTINCT album_id) FROM songs` / `COUNT(*) FROM albums`). Because this
 * is the sole writer, the metric is accurate, monotonic, smooth, and resume-stable
 * (from the persisted tables, no memory). Resumes from `librarySyncCursor` /
 * `songSyncCursor`.
 *
 * Scope: search3-capable servers. The per-album basic walk into the normalized
 * model is not implemented yet — if the server's songs lack `albumId`, the song
 * phase bails with an error phase rather than silently doing the wrong thing.
 */
import type { AlbumID3, Child } from 'subsonic-api';

import { ensureNormalizedSchema, resetNormalizedSchema } from '@/db/createNormalizedTables';
import { countAlbums, upsertAlbums } from '@/db/repository/albums';
import { countSongAlbums, countSongs, upsertSongs } from '@/db/repository/songs';
import { getDb } from '@/store/persistence/db';
import { offlineModeStore } from '@/store/offlineModeStore';
import { serverInfoStore } from '@/store/serverInfoStore';
import { syncStatusStore } from '@/store/syncStatusStore';

import {
  getAlbumsPageByName,
  probeEmptySearch3,
  searchAlbumsPage,
  searchSongsPage,
} from './subsonicService';

const ALBUM_PAGE = 1000; // search3 albumCount per page (uncapped); basic path caps at 500
const SONG_PAGE = 1000;
const BASIC_PAGE = 500; // getAlbumList2 spec cap
/** Refresh the album-progress COUNT(DISTINCT) every N song pages — indexed but not
 *  free at 1M songs, and the bar doesn't need per-page precision. */
const PROGRESS_EVERY = 5;

const nowMs = (): number => {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
};

let inFlight: Promise<void> | null = null;

/**
 * Run the full remote library sync into the normalized model. `full` drops +
 * recreates the normalized tables first (clean cold run). Deduped — a concurrent
 * call returns the running promise.
 */
export function runNormalizedLibrarySync(opts: { full?: boolean } = {}): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = doNormalizedSync(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doNormalizedSync({ full = false }: { full?: boolean }): Promise<void> {
  const db = getDb();
  if (!db) return;
  if (offlineModeStore.getState().offlineMode) return;

  const capturedGen = syncStatusStore.getState().generation;
  const genChanged = (): boolean => syncStatusStore.getState().generation !== capturedGen;
  const isOffline = (): boolean => offlineModeStore.getState().offlineMode;

  const tStart = nowMs();
  try {
    if (full) {
      resetNormalizedSchema(db);
      syncStatusStore.getState().resetLibrarySync();
      syncStatusStore.getState().resetSongSync();
    } else {
      ensureNormalizedSchema(db);
    }

    // Transport probe (persisted for resume).
    let strat = syncStatusStore.getState().syncStrategy;
    if (strat == null) {
      strat = (await probeEmptySearch3()) ? 'search3' : 'basic';
      if (genChanged()) return;
      syncStatusStore.getState().setSyncStrategy(strat);
    }

    // The effective ignored-article list (server's, else the local default) — the
    // same list the alphabet scroller uses, so stored sort keys match its sections.
    const articles = serverInfoStore.getState().ignoredArticles ?? undefined;

    // ── Album phase → normalized `albums` ──────────────────────────────────────
    const tAlbum0 = nowMs();
    syncStatusStore.getState().setLibrarySyncPhase('fetching');
    let albumOffset = syncStatusStore.getState().librarySyncCursor;
    let useBasic = strat === 'basic';
    let prevFirstId: string | null = null;
    for (;;) {
      if (genChanged()) return;
      if (isOffline()) {
        syncStatusStore.getState().setLibrarySyncPhase('paused-offline');
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      const page: AlbumID3[] = useBasic
        ? await getAlbumsPageByName(BASIC_PAGE, albumOffset)
        : await searchAlbumsPage(ALBUM_PAGE, albumOffset);
      if (page.length === 0) break;
      // Ignore-offset guard: a server that ignores `albumOffset` returns the same
      // first page forever. Detect via an unchanged first id and switch to basic.
      if (!useBasic && albumOffset > 0 && page[0]?.id === prevFirstId) {
        useBasic = true;
        albumOffset = 0; // restart basic; upserts are idempotent
        prevFirstId = null;
        continue;
      }
      prevFirstId = page[0]?.id ?? null;
      // eslint-disable-next-line no-await-in-loop
      await upsertAlbums(db, page, undefined, articles);
      albumOffset += page.length;
      syncStatusStore.getState().setLibrarySyncCursor(albumOffset);
      // eslint-disable-next-line no-await-in-loop
      syncStatusStore.getState().setLibrarySyncProgress(await countAlbums(db));
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    if (genChanged()) return;
    syncStatusStore.getState().markLibrarySyncComplete();
    const albumMs = nowMs() - tAlbum0;
    const totalAlbums = await countAlbums(db);

    // ── Song phase → normalized `songs` ────────────────────────────────────────
    const tSong0 = nowMs();
    syncStatusStore.getState().setDetailSyncPhase('syncing');
    syncStatusStore.getState().setDetailSyncTotal(totalAlbums);
    syncStatusStore.getState().setDetailSyncCompleted(await countSongAlbums(db));
    let songOffset = syncStatusStore.getState().songSyncCursor;
    let firstPage = songOffset === 0;
    let songPage = 0;
    for (;;) {
      if (genChanged()) return;
      if (isOffline()) {
        syncStatusStore.getState().setDetailSyncPhase('paused-offline');
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      const page: Child[] = await searchSongsPage(SONG_PAGE, songOffset);
      if (page.length === 0) break;
      if (firstPage) {
        firstPage = false;
        const missing = page.filter((s) => !s.albumId).length;
        if (missing / page.length > 0.01) {
          syncStatusStore.getState().setDetailSyncPhase('error');
          // eslint-disable-next-line no-console
          console.warn(
            '[normalized-sync] songs lack albumId — search3 fast path unavailable and the ' +
              'normalized per-album walk is not implemented yet. Bailing.',
          );
          return;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await upsertSongs(db, page, undefined, articles);
      songOffset += page.length;
      syncStatusStore.getState().setSongSyncCursor(songOffset);
      if (songPage % PROGRESS_EVERY === 0) {
        // eslint-disable-next-line no-await-in-loop
        syncStatusStore.getState().setDetailSyncCompleted(await countSongAlbums(db));
      }
      songPage += 1;
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    if (genChanged()) return;
    syncStatusStore.getState().setDetailSyncCompleted(totalAlbums);
    syncStatusStore.getState().markSongSyncComplete();
    const songMs = nowMs() - tSong0;

    const nAlbums = await countAlbums(db);
    const nSongs = await countSongs(db);
    // eslint-disable-next-line no-console
    console.log('[normalized-sync] done', {
      albums: nAlbums,
      songs: nSongs,
      albumMs: Math.round(albumMs),
      songMs: Math.round(songMs),
      totalMs: Math.round(nowMs() - tStart),
      songsPerSec: songMs > 0 ? Math.round(nSongs / (songMs / 1000)) : 0,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[normalized-sync] failed', e);
    syncStatusStore.getState().setDetailSyncPhase('error');
  }
}
