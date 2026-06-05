import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// Synchronous adapter: the play gate reads `seen` inline when the user starts
// playback. Async hydration would let the first play of an existing user (who
// has already seen it) read the default `false` and re-prompt — exactly the
// nag we don't want. `kvStorageSync` is hydrated before the first play.
import { kvStorageSync as kvStorage } from './persistence';

interface BackgroundPlaybackPromptState {
  /** Persisted: the one-time Fire-OS prompt has been shown. Never re-prompt. */
  seen: boolean;
  /** Transient: the prompt modal is currently visible. */
  visible: boolean;
  /**
   * Mark seen (so it never shows again) AND show it now. Called once from the
   * play gate when the user is on Fire OS and hasn't seen it. Setting `seen`
   * up-front — not on dismiss — guarantees a single appearance even if the
   * user force-quits before dismissing.
   */
  markSeenAndShow: () => void;
  /** Hide the modal. `seen` stays true. */
  dismiss: () => void;
  /** Re-arm the prompt (e.g. a "show again" debug/settings affordance). */
  reset: () => void;
}

export const backgroundPlaybackPromptStore = create<BackgroundPlaybackPromptState>()(
  persist(
    (set) => ({
      seen: false,
      visible: false,
      markSeenAndShow: () => set({ seen: true, visible: true }),
      dismiss: () => set({ visible: false }),
      reset: () => set({ seen: false }),
    }),
    {
      name: 'substreamer-bg-playback-prompt',
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({ seen: state.seen }),
    }
  )
);
