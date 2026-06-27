import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useThemedAlert } from './useThemedAlert';
import { clearQueue, seekTo, skipToTrack } from '../services/playerService';
import { createShareStore } from '../store/createShareStore';
import { moreOptionsStore, type MoreOptionsSource } from '../store/moreOptionsStore';
import { playerStore } from '../store/playerStore';
import { type Child } from '../services/subsonicService';

export interface UsePlayerActionsOptions {
  /** Identifies which player UI opened the more-options sheet. */
  source: MoreOptionsSource;
  /** Override for the clear-queue confirm action (defaults to `clearQueue`). */
  onClearConfirmed?: () => void;
}

/**
 * Shared queue/playback handlers used by every player surface. Playback
 * business logic lives in `playerService`; these are the thin UI wrappers.
 */
export function usePlayerActions({ source, onClearConfirmed }: UsePlayerActionsOptions) {
  const { t } = useTranslation();
  const { confirm } = useThemedAlert();

  const handleSeek = useCallback((seconds: number) => {
    seekTo(seconds);
  }, []);

  const handleQueueItemPress = useCallback((index: number) => {
    skipToTrack(index);
  }, []);

  const handleQueueItemLongPress = useCallback((track: Child) => {
    moreOptionsStore.getState().show({ type: 'song', item: track }, source);
  }, [source]);

  const handleShareQueue = useCallback(() => {
    const ids = playerStore.getState().queue.map((track) => track.id);
    if (ids.length > 0) {
      createShareStore.getState().showQueue(ids);
    }
  }, []);

  const handleClearQueue = useCallback(() => {
    confirm({
      title: t('clearQueue'),
      message: t('clearQueueMessage'),
      confirmLabel: t('clear'),
      destructive: true,
      onConfirm: onClearConfirmed ?? clearQueue,
    });
  }, [confirm, t, onClearConfirmed]);

  return {
    handleSeek,
    handleQueueItemPress,
    handleQueueItemLongPress,
    handleShareQueue,
    handleClearQueue,
  };
}
