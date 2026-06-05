import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { ThemedAlert } from './ThemedAlert';
import { useTheme } from '../hooks/useTheme';
import { backgroundPlaybackPromptStore } from '../store/backgroundPlaybackPromptStore';
import { requestBatteryOptimizationExemption } from '../services/batteryOptimizationService';

/**
 * One-time, Fire-OS-only prompt shown the first time the user starts playback.
 * Explains why background audio needs extra setup on Fire tablets — Fire OS's
 * "Smart Suspend" turns Wi-Fi off when idle and its battery management can
 * pause/stop background audio — and offers a shortcut to the battery-optimization
 * exemption. Non-blocking: playback has already started underneath; this just
 * surfaces the guidance once. Visibility is driven entirely by
 * `backgroundPlaybackPromptStore`, which only fires on Fire OS and at most once.
 */
export function BackgroundPlaybackPromptModal() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const visible = backgroundPlaybackPromptStore((s) => s.visible);

  const dismiss = useCallback(() => {
    backgroundPlaybackPromptStore.getState().dismiss();
  }, []);

  const openSettings = useCallback(() => {
    void requestBatteryOptimizationExemption();
  }, []);

  return (
    <ThemedAlert
      visible={visible}
      title={t('fireBackgroundPlaybackTitle')}
      message={t('fireBackgroundPlaybackBody')}
      buttons={[
        { text: t('fireBackgroundPlaybackDismiss'), style: 'default' },
        { text: t('fireBackgroundPlaybackOpenSettings'), style: 'default', onPress: openSettings },
      ]}
      onDismiss={dismiss}
      colors={colors}
    />
  );
}
