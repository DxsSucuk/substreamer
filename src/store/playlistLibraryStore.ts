import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import i18n from '../i18n/i18n';

import { createDebouncedPersistStorage } from './persistence';

import {
  deletePlaylist,
  deletePlaylistsNotIn,
  upsertPlaylists,
} from '../db/repository/playlists';
import { getProtectedIds } from '../db/protectedIds';
import {
  ensureCoverArtAuth,
  getAllPlaylists,
  getApi,
  type Playlist,
} from '../services/subsonicService';
import { getDb } from './persistence/db';
import { serverInfoStore } from './serverInfoStore';

/**
 * Hook invoked after `fetchAllPlaylists` has successfully replaced the list.
 * Registered by `dataSyncService` at module load; same pattern as the album
 * library reconcile hook. Receives the OLD and NEW id lists so consumers can
 * reap orphans from `playlistDetailStore` and pre-fetch new playlists.
 */
// Passes the full old + new playlist objects (not just ids) so the reconcile
// can detect UPDATED playlists by comparing `changed`/`songCount`, not only
// additions/removals.
let reconcileHook:
  | ((oldPlaylists: readonly Playlist[], newPlaylists: readonly Playlist[]) => void)
  | null = null;
export function registerPlaylistLibraryReconcileHook(
  hook:
    | ((oldPlaylists: readonly Playlist[], newPlaylists: readonly Playlist[]) => void)
    | null,
): void {
  reconcileHook = hook;
}

export interface PlaylistLibraryState {
  /** All playlists in the user's library */
  playlists: Playlist[];
  /** Whether a fetch is currently in progress */
  loading: boolean;
  /** Last error message, if any */
  error: string | null;
  /** Timestamp of the last successful fetch */
  lastFetchedAt: number | null;

  /** Fetch all playlists from the server via getPlaylists. */
  fetchAllPlaylists: () => Promise<void>;
  /** Remove a single playlist from the library by ID. */
  removePlaylist: (id: string) => void;
  /**
   * Patch a single playlist's editable metadata in place (after an edit), so
   * the library list reflects the change without a full re-sync. No-op if the
   * id isn't present.
   */
  patchPlaylistMetadata: (
    id: string,
    fields: { name?: string; comment?: string; public?: boolean },
  ) => void;
  /** Clear all playlist data */
  clearPlaylists: () => void;
}

const PERSIST_KEY = 'substreamer-playlist-library';

export const playlistLibraryStore = create<PlaylistLibraryState>()(
  persist(
    (set, get) => ({
      playlists: [],
      loading: false,
      error: null,
      lastFetchedAt: null,

      fetchAllPlaylists: async () => {
        // Prevent duplicate fetches
        if (get().loading) return;

        set({ loading: true, error: null });
        try {
          await ensureCoverArtAuth();
          const playlists = await getAllPlaylists();

          // Capture the old playlists at COMMIT time, not at fetch start, so
          // the reconcile hook sees the actual baseline at the moment the
          // store replacement happens. NB `getAllPlaylists` only throws on a
          // protocol/HTTP failure — with no usable API (offline, mid-logout,
          // pre-auth-restore) it returns `[]`, which is why the prune below is
          // gated rather than trusting an empty result.
          const oldPlaylists = get().playlists;

          // Array stays for the ~12 consumers + filters (retired in the search phase).
          set({ playlists, loading: false });
          // ALSO mirror into the normalized `playlists` table — the source the keyset
          // list reads. Upsert the current set, then prune server-side deletions only
          // when the API actually answered, never reaping downloaded playlists.
          // Best-effort. Bump `lastFetchedAt` AFTER the write so the keyset list reloads
          // with rows present. Articles match the scroller.
          try {
            const db = getDb();
            if (db) {
              const articles = serverInfoStore.getState().ignoredArticles ?? undefined;
              await upsertPlaylists(db, playlists, undefined, articles);
              if (getApi() !== null) {
                const protectedIds = await getProtectedIds(db);
                await deletePlaylistsNotIn(
                  db,
                  playlists.map((p) => p.id),
                  [...protectedIds.playlistIds],
                );
              }
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[playlistLibraryStore] normalized playlists upsert failed', err);
          }
          set({ lastFetchedAt: Date.now() });

          if (reconcileHook) {
            try {
              reconcileHook(oldPlaylists, playlists);
            } catch {
              /* non-critical — reconcile is best-effort */
            }
          }
        } catch (e) {
          set({
            loading: false,
            error: e instanceof Error ? e.message : i18n.t('failedToLoadPlaylists'),
          });
        }
      },

      removePlaylist: (id) => {
        set((state) => ({
          playlists: state.playlists.filter((p) => p.id !== id),
        }));
        // Mirror the deletion into the normalized list source (best-effort).
        const db = getDb();
        if (db) void deletePlaylist(db, id).catch(() => { /* best-effort */ });
      },

      patchPlaylistMetadata: (id, fields) => {
        set((state) => {
          if (!state.playlists.some((p) => p.id === id)) return {};
          return {
            playlists: state.playlists.map((p) =>
              p.id === id
                ? {
                    ...p,
                    ...(fields.name !== undefined ? { name: fields.name } : {}),
                    ...(fields.comment !== undefined ? { comment: fields.comment } : {}),
                    ...(fields.public !== undefined ? { public: fields.public } : {}),
                  }
                : p,
            ),
          };
        });
        // Re-upsert the patched playlist so normalized mirrors the array — a rename
        // re-derives sort_title/norm_name and the keyset list reorders (best-effort).
        const patched = get().playlists.find((p) => p.id === id);
        const db = getDb();
        if (patched && db) {
          const articles = serverInfoStore.getState().ignoredArticles ?? undefined;
          void upsertPlaylists(db, [patched], undefined, articles).catch(() => { /* best-effort */ });
        }
      },

      clearPlaylists: () =>
        set({
          playlists: [],
          loading: false,
          error: null,
          lastFetchedAt: null,
        }),
    }),
    {
      name: PERSIST_KEY,
      storage: createDebouncedPersistStorage(),
      partialize: (state) => ({
        playlists: state.playlists,
        lastFetchedAt: state.lastFetchedAt,
      }),
    }
  )
);
