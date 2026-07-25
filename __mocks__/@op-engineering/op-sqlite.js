/**
 * Auto-applied Jest manual mock for the native op-SQLite module (absent under
 * Node). Backs it with the in-memory better-sqlite3 adapter so DB-touching suites
 * run REAL SQL. `location` is forced to `:memory:` — test file paths resolved
 * from the mocked expo-file-system don't exist on disk, and each suite wants an
 * isolated DB. See src/db/testing/opSqliteBetterSqlite3.ts.
 */
const { createOpSqliteMock } = require('../../src/db/testing/opSqliteBetterSqlite3');

const base = createOpSqliteMock();
const openMemory = (opts) => base.open({ ...(opts || {}), location: ':memory:' });

module.exports = {
  ...base,
  open: openMemory,
  openSync: openMemory,
  openAsync: (opts) => Promise.resolve(openMemory(opts)),
};
