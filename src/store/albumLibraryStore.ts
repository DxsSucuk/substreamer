import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import i18n from '../i18n/i18n';

import { kvStorage } from './persistence';

import {
  ensureCoverArtAuth,
  getAllAlbumsAlphabetical,
  searchAllAlbums,
  type AlbumID3,
} from '../services/subsonicService';
import { baseCollator } from '../utils/intl';
import { getSortKey } from '../utils/sortHelpers';
import { layoutPreferencesStore } from './layoutPreferencesStore';
import { ratingStore } from './ratingStore';
import { serverInfoStore } from './serverInfoStore';

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
 * matters on large libraries (10k albums × n log n vs 2× n log n).
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

export interface AlbumLibraryState {
  /** All albums in the user's library */
  albums: AlbumID3[];
  /** Whether a fetch is currently in progress */
  loading: boolean;
  /** Last error message, if any */
  error: string | null;
  /** Timestamp of the last successful fetch */
  lastFetchedAt: number | null;

  /**
   * Fetch all albums from the server.
   * Strategy: try search3 with empty query first (fast, single request).
   * If the result set is empty, fall back to paginated getAlbumList2.
   */
  fetchAllAlbums: () => Promise<void>;
  /** Re-sort the in-memory album list using the current sort preference. */
  resortAlbums: () => void;
  /**
   * Merge a batch of albums into the in-memory list by id, replacing existing
   * entries and appending new ones. Triggers a re-sort. Used by the incremental
   * change-detection path to add newly discovered albums without a full
   * refetch.
   */
  upsertAlbums: (albums: AlbumID3[]) => void;
  /** Eagerly bump local play stats on the matching album in the library list.
   *  No-op when the album isn't present or `albumId` is undefined. */
  applyLocalPlay: (albumId: string | undefined, now: string) => void;
  /** Clear all album data */
  clearAlbums: () => void;
}

const PERSIST_KEY = 'substreamer-album-library';

export const albumLibraryStore = create<AlbumLibraryState>()(
  persist(
    (set, get) => ({
      albums: [],
      loading: false,
      error: null,
      lastFetchedAt: null,

      fetchAllAlbums: async () => {
        // Prevent duplicate fetches
        if (get().loading) return;

        set({ loading: true, error: null });
        try {
          await ensureCoverArtAuth();

          // Strategy 1: try search3 with empty query (works on many servers)
          let albums = await searchAllAlbums();

          // Strategy 2: if search3 returned nothing, paginate via getAlbumList2
          if (albums.length === 0) {
            albums = await getAllAlbumsAlphabetical();
          }

          // Sort albums according to the user's preferred sort order,
          // using article-stripped + accent-folded sort keys.
          const sortedAlbums = sortAlbumsByPreference(albums);

          // Capture old IDs at COMMIT time, not at fetch start. Reading them
          // before the network call diffs against a stale baseline if the
          // store mutates during the in-flight fetch (e.g. `applyLocalPlay`
          // bumping a playCount), causing the reconcile hook to receive
          // false-positive removals. Both transports throw on protocol or
          // HTTP failure (see `throwIfSubsonicFailure` in subsonicService),
          // so reaching this point means the empty/non-empty result is
          // authoritative — honor it.
          const oldIds = get().albums.map((a) => a.id);

          ratingStore.getState().reconcileRatings(
            sortedAlbums.map((a) => ({ id: a.id, serverRating: a.userRating ?? 0 }))
          );
          set({
            albums: sortedAlbums,
            loading: false,
            lastFetchedAt: Date.now(),
          });

          // Notify the reconcile hook (dataSyncService) so it can reap orphans
          // from albumDetailStore / songIndexStore and pre-fetch new IDs. Runs
          // asynchronously from the caller's perspective.
          if (reconcileHook) {
            try {
              reconcileHook(oldIds, sortedAlbums.map((a) => a.id));
            } catch {
              /* non-critical — reconcile is best-effort */
            }
          }
        } catch (e) {
          // Transport failure (HTTP error or Subsonic protocol failure).
          // Preserve the existing cache; surface the error in state.
          set({
            loading: false,
            error: e instanceof Error ? e.message : i18n.t('failedToLoadAlbums'),
          });
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
      },

      applyLocalPlay: (albumId, now) => {
        if (!albumId) return;
        const current = get().albums;
        const idx = current.findIndex((a) => a.id === albumId);
        if (idx === -1) return;
        const oldAlbum = current[idx];
        const nextAlbum: AlbumID3 = {
          ...oldAlbum,
          playCount: (oldAlbum.playCount ?? 0) + 1,
          played: now,
        };
        const nextAlbums = current.map((a, i) => (i === idx ? nextAlbum : a));
        set({ albums: nextAlbums });
      },

      clearAlbums: () =>
        set({
          albums: [],
          loading: false,
          error: null,
          lastFetchedAt: null,
        }),
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({
        albums: state.albums,
        lastFetchedAt: state.lastFetchedAt,
      }),
      // After rehydrate, re-sort using the current article-stripped
      // logic. The persisted array was sorted by whatever rules were in
      // effect when it was stored; without this, an upgrade from a
      // previous build leaves the library in the OLD order until the
      // next fetch or sort-toggle.
      onRehydrateStorage: () => (state) => {
        if (state && state.albums.length > 0) {
          state.albums = sortAlbumsByPreference(state.albums);
        }
      },
    }
  )
);

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
