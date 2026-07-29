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
 *  fast paged-`search3` song loop and the basic-path per-album walk (the walk is
 *  now the basic-path song fetch). Named `DetailSync*` for history — it tracks
 *  the song population, not album detail (which is on-demand only). */
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
  lastKnownServerUrl: string | null;
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
   *  Persisted here (not in `albumLibraryStore`, which is now row-based and
   *  keeps no persisted scalar). */
  librarySyncLastFetchedAt: number | null;

  // --- Sync strategy (capability probe) ---
  /** Transport for the whole library sync (album list + songs), from the
   *  empty-query `search3` probe. Persisted for resume routing. */
  syncStrategy: SyncStrategy | null;

  // --- Song sync (populates `song_index`) ---
  /** Strategy the song fetch actually uses — normally `syncStrategy`, but forced
   *  to `basic` (the walk) if fast-path songs come back without `albumId`. */
  songSyncStrategy: SyncStrategy | null;
  /** Resume cursor for the fast paged-`search3` song loop (`songOffset`). */
  songSyncCursor: number;
  /** True once every song has been fetched into `song_index`. Startup gate. */
  songSyncComplete: boolean;
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
  markSongSyncComplete: () => void;
  resetSongSync: () => void;
  /** Update the ephemeral blob→normalized migration progress (banner/card). */
  setNormalizedMigration: (phase: 'idle' | 'migrating', done: number, total: number) => void;
  /** Stamp `libraryLastUpdatedAt = now` — called at partial-update ingestion. */
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
      songSyncCursor: 0,
      songSyncComplete: false,
      songSyncFinalizing: false,

      normalizedMigrationPhase: 'idle',
      normalizedMigrationDone: 0,
      normalizedMigrationTotal: 0,

      fullSyncCompletedAt: null,
      libraryLastUpdatedAt: null,

      lastChangeDetectionAt: null,
      lastKnownServerUrl: null,
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
      markSongSyncComplete: () =>
        set((s) => ({
          songSyncComplete: true,
          songSyncFinalizing: false,
          detailSyncPhase: 'idle',
          detailSyncTotal: 0,
          detailSyncCompleted: 0,
          fullSyncCompletedAt: s.librarySyncComplete ? Date.now() : s.fullSyncCompletedAt,
        })),
      resetSongSync: () =>
        set({
          songSyncStrategy: null,
          songSyncCursor: 0,
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
        songSyncComplete: state.songSyncComplete,
        fullSyncCompletedAt: state.fullSyncCompletedAt,
        libraryLastUpdatedAt: state.libraryLastUpdatedAt,
        lastChangeDetectionAt: state.lastChangeDetectionAt,
        lastKnownServerUrl: state.lastKnownServerUrl,
        lastKnownServerSongCount: state.lastKnownServerSongCount,
        lastKnownServerScanTime: state.lastKnownServerScanTime,
        lastKnownNewestAlbumId: state.lastKnownNewestAlbumId,
        lastKnownNewestAlbumCreated: state.lastKnownNewestAlbumCreated,
      }),
    },
  ),
);
