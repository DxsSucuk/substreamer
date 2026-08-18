/**
 * Priority-aware container for the top-of-screen pill banners. At most ONE
 * banner shows at a time; the highest-priority active state wins and
 * suppresses the others.
 *
 * Ladder, highest first:
 *   1. Persistence degraded — writes won't survive relaunch, so it outranks
 *      even a broken connection
 *   2. SSL error / network unreachable / reconnected (ConnectivityBanner)
 *   3. Storage full
 *   4. Library-sync failures (paused-auth-error, paused-metered, error) —
 *      actionable, so they rank above a plain offline state
 *   5. (reserved for a connectivity "offline" variant)
 *   6. Library-sync progress / paused-offline
 *   7. Image-cache refresh progress — user-initiated and transient, so it
 *      yields to metadata catch-up
 *   8. Downloaded-metadata refresh progress — purely informational
 */

import { memo } from 'react';

import { ConnectivityBanner } from './ConnectivityBanner';
import { DownloadedMetadataBanner } from './DownloadedMetadataBanner';
import { ImageCacheBanner } from './ImageCacheBanner';
import { LibrarySyncBanner } from './LibrarySyncBanner';
import { PersistenceDegradedBanner } from './PersistenceDegradedBanner';
import { StorageFullBanner } from './StorageFullBanner';
import { connectivityStore } from '../store/connectivityStore';
import { downloadedMetadataRefreshStore } from '../store/downloadedMetadataRefreshStore';
import { imageDownloadQueueStore } from '../store/imageDownloadQueueStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { isDbHealthy } from '../store/persistence';
import { storageLimitStore } from '../store/storageLimitStore';
import { syncStatusStore } from '../store/syncStatusStore';

export const BannerStack = memo(function BannerStack() {
  const bannerState = connectivityStore((s) => s.bannerState);
  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const isStorageFull = storageLimitStore((s) => s.isStorageFull);
  const syncPhase = syncStatusStore((s) => s.detailSyncPhase);
  const listSyncPhase = syncStatusStore((s) => s.librarySyncPhase);
  const migrationPhase = syncStatusStore((s) => s.normalizedMigrationPhase);
  const imageQueueCycleId = imageDownloadQueueStore((s) => s.cycleId);
  const imageQueueTotal = imageDownloadQueueStore((s) => s.cycleTotal);
  const imageQueuePhase = imageDownloadQueueStore((s) => s.phase);
  const metaRefreshActive = downloadedMetadataRefreshStore((s) => s.active);
  const metaRefreshTotal = downloadedMetadataRefreshStore((s) => s.total);

  // Persistence-degraded is sticky and captured at module load. If SQLite
  // failed to open, surface this above everything else so the user knows
  // settings/login won't persist.
  if (!isDbHealthy()) return <PersistenceDegradedBanner />;

  // ConnectivityBanner hides itself when offlineMode is true. Mirror that here or
  // the ladder blocks lower-priority banners on behalf of a banner that won't render.
  const connectivityShowing = bannerState !== 'hidden' && !offlineMode;

  if (connectivityShowing) return <ConnectivityBanner />;
  if (isStorageFull) return <StorageFullBanner />;

  // Library-sync failures rank above plain offline. Split from the progress branch
  // below (both render <LibrarySyncBanner />) to leave room for rung 5.
  const isSyncError =
    syncPhase === 'error'
    || syncPhase === 'paused-auth-error'
    || syncPhase === 'paused-metered'
    || syncPhase === 'paused-error';
  if (isSyncError) return <LibrarySyncBanner />;

  // Album-LIST fetch progress (paginated `library_albums` sync) shares this slot — it
  // runs before the detail walk. The one-time blob→normalized migration ("Upgrading
  // library…") does too; LibrarySyncBanner prioritizes it over the sync variants.
  if (
    migrationPhase === 'migrating'
    || syncPhase === 'syncing'
    || syncPhase === 'paused-offline'
    || listSyncPhase === 'fetching'
    || listSyncPhase === 'paused-offline'
    || listSyncPhase === 'paused-error'
  ) {
    return <LibrarySyncBanner />;
  }

  // 'dismissed' keeps the cycle alive (for retry) but must not claim the banner
  // slot — otherwise a dismissed error would suppress lower-priority banners.
  if (imageQueueCycleId !== null && imageQueueTotal > 0 && imageQueuePhase !== 'dismissed') {
    return <ImageCacheBanner />;
  }

  // Lowest priority: the downloaded-metadata re-cache pass (startup backfill or
  // manual button).
  if (metaRefreshActive && metaRefreshTotal > 0) {
    return <DownloadedMetadataBanner />;
  }
  return null;
});
