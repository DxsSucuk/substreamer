/**
 * The saved play queues, stored as `queue_snapshots` rows (`kind = 'bookmark'`) — the
 * same table pair the live queue uses. Every mutation writes through, and
 * {@link BookmarksState.hydrateFromDbAsync} reads the map back from those rows in
 * `rehydrateAllStores`.
 *
 * The KV blob is the PREVIOUS home and still the fallback until migration 36 has moved
 * it into rows, which is what {@link BookmarksState.sqlAuthoritative} tracks. `persist`
 * stays for `autoName`/`sortOrder`, which have no table of their own.
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
  upsertSnapshot,
  writeBookmarkSnapshots,
  type BookmarkSnapshotInput,
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
  /**
   * True once the rows have been observed to hold everything memory holds — set by
   * {@link BookmarksState.hydrateFromDbAsync}, never persisted. While it is false the
   * KV blob is still the complete copy and `partialize` keeps writing it.
   */
  sqlAuthoritative: boolean;

  addBookmark: (bookmark: PlayQueueBookmark) => void;
  removeBookmark: (id: string) => void;
  renameBookmark: (id: string, name: string) => void;
  setAutoName: (autoName: boolean) => void;
  setSortOrder: (sortOrder: BookmarkSort) => void;
  /**
   * Merge incoming bookmarks into the existing set: union, existing-wins on id
   * collision (consistent with scrobbleExclusionStore/mbidOverrideStore). Used
   * by merge-mode backup restore. Returns counts.
   */
  mergeBookmarks: (
    incoming: Record<string, PlayQueueBookmark>,
  ) => { added: number; skipped: number };
  /**
   * Replace the whole set with `incoming`, dropping malformed entries. Used by
   * replace-mode backup restore; returns how many were kept. The repository is
   * cleared and rewritten in one atomic batch, so the set is never a mix of the
   * two.
   */
  replaceBookmarks: (incoming: Record<string, PlayQueueBookmark>) => number;
  /**
   * Replace the in-memory map from `queue_snapshots`, once the rows are known to be
   * the complete set. Called from `rehydrateAllStores`; a no-op whenever it cannot
   * prove that, which leaves the KV-hydrated map alone.
   */
  hydrateFromDbAsync: () => Promise<void>;
}

const PERSIST_KEY = 'substreamer-bookmarks';

/** A bookmark's parent row alone — what a rename writes. `kind` is what separates it
 *  from the live queue in the table the two share; `trackCount` belongs to the songs
 *  write. */
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

/** A bookmark as the repository's parent-row-plus-songs write takes it. */
const snapshotInput = (bookmark: PlayQueueBookmark): BookmarkSnapshotInput => ({
  id: bookmark.id,
  name: bookmark.name,
  createdAt: bookmark.createdAt,
  currentIndex: bookmark.currentIndex,
  positionSec: bookmark.positionSec,
  tracks: bookmark.queue,
});

/** Imported bookmarks are untrusted — a backup file can be corrupt or hand-edited,
 *  and the UI iterates `queue`, so an entry without one is dropped rather than left
 *  to crash the list on render. */
const isValidBookmark = (value: PlayQueueBookmark): boolean =>
  !!value && typeof value === 'object' && !!value.id && Array.isArray(value.queue);

/** What the repository actually stores: entries with no id are dropped on the way in
 *  (`song_id` is NOT NULL), so a stored-vs-held comparison has to drop them too. */
const storableTracks = (bookmark: PlayQueueBookmark): number =>
  bookmark.queue.filter((c) => !!c?.id).length;

/**
 * Resolve once `persist` has finished reading the KV blob. Zustand's hydration REPLACES
 * the state it lands on, so hydrating from SQL first would simply be undone by a
 * late-resolving `getItem` — `bookmarksStore` is not in `STARTUP_KV_STORES`, and the
 * splash fires `rehydrateAllStores()` without awaiting it. Same shape as
 * `awaitKvHydration`.
 */
const kvHydrated = (): Promise<void> =>
  new Promise<void>((resolve) => {
    if (bookmarksStore.persist.hasHydrated()) {
      resolve();
      return;
    }
    const unsubscribe = bookmarksStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });

export const bookmarksStore = create<BookmarksState>()(
  persist(
    (set, get) => ({
      bookmarks: {},
      autoName: true,
      sortOrder: 'newest',
      sqlAuthoritative: false,

      addBookmark: (bookmark) => {
        set((state) => ({
          bookmarks: { ...state.bookmarks, [bookmark.id]: bookmark },
        }));
        void writeBookmarkSnapshots([snapshotInput(bookmark)], { replaceExisting: false });
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
        const before = new Set(Object.keys(next));
        const { added, skipped } = mergeExistingWins(next, incoming, isValidBookmark);
        if (added > 0) {
          set({ bookmarks: next });
          // Only the ids the merge actually added: one that lost the collision kept
          // the local entry, and rewriting it would replace its songs with the
          // file's for no reason.
          void writeBookmarkSnapshots(
            Object.keys(next)
              .filter((id) => !before.has(id))
              .map((id) => snapshotInput(next[id])),
            { replaceExisting: false },
          );
        }
        return { added, skipped };
      },

      replaceBookmarks: (incoming) => {
        const bookmarks: Record<string, PlayQueueBookmark> = {};
        for (const [id, value] of Object.entries(incoming)) {
          if (isValidBookmark(value)) bookmarks[id] = value;
        }
        set({ bookmarks });
        void writeBookmarkSnapshots(Object.values(bookmarks).map(snapshotInput), {
          replaceExisting: true,
        });
        return Object.keys(bookmarks).length;
      },

      hydrateFromDbAsync: async () => {
        await kvHydrated();
        const snapshots = await readBookmarkSnapshots();
        // Null is "could not read", not "none". Replacing the map from a failed DB open
        // would blank a set with nothing to restore it from — and persist it.
        if (snapshots === null) return;
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
        // The rows are only authoritative once they hold everything the KV-hydrated map
        // holds. A non-empty table is NOT the gate: one bookmark saved after the upgrade
        // makes the table non-empty while the pre-upgrade blob is still the only copy of
        // the rest, and this read REPLACES the map. The track count is part of it because
        // a rename inserts a parent row on its own — id present, queue empty.
        const held = Object.values(get().bookmarks);
        const complete = held.every(
          (b) => (bookmarks[b.id]?.queue.length ?? -1) >= storableTracks(b),
        );
        if (!complete) return;
        set({ bookmarks, sqlAuthoritative: true });
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => kvStorage),
      // `bookmarks` leaves the blob the moment the rows are proven to hold them — that
      // is the retirement of the KV copy. Until then it stays, because every `set` here
      // rewrites the blob and dropping it early would erase the only complete copy.
      partialize: (state) => ({
        autoName: state.autoName,
        sortOrder: state.sortOrder,
        ...(state.sqlAuthoritative ? {} : { bookmarks: state.bookmarks }),
      }),
    },
  ),
);
