import { create } from 'zustand';

import { fetchAllSongsByTitleAsync } from './persistence/detailTables';
import type { Child } from '../services/subsonicService';

/**
 * In-memory songs-library list (the Songs segment's full A→Z dataset).
 *
 * Design (see also `songIndexStore`, `favoritesStore` optimistic overrides):
 *  - The list is built ONCE, asynchronously, after startup data tasks settle
 *    (and again on an explicit pull-to-refresh). The SQLite `song_index` table
 *    remains the source of truth and is read off the JS thread.
 *  - It is NEVER recalculated on every `song_index` write. Instead, the writes
 *    (`songIndexStore.upsertSongsForAlbum` / `deleteSongsForAlbums`) optimistically
 *    patch THIS in-memory array — splicing one album's songs in/out in sorted
 *    order. That keeps mid-browse updates O(album) instead of O(library) and
 *    avoids re-reading + re-mapping the whole table on every album-detail sync.
 *  - The optimistic patches live only in memory; the underlying DB write is
 *    already persisted, so a restart or pull-to-refresh recomputes from a clean
 *    source. (Same philosophy as the 5-star rating / favourite overrides.)
 *
 * Per-row star/rating/download badges and the downloaded/favourites filters are
 * driven by live stores in `useAllSongsByTitle`, so this array only needs to
 * track membership + ordering, not transient per-row state.
 */
interface SongLibraryState {
  /** The full A→Z song list, or null before the first build completes. */
  base: Child[] | null;
  /** True while a (re)build is in flight. */
  building: boolean;
  /** Build the list from `song_index` if not already built (or `force` to rebuild). */
  build: (force?: boolean) => Promise<void>;
  /** Force a re-read from `song_index` after a BULK table change (the paged song
   *  sync bypasses `patchAlbum`, so it wouldn't otherwise trigger a rebuild).
   *  Sets `dirty` so an in-flight build re-reads, waits for it, then forces a
   *  guaranteed-fresh build. */
  rebuildFromDb: () => Promise<void>;
  /** Optimistically merge one album's songs into the in-memory list. */
  patchAlbum: (albumId: string, songs: readonly Child[]) => void;
  /** Optimistically remove songs for the given albums from the in-memory list. */
  removeAlbums: (albumIds: readonly string[]) => void;
  /** Drop the in-memory list (logout / cache clear). */
  reset: () => void;
}

/** De-dupe concurrent build() calls. */
let inFlight: Promise<void> | null = null;
/** Set when a DB write lands mid-build so the build re-reads before settling. */
let dirty = false;

/** True when a song has no orderable title (mirrors SQL `title IS NULL`). */
function emptyTitle(c: Child): boolean {
  return !c.title;
}

/**
 * Order comparator mirroring the `song_index` query:
 *   ORDER BY (title IS NULL), lower(title), id
 * Empty/untitled songs sort last; then case-insensitive title; `id` breaks ties.
 */
function compareSongs(a: Child, b: Child): number {
  const ae = emptyTitle(a);
  const be = emptyTitle(b);
  if (ae !== be) return ae ? 1 : -1;
  if (!ae) {
    const at = a.title!.toLowerCase();
    const bt = b.title!.toLowerCase();
    if (at < bt) return -1;
    if (at > bt) return 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Merge two already-sorted lists into one sorted list (stable, O(n + m)). */
function mergeSorted(a: readonly Child[], b: readonly Child[]): Child[] {
  const out: Child[] = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) {
    out[k++] = compareSongs(a[i], b[j]) <= 0 ? a[i++] : b[j++];
  }
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/**
 * Cheap no-op guard: do the existing album rows already match the incoming set
 * (same ids, same orderable/display fields)? Reopening an unchanged cached album
 * is the common mid-browse case — skipping the splice avoids a needless re-render
 * of the whole Songs list. Star/rating are excluded (driven by live stores).
 */
function sameAlbumSongs(existing: readonly Child[], incoming: readonly Child[]): boolean {
  if (existing.length !== incoming.length) return false;
  const byId = new Map(existing.map((s) => [s.id, s]));
  for (const s of incoming) {
    const e = byId.get(s.id);
    if (!e) return false;
    if ((e.title ?? '') !== (s.title ?? '')) return false;
    if ((e.artist ?? '') !== (s.artist ?? '')) return false;
    if ((e.album ?? '') !== (s.album ?? '')) return false;
    if ((e.coverArt ?? '') !== (s.coverArt ?? '')) return false;
    if ((e.duration ?? 0) !== (s.duration ?? 0)) return false;
    if ((e.track ?? 0) !== (s.track ?? 0)) return false;
    if ((e.discNumber ?? 0) !== (s.discNumber ?? 0)) return false;
    if ((e.year ?? 0) !== (s.year ?? 0)) return false;
  }
  return true;
}

export const songLibraryStore = create<SongLibraryState>()((set, get) => ({
  base: null,
  building: false,

  build: (force = false) => {
    if (!force && get().base !== null) return Promise.resolve();
    if (inFlight) return inFlight;

    const run = (async () => {
      try {
        set({ building: true });
        let list: Child[];
        // Re-read if a DB write landed mid-read (e.g. the startup album walk is
        // still writing) so the built snapshot can't miss a just-written album.
        do {
          dirty = false;
          list = await fetchAllSongsByTitleAsync();
        } while (dirty);
        set({ base: list, building: false });
      } finally {
        inFlight = null;
        if (get().building) set({ building: false });
      }
    })();

    inFlight = run;
    return run;
  },

  rebuildFromDb: async () => {
    dirty = true;
    const current = inFlight;
    if (current) {
      try {
        await current; // let the in-flight build re-read (via dirty) and settle
      } catch {
        /* build swallows its own errors */
      }
    }
    await get().build(true); // guaranteed-fresh read of the just-bulk-written table
  },

  patchAlbum: (albumId, songs) => {
    // A build is in flight — let it re-read rather than patching a partial list.
    if (get().building) {
      dirty = true;
      return;
    }
    const base = get().base;
    // Not built yet: the eventual build() reads the DB (already written), so
    // there's nothing to patch in memory.
    if (base === null) return;

    const filtered: Child[] = [];
    const existing: Child[] = [];
    for (const s of base) {
      if (s.albumId === albumId) existing.push(s);
      else filtered.push(s);
    }

    const incoming = songs.map((s) => (s.albumId === albumId ? s : { ...s, albumId }));
    if (sameAlbumSongs(existing, incoming)) return; // unchanged → no re-render

    const sortedIncoming = [...incoming].sort(compareSongs);
    set({ base: mergeSorted(filtered, sortedIncoming) });
  },

  removeAlbums: (albumIds) => {
    if (get().building) {
      dirty = true;
      return;
    }
    const base = get().base;
    if (base === null) return;
    if (albumIds.length === 0) return;
    const drop = new Set<string>(albumIds);
    const next = base.filter((s) => s.albumId === undefined || !drop.has(s.albumId));
    if (next.length !== base.length) set({ base: next });
  },

  reset: () => {
    dirty = false;
    set({ base: null, building: false });
  },
}));
