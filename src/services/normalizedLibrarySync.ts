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

import type { InternalDb } from '@/db/client';
import { ensureNormalizedSchema, resetNormalizedSchema } from '@/db/createNormalizedTables';
import { countAlbums, listAlbumIds, upsertAlbums } from '@/db/repository/albums';
import { upsertArtists } from '@/db/repository/artists';
import { deletePlaylistsNotIn, upsertPlaylists } from '@/db/repository/playlists';
import { getProtectedIds } from '@/db/protectedIds';
import { countSongAlbums, countSongs, listSongAlbumIds, upsertSongs } from '@/db/repository/songs';
import { getDb } from '@/store/persistence/db';
import { clearAlbumCoverArtCache } from '@/hooks/useSongCoverArt';
import { offlineModeStore } from '@/store/offlineModeStore';
import { ratingStore } from '@/store/ratingStore';
import { serverInfoStore } from '@/store/serverInfoStore';
import { syncStatusStore } from '@/store/syncStatusStore';
import { runPool } from '@/utils/promisePool';

import {
  ensureCoverArtAuth,
  getAlbum,
  getAlbumsPageByName,
  getAllArtists,
  getAllPlaylists,
  getApi,
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
/** Concurrent per-album `getAlbum` fetches during the basic-server song walk. */
const WALK_CONCURRENCY = 4;

const nowMs = (): number => {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
};

let inFlight: Promise<void> | null = null;

/**
 * Basic (non-search3) servers: songs don't carry `albumId`, so the paged fast path can't
 * key them. Walk each album we don't yet have songs for (`listAlbumIds − listSongAlbumIds`)
 * and upsert its `getAlbum` song list. Resumable (skips already-populated albums) and bails
 * on a generation bump or offline flip; progress is albums-with-songs / total-albums.
 */
async function doBasicSongWalk(
  db: InternalDb,
  articles: readonly string[] | undefined,
  capturedGen: number,
): Promise<void> {
  const genChanged = (): boolean => syncStatusStore.getState().generation !== capturedGen;
  const isOffline = (): boolean => offlineModeStore.getState().offlineMode;

  const allIds = await listAlbumIds(db);
  const have = new Set(await listSongAlbumIds(db));
  const missing = allIds.filter((id) => !have.has(id));
  syncStatusStore.getState().setDetailSyncTotal(allIds.length);
  let done = allIds.length - missing.length;
  syncStatusStore.getState().setDetailSyncCompleted(done);
  if (missing.length === 0) return;

  // Abort the pool on a generation bump (cancel/force-resync/logout) or an offline flip.
  const ctrl = new AbortController();
  const unsubGen = syncStatusStore.subscribe((s) => {
    if (s.generation !== capturedGen) ctrl.abort();
  });
  const unsubOffline = offlineModeStore.subscribe((s) => {
    if (s.offlineMode) ctrl.abort();
  });
  try {
    await runPool(
      missing,
      async (id) => {
        if (genChanged() || isOffline()) throw new Error('walk-bail');
        const album = await getAlbum(id).catch(() => null);
        if (album?.song && album.song.length > 0) {
          await upsertSongs(db, album.song, undefined, articles);
        }
        done += 1;
        if (done % PROGRESS_EVERY === 0) syncStatusStore.getState().setDetailSyncCompleted(done);
      },
      { concurrency: WALK_CONCURRENCY, signal: ctrl.signal },
    );
  } finally {
    unsubGen();
    unsubOffline();
  }
  syncStatusStore.getState().setDetailSyncCompleted(done);
}

/**
 * search3 (fast-path) song phase: page empty-query songs and bulk-upsert them. Keeps the
 * safety fallback — if the first page's songs lack `albumId` (a server that pages albums
 * via search3 but not songs), switch to the per-album walk. Returns 'bailed' on a
 * generation bump / offline flip (resumable), else 'done'.
 */
async function runSearch3SongPhase(
  db: InternalDb,
  articles: readonly string[] | undefined,
  capturedGen: number,
): Promise<'done' | 'bailed'> {
  const genChanged = (): boolean => syncStatusStore.getState().generation !== capturedGen;
  const isOffline = (): boolean => offlineModeStore.getState().offlineMode;
  let songOffset = syncStatusStore.getState().songSyncCursor;
  let firstPage = songOffset === 0;
  let songPage = 0;
  for (;;) {
    if (genChanged()) return 'bailed';
    if (isOffline()) {
      syncStatusStore.getState().setDetailSyncPhase('paused-offline');
      return 'bailed';
    }
    // eslint-disable-next-line no-await-in-loop
    const page: Child[] = await searchSongsPage(SONG_PAGE, songOffset);
    if (page.length === 0) break;
    if (firstPage) {
      firstPage = false;
      const missing = page.filter((s) => !s.albumId).length;
      if (missing / page.length > 0.01) {
        // Songs lack albumId — fall back to the per-album walk.
        // eslint-disable-next-line no-await-in-loop
        await doBasicSongWalk(db, articles, capturedGen);
        return genChanged() || isOffline() ? 'bailed' : 'done';
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
  return 'done';
}

/** Initial sync of the (lightweight) artists list into the normalized `artists` table —
 *  tacked onto the library sync so the user's first Artists tab open is instant. */
export async function syncArtistsNormalized(
  db: InternalDb,
  articles: readonly string[] | undefined,
): Promise<void> {
  await ensureCoverArtAuth();
  const artists = await getAllArtists();
  ratingStore.getState().reconcileRatings(
    artists.map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 })),
  );
  await upsertArtists(db, artists, undefined, articles);
}

/** Initial sync of the (lightweight) playlists list into the normalized `playlists`
 *  table, pruning server-removed playlists. Track membership stays on-demand. */
export async function syncPlaylistsNormalized(
  db: InternalDb,
  articles: readonly string[] | undefined,
): Promise<void> {
  await ensureCoverArtAuth();
  const playlists = await getAllPlaylists();
  await upsertPlaylists(db, playlists, undefined, articles);
  // Prune only when the API actually answered — `getAllPlaylists` returns `[]` (not a
  // throw) when there is no usable API, and pruning against that empties the table.
  if (getApi() === null) return;
  const protectedIds = await getProtectedIds(db);
  await deletePlaylistsNotIn(db, playlists.map((p) => p.id), [...protectedIds.playlistIds]);
}

/**
 * Run the full remote library sync into the normalized model. `full` drops +
 * recreates the normalized tables first (clean cold run). Deduped — a concurrent
 * call returns the running promise.
 */
export function runNormalizedLibrarySync(
  opts: { full?: boolean; forceStrategy?: 'search3' | 'basic' } = {},
): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = doNormalizedSync(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doNormalizedSync(
  { full = false, forceStrategy }: { full?: boolean; forceStrategy?: 'search3' | 'basic' },
): Promise<void> {
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

    // Transport: forced (dev fast/slow timing spikes) → use as-is; else the persisted
    // resume strategy; else probe once and persist.
    let strat = forceStrategy ?? syncStatusStore.getState().syncStrategy;
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
    // A resync can change album cover-art tokens — drop the bounded cover-art cache so
    // the next lookups re-read the fresh `albums.cover_art` (the cache is otherwise
    // populated on-demand and never self-invalidates).
    clearAlbumCoverArtCache();
    const albumMs = nowMs() - tAlbum0;
    const totalAlbums = await countAlbums(db);

    // ── Song phase → normalized `songs` ────────────────────────────────────────
    const tSong0 = nowMs();
    syncStatusStore.getState().setDetailSyncPhase('syncing');
    syncStatusStore.getState().setDetailSyncTotal(totalAlbums);
    syncStatusStore.getState().setDetailSyncCompleted(await countSongAlbums(db));
    if (strat === 'basic') {
      // Basic (non-search3) server, or a forced slow-path run: songs don't carry albumId,
      // so walk each album's getAlbum song list instead of paging search3.
      await doBasicSongWalk(db, articles, capturedGen);
      if (genChanged() || isOffline()) return;
    } else if ((await runSearch3SongPhase(db, articles, capturedGen)) === 'bailed') {
      return;
    }
    if (genChanged()) return;
    syncStatusStore.getState().setDetailSyncCompleted(totalAlbums);
    syncStatusStore.getState().markSongSyncComplete();
    const songMs = nowMs() - tSong0;

    // ── Artists + Playlists — lightweight lists, tacked onto the initial sync so the
    // user's first Artists/Playlists tab open is instant, not an on-demand fetch.
    if (!isOffline() && !genChanged()) {
      // eslint-disable-next-line no-console
      await syncArtistsNormalized(db, articles).catch((e) => console.warn('[normalized-sync] artists failed', e));
    }
    if (!isOffline() && !genChanged()) {
      // eslint-disable-next-line no-console
      await syncPlaylistsNormalized(db, articles).catch((e) => console.warn('[normalized-sync] playlists failed', e));
    }

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
