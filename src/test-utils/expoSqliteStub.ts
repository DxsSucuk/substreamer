/**
 * Test-only stub for the removed `expo-sqlite` package.
 *
 * The app no longer imports expo-sqlite (op-SQLite owns the database), but a batch
 * of legacy suites still call `jest.mock('expo-sqlite', …)`. Those mocks are now
 * DEAD (nothing under test imports expo-sqlite — db.ts uses the op-SQLite client),
 * but `jest.mock` still needs the name to RESOLVE to a real module. A
 * `moduleNameMapper` entry points `expo-sqlite` here; each suite's own factory
 * then replaces this stub. Remove the stub + those dead mocks in the test-seam
 * cleanup pass.
 */
export const openDatabaseSync = (): never => {
  throw new Error('expo-sqlite has been removed; op-SQLite owns the database');
};
export const defaultDatabaseDirectory = '';
