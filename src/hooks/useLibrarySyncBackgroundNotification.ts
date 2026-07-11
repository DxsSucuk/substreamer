import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';

import { syncStatusStore } from '../store/syncStatusStore';

const CHANNEL_ID = 'library-sync';
let channelEnsured = false;

function ensureChannel(): void {
  if (channelEnsured) return;
  channelEnsured = true;
  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Library sync',
      importance: Notifications.AndroidImportance.LOW,
      sound: null,
    }).catch(() => { /* non-critical if the channel already exists */ });
  }
}

/**
 * Post a low-importance Android notification while a full album-detail walk
 * is running and the app is backgrounded. Mirrors
 * `useDownloadBackgroundNotification` so users know the sync hasn't stalled
 * silently and can tell they're consuming bandwidth.
 */
export function useLibrarySyncBackgroundNotification() {
  const { t } = useTranslation();
  const notificationId = useRef<string | null>(null);

  useEffect(() => {
    ensureChannel();
    const sub = AppState.addEventListener('change', async (next) => {
      // Only the slow basic-path walk warrants a background notification; the
      // fast paged-search3 song sync is done in seconds.
      const st = syncStatusStore.getState();
      const isWalking = st.detailSyncPhase === 'syncing' && st.songSyncStrategy === 'basic';

      if (next === 'background' && isWalking) {
        const { granted } = await Notifications.requestPermissionsAsync();
        if (!granted) return;

        notificationId.current = await Notifications.scheduleNotificationAsync({
          content: {
            title: t('librarySyncingInProgress'),
            body: t('librarySyncingInProgressBody'),
            ...(Platform.OS === 'android' && { channelId: CHANNEL_ID }),
          },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 1 },
        });
      } else if (next === 'active' && notificationId.current) {
        await Notifications.dismissNotificationAsync(notificationId.current);
        notificationId.current = null;
      }
    });

    return () => sub.remove();
  }, [t]);
}
