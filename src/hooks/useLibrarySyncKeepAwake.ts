import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect } from 'react';

import { syncStatusStore } from '../store/syncStatusStore';

const TAG = 'library-sync';

/**
 * Keep the device awake while the SLOW basic-path song walk is running (the
 * per-album `getAlbum` fetch, which can take minutes on large libraries). The
 * fast paged-`search3` song sync completes in seconds, so it doesn't hold the
 * device awake.
 */
export function useLibrarySyncKeepAwake() {
  const isWalking = syncStatusStore(
    (s) => s.detailSyncPhase === 'syncing' && s.songSyncStrategy === 'basic',
  );

  useEffect(() => {
    if (isWalking) {
      activateKeepAwakeAsync(TAG).catch(() => { /* activity may be unavailable */ });
    } else {
      deactivateKeepAwake(TAG).catch(() => { /* activity may be unavailable */ });
    }
    return () => {
      deactivateKeepAwake(TAG).catch(() => { /* activity may be unavailable during backgrounding */ });
    };
  }, [isWalking]);
}
