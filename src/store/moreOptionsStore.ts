/**
 * Lightweight Zustand store managing the "more options" bottom sheet.
 *
 * Any component can call `moreOptionsStore.getState().show(...)` to open
 * the sheet.  The sheet itself is rendered once in the root layout and
 * reads from this store.
 */

import { create } from 'zustand';

import { type AlbumID3, type ArtistID3, type Child, type Playlist } from '../services/subsonicService';

/* ------------------------------------------------------------------ */
/*  Entity types                                                       */
/* ------------------------------------------------------------------ */

export type MoreOptionsEntity =
  | { type: 'song'; item: Child }
  | { type: 'album'; item: AlbumID3 }
  | { type: 'artist'; item: ArtistID3 }
  | { type: 'playlist'; item: Playlist };

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

export type MoreOptionsSource =
  | 'default'
  /** Song rows inside a playlist's detail view. The playlist owns its tracks'
   *  downloads, so per-song "Remove Download" is hidden there. */
  | 'playlist-detail'
  | 'player-phone-portrait'
  | 'player-tablet-portrait'
  | 'player-tablet-splitview'
  | 'player-tablet-landscape';

export interface MoreOptionsState {
  visible: boolean;
  entity: MoreOptionsEntity | null;
  source: MoreOptionsSource;

  show: (entity: MoreOptionsEntity, source?: MoreOptionsSource) => void;
  hide: () => void;
  /**
   * Close the sheet AND return a promise that resolves when the underlying
   * BottomSheet's native Modal has fully torn down. Use this when you need
   * to open another Modal (alert, sheet, etc.) immediately after — Android
   * can only safely show one Modal at a time, so we have to wait for the
   * first to fully unmount before mounting the next.
   *
   * Backed by `_signalCloseComplete()` which the BottomSheet's
   * `onCloseComplete` calls after the post-unmount RAF chain.
   */
  hideAndAwait: () => Promise<void>;
  /** @internal — called by MoreOptionsSheet's BottomSheet onCloseComplete. */
  _signalCloseComplete: () => void;
}

// Resolvers waiting for the next close-complete signal. We hold them at
// module scope (not inside the store) so the promise plumbing doesn't
// trigger spurious re-renders for subscribers of the store object.
const closeCompleteResolvers: Array<{
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}> = [];

// Belt-and-braces fallback for `hideAndAwait`. The BottomSheet's
// scheduleCloseComplete chain (RAF + 100ms setTimeout) normally fires
// onCloseComplete within ~120ms of visible→false; if it doesn't (RAF stalled
// with no rendering activity, ref cleared by an unmount race), the caller
// would hang forever and every chained modal would silently no-op. Costs
// nothing on the happy path — the close-complete signal removes the resolver
// before the timeout fires.
const SAFETY_TIMEOUT_MS = 500;

export const moreOptionsStore = create<MoreOptionsState>()((set) => ({
  visible: false,
  entity: null,
  source: 'default',

  show: (entity, source = 'default') => set({ visible: true, entity, source }),

  hide: () => set({ visible: false, entity: null, source: 'default' }),

  hideAndAwait: () => {
    set({ visible: false, entity: null, source: 'default' });
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const idx = closeCompleteResolvers.findIndex((e) => e.resolve === resolve);
        if (idx >= 0) {
          closeCompleteResolvers.splice(idx, 1);
          resolve();
        }
      }, SAFETY_TIMEOUT_MS);
      closeCompleteResolvers.push({ resolve, timer });
    });
  },

  _signalCloseComplete: () => {
    // Drain every pending awaiter — they all wanted the same signal — and clear
    // each safety-net timer so it doesn't linger (held handle) after resolving.
    while (closeCompleteResolvers.length > 0) {
      const entry = closeCompleteResolvers.shift();
      if (entry) {
        clearTimeout(entry.timer);
        entry.resolve();
      }
    }
  },
}));
