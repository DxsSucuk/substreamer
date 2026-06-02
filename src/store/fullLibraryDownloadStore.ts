import { create } from 'zustand';

/**
 * Transient progress state for the "Download Full Library" one-shot. Tracks the
 * prepare → queueing phases and how many albums/playlists have been added to the
 * download queue so the settings card can show live progress + a Stop control.
 *
 * Deliberately NOT persisted: the action is idempotent (enqueue dedups), so a
 * restart mid-run just means the user taps it again; the already-queued items
 * keep downloading via the normal queue regardless.
 */
export type FullLibraryDownloadPhase = 'preparing' | 'queueing' | null;

interface FullLibraryDownloadState {
  active: boolean;
  phase: FullLibraryDownloadPhase;
  albumsTotal: number;
  albumsQueued: number;
  playlistsTotal: number;
  playlistsQueued: number;
  /** User-facing failure message from the last run, surfaced by the card. */
  error: string | null;

  start: () => void;
  setPhase: (phase: FullLibraryDownloadPhase) => void;
  setTotals: (albumsTotal: number, playlistsTotal: number) => void;
  incAlbum: () => void;
  incPlaylist: () => void;
  /** Record a failure for the card to surface; doesn't stop the run. */
  fail: (error: string) => void;
  clearError: () => void;
  /** Request the run stop adding more items (in-flight downloads continue). */
  cancel: () => void;
  /** Clear run progress (preserves `error` for the card to surface). */
  finish: () => void;
}

const RUN_IDLE = {
  active: false,
  phase: null as FullLibraryDownloadPhase,
  albumsTotal: 0,
  albumsQueued: 0,
  playlistsTotal: 0,
  playlistsQueued: 0,
};

export const fullLibraryDownloadStore = create<FullLibraryDownloadState>()((set) => ({
  ...RUN_IDLE,
  error: null,

  start: () => set({ ...RUN_IDLE, error: null, active: true, phase: 'preparing' }),
  setPhase: (phase) => set({ phase }),
  setTotals: (albumsTotal, playlistsTotal) => set({ albumsTotal, playlistsTotal }),
  incAlbum: () => set((s) => ({ albumsQueued: s.albumsQueued + 1 })),
  incPlaylist: () => set((s) => ({ playlistsQueued: s.playlistsQueued + 1 })),
  fail: (error) => set({ error }),
  clearError: () => set({ error: null }),
  cancel: () => set({ active: false }),
  finish: () => set({ ...RUN_IDLE }),
}));
