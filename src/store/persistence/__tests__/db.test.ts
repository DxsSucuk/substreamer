// Per-suite mocks re-evaluate the module-scope try/catch in db.ts (which opens
// via the op-SQLite client) using jest.isolateModules + jest.doMock on
// '@op-engineering/op-sqlite'. The client applies PRAGMAs and runs schema DDL
// through op-SQLite's `executeSync`, so a jest.fn() spy on it captures the exact
// statement sequence the previous expo-sqlite `execSync` spy used to.

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
      mockExecuteSync = jest.fn(() => okResult);
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

  it('creates every persistence table in FK-safe order', () => {
    const creates = mockExecuteSync.mock.calls
      .map((c) => c[0] as string)
      // Legacy tables only — the normalized model's generated DDL uses backtick-
      // quoted names and is validated by the repository/DDL tests, not here.
      .filter((sql) => sql.trim().startsWith('CREATE TABLE') && !sql.includes('`'));
    // The order here is load-bearing: cached_items must be created before
    // cached_item_songs so the FOREIGN KEY clause resolves.
    const tableNames = creates.map((sql) => {
      const match = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
      return match?.[1];
    });
    expect(tableNames).toEqual([
      'storage',
      'album_details',
      'song_index',
      'library_albums',
      'scrobble_events',
      'pending_scrobble_events',
      'cached_songs',
      'cached_items',
      'cached_item_songs',
      'download_queue',
      'cached_images',
      'image_download_queue',
    ]);
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

  it('creates every expected index', () => {
    const indexNames = mockExecuteSync.mock.calls
      .map((c) => c[0] as string)
      // Legacy indexes only — the normalized model's generated DDL uses backticks.
      .filter((sql) => sql.trim().startsWith('CREATE INDEX') && !sql.includes('`'))
      .map((sql) => {
        const match = sql.match(/CREATE INDEX IF NOT EXISTS (\w+)/);
        return match?.[1];
      });
    expect(indexNames.sort()).toEqual(
      [
        'idx_cached_images_cached_at',
        'idx_cached_images_cover_art_id',
        'idx_cached_item_songs_song_id',
        'idx_cached_songs_album_id',
        'idx_download_queue_position',
        'idx_download_queue_status',
        'idx_image_download_queue_cycle',
        'idx_image_download_queue_status',
        'idx_library_albums_dmeta_artist',
        'idx_library_albums_dmeta_name',
        'idx_library_albums_norm_name',
        'idx_library_albums_sortKey',
        'idx_pending_scrobble_events_time',
        'idx_scrobble_events_time',
        'idx_song_index_albumId',
        'idx_song_index_dmeta_artist',
        'idx_song_index_dmeta_title',
        'idx_song_index_norm_title',
        'idx_song_index_sort',
        'idx_song_index_starred',
      ].sort(),
    );
  });

  it('cached_item_songs declares ON DELETE CASCADE on item_id', () => {
    // Guards against accidental schema regression — the cascade behavior is
    // exactly what the UPSERT fix in commit 5867ff0 relies on for orphan
    // edges to clean up, and its absence would silently corrupt the
    // refcount-by-COUNT invariant.
    const cascadeDdl = mockExecuteSync.mock.calls
      .map((c) => c[0] as string)
      .find((sql) => sql.includes('cached_item_songs'));
    expect(cascadeDdl).toMatch(/ON DELETE CASCADE/);
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
        execSync: jest.fn(),
        withTransactionSync: jest.fn(),
        withTransactionAsync: jest.fn(),
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
