import { type StateStorage } from 'zustand/middleware';

import { getDb, kvFallback, serializeDbWrite } from './db';

// Fires once per process the first time any kvStorage operation falls back
// to the in-memory Map. `db.ts` already logs at init time, but that warn is
// silent w.r.t. *when* writes are actually being dropped — this surface
// makes that explicit at the first persist-store hit.
let _fallbackWarned = false;
function warnFallbackOnce(op: string, key: string): void {
  if (_fallbackWarned) return;
  _fallbackWarned = true;
  // eslint-disable-next-line no-console
  console.warn(
    `[kvStorage] SQLite unavailable; writes are ephemeral. First fallback at ${op}(${key}).`,
  );
}

/**
 * **Synchronous** Zustand `StateStorage` adapter backed by the shared SQLite
 * handle. Stores each persist blob as one row in the `storage(key, value)`
 * table.
 *
 * Reserved for callers that genuinely require a synchronous result:
 *  - Flash-critical persist stores hydrated before first paint (`themeStore`,
 *    `localeStore`, `authStore`, `onboardingStore`) — async hydration would
 *    reintroduce the startup white/wrong-mode/logged-out flash.
 *  - Hand-rolled blob persistence with synchronous return contracts
 *    (`queuePersistenceService`, the image-queue meta + settings blobs in
 *    `imageCacheService`/`musicCacheStore`/`imageCacheStore`, the splash
 *    `completedVersion` read, the pre-render native-color-scheme read).
 *
 * Everything else should use the async {@link kvStorage} below so its SQLite
 * IO runs on a background thread instead of blocking the JS thread.
 *
 * When `db.ts` fails to open SQLite (seen on stripped / corrupted Android
 * OEM ROMs), all operations fall through to an in-memory `Map` owned by
 * `db.ts` so the UI can still render. Writes in that mode don't survive a
 * relaunch — `isDbHealthy()` lets the UI surface the degraded state.
 *
 * Row-table modules (musicCacheTables, scrobbleTable, detailTables) don't
 * get this memory fallback — silently writing per-row data nowhere is worse
 * than not writing at all. They treat `getDb() === null` as a no-op.
 */
export const kvStorageSync: StateStorage = {
  getItem(key: string): string | null {
    const db = getDb();
    if (db === null) return kvFallback.get(key) ?? null;
    try {
      const row = db.getFirstSync<{ value: string }>(
        'SELECT value FROM storage WHERE key = ?;',
        [key],
      );
      return row?.value ?? null;
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    const db = getDb();
    if (db === null) {
      warnFallbackOnce('setItem', key);
      kvFallback.set(key, value);
      return;
    }
    try {
      db.runSync(
        'INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?);',
        [key, value],
      );
    } catch {
      /* persistence dropped this write; nothing else to do */
    }
  },
  removeItem(key: string): void {
    const db = getDb();
    if (db === null) {
      warnFallbackOnce('removeItem', key);
      kvFallback.delete(key);
      return;
    }
    try {
      db.runSync('DELETE FROM storage WHERE key = ?;', [key]);
    } catch {
      /* dropped */
    }
  },
};

/**
 * **Asynchronous** Zustand `StateStorage` adapter — the default for the
 * persist stores. Identical semantics to {@link kvStorageSync} but the SQLite
 * IO runs on expo-sqlite's background thread (`getFirstAsync`/`runAsync`), so
 * reads (boot hydration) and writes (every persisted mutation) never block
 * the JS thread.
 *
 * Async hydration means a store backed by this adapter is NOT populated at
 * first render — Zustand hydrates it a microtask later. That is fine for the
 * data/settings stores; the four flash-critical stores deliberately stay on
 * {@link kvStorageSync}. The startup chain in `_layout` waits on
 * `awaitKvHydration()` before the data-sync flow reads these stores.
 *
 * The `getDb() === null` fallback branches mutate/read `kvFallback`
 * synchronously (before any `await`) and resolve immediately, so behaviour in
 * the degraded no-SQLite mode matches the sync adapter.
 */
export const kvStorage: StateStorage = {
  async getItem(key: string): Promise<string | null> {
    const db = getDb();
    if (db === null) return kvFallback.get(key) ?? null;
    try {
      const row = await db.getFirstAsync<{ value: string }>(
        'SELECT value FROM storage WHERE key = ?;',
        [key],
      );
      return row?.value ?? null;
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    const db = getDb();
    if (db === null) {
      warnFallbackOnce('setItem', key);
      kvFallback.set(key, value);
      return;
    }
    try {
      await db.runAsync(
        'INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?);',
        [key, value],
      );
    } catch {
      /* persistence dropped this write; nothing else to do */
    }
  },
  async removeItem(key: string): Promise<void> {
    const db = getDb();
    if (db === null) {
      warnFallbackOnce('removeItem', key);
      kvFallback.delete(key);
      return;
    }
    try {
      await db.runAsync('DELETE FROM storage WHERE key = ?;', [key]);
    } catch {
      /* dropped */
    }
  },
};

/** Delete every row from the `storage` table — used by logout. */
export async function clearKvStorage(): Promise<void> {
  const db = getDb();
  if (db === null) {
    kvFallback.clear();
    return;
  }
  try {
    await serializeDbWrite(() => db.runAsync('DELETE FROM storage;'));
  } catch {
    /* dropped */
  }
}
