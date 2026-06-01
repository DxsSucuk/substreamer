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
const closeCompleteResolvers: Array<() => void> = [];

// Belt-and-braces fallback for `hideAndAwait`. The BottomSheet's
// scheduleCloseComplete chain (RAF + 100ms setTimeout) normally fires
// onCloseComplete within ~120ms of visible→false. If it doesn't — RAF
// stalled with no rendering activity, ref cleared by an unmount race,
// any other edge — the caller would hang forever and every chained
// modal would silently no-op. This timeout guarantees we resolve within
// SAFETY_TIMEOUT_MS so the next sheet still opens. The cost on the
// happy path is zero (the close-complete signal removes the resolver
// from the array before the timeout fires, making the timeout a no-op).
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
      closeCompleteResolvers.push(resolve);
      setTimeout(() => {
        const idx = closeCompleteResolvers.indexOf(resolve);
        if (idx >= 0) {
          closeCompleteResolvers.splice(idx, 1);
          resolve();
        }
      }, SAFETY_TIMEOUT_MS);
    });
  },

  _signalCloseComplete: () => {
    // Drain every pending awaiter — they all wanted the same signal.
    while (closeCompleteResolvers.length > 0) {
      const resolve = closeCompleteResolvers.shift();
      resolve?.();
    }
  },
}));
