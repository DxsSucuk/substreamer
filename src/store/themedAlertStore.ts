/**
 * Global themed-alert store. One alert at a time, rendered by the
 * `ThemedAlertHost` mounted at the root of `_layout.tsx`.
 *
 * Global instead of the per-component `useThemedAlert` hook: an alert
 * opened from inside another Modal's React subtree (most notably
 * MoreOptionsSheet's BottomSheet) races the old Dialog's native dismiss
 * on Android — the alert mounts but Android inserts it below the
 * still-dismissing window, so it stays invisible until something else
 * stacks on top. Mounting it in a sibling React subtree to the closing
 * Modal avoids that, the same pattern `addToPlaylistStore` /
 * `mbidSearchStore` / `createShareStore` already use. Do not reach for a
 * `setTimeout` delay instead — the race is structural, not a timing gap.
 *
 * `useThemedAlert.alert()` delegates here so consumers don't need to
 * change their API.
 */

import { create } from 'zustand';

interface ThemedAlertButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

interface ThemedAlertState {
  visible: boolean;
  title: string;
  message?: string;
  buttons: ThemedAlertButton[];

  show: (title: string, message: string | undefined, buttons: ThemedAlertButton[]) => void;
  hide: () => void;
}

export const themedAlertStore = create<ThemedAlertState>()((set) => ({
  visible: false,
  title: '',
  message: undefined,
  buttons: [],

  show: (title, message, buttons) => set({
    visible: true,
    title,
    message,
    buttons,
  }),

  hide: () => set({ visible: false }),
}));
