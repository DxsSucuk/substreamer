// The kvStorage adapters delegate to the shared handle owned by db.ts. Tests
// inject a fake handle via db.ts's `__setDbForTests`; the in-memory fallback
// path is exercised by setting the handle to null.
//
// There are two adapters: `kvStorageSync` (getFirstSync/runSync) for
// flash-critical + hand-rolled sync callers, and `kvStorage` (getFirstAsync/
// runAsync) — the async default whose SQLite IO runs off the JS thread.

import { __setDbForTests, kvFallback } from '../db';
import { kvStorage, kvStorageSync, clearKvStorage } from '../kvStorage';

describe('kvStorageSync (happy path)', () => {
  let mockGetFirstSync: jest.Mock;
  let mockRunSync: jest.Mock;

  beforeEach(() => {
    mockGetFirstSync = jest.fn();
    mockRunSync = jest.fn();
    __setDbForTests({
      getFirstSync: mockGetFirstSync,
      getAllSync: jest.fn(),
      getAllAsync: jest.fn(),
      getFirstAsync: jest.fn(),
      runSync: mockRunSync,
      runAsync: jest.fn(),
      execSync: jest.fn(),
      withTransactionSync: jest.fn(),
      withTransactionAsync: jest.fn(),
    });
  });

  afterAll(() => {
    __setDbForTests(null);
  });

  describe('getItem', () => {
    it('returns value when row exists', () => {
      mockGetFirstSync.mockReturnValue({ value: '{"count":1}' });
      expect(kvStorageSync.getItem('my-key')).toBe('{"count":1}');
      expect(mockGetFirstSync).toHaveBeenCalledWith(
        'SELECT value FROM storage WHERE key = ?;',
        ['my-key'],
      );
    });

    it('returns null when row does not exist', () => {
      mockGetFirstSync.mockReturnValue(undefined);
      expect(kvStorageSync.getItem('missing')).toBeNull();
    });

    it('returns null when getFirstSync throws (per-call failure)', () => {
      mockGetFirstSync.mockImplementation(() => {
        throw new Error('disk i/o');
      });
      expect(kvStorageSync.getItem('any')).toBeNull();
    });
  });

  describe('setItem', () => {
    it('inserts or replaces the key-value pair', () => {
      kvStorageSync.setItem('my-key', '{"count":1}');
      expect(mockRunSync).toHaveBeenCalledWith(
        'INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?);',
        ['my-key', '{"count":1}'],
      );
    });

    it('swallows runSync failures', () => {
      mockRunSync.mockImplementation(() => {
        throw new Error('disk full');
      });
      expect(() => kvStorageSync.setItem('any', 'v')).not.toThrow();
    });
  });

  describe('removeItem', () => {
    it('deletes the row by key', () => {
      kvStorageSync.removeItem('my-key');
      expect(mockRunSync).toHaveBeenCalledWith(
        'DELETE FROM storage WHERE key = ?;',
        ['my-key'],
      );
    });

    it('swallows runSync failures', () => {
      mockRunSync.mockImplementation(() => {
        throw new Error('disk i/o');
      });
      expect(() => kvStorageSync.removeItem('any')).not.toThrow();
    });
  });

  describe('clearKvStorage', () => {
    it('deletes every row from the storage table', () => {
      clearKvStorage();
      expect(mockRunSync).toHaveBeenCalledWith('DELETE FROM storage;');
    });

    it('swallows runSync failures', () => {
      mockRunSync.mockImplementation(() => {
        throw new Error('disk i/o');
      });
      expect(() => clearKvStorage()).not.toThrow();
    });
  });
});

describe('kvStorage (async, happy path)', () => {
  let mockGetFirstAsync: jest.Mock;
  let mockRunAsync: jest.Mock;

  beforeEach(() => {
    mockGetFirstAsync = jest.fn();
    mockRunAsync = jest.fn().mockResolvedValue({ changes: 1, lastInsertRowId: 0 });
    __setDbForTests({
      getFirstSync: jest.fn(),
      getAllSync: jest.fn(),
      getAllAsync: jest.fn(),
      getFirstAsync: mockGetFirstAsync,
      runSync: jest.fn(),
      runAsync: mockRunAsync,
      execSync: jest.fn(),
      withTransactionSync: jest.fn(),
      withTransactionAsync: jest.fn(),
    });
  });

  afterAll(() => {
    __setDbForTests(null);
  });

  describe('getItem', () => {
    it('returns value when row exists', async () => {
      mockGetFirstAsync.mockResolvedValue({ value: '{"count":1}' });
      await expect(kvStorage.getItem('my-key')).resolves.toBe('{"count":1}');
      expect(mockGetFirstAsync).toHaveBeenCalledWith(
        'SELECT value FROM storage WHERE key = ?;',
        ['my-key'],
      );
    });

    it('returns null when row does not exist', async () => {
      mockGetFirstAsync.mockResolvedValue(null);
      await expect(kvStorage.getItem('missing')).resolves.toBeNull();
    });

    it('returns null when getFirstAsync rejects (per-call failure)', async () => {
      mockGetFirstAsync.mockRejectedValue(new Error('disk i/o'));
      await expect(kvStorage.getItem('any')).resolves.toBeNull();
    });
  });

  describe('setItem', () => {
    it('inserts or replaces the key-value pair', async () => {
      await kvStorage.setItem('my-key', '{"count":1}');
      expect(mockRunAsync).toHaveBeenCalledWith(
        'INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?);',
        ['my-key', '{"count":1}'],
      );
    });

    it('swallows runAsync failures', async () => {
      mockRunAsync.mockRejectedValue(new Error('disk full'));
      await expect(kvStorage.setItem('any', 'v')).resolves.toBeUndefined();
    });
  });

  describe('removeItem', () => {
    it('deletes the row by key', async () => {
      await kvStorage.removeItem('my-key');
      expect(mockRunAsync).toHaveBeenCalledWith(
        'DELETE FROM storage WHERE key = ?;',
        ['my-key'],
      );
    });

    it('swallows runAsync failures', async () => {
      mockRunAsync.mockRejectedValue(new Error('disk i/o'));
      await expect(kvStorage.removeItem('any')).resolves.toBeUndefined();
    });
  });
});

describe('kvStorage adapters (db unavailable → in-memory fallback)', () => {
  beforeEach(() => {
    __setDbForTests(null);
    kvFallback.clear();
  });

  it('sync adapter round-trips values via the kvFallback Map', () => {
    kvStorageSync.setItem('alpha', 'one');
    kvStorageSync.setItem('beta', 'two');
    expect(kvStorageSync.getItem('alpha')).toBe('one');
    expect(kvStorageSync.getItem('beta')).toBe('two');
  });

  it('async adapter round-trips values via the same kvFallback Map', async () => {
    await kvStorage.setItem('alpha', 'one');
    await expect(kvStorage.getItem('alpha')).resolves.toBe('one');
    // Written by the async adapter, readable by the sync adapter (shared Map).
    expect(kvStorageSync.getItem('alpha')).toBe('one');
  });

  it('returns null for keys never set', async () => {
    expect(kvStorageSync.getItem('never-set')).toBeNull();
    await expect(kvStorage.getItem('never-set')).resolves.toBeNull();
  });

  it('removeItem deletes from the fallback Map', async () => {
    await kvStorage.setItem('gamma', 'three');
    await kvStorage.removeItem('gamma');
    await expect(kvStorage.getItem('gamma')).resolves.toBeNull();
  });

  it('clearKvStorage empties the fallback Map', () => {
    kvStorageSync.setItem('delta', 'four');
    kvStorageSync.setItem('epsilon', 'five');
    clearKvStorage();
    expect(kvStorageSync.getItem('delta')).toBeNull();
    expect(kvStorageSync.getItem('epsilon')).toBeNull();
  });
});
