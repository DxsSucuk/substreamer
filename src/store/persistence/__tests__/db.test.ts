// Per-suite mocks re-evaluate the module-scope try/catch in db.ts (which opens
// via the op-SQLite client) using jest.isolateModules + jest.doMock on
// '@op-engineering/op-sqlite'. The client applies PRAGMAs and runs schema DDL
// through op-SQLite's `executeSync`, so a jest.fn() spy on it captures the exact
// statement sequence the previous expo-sqlite `execSync` spy used to.

import { KEPT_TABLES } from '../../../db/createNormalizedTables';
import { NORMALIZED_DDL } from '../../../db/normalizedDdl';

const okResult = { rows: [] as Array<Record<string, unknown>>, rowsAffected: 0 };

describe('persistence/db (happy path)', () => {
  let mockExecuteSync: jest.Mock;
  let mockExecute: jest.Mock;
  let getDb: typeof import('../db').getDb;
  let __setDbForTests: typeof import('../db').__setDbForTests;
  let isDbHealthy: typeof import('../db').isDbHealthy;
  let dbInitError: Error | null;

  beforeAll(() => {
    jest.isolateModules(() => {
      // Report `cached_item_songs` as present so the dedup's existence guard fires —
      // an upgrading install, which is the case the dedup exists for.
      mockExecuteSync = jest.fn((sql: string) =>
        typeof sql === 'string' && sql.includes('sqlite_master')
          ? { rows: [{ n: 1 }], rowsAffected: 0 }
          : okResult,
      );
      mockExecute = jest.fn(async () => okResult);
      jest.doMock('@op-engineering/op-sqlite', () => ({
        open: () => ({
          executeSync: mockExecuteSync,
          execute: mockExecute,
          getDbPath: () => ':memory:',
          close: jest.fn(),
        }),
      }));
      const mod = require('../db');
      getDb = mod.getDb;
      __setDbForTests = mod.__setDbForTests;
      isDbHealthy = mod.isDbHealthy;
      dbInitError = mod.dbInitError;
    });
  });

  it('reports healthy with no init error', () => {
    expect(isDbHealthy()).toBe(true);
    expect(dbInitError).toBeNull();
  });

  it('returns a healthy op-SQLite-backed handle from getDb that forwards to executeSync', () => {
    const handle = getDb();
    expect(handle).not.toBeNull();
    handle?.execSync('SELECT 42;');
    expect(mockExecuteSync).toHaveBeenCalledWith('SELECT 42;');
  });

  it('applies PRAGMAs in the documented order (incl. the boot WAL fold)', () => {
    const pragmaSets = mockExecuteSync.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => sql.startsWith('PRAGMA') && (sql.includes('=') || sql.includes('wal_checkpoint')));
    expect(pragmaSets).toEqual([
      'PRAGMA journal_mode = WAL;',
      'PRAGMA wal_checkpoint(TRUNCATE);',
      'PRAGMA synchronous = NORMAL;',
      'PRAGMA foreign_keys = ON;',
      'PRAGMA busy_timeout = 5000;',
      'PRAGMA cache_size = -32000;',
      'PRAGMA temp_store = MEMORY;',
    ]);
  });

  it('hand-writes no CREATE TABLE at boot', () => {
    const creates = mockExecuteSync.mock.calls
      .map((c) => c[0] as string)
      // The normalized model + the permanent kept tables live in schema.ts and are
      // created by ensureNormalizedSchema from the generated (backtick-quoted) DDL.
      .filter((sql) => sql.trim().startsWith('CREATE TABLE') && !sql.includes('`'));
    const tableNames = creates.map((sql) => {
      const match = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
      return match?.[1];
    });
    // Every table is declared in schema.ts now. The legacy blob tables are created only
    // by Migration 12, off the boot path.
    expect(tableNames).toEqual([]);
  });

  it('declares every permanent table in the generated DDL, not by hand', () => {
    const ddl = NORMALIZED_DDL.join('\n');
    for (const t of KEPT_TABLES) {
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS \`${t}\``);
    }
  });

  it('reads the tuning PRAGMAs back at boot to validate they applied', () => {
    const readbacks = mockExecuteSync.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => sql.startsWith('PRAGMA') && !sql.includes('=') && !sql.includes('('));
    expect(readbacks).toEqual(
      expect.arrayContaining([
        'PRAGMA busy_timeout;',
        'PRAGMA cache_size;',
        'PRAGMA temp_store;',
      ]),
    );
  });

  it('hand-writes no CREATE INDEX at boot', () => {
    const indexNames = mockExecuteSync.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => sql.trim().startsWith('CREATE INDEX') && !sql.includes('`'))
      .map((sql) => {
        const match = sql.match(/CREATE INDEX IF NOT EXISTS (\w+)/);
        return match?.[1];
      });
    expect(indexNames).toEqual([]);
  });

  it('the kept tables index via the generated DDL, after their columns exist', () => {
    // The whole point of the consolidation: ensureNormalizedSchema runs tables →
    // ALTER-add missing columns → indexes, so `idx_scrobble_events_hour` can no longer
    // be created before the `hour` column and take DB init down.
    const ddl = NORMALIZED_DDL.join('\n');
    for (const idx of [
      'idx_scrobble_events_time',
      'idx_scrobble_events_hour',
      'idx_pending_scrobble_events_time',
      'idx_cached_songs_album_id',
      'idx_cached_item_songs_song_id',
      'idx_cached_item_songs_item_song',
      'idx_download_queue_status',
      'idx_download_queue_position_unique',
      'idx_cached_images_cached_at',
      'idx_cached_images_cover_art_id',
      'idx_image_download_queue_status',
      'idx_image_download_queue_cycle',
    ]) {
      expect(ddl).toContain(`\`${idx}\``);
    }
  });

  it('cached_item_songs declares ON DELETE CASCADE on item_id', () => {
    // Guards against accidental schema regression — the cascade behavior is
    // exactly what the UPSERT fix in commit 5867ff0 relies on for orphan
    // edges to clean up, and its absence would silently corrupt the
    // refcount-by-COUNT invariant. Match the CREATE specifically: the dedup DELETE in
    // db.ts also mentions the table, and drizzle emits lowercase `ON DELETE cascade`.
    const cascadeDdl = NORMALIZED_DDL.find(
      (sql) => sql.trim().startsWith('CREATE TABLE') && sql.includes('cached_item_songs'),
    );
    expect(cascadeDdl).toMatch(/on delete cascade/i);
  });

  it('dedups cached_item_songs before the UNIQUE index is created', () => {
    // The dedup must precede ensureNormalizedSchema — that transaction creates the
    // UNIQUE (item_id, song_id) index all-or-nothing, so leftover duplicates would
    // fail it and null the whole DB handle.
    const sqls = mockExecuteSync.mock.calls.map((c) => c[0] as string);
    const dedupIdx = sqls.findIndex((s) => s.includes('DELETE FROM cached_item_songs'));
    const uniqueIdx = sqls.findIndex((s) => s.includes('idx_cached_item_songs_item_song'));
    expect(dedupIdx).toBeGreaterThanOrEqual(0);
    expect(uniqueIdx).toBeGreaterThan(dedupIdx);
  });

  it('retires the old non-unique download_queue position index at boot', () => {
    // A new index NAME plus a DROP of the old one — `CREATE UNIQUE INDEX IF NOT
    // EXISTS idx_download_queue_position` would be a silent no-op against the
    // existing non-unique index, so upgrading installs would never get the
    // constraint.
    const sqls = mockExecuteSync.mock.calls.map((c) => c[0] as string);
    expect(sqls).toContain('DROP INDEX IF EXISTS idx_download_queue_position;');
  });

  it('probes download_queue for duplicate positions before the UNIQUE index is created', () => {
    // Same ordering requirement as the cached_item_songs dedup: the renumber must
    // run first or leftover duplicates fail the all-or-nothing CREATE.
    const sqls = mockExecuteSync.mock.calls.map((c) => c[0] as string);
    const probeIdx = sqls.findIndex((s) => s.includes('HAVING COUNT(*) > 1'));
    const uniqueIdx = sqls.findIndex((s) => s.includes('idx_download_queue_position_unique'));
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(uniqueIdx).toBeGreaterThan(probeIdx);
  });

  describe('__setDbForTests', () => {
    it('swaps the shared handle and restores it', () => {
      const original = getDb();
      const fake = {
        getFirstSync: jest.fn(),
        getAllSync: jest.fn(),
        getAllAsync: jest.fn(),
        getFirstAsync: jest.fn(),
        runSync: jest.fn(),
        runAsync: jest.fn(),
        runBatchAsync: jest.fn(),
        runAtomicBatchAsync: jest.fn(),
        execSync: jest.fn(),
        withTransactionSync: jest.fn(),
      };
      __setDbForTests(fake);
      expect(getDb()).toBe(fake);
      __setDbForTests(original);
      expect(getDb()).toBe(original);
    });

    it('accepts null to simulate an unhealthy DB', () => {
      const original = getDb();
      __setDbForTests(null);
      expect(getDb()).toBeNull();
      __setDbForTests(original);
    });
  });
});

describe('persistence/db (init failure)', () => {
  let getDb: typeof import('../db').getDb;
  let kvFallback: Map<string, string>;
  let isDbHealthy: typeof import('../db').isDbHealthy;
  let dbInitError: Error | null;
  let warnSpy: jest.SpyInstance;

  beforeAll(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.isolateModules(() => {
      jest.doMock('@op-engineering/op-sqlite', () => ({
        open: () => {
          throw new Error('OEM ICU/JSSE failure');
        },
      }));
      const mod = require('../db');
      getDb = mod.getDb;
      kvFallback = mod.kvFallback;
      isDbHealthy = mod.isDbHealthy;
      dbInitError = mod.dbInitError;
    });
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  it('reports unhealthy and captures the init error', () => {
    expect(isDbHealthy()).toBe(false);
    expect(dbInitError).toBeInstanceOf(Error);
    expect(dbInitError?.message).toContain('OEM ICU/JSSE failure');
  });

  it('getDb returns null when init failed', () => {
    expect(getDb()).toBeNull();
  });

  it('exposes an empty kvFallback Map for the KV adapter to use', () => {
    expect(kvFallback).toBeInstanceOf(Map);
    expect(kvFallback.size).toBe(0);
  });

  it('logs a warning when init fails', () => {
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[persistence/db] init failed'),
      expect.any(String),
    );
  });
});

describe('persistence/db (non-Error throw)', () => {
  let dbInitError: Error | null;
  let warnSpy: jest.SpyInstance;

  beforeAll(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.isolateModules(() => {
      jest.doMock('@op-engineering/op-sqlite', () => ({
        open: () => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw 'string-shaped failure';
        },
      }));
      const mod = require('../db');
      dbInitError = mod.dbInitError;
    });
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  it('coerces non-Error throws into a real Error', () => {
    expect(dbInitError).toBeInstanceOf(Error);
    expect(dbInitError?.message).toBe('string-shaped failure');
  });
});
