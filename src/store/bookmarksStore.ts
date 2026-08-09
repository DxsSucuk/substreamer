/**
 * The saved play queues. Every mutation writes through to `queue_snapshots`
 * (`kind = 'bookmark'`) — the same table pair the live queue uses — AND to the KV
 * blob, which is still the source the store hydrates from.
 *
 * Reads flip to SQL in D1.4, once the migration has moved the existing blob into
 * rows: until then the table holds only what was saved after the upgrade, so
 * {@link BookmarksState.hydrateFromDbAsync} is deliberately not wired into
 * `rehydrateAllStores` yet. It replaces the map wholesale, and the persist
 * middleware writes whatever it produces straight back over the blob.
 *
 * Bookmarks are never capped, evicted or pruned: they are user-created and there is
 * nothing to re-derive them from.
 */
import { create } from 'zustand';
import { mergeExistingWins } from './mergeRecord';
import { createJSONStorage, persist } from 'zustand/middleware';

import { kvStorage } from './persistence';
import {
  deleteSnapshot,
  readBookmarkSnapshots,
  replaceSnapshotTracks,
  upsertSnapshot,
  type QueueSnapshotMeta,
} from './persistence/queueSnapshotTable';
import { type Child } from '../services/subsonicService';

/**
 * A saved snapshot of the play queue plus the position of the current track,
 * so the user can later restore the queue and resume playback exactly where
 * they left off. Fully local to Substreamer — never pushed to the server, but
 * included in backups (see backupService) so it survives reinstall/device
 * change like completed plays and scrobble exclusions.
 */
export interface PlayQueueBookmark {
  /** Stable per-bookmark UUID. */
  id: string;
  /** User-facing name (auto-generated or entered). */
  name: string;
  /** Creation time, ms epoch. */
  createdAt: number;
  /** Full queue snapshot, same Child[] shape queuePersistenceService persists. */
  queue: Child[];
  /** Index of the current track within `queue`. */
  currentIndex: number;
  /** Playback position within the current track, in seconds. */
  positionSec: number;
}

type BookmarkSort = 'newest' | 'oldest';

interface BookmarksState {
  bookmarks: Record<string, PlayQueueBookmark>;
  /** When true, tapping the player bookmark icon auto-names the bookmark. */
  autoName: boolean;
  /** Persisted sort order for the bookmarks list. */
  sortOrder: BookmarkSort;

  addBookmark: (bookmark: PlayQueueBookmark) => void;
  removeBookmark: (id: string) => void;
  renameBookmark: (id: string, name: string) => void;
  setAutoName: (autoName: boolean) => void;
  setSortOrder: (sortOrder: BookmarkSort) => void;
  /**
   * Merge incoming bookmarks into the existing set: union, existing-wins on id
   * collision (consistent with scrobbleExclusionStore/mbidOverrideStore). Used
   * by merge-mode backup restore. Returns counts.
   *
   * Memory + the KV blob, which is what the store still reads. D1.3 must route it
   * through the repository as well, before D1.4 flips reads to SQL.
   */
  mergeBookmarks: (
    incoming: Record<string, PlayQueueBookmark>,
  ) => { added: number; skipped: number };
  /**
   * Replace the in-memory map from `queue_snapshots`. NOT wired into
   * `rehydrateAllStores` yet — D1.4 does that, after its migration has made the
   * table the complete set (see the module docblock).
   */
  hydrateFromDbAsync: () => Promise<void>;
}

const PERSIST_KEY = 'substreamer-bookmarks';

/** A bookmark's parent row. `kind` is what separates it from the live queue in the
 *  table the two share; `trackCount` belongs to `replaceSnapshotTracks`. */
const snapshotMeta = (
  bookmark: PlayQueueBookmark,
): Omit<QueueSnapshotMeta, 'trackCount'> => ({
  id: bookmark.id,
  kind: 'bookmark',
  name: bookmark.name,
  createdAt: bookmark.createdAt,
  currentIndex: bookmark.currentIndex,
  positionSec: bookmark.positionSec,
});

/** Parent row then songs, in that order — the songs FK to the parent. Each op
 *  swallows its own failures, so this never rejects. */
async function writeBookmark(bookmark: PlayQueueBookmark): Promise<void> {
  await upsertSnapshot(snapshotMeta(bookmark));
  await replaceSnapshotTracks(bookmark.id, bookmark.queue);
}

export const bookmarksStore = create<BookmarksState>()(
  persist(
    (set, get) => ({
      bookmarks: {},
      autoName: true,
      sortOrder: 'newest',

      addBookmark: (bookmark) => {
        set((state) => ({
          bookmarks: { ...state.bookmarks, [bookmark.id]: bookmark },
        }));
        void writeBookmark(bookmark);
      },

      removeBookmark: (id) => {
        set((state) => {
          const { [id]: _removed, ...rest } = state.bookmarks;
          return { bookmarks: rest };
        });
        void deleteSnapshot(id);
      },

      renameBookmark: (id, name) => {
        const existing = get().bookmarks[id];
        if (!existing) return;
        const renamed = { ...existing, name };
        set((state) => ({ bookmarks: { ...state.bookmarks, [id]: renamed } }));
        // Parent row only: an UPSERT leaves the songs alone, which is exactly what
        // `INSERT OR REPLACE` would not do (it cascades them away).
        void upsertSnapshot(snapshotMeta(renamed));
      },

      setAutoName: (autoName) => set({ autoName }),
      setSortOrder: (sortOrder) => set({ sortOrder }),

      mergeBookmarks: (incoming) => {
        const next = { ...get().bookmarks };
        const { added, skipped } = mergeExistingWins(
          next,
          incoming,
          (value) =>
            !!value && typeof value === 'object' && !!value.id && Array.isArray(value.queue),
        );
        if (added > 0) set({ bookmarks: next });
        return { added, skipped };
      },

      hydrateFromDbAsync: async () => {
        const snapshots = await readBookmarkSnapshots();
        const bookmarks: Record<string, PlayQueueBookmark> = {};
        for (const snapshot of snapshots) {
          bookmarks[snapshot.id] = {
            id: snapshot.id,
            name: snapshot.name ?? '',
            createdAt: snapshot.createdAt,
            queue: snapshot.tracks,
            currentIndex: snapshot.currentIndex,
            positionSec: snapshot.positionSec ?? 0,
          };
        }
        set({ bookmarks });
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({
        bookmarks: state.bookmarks,
        autoName: state.autoName,
        sortOrder: state.sortOrder,
      }),
    },
  ),
);
