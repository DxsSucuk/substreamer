import { create } from 'zustand';
import { bumpPlayStats } from './playStats';

import i18n from '../i18n/i18n';

import {
  clearLibraryAlbumsAsync,
  countLibraryAlbumsAsync,
  hydrateLibraryAlbumsAsync,
  kvStorage,
  upsertLibraryAlbumsAsync,
} from './persistence';

import {
  ensureCoverArtAuth,
  getAlbumsPageByName,
  probeEmptySearch3,
  searchAlbumsPage,
  type AlbumID3,
} from '../services/subsonicService';
import { baseCollator } from '../utils/intl';
import { getSortKey } from '../utils/sortHelpers';
import { layoutPreferencesStore } from './layoutPreferencesStore';
import { offlineModeStore } from './offlineModeStore';
import { ratingStore } from './ratingStore';
import { serverInfoStore } from './serverInfoStore';
import { syncStatusStore } from './syncStatusStore';

/**
 * Hook invoked after `fetchAllAlbums` has successfully replaced the library.
 * Registered by `dataSyncService` at module load so we avoid a circular
 * import (dataSyncService → albumLibraryStore → dataSyncService).
 * Receives the OLD and NEW id lists so consumers can reap orphans from
 * downstream caches (albumDetailStore, songIndexStore) and pre-fetch new IDs.
 */
let reconcileHook: ((oldIds: readonly string[], newIds: readonly string[]) => void) | null = null;
export function registerAlbumLibraryReconcileHook(
  hook: ((oldIds: readonly string[], newIds: readonly string[]) => void) | null,
): void {
  reconcileHook = hook;
}

/**
 * Sort an album array by the current sort preference using
 * article-stripped, accent-folded keys. Schwartzian transform — sort
 * keys are computed once per item, not twice per comparison, which
 * matters on large libraries (100k albums × n log n vs 2× n log n).
 */
function sortAlbumsByPreference(albums: AlbumID3[]): AlbumID3[] {
  const sortOrder = layoutPreferencesStore.getState().albumSortOrder;
  const articles = serverInfoStore.getState().ignoredArticles ?? undefined;
  const decorated = albums.map((a): [string, AlbumID3] => {
    const key =
      sortOrder === 'title'
        ? getSortKey(a.name ?? '', a.sortName, articles)
        : getSortKey(a.artist ?? '', undefined, articles);
    return [key, a];
  });
  decorated.sort(([ka], [kb]) => baseCollator.compare(ka, kb));
  return decorated.map(([, a]) => a);
}

/**
 * The stable, title-based sort key stored in each `library_albums` row. The
 * DISK order is always title-based so a resume-from-`COUNT(*)` offset is
 * meaningful; the in-memory list is re-sorted by the user's live preference
 * (title OR artist) via {@link sortAlbumsByPreference}. Reads `ignoredArticles`
 * at write time — if the server's article list later changes the disk pre-sort
 * is slightly stale, but the visible order (always re-sorted in memory) stays
 * correct.
 */
function titleSortKeyFor(a: AlbumID3): string {
  const articles = serverInfoStore.getState().ignoredArticles ?? undefined;
  return getSortKey(a.name ?? '', a.sortName, articles);
}

/** Basic-path page size. `getAlbumList2.size` is spec-capped at 500. */
const PAGE_SIZE = 500;
/** Fast-path (paged `search3`) page size. `search3.albumCount` is uncapped, but a
 *  smaller page bounds peak memory (fewer transient parsed objects per fetch) and
 *  is safer on servers that choke on a 10k `search3` — at a negligible cost in
 *  extra round-trips (sync time is dominated by per-item work, not round-trips).
 *  Right-sized down from 10k; tune via the remote-sync spike (E). */
const SEARCH3_PAGE = 1000;
/** Infinite-loop backstop: a server that ignores `offset` and never returns an
 *  empty page can't run past this. Expressed as a sane album cap (well beyond any
 *  real library) over the page size, so it stays correct if the page size changes. */
const MAX_ALBUMS = 500_000;
const PAGE_CEILING = Math.ceil(MAX_ALBUMS / SEARCH3_PAGE);
/** The legacy KV blob the album list used before it became row-based. Seeded
 *  into `library_albums` once on upgrade, then deleted. */
const LEGACY_BLOB_KEY = 'substreamer-album-library';

/**
 * Monotonic token identifying the currently-authoritative `fetchAllAlbums`
 * run. A generation bump (server-switch / force-resync / user-cancel) makes a
 * running pager bail; but `clearAlbums` resets `loading` to false, which lets a
 * fresh `fetchAllAlbums` start before the old pager has finished bailing —
 * briefly overlapping. Only the run whose token is still `activeFetchToken`
 * may mutate `loading`, so a stale bailing pager can't clobber the new run's
 * state (nor leave `loading` stuck true after a user-cancel).
 */
let activeFetchToken = 0;

/**
 * One-time upgrade seed: if `library_albums` is empty but the old KV blob
 * exists, seed its albums into rows for instant UI. Does NOT mark the sync
 * complete — a blob may be partial (e.g. a large library whose blob never
 * fully persisted), so the resume pager backfills from `COUNT(*)`. The blob is
 * deleted only after the seed commits.
 */
async function seedFromLegacyBlob(): Promise<AlbumID3[] | null> {
  try {
    const raw = await kvStorage.getItem(LEGACY_BLOB_KEY);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as { state?: { albums?: AlbumID3[] } };
    const albums = parsed?.state?.albums;
    if (!Array.isArray(albums) || albums.length === 0) {
      // Nothing usable — drop the stale blob so we don't re-parse it every boot.
      await kvStorage.removeItem(LEGACY_BLOB_KEY);
      return null;
    }
    await upsertLibraryAlbumsAsync(albums, titleSortKeyFor);
    await kvStorage.removeItem(LEGACY_BLOB_KEY);
    return albums;
  } catch {
    return null;
  }
}

export interface AlbumLibraryState {
  /** All albums in the user's library (in-memory mirror of `library_albums`). */
  albums: AlbumID3[];
  /** Whether a fetch is currently in progress */
  loading: boolean;
  /** Last error message, if any */
  error: string | null;
  /** True once `hydrateFromDbAsync` has loaded the row-backed list (or seeded
   *  from the legacy blob). Consumers gate their "empty → fetch" mount check on
   *  this so an un-hydrated empty window can't trigger a spurious full fetch. */
  hasHydrated: boolean;

  /** Load the in-memory list from the `library_albums` rows (or seed from the
   *  legacy blob on first upgrade). Called by `rehydrateAllStores` at boot. */
  hydrateFromDbAsync: () => Promise<void>;
  /**
   * Fetch the full album list from the server, paginated into `library_albums`.
   * Pages of 500 via `getAlbumList2` (alphabeticalByName); persists each page
   * progressively; resumes from `COUNT(*)`; marks complete when the last page
   * is reached. Runs in the background, yielding between pages.
   */
  fetchAllAlbums: () => Promise<void>;
  /** Re-sort the in-memory album list using the current sort preference. */
  resortAlbums: () => void;
  /**
   * Merge a batch of albums into the in-memory list by id, replacing existing
   * entries and appending new ones. Triggers a re-sort and a row write-through.
   * Used by the incremental change-detection path to add newly discovered
   * albums without a full refetch.
   */
  upsertAlbums: (albums: AlbumID3[]) => void;
  /** Eagerly bump local play stats on the matching album in the library list.
   *  No-op when the album isn't present or `albumId` is undefined. Persists the
   *  bumped album so the play stats survive restart. */
  applyLocalPlay: (albumId: string | undefined, now: string) => void;
  /** Clear all album data (in-memory + the `library_albums` rows + sync markers). */
  clearAlbums: () => Promise<void>;
}

export const albumLibraryStore = create<AlbumLibraryState>()((set, get) => ({
  albums: [],
  loading: false,
  error: null,
  hasHydrated: false,

  hydrateFromDbAsync: async () => {
    let restored = await hydrateLibraryAlbumsAsync();
    if (restored.length === 0) {
      const seeded = await seedFromLegacyBlob();
      if (seeded) restored = seeded;
    }
    ratingStore.getState().reconcileRatings(
      restored.map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 })),
    );
    set({ albums: sortAlbumsByPreference(restored), hasHydrated: true });
  },

  fetchAllAlbums: async () => {
    // Prevent duplicate/concurrent fetches (a pull-to-refresh or the screen's
    // mount guard while a fetch is already running dedups here).
    if (get().loading) return;

    const myToken = ++activeFetchToken;
    const isStale = () => activeFetchToken !== myToken;

    set({ loading: true, error: null });
    const sync = syncStatusStore.getState();
    sync.setLibrarySyncPhase('fetching');
    const capturedGen = sync.generation;

    // Only touch `loading` if a newer run hasn't taken over (isStale).
    const bail = (): void => {
      if (!isStale()) set({ loading: false });
    };
    // A server-switch / logout / force-resync bumps generation.
    const genChanged = (): boolean => syncStatusStore.getState().generation !== capturedGen;

    // Pre-fetch id set for the reconcile hook (removals/additions across the
    // whole refetch) + cross-strategy dedup.
    const oldIds = get().albums.map((a) => a.id);
    const seen = new Set<string>(oldIds);

    // Persist a batch to rows + append the fresh ones to the in-memory list +
    // bump progress. Caller gen-checks before invoking.
    const ingest = async (batch: AlbumID3[]): Promise<void> => {
      await upsertLibraryAlbumsAsync(batch, titleSortKeyFor);
      const fresh = batch.filter((a) => !seen.has(a.id));
      for (const a of fresh) seen.add(a.id);
      // Interim fetch order — the final sort settles it; the banner says "fetching".
      if (fresh.length > 0) set({ albums: [...get().albums, ...fresh] });
      syncStatusStore.getState().setLibrarySyncProgress(seen.size);
    };

    // Paginated getAlbumList2 (alphabeticalByName) from `startOffset` to
    // exhaustion. 'done' = full list fetched; 'bailed' = gen change / offline /
    // server-ignores-offset.
    const runAlphabetical = async (startOffset: number): Promise<'done' | 'bailed'> => {
      let offset = startOffset;
      let pageCount = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (genChanged()) return 'bailed';
        if (offlineModeStore.getState().offlineMode) {
          syncStatusStore.getState().setLibrarySyncPhase('paused-offline');
          return 'bailed';
        }
        // eslint-disable-next-line no-await-in-loop
        const batch = await getAlbumsPageByName(PAGE_SIZE, offset);
        if (batch.length === 0) return 'done'; // end of results
        // Server ignores `offset` (same page repeatedly) → all-duplicates.
        if (batch.every((a) => seen.has(a.id))) {
          syncStatusStore.getState().setLibrarySyncPhase('idle');
          return 'bailed';
        }
        if (genChanged()) return 'bailed';
        // eslint-disable-next-line no-await-in-loop
        await ingest(batch);
        offset += batch.length; // advance by ACTUAL count (server may return < size)
        if ((pageCount += 1) > PAGE_CEILING) return 'done'; // infinite-loop backstop
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    };

    // Fast path: page empty-query `search3` by `albumOffset` in 10k chunks from
    // `startOffset` (the persisted resume cursor) to exhaustion. Returns
    // 'switch-basic' if the server ignores the offset (all-duplicate page).
    const runSearch3Paged = async (startOffset: number): Promise<'done' | 'bailed' | 'switch-basic'> => {
      let offset = startOffset;
      let pageCount = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (genChanged()) return 'bailed';
        if (offlineModeStore.getState().offlineMode) {
          syncStatusStore.getState().setLibrarySyncPhase('paused-offline');
          return 'bailed';
        }
        // eslint-disable-next-line no-await-in-loop
        const batch = await searchAlbumsPage(SEARCH3_PAGE, offset);
        if (batch.length === 0) return 'done';
        // Server ignored `albumOffset` (returned an already-seen page) → it isn't
        // really paging; abandon fast and restart on the basic path.
        if (offset > 0 && batch.every((a) => seen.has(a.id))) return 'switch-basic';
        if (genChanged()) return 'bailed';
        // eslint-disable-next-line no-await-in-loop
        await ingest(batch);
        offset += batch.length;
        syncStatusStore.getState().setLibrarySyncCursor(offset); // persist resume cursor
        if ((pageCount += 1) > PAGE_CEILING) return 'done';
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    };

    try {
      await ensureCoverArtAuth();

      // Decide the transport once via the capability probe (persisted for resume).
      let strategy = syncStatusStore.getState().syncStrategy;
      if (strategy === null) {
        strategy = (await probeEmptySearch3()) ? 'search3' : 'basic';
        if (genChanged()) return bail();
        syncStatusStore.getState().setSyncStrategy(strategy);
      }

      if (strategy === 'search3') {
        const r = await runSearch3Paged(syncStatusStore.getState().librarySyncCursor);
        if (r === 'bailed') return bail();
        if (r === 'switch-basic') {
          // Server claimed empty-query support but doesn't page — restart basic.
          await clearLibraryAlbumsAsync();
          set({ albums: [] });
          seen.clear();
          syncStatusStore.getState().setSyncStrategy('basic');
          syncStatusStore.getState().setLibrarySyncCursor(0);
          const r2 = await runAlphabetical(0);
          if (r2 === 'bailed') return bail();
        }
      } else {
        // Basic path — paginate getAlbumList2 from the row count (contiguous
        // alphabetical prefix).
        const r = await runAlphabetical(await countLibraryAlbumsAsync());
        if (r === 'bailed') return bail();
      }

      // A newer run took over while we were finishing — don't clobber its state.
      if (isStale()) return;

      // Completed: final sort + ratings reconcile + mark complete.
      const sorted = sortAlbumsByPreference(get().albums);
      ratingStore.getState().reconcileRatings(
        sorted.map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 })),
      );
      set({ albums: sorted, loading: false });
      syncStatusStore.getState().markLibrarySyncComplete();

      if (reconcileHook) {
        try {
          reconcileHook(oldIds, sorted.map((a) => a.id));
        } catch {
          /* non-critical — reconcile is best-effort */
        }
      }
    } catch (e) {
      // Transport failure — preserve the existing rows/list; surface the error.
      // Leaves librarySyncComplete false so the fetch resumes next launch.
      if (!isStale()) {
        set({
          loading: false,
          error: e instanceof Error ? e.message : i18n.t('failedToLoadAlbums'),
        });
        syncStatusStore.getState().setLibrarySyncPhase('idle');
      }
    }
  },

  resortAlbums: () => {
    const current = get().albums;
    if (current.length === 0) return;
    set({ albums: sortAlbumsByPreference(current) });
  },

  upsertAlbums: (albums: AlbumID3[]) => {
    if (albums.length === 0) return;
    const current = get().albums;
    const merged: Record<string, AlbumID3> = {};
    for (const a of current) merged[a.id] = a;
    for (const a of albums) merged[a.id] = a;
    const next = sortAlbumsByPreference(Object.values(merged));
    ratingStore.getState().reconcileRatings(
      albums.map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 })),
    );
    set({ albums: next });
    // Write-through to rows (fire-and-forget after the in-memory set).
    void upsertLibraryAlbumsAsync(albums, titleSortKeyFor);
  },

  applyLocalPlay: (albumId, now) => {
    if (!albumId) return;
    const current = get().albums;
    const idx = current.findIndex((a) => a.id === albumId);
    if (idx === -1) return;
    const oldAlbum = current[idx];
    const nextAlbum: AlbumID3 = bumpPlayStats(oldAlbum, now);
    const nextAlbums = current.map((a, i) => (i === idx ? nextAlbum : a));
    set({ albums: nextAlbums });
    // Persist the bumped album to the blob — play stats survive restart. Skip the
    // FULL normalized dual-write here (it would DELETE+reinsert the album's child
    // tables just to bump a scalar). The normalized play stats are kept current by a
    // TARGETED scalar UPDATE in playStatsService.applyLocalPlay (bumpAlbumPlayStats).
    void upsertLibraryAlbumsAsync([nextAlbum], titleSortKeyFor, { syncNormalized: false });
  },

  clearAlbums: async () => {
    set({ albums: [], loading: false, error: null });
    // Wipe the rows (awaited) so they're gone before any subsequent fetch
    // (server-switch / force-resync await this before refetching).
    await clearLibraryAlbumsAsync();
    syncStatusStore.getState().resetLibrarySync();
  },
}));

// Re-sort albums when the user changes the sort preference.
layoutPreferencesStore.subscribe((state, prevState) => {
  if (state.albumSortOrder !== prevState.albumSortOrder) {
    albumLibraryStore.getState().resortAlbums();
  }
});

// NOTE: the `albumListsStore → albumLibraryStore` subscribe used to live
// here. It was retired in Phase 5 of the data-sync refactor. The equivalent
// behavior (refresh library when recentlyAdded surfaces an unknown id) is
// now owned by `dataSyncService.ts` via `onAlbumReferenced`, which also
// handles download-triggered references from `musicCacheService`.
