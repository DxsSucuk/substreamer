import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { kvStorage } from './persistence';

/** Scopes accepted by pull-to-refresh + a couple of internal orchestration scopes. */
export type SyncScope =
  | 'home'
  | 'albums'
  | 'songs'
  | 'artists'
  | 'playlists'
  | 'favorites'
  | 'genres'
  | 'all'
  | 'full-walk'
  | 'song-sync'
  | 'change-detect';

/** Phase of the SONG fetch (the second sync step). `syncing` covers both the
 *  fast paged-`search3` song loop and the basic-path per-album walk. Despite the
 *  `DetailSync*` name it tracks song population, not album detail (which is
 *  on-demand only). */
export type DetailSyncPhase =
  | 'idle'
  | 'syncing'
  | 'paused-offline'
  | 'paused-auth-error'
  | 'paused-metered'
  | 'error';

/** Phase of the album-LIST fetch (distinct from the song fetch above). The
 *  list is fetched into `library_albums`; this drives the "Fetching library… N
 *  albums" banner and the "already fetched?" gate. */
export type LibrarySyncPhase = 'idle' | 'fetching' | 'paused-offline';

/** Which transport the library sync is using, decided by a capability probe
 *  (`search3` empty-query supported?). `search3` = fast paged `search3`
 *  (albums via `albumOffset`, songs via `songOffset`, 10k chunks). `basic` =
 *  legacy `getAlbumList2` (albums) + per-album `getAlbum` walk (songs). Persisted
 *  so an interrupted sync resumes on the right path. `null` = not yet probed. */
export type SyncStrategy = 'search3' | 'basic';

interface LastKnownMarkers {
  lastChangeDetectionAt: number | null;
  lastKnownServerSongCount: number | null;
  lastKnownServerScanTime: number | null;
  lastKnownNewestAlbumId: string | null;
  lastKnownNewestAlbumCreated: number | null;
}

export interface SyncStatusState extends LastKnownMarkers {
  // Persisted sync state
  detailSyncPhase: DetailSyncPhase;
  detailSyncTotal: number;
  /** Persisted running counter of successful detail fetches in the current
   *  walk. Frozen-reset to zero at walk start via `setDetailSyncTotal`. UI
   *  reads this directly so progress displays don't do an O(N) library scan. */
  detailSyncCompleted: number;
  /** Ephemeral — session-only. Set when the user dismisses the pill banner;
   *  cleared when the walk phase transitions back to 'idle' (or on app
   *  restart since this field is not persisted). */
  bannerDismissedAt: number | null;

  // --- Album-LIST sync (paginated fetch into `library_albums`) ---
  /** Phase of the paginated album-list fetch. */
  librarySyncPhase: LibrarySyncPhase;
  /** True once the full album list has been fetched end-to-end. The startup
   *  gate skips a full re-fetch when this is set and rows exist; an
   *  interrupted fetch leaves it false so the pager resumes from `COUNT(*)`. */
  librarySyncComplete: boolean;
  /** Albums fetched so far in the current/last list sync — banner display. */
  librarySyncCount: number;
  /** Resume cursor for the album-LIST fetch: the next offset to request on the
   *  fast paged-`search3` path (advanced by each committed page). */
  librarySyncCursor: number;
  /** Epoch ms of the last completed album-list fetch — settings display.
   *  Persisted here (not in `albumLibraryStore`, which is row-based and keeps
   *  no persisted scalar). */
  librarySyncLastFetchedAt: number | null;

  // --- Sync strategy (capability probe) ---
  /** Transport for the whole library sync (album list + songs), from the
   *  empty-query `search3` probe. Persisted for resume routing. */
  syncStrategy: SyncStrategy | null;

  // --- Song sync (populates the normalized `songs` table) ---
  /** Strategy the song fetch actually uses — normally `syncStrategy`, but forced
   *  to `basic` (the walk) if fast-path songs come back without `albumId`. */
  songSyncStrategy: SyncStrategy | null;
  // --- Artist / playlist list refresh (UI state channel) ---
  // These lists are fetched whole in one call, so they need no cursor — just the
  // `loading` + `lastFetchedAt` pair the list screens render from. They live here
  // rather than in the library stores, same as `librarySyncLastFetchedAt` above.
  // `loading` is EPHEMERAL: a persisted true would strand the spinner after a kill
  // mid-fetch.
  artistLibraryLoading: boolean;
  artistLibraryLastFetchedAt: number | null;
  playlistLibraryLoading: boolean;
  playlistLibraryLastFetchedAt: number | null;

  /** Resume cursor for the fast paged-`search3` song loop (`songOffset`). */
  songSyncCursor: number;
  /** A FULL resync asked for a total re-walk of every album's songs. The basic walk
   *  skips albums that already have songs and a resync does not drop the tables, so
   *  without this flag a full resync would be a no-op. Persisted so an interrupted
   *  full resync still re-walks on resume instead of silently completing. */
  fullWalkPending: boolean;
  /** True once every song has been fetched into the `songs` table. Startup gate. */
  songSyncComplete: boolean;
  /** The per-album repair asked the server about every album still holding no tracks and
   *  got nothing back: they are track-less on the server, not victims of a lost page.
   *  Both the completion gate and the startup gate key off "is any album empty?", so
   *  without this verdict they re-trigger a sync on every launch and online-resume
   *  forever. Cleared by `resetSongSync` — the full-resync hatch is when it is worth
   *  asking again. */
  songGapRepairAttempted: boolean;
  /** EPHEMERAL — the fetch loop finished and the in-memory index is rebuilding
   *  (`rebuildFromDb`), which can take seconds. Drives a "Finalizing…" label so the
   *  100%-then-spinner window doesn't read as stuck. Not persisted. */
  songSyncFinalizing: boolean;

  // --- Normalized-model migration (one-time blob→normalized upgrade) ---
  /** Whether the background blob→normalized migration is running now — drives the
   *  "Upgrading library…" banner/card progress. EPHEMERAL (recomputed each launch);
   *  the one-time completion flag lives in kvStorage, not here. */
  normalizedMigrationPhase: 'idle' | 'migrating';
  /** Rows migrated so far (albums + songs) and the total, for the progress bar/%. */
  normalizedMigrationDone: number;
  normalizedMigrationTotal: number;

  // --- Full-sync + last-updated markers (search routing + Settings display) ---
  /** Epoch ms when the FULL sync (album list + all songs) last completed — set
   *  when both `librarySyncComplete` and `songSyncComplete` are true. Null until
   *  the first complete sync; cleared when either sync is reset. */
  fullSyncCompletedAt: number | null;
  /** Epoch ms of the last PARTIAL update that actually CHANGED library data
   *  (scan-detected new/changed album, album refresh writing new songs). Distinct
   *  from `lastChangeDetectionAt`, which is only when detection last RAN. */
  libraryLastUpdatedAt: number | null;

  // Ephemeral
  generation: number;
  inFlight: Map<SyncScope, Promise<void>>;

  // Actions
  setDetailSyncPhase: (phase: DetailSyncPhase) => void;
  setDetailSyncTotal: (total: number) => void;
  /** Increment `detailSyncCompleted` by 1 — called by the walk after each
   *  successful `fetchAlbum`. */
  incrementDetailSyncCompleted: () => void;
  /** Set `detailSyncCompleted` outright — the fast song path derives it as the
   *  count of DISTINCT albums we have songs for (albums-processed / total-albums). */
  setDetailSyncCompleted: (completed: number) => void;
  /** Toggle the "Finalizing…" state (in-memory index rebuild after the fetch). */
  setSongSyncFinalizing: (finalizing: boolean) => void;
  setLastKnownMarkers: (partial: Partial<LastKnownMarkers>) => void;
  setBannerDismissedAt: (at: number | null) => void;
  resetDetailSync: () => void;
  // Album-list sync actions
  setLibrarySyncPhase: (phase: LibrarySyncPhase) => void;
  setLibrarySyncProgress: (count: number) => void;
  setLibrarySyncCursor: (cursor: number) => void;
  markLibrarySyncComplete: () => void;
  resetLibrarySync: () => void;
  // Strategy + song-sync actions
  setSyncStrategy: (strategy: SyncStrategy | null) => void;
  setSongSyncStrategy: (strategy: SyncStrategy | null) => void;
  setSongSyncCursor: (cursor: number) => void;
  /** Mark an artist/playlist list refresh as started, or finished (stamps lastFetchedAt). */
  setListRefresh: (kind: 'artists' | 'playlists', loading: boolean) => void;
  markSongSyncComplete: () => void;
  /** Record that the per-album gap repair ran and the remaining albums came back
   *  track-less — see {@link SyncStatusState.songGapRepairAttempted}. */
  markSongGapRepairAttempted: () => void;
  resetSongSync: () => void;
  /** Update the ephemeral blob→normalized migration progress (banner/card). */
  setNormalizedMigration: (phase: 'idle' | 'migrating', done: number, total: number) => void;
  /**
   * Stamp `libraryLastUpdatedAt = now` — the "library data changed" signal the CarPlay
   * browse tree refreshes on. Deliberately NOT persisted: it means "changed in this
   * session", and restoring it on boot reads as a change to every subscriber.
   */
  bumpLibraryUpdated: () => void;
  bumpGeneration: () => void;
  setInFlight: (scope: SyncScope, promise: Promise<void>) => void;
  clearInFlight: (scope: SyncScope) => void;
  getInFlight: (scope: SyncScope) => Promise<void> | undefined;
}

const PERSIST_KEY = 'substreamer-sync-status';

export const syncStatusStore = create<SyncStatusState>()(
  persist(
    (set, get) => ({
      detailSyncPhase: 'idle',
      detailSyncTotal: 0,
      detailSyncCompleted: 0,
      bannerDismissedAt: null,

      librarySyncPhase: 'idle',
      librarySyncComplete: false,
      librarySyncCount: 0,
      librarySyncCursor: 0,
      librarySyncLastFetchedAt: null,

      syncStrategy: null,
      songSyncStrategy: null,
      artistLibraryLoading: false,
      artistLibraryLastFetchedAt: null,
      playlistLibraryLoading: false,
      playlistLibraryLastFetchedAt: null,
      songSyncCursor: 0,
      fullWalkPending: false,
      songSyncComplete: false,
      songGapRepairAttempted: false,
      songSyncFinalizing: false,

      normalizedMigrationPhase: 'idle',
      normalizedMigrationDone: 0,
      normalizedMigrationTotal: 0,

      fullSyncCompletedAt: null,
      libraryLastUpdatedAt: null,

      lastChangeDetectionAt: null,
      lastKnownServerSongCount: null,
      lastKnownServerScanTime: null,
      lastKnownNewestAlbumId: null,
      lastKnownNewestAlbumCreated: null,

      generation: 0,
      inFlight: new Map(),

      setDetailSyncPhase: (phase) => {
        set({ detailSyncPhase: phase });
        if (phase === 'idle') {
          // Clear session-level banner dismissal when phase settles.
          set({ bannerDismissedAt: null });
        }
      },
      setDetailSyncTotal: (total) =>
        set({ detailSyncTotal: total, detailSyncCompleted: 0 }),
      incrementDetailSyncCompleted: () =>
        set({ detailSyncCompleted: get().detailSyncCompleted + 1 }),
      setDetailSyncCompleted: (completed) => set({ detailSyncCompleted: completed }),
      setSongSyncFinalizing: (finalizing) => set({ songSyncFinalizing: finalizing }),
      setLastKnownMarkers: (partial) => set(partial),
      setBannerDismissedAt: (at) => set({ bannerDismissedAt: at }),
      resetDetailSync: () =>
        set({
          detailSyncPhase: 'idle',
          detailSyncTotal: 0,
          detailSyncCompleted: 0,
          bannerDismissedAt: null,
        }),
      setLibrarySyncPhase: (phase) => set({ librarySyncPhase: phase }),
      setLibrarySyncProgress: (count) => set({ librarySyncCount: count }),
      setLibrarySyncCursor: (cursor) => set({ librarySyncCursor: cursor }),
      markLibrarySyncComplete: () =>
        set((s) => ({
          librarySyncComplete: true,
          librarySyncPhase: 'idle',
          librarySyncLastFetchedAt: Date.now(),
          // Full sync is complete only once BOTH the album list and songs are done.
          fullSyncCompletedAt: s.songSyncComplete ? Date.now() : s.fullSyncCompletedAt,
        })),
      resetLibrarySync: () =>
        set({
          librarySyncPhase: 'idle',
          librarySyncComplete: false,
          librarySyncCount: 0,
          librarySyncCursor: 0,
          librarySyncLastFetchedAt: null,
          fullSyncCompletedAt: null,
        }),
      setSyncStrategy: (strategy) => set({ syncStrategy: strategy }),
      setSongSyncStrategy: (strategy) => set({ songSyncStrategy: strategy }),
      setSongSyncCursor: (cursor) => set({ songSyncCursor: cursor }),
      setListRefresh: (kind, loading) =>
        set(
          kind === 'artists'
            ? {
                artistLibraryLoading: loading,
                // Stamp only on completion — the list screens reload their window off
                // a change in this value.
                ...(loading ? {} : { artistLibraryLastFetchedAt: Date.now() }),
              }
            : {
                playlistLibraryLoading: loading,
                ...(loading ? {} : { playlistLibraryLastFetchedAt: Date.now() }),
              },
        ),
      markSongSyncComplete: () =>
        set((s) => ({
          songSyncComplete: true,
          // Cleared here rather than only in the walk: on a search3 server the basic
          // walk never runs, so the flag would otherwise latch true forever.
          fullWalkPending: false,
          songSyncFinalizing: false,
          detailSyncPhase: 'idle',
          detailSyncTotal: 0,
          detailSyncCompleted: 0,
          fullSyncCompletedAt: s.librarySyncComplete ? Date.now() : s.fullSyncCompletedAt,
        })),
      markSongGapRepairAttempted: () => set({ songGapRepairAttempted: true }),
      resetSongSync: () =>
        set({
          songSyncStrategy: null,
          songSyncCursor: 0,
          // The full resync is the "start over" hatch — ask the server about the empty
          // albums again rather than carrying a stale verdict across it.
          songGapRepairAttempted: false,
          // The full resync wants every album's songs
          // re-fetched, not just the ones missing them. Persisted with the cursor
          // in this same write so an interrupted run resumes as a full walk.
          fullWalkPending: true,
          songSyncComplete: false,
          songSyncFinalizing: false,
          detailSyncPhase: 'idle',
          detailSyncTotal: 0,
          detailSyncCompleted: 0,
          fullSyncCompletedAt: null,
        }),
      setNormalizedMigration: (phase, done, total) =>
        set({
          normalizedMigrationPhase: phase,
          normalizedMigrationDone: done,
          normalizedMigrationTotal: total,
        }),
      bumpLibraryUpdated: () => set({ libraryLastUpdatedAt: Date.now() }),
      bumpGeneration: () => set({ generation: get().generation + 1 }),
      setInFlight: (scope, promise) => {
        // Replace (not mutate) the Map so Zustand selector subscribers using
        // Object.is equality detect the change. A shared mutable reference
        // would pass the equality check and silently skip notifications.
        const next = new Map(get().inFlight);
        next.set(scope, promise);
        set({ inFlight: next });
      },
      clearInFlight: (scope) => {
        const next = new Map(get().inFlight);
        next.delete(scope);
        set({ inFlight: next });
      },
      getInFlight: (scope) => get().inFlight.get(scope),
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({
        detailSyncPhase: state.detailSyncPhase,
        detailSyncTotal: state.detailSyncTotal,
        detailSyncCompleted: state.detailSyncCompleted,
        // bannerDismissedAt is session-only by design — the banner comes
        // back on the next app launch if the walk is still active. Not
        // persisted.
        librarySyncPhase: state.librarySyncPhase,
        librarySyncComplete: state.librarySyncComplete,
        librarySyncCount: state.librarySyncCount,
        librarySyncCursor: state.librarySyncCursor,
        librarySyncLastFetchedAt: state.librarySyncLastFetchedAt,
        syncStrategy: state.syncStrategy,
        songSyncStrategy: state.songSyncStrategy,
        songSyncCursor: state.songSyncCursor,
        fullWalkPending: state.fullWalkPending,
        // `loading` is deliberately NOT persisted (see the field docs) — only the
        // timestamps, which the list screens use to tell "never fetched" from "empty".
        artistLibraryLastFetchedAt: state.artistLibraryLastFetchedAt,
        playlistLibraryLastFetchedAt: state.playlistLibraryLastFetchedAt,
        songSyncComplete: state.songSyncComplete,
        songGapRepairAttempted: state.songGapRepairAttempted,
        fullSyncCompletedAt: state.fullSyncCompletedAt,
        lastChangeDetectionAt: state.lastChangeDetectionAt,
        lastKnownServerSongCount: state.lastKnownServerSongCount,
        lastKnownServerScanTime: state.lastKnownServerScanTime,
        lastKnownNewestAlbumId: state.lastKnownNewestAlbumId,
        lastKnownNewestAlbumCreated: state.lastKnownNewestAlbumCreated,
      }),
    },
  ),
);
