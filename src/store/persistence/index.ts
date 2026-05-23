/**
 * Public API for the persistence service.
 *
 * One import path for every consumer:
 *   import { kvStorage, isDbHealthy, upsertCachedItem, ... } from '@/store/persistence';
 *
 * NOTE: `rehydrate.ts` (single rehydrateAllStores command) is intentionally
 * NOT re-exported here. It imports the per-row stores, and those stores
 * import table helpers from this barrel — re-exporting `rehydrateAllStores`
 * here would create a cycle. Consumers import it directly from
 * `'../store/persistence/rehydrate'`.
 */

// Handle / lifecycle / health / test hook
export { getDb, isDbHealthy, dbInitError, kvFallback, __setDbForTests, type InternalDb } from './db';

// KV blob storage (Zustand StateStorage adapter) + clear
export { kvStorage, clearKvStorage } from './kvStorage';

// Music-cache row-table API
export * from './musicCacheTables';

// Scrobble row-table API
export * from './scrobbleTable';

// Pending-scrobble row-table API
export * from './pendingScrobbleTable';

// Detail-cache row-table API
export * from './detailTables';

// Image-cache row-table API
export * from './imageCacheTable';

// Image-download-queue row-table API (persistent queue for cover-art refresh cycles)
export * from './imageDownloadQueueTable';
