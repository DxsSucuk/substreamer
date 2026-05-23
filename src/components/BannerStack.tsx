/**
 * Priority-aware container for the top-of-screen pill banners. At most ONE
 * banner is shown at a time; the highest-priority banner with an active state
 * wins and suppresses the others.
 *
 * Ladder (highest priority first — matches the plan document):
 *   1. Persistence degraded (PersistenceDegradedBanner) — sticky session-long
 *      signal that writes won't survive relaunch; user MUST know about it
 *      even if connectivity is also broken
 *   2. SSL-error / network-unreachable / reconnected (ConnectivityBanner)
 *   3. Storage full (StorageFullBanner)
 *   4. Library-sync error variants: paused-auth-error, paused-metered, error
 *      (LibrarySyncBanner — actionable failures rank above a plain offline
 *      state so users see "reauthenticate" before "offline")
 *   5. (reserved — no connectivity "offline" variant exists today;
 *      ConnectivityBanner hides itself when the user enables offline mode)
 *   6. Library-sync progress / paused-offline variants (LibrarySyncBanner)
 *   7. Cover-art recache progress (CoverArtRecacheBanner) — transient
 *      post-Migration-22 sweep; ranks below library-sync progress because
 *      metadata catch-up is the higher-priority data signal
 */

import { memo } from 'react';

import { ConnectivityBanner } from './ConnectivityBanner';
import { CoverArtRecacheBanner } from './CoverArtRecacheBanner';
import { LibrarySyncBanner } from './LibrarySyncBanner';
import { PersistenceDegradedBanner } from './PersistenceDegradedBanner';
import { StorageFullBanner } from './StorageFullBanner';
import { connectivityStore } from '../store/connectivityStore';
import { coverArtRecacheStore } from '../store/coverArtRecacheStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { isDbHealthy } from '../store/persistence';
import { storageLimitStore } from '../store/storageLimitStore';
import { syncStatusStore } from '../store/syncStatusStore';

export const BannerStack = memo(function BannerStack() {
  const bannerState = connectivityStore((s) => s.bannerState);
  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const isStorageFull = storageLimitStore((s) => s.isStorageFull);
  const syncPhase = syncStatusStore((s) => s.detailSyncPhase);
  const recacheStatus = coverArtRecacheStore((s) => s.status);
  const recacheTotal = coverArtRecacheStore((s) => s.total);

  // Persistence-degraded is sticky and captured at module load. If SQLite
  // failed to open, surface this above everything else so the user knows
  // settings/login won't persist.
  if (!isDbHealthy()) return <PersistenceDegradedBanner />;

  // ConnectivityBanner internally hides itself when offlineMode is true (see
  // ConnectivityBanner.tsx:62). Mirror that logic here so the priority
  // ladder doesn't needlessly block lower-priority banners.
  const connectivityShowing = bannerState !== 'hidden' && !offlineMode;

  if (connectivityShowing) return <ConnectivityBanner />;
  if (isStorageFull) return <StorageFullBanner />;

  // Library-sync: error/paused-auth/paused-metered rank above plain offline.
  // Currently functionally equivalent to the progress variant (they all
  // render <LibrarySyncBanner />) but structured explicitly so that a
  // future connectivity "offline" variant can be inserted between them.
  const isSyncError =
    syncPhase === 'error'
    || syncPhase === 'paused-auth-error'
    || syncPhase === 'paused-metered';
  if (isSyncError) return <LibrarySyncBanner />;

  if (syncPhase === 'syncing' || syncPhase === 'paused-offline') {
    return <LibrarySyncBanner />;
  }

  if (recacheStatus === 'running' && recacheTotal > 0) {
    return <CoverArtRecacheBanner />;
  }
  return null;
});
