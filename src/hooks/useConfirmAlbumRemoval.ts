import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useThemedAlert } from './useThemedAlert';
import {
  computeAlbumRemovalOutcome,
  deleteCachedItem,
  demoteAlbumToPartial,
} from '../services/musicCacheService';
import { musicCacheStore } from '../store/musicCacheStore';

/**
 * Returns `{ confirmRemove }`. Android confirmation modals mount via the
 * root-level `ThemedAlertHost`, so callers no longer need to render their
 * own `<ThemedAlert>`.
 *
 * `confirmRemove(itemId)` behaviour:
 * - Non-album items → pass straight through to `deleteCachedItem`.
 * - Album with no survivors (all songs would be orphaned) → `deleteCachedItem`.
 * - Album with survivors (some songs are also edged by playlist / favorites /
 *   single-song items) → show a confirmation dialog explaining the outcome.
 *   On confirm, `demoteAlbumToPartial` preserves the album row with survivor
 *   edges (and its original `downloadedAt`), so the UI shows it as partial.
 */
export function useConfirmAlbumRemoval() {
  const { confirm } = useThemedAlert();
  const { t } = useTranslation();

  const confirmRemove = useCallback(
    (itemId: string) => {
      if (!itemId) return;
      const cached = musicCacheStore.getState().cachedItems[itemId];
      if (!cached) {
        deleteCachedItem(itemId);
        return;
      }
      if (cached.type !== 'album') {
        deleteCachedItem(itemId);
        return;
      }
      const { survivorCount } = computeAlbumRemovalOutcome(itemId);
      if (survivorCount === 0) {
        deleteCachedItem(itemId);
        return;
      }
      confirm({
        title: t('removeAlbumKeepsSongsTitle'),
        message: t('removeAlbumKeepsSongsMessage', {
          count: survivorCount,
          album: cached.name,
        }),
        confirmLabel: t('removeAnyway'),
        destructive: true,
        onConfirm: () => demoteAlbumToPartial(itemId),
      });
    },
    [confirm, t],
  );

  return { confirmRemove };
}
