/**
 * Persistent Zustand store for offline music cache state (v2).
 *
 * No `persist(createJSONStorage(...))` middleware — persistence is split three ways:
 *   - `cachedSongs`, `cachedItems`, and `downloadQueue` are persisted per-row
 *     via `./persistence/musicCacheTables`.
 *   - `maxConcurrentDownloads` is persisted as a tiny JSON blob under
 *     `substreamer-music-cache-settings` in `kvStorage`.
 *   - `totalBytes` / `totalFiles` are derived aggregates, recomputed from the
 *     filesystem on startup via `recalculate(...)` (the service layer owns
 *     the walk).
 *
 * Every action writes through to the persistence layer BEFORE mutating the
 * in-memory state, so an observer reacting to the store change can trust that
 * disk is already in sync.
 */

import { create, type StoreApi } from 'zustand';

import { type Child } from 'subsonic-api';

import {
  childGenreNames,
  clearAllMusicCacheRows,
  convertLegacyMetadataAsync,
  orphanSongIfUnreferencedAsync,
  deleteCachedItem as deleteCachedItemRow,
  deleteCachedSong as deleteCachedSongRow,
  hydrateCachedItemsAsync,
  hydrateCachedSongsAsync,
  hydrateDownloadQueueAsync,
  insertDownloadQueueItem,
  markDownloadComplete,
  removeCachedItemSong as removeCachedItemSongRow,
  removeDownloadQueueItem,
  reorderCachedItemSongs as reorderCachedItemSongsRow,
  reorderDownloadQueue,
  updateDownloadQueueItem,
  upsertCachedItem as upsertCachedItemRow,
  upsertCachedSong as upsertCachedSongRow,
  type CachedItemRow,
  type CachedSongRow,
  type DownloadQueueRow,
} from './persistence/musicCacheTables';
// Synchronous adapter: the settings blob (maxConcurrentDownloads) is read via
// a synchronous helper; the bulk cache data hydrates via per-row tables.
import { kvStorageSync as kvStorage } from './persistence';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Cached-song metadata. Re-exported from the persistence layer so consumers
 *  import a single canonical shape from the store. */
export type CachedSongMeta = CachedSongRow;

/** Cached-item metadata with ordered song IDs (derived from edges). */
export type CachedItemMeta = CachedItemRow;

/** Persisted download-queue item. */
export type DownloadQueueItem = DownloadQueueRow;

/** What a caller supplies to enqueue. The queue owns the rest: `queuePosition` is
 *  assigned by SQL, the others by the store. */
export type DownloadQueueDraft = Omit<
  DownloadQueueItem,
  'queueId' | 'status' | 'completedSongs' | 'addedAt' | 'queuePosition'
>;

export type MaxConcurrentDownloads = 1 | 3 | 5;

/** Shape of the settings blob stored at `SETTINGS_KEY`. */
interface MusicCacheSettings {
  maxConcurrentDownloads: MaxConcurrentDownloads;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const SETTINGS_KEY = 'substreamer-music-cache-settings';
const DEFAULT_MAX_CONCURRENT: MaxConcurrentDownloads = 3;

/* ------------------------------------------------------------------ */
/*  Settings blob helpers                                              */
/* ------------------------------------------------------------------ */

function readSettingsBlob(): MusicCacheSettings {
  // kvStorage.getItem is synchronous in our backing implementation, but
  // its Zustand StateStorage type signature permits async returns. Narrow
  // to string | null for the sync path we actually use.
  const raw = kvStorage.getItem(SETTINGS_KEY) as string | null;
  if (raw === null) {
    return { maxConcurrentDownloads: DEFAULT_MAX_CONCURRENT };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MusicCacheSettings>;
    const max = parsed?.maxConcurrentDownloads;
    if (max === 1 || max === 3 || max === 5) {
      return { maxConcurrentDownloads: max };
    }
    return { maxConcurrentDownloads: DEFAULT_MAX_CONCURRENT };
  } catch {
    return { maxConcurrentDownloads: DEFAULT_MAX_CONCURRENT };
  }
}

function writeSettingsBlob(settings: MusicCacheSettings): void {
  try {
    kvStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* dropped — next launch falls back to defaults */
  }
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

export interface MusicCacheState {
  // Data (hydrated from musicCacheTables on startup)
  cachedSongs: Record<string, CachedSongMeta>;
  cachedItems: Record<string, CachedItemMeta>;
  downloadQueue: DownloadQueueItem[];

  // Settings (persisted as a tiny JSON blob)
  maxConcurrentDownloads: MaxConcurrentDownloads;

  // Derived aggregates (rebuilt from filesystem via recalculate())
  totalBytes: number;
  totalFiles: number;

  /**
   * Bumped on EVERY mutation of `cachedSongs` / `cachedItems`.
   *
   * Downloaded lists read from SQL, so a changed map identity no longer re-runs them
   * and they would sit stale until the screen remounted. They key an effect on this
   * counter instead. Same role as `favoritesStore.version`.
   *
   * In-memory only (this store has no persist middleware) and monotonic. No-op paths
   * must NOT bump it — see `bumped`.
   */
  revision: number;

  // Lifecycle
  hasHydrated: boolean;

  /* Queue actions */
  /** `songs` is the payload to download. It goes to `download_queue_songs` and is
   *  NOT kept in memory — the queue mirror holds the item, never its tracks. */
  enqueue: (draft: DownloadQueueDraft, songs: readonly Child[]) => void;
  /**
   * Variant of `enqueue` that skips the "already in cachedItems" short-circuit.
   * Used by `enqueueAlbumDownload` for top-up flows where the album already
   * has a partial `cached_items` row and we want to download the missing
   * songs. Still dedupes against an existing queue entry for the same itemId.
   *
   * `songs` is the missing DELTA, not the whole album — which is why
   * `enqueueAlbumDownload` writes the real total to `expectedSongCount` first.
   */
  enqueueTopUp: (draft: DownloadQueueDraft, songs: readonly Child[]) => void;
  removeFromQueue: (queueId: string) => void;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  updateQueueItem: (
    queueId: string,
    update: Partial<Pick<DownloadQueueItem, 'status' | 'completedSongs' | 'error'>>,
  ) => void;
  /**
   * Finalise a download: remove the queue row, upsert the item + songs, and
   * insert the edges -- atomic in SQL, then mirrored in memory.
   *
   * `childBySongId` carries the real server `Child` for the songs that have one;
   * only those get their `cached_song_*` mirrors rewritten.
   */
  markItemComplete: (
    queueId: string,
    item: Omit<CachedItemMeta, 'songIds'>,
    songs: CachedSongMeta[],
    edges: Array<{ songId: string; position: number }>,
    childBySongId?: Map<string, Child>,
  ) => void;

  /* Cached item / song actions */
  upsertCachedItem: (
    item: Omit<CachedItemMeta, 'songIds'>,
    songIds?: string[],
  ) => void;
  /**
   * Delete a cached item. Returns the list of songIds whose refcount dropped
   * to zero as a result (so the service layer can delete the files). The
   * store itself has already removed the orphan songs from `cachedSongs`.
   */
  removeCachedItem: (itemId: string) => Promise<string[]>;
  /**
   * Remove a single song at `position` from an item. Returns the song id if
   * that song became orphan (so service can delete its file); `null` if the
   * song is still referenced by another item.
   */
  removeCachedItemSong: (
    itemId: string,
    position: number,
  ) => Promise<{ orphanedSongId: string | null }>;
  reorderCachedItemSongs: (
    itemId: string,
    fromPosition: number,
    toPosition: number,
  ) => void;
  /** `child` is the real server `Child` behind this write, when there is one —
   *  the only thing that rewrites the song's `cached_song_*` mirrors. */
  upsertCachedSong: (song: CachedSongMeta, child?: Child) => void;
  deleteCachedSong: (songId: string) => void;

  /* Settings + aggregates */
  setMaxConcurrentDownloads: (n: MaxConcurrentDownloads) => void;
  addBytes: (bytes: number) => void;
  addFiles: (count: number) => void;
  recalculate: (stats: { totalBytes: number; totalFiles: number }) => void;

  /* Lifecycle */
  reset: () => void;
  /** Load cached songs/items/queue on a background thread with chunked
   * mapping. Called once at app start via `rehydrateAllStores`. */
  hydrateFromDbAsync: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

function generateQueueId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Shared body of `enqueue` / `enqueueTopUp`.
 *
 * The dedupe read and the append happen inside ONE functional `set`, so the write
 * is against live state rather than a snapshot captured before it. The row's real
 * slot is assigned by SQL (`MAX(queue_position) + 1`, under a UNIQUE index), and the
 * returned value replaces the optimistic one held in memory — they differ only when
 * memory and disk disagree, e.g. an enqueue that beat `hydrateFromDbAsync`.
 *
 * Stays synchronous on purpose: every caller runs `processQueue()` on the next line
 * and none awaits, and the `itemId` dedupe is only sound because the action cannot
 * yield between reading the queue and appending to it.
 */
function appendToQueue(
  set: StoreApi<MusicCacheState>['setState'],
  get: StoreApi<MusicCacheState>['getState'],
  draft: DownloadQueueDraft,
  songs: readonly Child[],
  skipWhenCached: boolean,
): void {
  const queueId = generateQueueId();
  set((state) => {
    if (state.downloadQueue.some((q) => q.itemId === draft.itemId)) return {};
    if (skipWhenCached && draft.itemId in state.cachedItems) return {};
    const maxPosition = state.downloadQueue.reduce(
      (max, q) => (q.queuePosition > max ? q.queuePosition : max),
      0,
    );
    return {
      downloadQueue: [
        ...state.downloadQueue,
        {
          ...draft,
          queueId,
          status: 'queued',
          completedSongs: 0,
          addedAt: Date.now(),
          queuePosition: maxPosition + 1,
        },
      ],
    };
  });
  const row = get().downloadQueue.find((q) => q.queueId === queueId);
  if (row === undefined) return; // deduped
  void insertDownloadQueueItem(row, songs).then((assigned) => {
    if (assigned === null || assigned === row.queuePosition) return;
    set((state) => ({
      downloadQueue: state.downloadQueue.map((q) =>
        q.queueId === queueId ? { ...q, queuePosition: assigned } : q,
      ),
    }));
  });
}

/**
 * `queuePosition` is UNIQUE and monotonic, NOT dense. Deleting a queue row leaves
 * its slot vacant on disk (see `removeDownloadQueueItem` for why renumbering is
 * untenable at library scale), so the mirror drops the row and touches nothing
 * else — anything that renumbered here would put memory out of step with disk.
 */
const dropFromQueueMirror = (
  queue: DownloadQueueItem[],
  queueId: string,
): DownloadQueueItem[] => queue.filter((q) => q.queueId !== queueId);

/**
 * In-memory twin of `reorderDownloadQueue`'s repack: the mover takes `toPosition`
 * and everything else in `[from, to]` steps one slot the other way. Copying the SQL
 * arithmetic rather than renumbering is what keeps memory and disk agreeing on a
 * holed queue — which is every queue that has ever had an item removed or finish.
 * The re-sort keeps array order equal to slot order, which every index → slot
 * translation (including `reorderQueue`'s own) depends on.
 */
function repackQueueMirror(
  queue: DownloadQueueItem[],
  fromPosition: number,
  toPosition: number,
): DownloadQueueItem[] {
  const step = fromPosition < toPosition ? -1 : 1;
  const low = Math.min(fromPosition, toPosition);
  const high = Math.max(fromPosition, toPosition);
  return queue
    .map((q) => {
      if (q.queuePosition < low || q.queuePosition > high) return q;
      return {
        ...q,
        queuePosition:
          q.queuePosition === fromPosition ? toPosition : q.queuePosition + step,
      };
    })
    .sort((a, b) => a.queuePosition - b.queuePosition);
}

/**
 * Mirror the disk write's metadata-preservation rules in memory: a write with no
 * metadata must not blank what the row already carries (on disk that's "skip the
 * component row").
 */
function preserveItemMetadata(
  item: Omit<CachedItemMeta, 'songIds'>,
  existing: CachedItemMeta | undefined,
): Omit<CachedItemMeta, 'songIds'> {
  if (!existing) return item;
  return {
    ...item,
    albumMeta: item.albumMeta ?? existing.albumMeta,
    playlistMeta: item.playlistMeta ?? existing.playlistMeta,
  };
}

/**
 * In-memory counterpart of the song upsert: promoted columns absent from the
 * incoming row survive (the disk COALESCE), and the `genres` projection is
 * refreshed only when a real `Child` came with the write — the same rule the
 * `cached_song_*` tables follow.
 */
function mergeCachedSong(
  existing: CachedSongMeta | undefined,
  song: CachedSongMeta,
  child?: Child,
): CachedSongMeta {
  if (!existing) return child ? { ...song, genres: childGenreNames(child) } : song;
  // Spread-skip `undefined`: a mapper emits keys for fields the server omitted, and a
  // plain spread would clear them in memory while the disk COALESCE keeps them — the
  // two would disagree until the next hydrate.
  const merged = { ...existing };
  for (const [k, v] of Object.entries(song)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }
  return child ? { ...merged, genres: childGenreNames(child) } : merged;
}

/**
 * In-flight `hydrateFromDbAsync` promise. A cold boot fires it 2–4× concurrently
 * (root layout, splash ×2, headless bootstrap); memoising only the IN-FLIGHT
 * promise collapses those without turning it into a permanent memo — `reset()`
 * clears `hasHydrated` and a server switch must re-read.
 */
let hydrateInFlight: Promise<void> | null = null;

/**
 * Wrap a state patch that CHANGES `cachedSongs` or `cachedItems`, stamping the next
 * `revision`. Every such patch must go through this — a mutation that forgets to leaves
 * the downloaded lists silently stale.
 *
 * Deliberately NOT applied to no-op paths (a delete of an absent song, an edge index
 * out of range): those return an unchanged state and must not wake readers.
 */
const bumped = <T extends Partial<MusicCacheState>>(
  prev: MusicCacheState,
  patch: T,
): T & { revision: number } => ({ ...patch, revision: prev.revision + 1 });

export const musicCacheStore = create<MusicCacheState>()((set, get) => ({
  cachedSongs: {},
  cachedItems: {},
  downloadQueue: [],

  maxConcurrentDownloads: DEFAULT_MAX_CONCURRENT,

  totalBytes: 0,
  totalFiles: 0,
  revision: 0,

  hasHydrated: false,

  // Dedupe: skip if the same itemId is already queued or already cached.
  enqueue: (draft, songs) => appendToQueue(set, get, draft, songs, true),

  // Top-ups only dedupe against an existing queue entry — a partial `cachedItems`
  // row is expected and must not block the enqueue.
  enqueueTopUp: (draft, songs) => appendToQueue(set, get, draft, songs, false),

  removeFromQueue: (queueId) => {
    removeDownloadQueueItem(queueId);
    set((state) => ({ downloadQueue: dropFromQueueMirror(state.downloadQueue, queueId) }));
  },

  reorderQueue: (fromIndex, toIndex) => {
    const state = get();
    const queue = state.downloadQueue;
    if (
      fromIndex < 0 ||
      fromIndex >= queue.length ||
      toIndex < 0 ||
      toIndex >= queue.length ||
      fromIndex === toIndex
    ) {
      return;
    }
    // The store's array API is 0-indexed to match RN reorderable-list conventions;
    // the persistence layer moves rows by `queue_position`. Translate through the
    // rows' OWN slots, never `index + 1` — slots are unique and monotonic but not
    // dense, so `index + 1` names the wrong rows on any queue that has had an item
    // removed or finish.
    const fromPosition = queue[fromIndex].queuePosition;
    const toPosition = queue[toIndex].queuePosition;
    reorderDownloadQueue(fromPosition, toPosition);
    set({ downloadQueue: repackQueueMirror(queue, fromPosition, toPosition) });
  },

  updateQueueItem: (queueId, update) => {
    updateDownloadQueueItem(queueId, update);
    set((state) => ({
      downloadQueue: state.downloadQueue.map((q) =>
        q.queueId === queueId ? { ...q, ...update } : q,
      ),
    }));
  },

  markItemComplete: (queueId, item, songs, edges, childBySongId) => {
    const existing = get().cachedItems[item.itemId];
    // For top-ups (existing row):
    //   - preserve `downloadedAt` (user "downloaded" this earlier).
    //   - preserve `expectedSongCount`: the worker derives it from `songs.length`,
    //     which for a top-up is only the missing-song delta. The existing row already
    //     holds the authoritative album total from `enqueueAlbumDownload`; clobbering
    //     it misclassifies a later remove-with-survivors as complete.
    const itemToPersist: Omit<CachedItemMeta, 'songIds'> = existing
      ? {
          ...preserveItemMetadata(item, existing),
          downloadedAt: existing.downloadedAt,
          expectedSongCount: existing.expectedSongCount,
        }
      : item;

    markDownloadComplete(queueId, itemToPersist, songs, edges, childBySongId);

    // New songIds from this run, in caller-supplied position order.
    const newSongIdsInOrder = [...edges]
      .sort((a, b) => a.position - b.position)
      .map((e) => e.songId);

    // Merge: keep existing order, append new songs that aren't already edged.
    let songIds: string[];
    if (existing) {
      const existingSet = new Set(existing.songIds);
      const additions = newSongIdsInOrder.filter((id) => !existingSet.has(id));
      songIds = [...existing.songIds, ...additions];
    } else {
      songIds = newSongIdsInOrder;
    }

    set((state) => {
      const nextSongs = { ...state.cachedSongs };
      for (const s of songs) {
        nextSongs[s.id] = mergeCachedSong(state.cachedSongs[s.id], s, childBySongId?.get(s.id));
      }
      return bumped(state, {
        downloadQueue: dropFromQueueMirror(state.downloadQueue, queueId),
        cachedItems: {
          ...state.cachedItems,
          [item.itemId]: { ...itemToPersist, songIds },
        },
        cachedSongs: nextSongs,
      });
    });
  },

  upsertCachedItem: (item, songIds) => {
    // Optimistic-persist: fire the async row write; in-memory set() below is the
    // source of truth for the UI and self-heals on next hydrate.
    void upsertCachedItemRow(item);
    set((state) => {
      const existing = state.cachedItems[item.itemId];
      const nextSongIds =
        songIds !== undefined ? songIds : existing?.songIds ?? [];
      return bumped(state, {
        cachedItems: {
          ...state.cachedItems,
          [item.itemId]: { ...preserveItemMetadata(item, existing), songIds: nextSongIds },
        },
      });
    });
  },

  removeCachedItem: async (itemId) => {
    const state = get();
    const item = state.cachedItems[itemId];
    const affectedSongIds = item?.songIds ?? [];
    // Optimistic: drop the item from memory immediately so the UI updates
    // without waiting on disk IO.
    set((prev) => {
      const nextItems = { ...prev.cachedItems };
      delete nextItems[itemId];
      return bumped(prev, { cachedItems: nextItems });
    });
    // Persist: delete the item row (cascades its own edges), then — atomically
    // per song — orphan any song that lost its last REAL holder. The count +
    // orphan run in ONE transaction inside `orphanSongIfUnreferencedAsync`, so
    // no concurrent insert can add a holder between the count and the delete.
    await deleteCachedItemRow(itemId);
    const orphaned: string[] = [];
    const touchedHolders = new Set<string>();
    const prunedHolders = new Set<string>();
    for (const songId of affectedSongIds) {
      // eslint-disable-next-line no-await-in-loop
      const { orphaned: didOrphan, affectedItems, prunedItems } =
        await orphanSongIfUnreferencedAsync(songId);
      if (didOrphan) {
        orphaned.push(songId);
        affectedItems.forEach((i) => touchedHolders.add(i));
        prunedItems.forEach((i) => prunedHolders.add(i));
      }
    }
    // Reconcile in-memory with what actually got orphaned/pruned on disk.
    set((prev) => {
      const orphanSet = new Set(orphaned);
      const nextItems = { ...prev.cachedItems };
      for (const pid of prunedHolders) delete nextItems[pid];
      // Surviving derived holders that lost an orphaned song: drop it from songIds.
      for (const hid of touchedHolders) {
        if (prunedHolders.has(hid)) continue;
        const h = nextItems[hid];
        if (h) nextItems[hid] = { ...h, songIds: h.songIds.filter((s) => !orphanSet.has(s)) };
      }
      const nextSongs = { ...prev.cachedSongs };
      // Decrement the disk-usage aggregates by the orphaned songs' bytes/count
      // (symmetric with addBytes/addFiles on download; boot recomputes from truth).
      // Without this the card's file count and disk usage stay stale after a delete.
      let freedBytes = 0;
      for (const songId of orphaned) {
        freedBytes += prev.cachedSongs[songId]?.bytes ?? 0;
        delete nextSongs[songId];
      }
      return bumped(prev, {
        cachedItems: nextItems,
        cachedSongs: nextSongs,
        totalBytes: Math.max(0, prev.totalBytes - freedBytes),
        totalFiles: Math.max(0, prev.totalFiles - orphaned.length),
      });
    });
    return orphaned;
  },

  removeCachedItemSong: async (itemId, position) => {
    const state = get();
    const item = state.cachedItems[itemId];
    if (!item) return { orphanedSongId: null };
    // position is 1-indexed in SQL; songIds array is 0-indexed.
    const index = position - 1;
    if (index < 0 || index >= item.songIds.length) {
      return { orphanedSongId: null };
    }
    const songId = item.songIds[index];
    // Optimistic: drop the edge from the item's in-memory songIds immediately.
    set((prev) => {
      const prevItem = prev.cachedItems[itemId];
      if (!prevItem) return {}; // no-op — must not bump
      const nextItems = { ...prev.cachedItems };
      nextItems[itemId] = {
        ...prevItem,
        songIds: prevItem.songIds.filter((_, i) => i !== index),
      };
      return bumped(prev, { cachedItems: nextItems });
    });
    // Persist: remove the edge row (so a real-ref count of 0 means no OTHER real
    // holder remains), then atomically orphan the song iff unreferenced.
    await removeCachedItemSongRow(itemId, position);
    const { orphaned, affectedItems, prunedItems } =
      await orphanSongIfUnreferencedAsync(songId);
    if (!orphaned) return { orphanedSongId: null };
    const orphanedSongId = songId;
    set((prev) => {
      const nextItems = { ...prev.cachedItems };
      const prunedSet = new Set(prunedItems);
      for (const pid of prunedItems) delete nextItems[pid];
      // Surviving derived holders of the orphaned song lost it too.
      for (const hid of affectedItems) {
        if (prunedSet.has(hid) || hid === itemId) continue;
        const h = nextItems[hid];
        if (h) nextItems[hid] = { ...h, songIds: h.songIds.filter((s) => s !== orphanedSongId) };
      }
      // Decrement disk-usage aggregates for the single orphaned song (see
      // removeCachedItem).
      const freedBytes = prev.cachedSongs[orphanedSongId]?.bytes ?? 0;
      const { [orphanedSongId]: _gone, ...restSongs } = prev.cachedSongs;
      return bumped(prev, {
        cachedItems: nextItems,
        cachedSongs: restSongs,
        totalBytes: Math.max(0, prev.totalBytes - freedBytes),
        totalFiles: Math.max(0, prev.totalFiles - 1),
      });
    });
    return { orphanedSongId };
  },

  reorderCachedItemSongs: (itemId, fromPosition, toPosition) => {
    const state = get();
    const item = state.cachedItems[itemId];
    if (!item) return;
    const fromIdx = fromPosition - 1;
    const toIdx = toPosition - 1;
    if (
      fromIdx < 0 ||
      fromIdx >= item.songIds.length ||
      toIdx < 0 ||
      toIdx >= item.songIds.length ||
      fromIdx === toIdx
    ) {
      return;
    }
    void reorderCachedItemSongsRow(itemId, fromPosition, toPosition);
    const nextSongIds = [...item.songIds];
    const [moved] = nextSongIds.splice(fromIdx, 1);
    nextSongIds.splice(toIdx, 0, moved);
    set((prev) =>
      bumped(prev, {
        cachedItems: {
          ...prev.cachedItems,
          [itemId]: { ...prev.cachedItems[itemId], songIds: nextSongIds },
        },
      }),
    );
  },

  upsertCachedSong: (song, child) => {
    void upsertCachedSongRow(song, child);
    set((state) =>
      bumped(state, {
        cachedSongs: {
          ...state.cachedSongs,
          [song.id]: mergeCachedSong(state.cachedSongs[song.id], song, child),
        },
      }),
    );
  },

  deleteCachedSong: (songId) => {
    void deleteCachedSongRow(songId);
    set((state) => {
      if (!(songId in state.cachedSongs)) return state; // no-op — must not bump
      const { [songId]: _removed, ...rest } = state.cachedSongs;
      return bumped(state, { cachedSongs: rest });
    });
  },

  setMaxConcurrentDownloads: (n) => {
    writeSettingsBlob({ maxConcurrentDownloads: n });
    set({ maxConcurrentDownloads: n });
  },

  addBytes: (bytes) =>
    set((state) => ({ totalBytes: state.totalBytes + bytes })),

  addFiles: (count) =>
    set((state) => ({ totalFiles: state.totalFiles + count })),

  recalculate: ({ totalBytes, totalFiles }) =>
    set({ totalBytes, totalFiles }),

  reset: () => {
    void clearAllMusicCacheRows();
    try {
      kvStorage.removeItem(SETTINGS_KEY);
    } catch {
      /* dropped */
    }
    set((prev) =>
      bumped(prev, {
        cachedSongs: {},
        cachedItems: {},
        downloadQueue: [],
        totalBytes: 0,
        totalFiles: 0,
        maxConcurrentDownloads: DEFAULT_MAX_CONCURRENT,
        hasHydrated: false,
      }),
    );
  },

  hydrateFromDbAsync: () => {
    if (hydrateInFlight) return hydrateInFlight;
    const run = (async () => {
      // AWAITED, and BEFORE the read. Nothing reads a `raw_json` envelope at
      // runtime any more, so a row published ahead of its own conversion would
      // serve empty metadata columns. Once the work set is empty — every launch
      // after the upgrade — this costs two COUNT probes.
      await convertLegacyMetadataAsync();

      // Idempotent re-read; the per-row tables are the source of truth. SQLite
      // reads run on a background thread; `readSettingsBlob` stays sync (small
      // kvStorage blob).
      const cachedSongs = await hydrateCachedSongsAsync();
      const cachedItems = await hydrateCachedItemsAsync();
      const downloadQueue = await hydrateDownloadQueueAsync();
      const settings = readSettingsBlob();

      let totalBytes = 0;
      for (const songId of Object.keys(cachedSongs)) {
        totalBytes += cachedSongs[songId].bytes;
      }
      const totalFiles = Object.keys(cachedSongs).length;

      // Bumps too: the legacy-metadata conversion above rewrote rows on disk, and
      // this is what publishes them. SQL-backed readers have to re-read when that
      // lands or they hold the pre-conversion answer.
      set((prev) =>
        bumped(prev, {
          cachedSongs,
          cachedItems,
          downloadQueue,
          maxConcurrentDownloads: settings.maxConcurrentDownloads,
          totalBytes,
          totalFiles,
          hasHydrated: true,
        }),
      );
    })().finally(() => {
      hydrateInFlight = null;
    });
    hydrateInFlight = run;
    return run;
  },
}));

/* ------------------------------------------------------------------ */
/*  Convenience wrappers                                               */
/* ------------------------------------------------------------------ */

/**
 * Truncate the four music-cache tables. Exposed so `resetAllStores` can wipe
 * disk state without importing the persistence module directly.
 */
export async function clearMusicCacheTables(): Promise<void> {
  await clearAllMusicCacheRows();
}

/* ------------------------------------------------------------------ */
/*  Envelope accessors                                                 */
/* ------------------------------------------------------------------ */

/**
 * Lazy-build memoisation for song envelopes, keyed by the ROW object. A row is
 * replaced with a fresh object on every upsert and dropped on reset/clear, so
 * its WeakMap entry (the built `Child`) becomes unreachable and GCs naturally —
 * no manual invalidation. A plain Map keyed by song id would instead pin every
 * built `Child` for the whole session.
 */
const songEnvelopeCache = new WeakMap<object, Child>();

/**
 * Rebuild the server's `Child` from a row's promoted columns. `albumId`,
 * `suffix`, `bitRate`, `bitDepth` and `samplingRate` come from their `src*`
 * twins — the same-named row fields describe the DOWNLOADED file, not the track
 * the server sent. Where a column holds a download-time placeholder
 * (`'Unknown Artist'`, `'Unknown'`) this returns the placeholder rather than the
 * `undefined` the envelope had: the placeholder IS the stored data.
 */
function childFromPromotedColumns(row: CachedSongMeta): Child {
  const hasReplayGain =
    row.rgTrackGain !== undefined ||
    row.rgAlbumGain !== undefined ||
    row.rgTrackPeak !== undefined ||
    row.rgAlbumPeak !== undefined ||
    row.rgBaseGain !== undefined ||
    row.rgFallbackGain !== undefined;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    albumId: row.srcAlbumId,
    coverArt: row.coverArt,
    duration: row.duration,
    suffix: row.srcSuffix,
    bitRate: row.srcBitRate,
    bitDepth: row.srcBitDepth,
    samplingRate: row.srcSamplingRate,
    artistId: row.artistId,
    displayArtist: row.displayArtist,
    displayAlbumArtist: row.displayAlbumArtist,
    displayComposer: row.displayComposer,
    track: row.track,
    discNumber: row.discNumber,
    year: row.year,
    genre: row.genre,
    genres: row.genres,
    size: row.size,
    contentType: row.contentType,
    transcodedContentType: row.transcodedContentType,
    transcodedSuffix: row.transcodedSuffix,
    channelCount: row.channelCount,
    path: row.path,
    userRating: row.userRating,
    averageRating: row.averageRating,
    playCount: row.playCount,
    created: row.created === undefined ? undefined : new Date(row.created),
    starred: row.starred === undefined ? undefined : new Date(row.starred),
    played: row.played,
    type: row.type as Child['type'],
    bpm: row.bpm,
    comment: row.comment,
    sortName: row.sortName,
    musicBrainzId: row.musicBrainzId,
    explicitStatus: row.explicitStatus,
    bookmarkPosition: row.bookmarkPosition,
    isVideo: row.isVideo,
    isDir: row.isDir ?? false,
    parent: row.parent,
    originalWidth: row.originalWidth,
    originalHeight: row.originalHeight,
    // The five gains are one server object; rebuild it only when at least one
    // column survived, so a track with no ReplayGain data keeps `undefined`.
    replayGain: hasReplayGain
      ? ({
          trackGain: row.rgTrackGain,
          albumGain: row.rgAlbumGain,
          trackPeak: row.rgTrackPeak,
          albumPeak: row.rgAlbumPeak,
          baseGain: row.rgBaseGain,
          fallbackGain: row.rgFallbackGain,
        } as Child['replayGain'])
      : undefined,
  };
}

/**
 * Return the full Subsonic `Child` for a cached song. Synchronous by contract —
 * both consumers (`searchService`, feeding Tuned-In's offline mixes) are sync,
 * so this reads the in-memory row and never touches the DB.
 *
 * Built from the promoted columns alone; `null` when there is no row. The legacy
 * `raw_json` envelope is NOT read here — `hydrateFromDbAsync` awaits the
 * conversion that promotes it, so every published row carries its metadata in
 * columns. The four non-genre `Child` arrays live in `cached_song_*` but are
 * deliberately not hydrated, so they are absent here.
 */
export function getSongEnvelope(songId: string): Child | null {
  const row = musicCacheStore.getState().cachedSongs[songId];
  if (!row) return null;
  const cached = songEnvelopeCache.get(row);
  if (cached) return cached;
  const child = childFromPromotedColumns(row);
  songEnvelopeCache.set(row, child);
  return child;
}
