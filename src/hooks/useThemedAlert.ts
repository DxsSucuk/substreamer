import { Alert, Platform } from 'react-native';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { themedAlertStore } from '../store/themedAlertStore';

interface AlertButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

/**
 * Platform-aware alert hook.
 *
 * - iOS: delegates to the native `Alert.alert` (respects system dark mode).
 * - Android: routes through the global `themedAlertStore` so the alert
 *   Modal mounts at the root layout (via `ThemedAlertHost`), independent
 *   of whatever component triggered it. This avoids Android Modal
 *   handoff races when an alert is opened immediately after another
 *   Modal closes (e.g. MoreOptionsSheet → Delete Playlist confirm).
 */
export function useThemedAlert() {
  const { t } = useTranslation();

  const alert = useCallback(
    (title: string, message?: string, buttons?: AlertButton[]) => {
      const resolvedButtons = buttons ?? [{ text: t('ok'), style: 'default' as const }];

      if (Platform.OS === 'ios') {
        Alert.alert(title, message, resolvedButtons);
        return;
      }

      themedAlertStore.getState().show(title, message, resolvedButtons);
    },
    [t],
  );

  /**
   * Two-button confirmation: a cancel button (auto-injected) plus a single
   * affirmative action. `destructive` styles the action red. Use for the
   * common `[cancel, confirm]` dialog instead of hand-building the buttons.
   */
  const confirm = useCallback(
    (options: {
      title: string;
      message?: string;
      confirmLabel: string;
      destructive?: boolean;
      onConfirm: () => void;
    }) => {
      alert(options.title, options.message, [
        { text: t('cancel'), style: 'cancel' },
        {
          text: options.confirmLabel,
          style: options.destructive ? 'destructive' : 'default',
          onPress: options.onConfirm,
        },
      ]);
    },
    [alert, t],
  );

  return { alert, confirm };
}
