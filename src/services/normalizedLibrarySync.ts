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
 * Handles both transports: paged `search3` where songs carry `albumId`, and the
 * per-album `getAlbum` walk for basic servers (and for search3 servers whose songs
 * come back without `albumId`).
 */
import type { AlbumID3, Child } from 'subsonic-api';

import type { InternalDb } from '@/db/client';
import { ensureNormalizedSchema, resetNormalizedSchema } from '@/db/createNormalizedTables';
import { countAlbums, listAlbumIds, upsertAlbums } from '@/db/repository/albums';
import { deleteArtistsNotIn, upsertArtists } from '@/db/repository/artists';
import { deletePlaylistsNotIn, upsertPlaylists } from '@/db/repository/playlists';
import { getProtectedIds } from '@/db/protectedIds';
import {
  countSongAlbums,
  countSongs,
  deleteAlbumSongsNotIn,
  listSongAlbumIds,
  upsertSongs,
} from '@/db/repository/songs';
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
/** Generation + fullness of the in-flight run, so a later caller can tell whether
 *  joining it would actually satisfy the request. See `runNormalizedLibrarySync`. */
let inFlightGen = -1;
let inFlightFull = false;

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
): Promise<'done' | 'bailed'> {
  const genChanged = (): boolean => syncStatusStore.getState().generation !== capturedGen;
  const isOffline = (): boolean => offlineModeStore.getState().offlineMode;

  const allIds = await listAlbumIds(db);
  // A full resync must re-fetch EVERY album's songs. The incremental walk skips albums
  // that already have songs, which — now that a full resync no longer drops the tables —
  // would make it an instant no-op and silently mark the sync complete.
  const fullWalk = syncStatusStore.getState().fullWalkPending;
  const have = fullWalk ? new Set<string>() : new Set(await listSongAlbumIds(db));
  const missing = allIds.filter((id) => !have.has(id));
  syncStatusStore.getState().setDetailSyncTotal(allIds.length);
  let done = allIds.length - missing.length;
  syncStatusStore.getState().setDetailSyncCompleted(done);
  if (missing.length === 0) return 'done';

  // Abort the pool on a generation bump (cancel/force-resync/logout) or an offline flip.
  const ctrl = new AbortController();
  const unsubGen = syncStatusStore.subscribe((s) => {
    if (s.generation !== capturedGen) ctrl.abort();
  });
  const unsubOffline = offlineModeStore.subscribe((s) => {
    if (s.offlineMode) ctrl.abort();
  });
  let result;
  try {
    result = await runPool(
      missing,
      async (id) => {
        if (genChanged() || isOffline()) throw new Error('walk-bail');
        // `getAlbum` swallows every error and returns null, so a null result is the ONLY
        // signal a fetch failed. Throw so it lands in runPool's `rejected` — otherwise a
        // flaky connection silently leaves albums track-less and still reports success.
        const album = await getAlbum(id);
        if (album === null) throw new Error('walk-fetch-failed');
        if (album.song && album.song.length > 0) {
          await upsertSongs(db, album.song, undefined, articles);
          await deleteAlbumSongsNotIn(db, id, album.song.map((s) => s.id));
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
  // A partial walk must NOT read as success: it would clear `fullWalkPending` and mark
  // the song sync complete with albums still missing their tracks.
  if (result.aborted || result.rejected.length > 0) return 'bailed';
  return 'done';
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
    // An empty page means "end of library" ONLY if we actually had an API to ask. With
    // no usable API (mid-logout, pre-auth-restore) the page fns resolve [] without
    // throwing, and treating that as the end marks a truncated library complete.
    if (page.length === 0) return getApi() === null ? 'bailed' : 'done';
    if (firstPage) {
      firstPage = false;
      const missing = page.filter((s) => !s.albumId).length;
      if (missing / page.length > 0.01) {
        // Songs lack albumId — fall back to the per-album walk.
        // eslint-disable-next-line no-await-in-loop
        const walk = await doBasicSongWalk(db, articles, capturedGen);
        return walk === 'done' && !genChanged() && !isOffline() ? 'done' : 'bailed';
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
  // Prune only when the API actually answered — same shape as the playlist prune.
  // Nothing else ever removes an artist row, so a server-side rename (ids are name
  // hashes on some servers) would otherwise leave the old artist in the list forever.
  if (getApi() === null) return;
  await deleteArtistsNotIn(db, artists.map((a) => a.id));
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
 * Run the full remote library sync into the normalized model. `full` restarts from
 * cursor zero and re-walks every album's songs, without dropping the tables.
 *
 * Deduping is conditional: a plain concurrent call joins the running promise, but a
 * `full` request must never silently join a non-full run (that is the user tapping the
 * exit hatch and getting nothing), and neither may a call whose generation has moved on
 * — `forceFullResync` bumps the generation immediately before asking for the full run.
 */
export function runNormalizedLibrarySync(
  opts: { full?: boolean; forceStrategy?: 'search3' | 'basic' } = {},
): Promise<void> {
  const gen = syncStatusStore.getState().generation;
  const canJoin = inFlight !== null && gen === inFlightGen && (!opts.full || inFlightFull);
  if (canJoin) return inFlight as Promise<void>;
  const previous = inFlight;
  inFlightGen = gen;
  inFlightFull = opts.full === true;
  const run = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => doNormalizedSync(opts));
  inFlight = run.finally(() => {
    if (inFlight === run) inFlight = null;
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
    ensureNormalizedSchema(db);
    if (full) {
      // Deliberately NOT `resetNormalizedSchema`. Dropping the tables also destroys the
      // things the sync never rebuilds — playlist membership, artist bio/similar/top
      // songs — and album/playlist detail read only the normalized tables, so a
      // downloaded album's track list goes blank offline until the song phase finishes,
      // permanently if it is interrupted. Upserts overwrite every server-derived column
      // anyway, so a restart-from-zero rebuild is equivalent without the collateral.
      syncStatusStore.getState().resetLibrarySync();
      syncStatusStore.getState().resetSongSync();
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
      if (page.length === 0) {
        // End of library ONLY if we actually had an API to ask — the page fns resolve
        // [] without throwing when there is none (mid-logout, pre-auth-restore), and
        // marking the library complete off that leaves it permanently truncated.
        if (getApi() === null) return;
        break;
      }
      // Ignore-offset guard: a server that ignores `albumOffset` returns the same
      // first page forever. Detect via an unchanged first id and switch to basic.
      if (!useBasic && albumOffset > 0 && page[0]?.id === prevFirstId) {
        useBasic = true;
        albumOffset = 0; // restart basic; upserts are idempotent
        prevFirstId = null;
        continue;
      }
      prevFirstId = page[0]?.id ?? null;
      // Correct any stale optimistic rating override against the server value — parity
      // with the blob album-list sync (`albumLibraryStore.fetchAllAlbums`), which is the
      // only thing doing this today and goes away with that store. Per page rather than
      // at the end so it stays bounded-memory.
      ratingStore.getState().reconcileRatings(
        page.map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 })),
      );
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
    // On a full re-walk every album is about to be re-fetched, so seeding from
    // `countSongAlbums` would show 100% for the whole phase (the rows are still there —
    // we no longer drop them). Start from zero and let the walk count up.
    const fullWalk = syncStatusStore.getState().fullWalkPending;
    syncStatusStore.getState().setDetailSyncCompleted(fullWalk ? 0 : await countSongAlbums(db));
    if (strat === 'basic') {
      // Basic (non-search3) server, or a forced slow-path run: songs don't carry albumId,
      // so walk each album's getAlbum song list instead of paging search3.
      if ((await doBasicSongWalk(db, articles, capturedGen)) === 'bailed') return;
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
