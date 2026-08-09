/**
 * Phase 5: the offline-mode → filter-bar sync is now wired explicitly via
 * `initializeOfflineFilterBarSync()` instead of running at module import.
 * This file documents the new contract: importing `offlineModeStore` must
 * NOT touch `filterBarStore`; the sync only kicks in after explicit init.
 */

jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));

beforeEach(() => {
  jest.resetModules();
});

it('importing offlineModeStore does NOT touch filterBarStore (post-Phase-5)', () => {
  const { kvStorage } = require('../persistence/__mocks__/kvStorage');
  kvStorage.setItem(
    'substreamer-offline-mode',
    JSON.stringify({
      state: { offlineMode: true, showInFilterBar: true },
      version: 0,
    }),
  );

  const { filterBarStore } = require('../filterBarStore');
  // Import the offline-mode store — must not have side effects on filterBarStore.
  require('../offlineModeStore');

  expect(filterBarStore.getState().downloadedOnly).toBe(false);
});

it('initializeOfflineFilterBarSync() mirrors offlineMode into filterBarStore', () => {
  const { kvStorage } = require('../persistence/__mocks__/kvStorage');
  kvStorage.setItem(
    'substreamer-offline-mode',
    JSON.stringify({
      state: { offlineMode: true, showInFilterBar: true },
      version: 0,
    }),
  );

  const { filterBarStore } = require('../filterBarStore');
  const { initializeOfflineFilterBarSync } = require('../offlineModeStore');

  expect(filterBarStore.getState().downloadedOnly).toBe(false);

  const unsub = initializeOfflineFilterBarSync();
  expect(filterBarStore.getState().downloadedOnly).toBe(true);

  unsub();
});

it('subsequent offlineMode changes are mirrored after init', () => {
  const { filterBarStore } = require('../filterBarStore');
  const { offlineModeStore, initializeOfflineFilterBarSync } = require('../offlineModeStore');

  const unsub = initializeOfflineFilterBarSync();
  expect(filterBarStore.getState().downloadedOnly).toBe(false);

  offlineModeStore.getState().setOfflineMode(true);
  expect(filterBarStore.getState().downloadedOnly).toBe(true);

  offlineModeStore.getState().setOfflineMode(false);
  expect(filterBarStore.getState().downloadedOnly).toBe(false);

  unsub();
});

it('idempotent — repeat calls return the same teardown handle', () => {
  const { initializeOfflineFilterBarSync } = require('../offlineModeStore');
  const a = initializeOfflineFilterBarSync();
  const b = initializeOfflineFilterBarSync();
  expect(a).toBe(b);
  a();
});
