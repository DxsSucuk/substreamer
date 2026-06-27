/**
 * Global themed-alert store. One alert at a time, rendered by the
 * `ThemedAlertHost` mounted at the root of `_layout.tsx`.
 *
 * Why global instead of the per-component `useThemedAlert` hook: when
 * an alert is opened from inside another Modal's React subtree (most
 * notably MoreOptionsSheet's BottomSheet — handleDeletePlaylist,
 * removalAlertProps, etc.), the new Dialog races the old Dialog's
 * native dismiss on Android. Result: the alert mounts but Android
 * inserts it below the still-dismissing previous window, making it
 * invisible until something else stacks on top. Timing fixes
 * (setTimeout(N)) are fragile and we've burned enough on them — the
 * structural answer is to mount the alert in a sibling React subtree
 * to the closing Modal, the same pattern that already works for
 * `addToPlaylistStore` / `mbidSearchStore` / `createShareStore`.
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
