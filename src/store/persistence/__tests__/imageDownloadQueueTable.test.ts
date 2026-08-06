// Mock expo-sqlite with a minimal no-op DB so `persistence/db.ts`'s
// module-scope init succeeds on import. Individual tests override the
// shared handle via `db.__setDbForTests` with a richer fake.
jest.mock('expo-sqlite', () => ({
  openDatabaseSync: () => ({
    getFirstSync: () => undefined,
    getAllSync: () => [],
    runSync: () => ({ changes: 0 }),
    execSync: () => {},
    withTransactionSync: (fn: () => void) => fn(),
  }),
}));

import { __setDbForTests } from '../db';
import {
  clearImageQueueByCycle,
  countImageQueueRowsByCycle,
  countImageQueueRowsByStatus,
  enqueueImagesBulk,
  markImageDownloading,
  markImageError,
  pickNextQueuedImageRow,
  removeImageFromQueue,
  resetErrorRowsForCycle,
  resetStalledImageRows,
} from '../imageDownloadQueueTable';

/**
 * Single-id enqueue helper (the production single-row `enqueueImage` was removed;
 * `enqueueImagesBulk` is the live enqueue API). Used as test setup only.
 */
const enqueue = (
  id: string,
  scope: Parameters<typeof enqueueImagesBulk>[1],
  cycle: string,
  t?: number,
): Promise<number> => enqueueImagesBulk([id], scope, cycle, t);

interface FakeRow {
  cover_art_id: string;
  scope: string;
  status: string;
  error: string | null;
  attempts: number;
  added_at: number;
  cycle_id: string;
}

function makeFakeDb() {
  const rows = new Map<string, FakeRow>();

  const runSync = (rawSql: string, params: readonly unknown[] = []): { changes: number } => {
    const s = rawSql.replace(/\s+/g, ' ').trim();

    // Set-based enqueue: `SELECT value, ?, 'queued', NULL, 0, ?, ? FROM json_each(?)`,
    // so the ids arrive as a JSON array in the LAST bind, not one row per call.
    if (s.startsWith('INSERT OR IGNORE INTO image_download_queue')) {
      const [scope, addedAt, cycleId, idsJson] = params as [string, number, string, string];
      let changes = 0;
      for (const coverArtId of JSON.parse(idsJson) as string[]) {
        if (rows.has(coverArtId)) continue;
        rows.set(coverArtId, {
          cover_art_id: coverArtId,
          scope,
          status: 'queued',
          error: null,
          attempts: 0,
          added_at: addedAt,
          cycle_id: cycleId,
        });
        changes++;
      }
      return { changes };
    }

    if (s.startsWith("UPDATE image_download_queue SET status = 'downloading'")) {
      const [coverArtId] = params as [string];
      const row = rows.get(coverArtId);
      if (!row) return { changes: 0 };
      row.status = 'downloading';
      row.error = null;
      return { changes: 1 };
    }

    if (s.startsWith("UPDATE image_download_queue SET status = 'error'")) {
      const [error, coverArtId] = params as [string, string];
      const row = rows.get(coverArtId);
      if (!row) return { changes: 0 };
      row.status = 'error';
      row.error = error;
      row.attempts += 1;
      return { changes: 1 };
    }

    if (
      s.startsWith("UPDATE image_download_queue SET status = 'queued', attempts = attempts + 1 WHERE status = 'downloading'")
    ) {
      let changes = 0;
      for (const row of rows.values()) {
        if (row.status === 'downloading') {
          row.status = 'queued';
          row.attempts += 1;
          changes++;
        }
      }
      return { changes };
    }

    if (
      s.startsWith("UPDATE image_download_queue SET status = 'queued', error = NULL WHERE status = 'error' AND cycle_id = ?")
    ) {
      // Older patterns first to disambiguate — the cycle-scoped reset comes
      // via resetErrorRowsForCycle (uses attempts = 0).
      return { changes: 0 };
    }

    if (
      s.startsWith("UPDATE image_download_queue SET status = 'queued', error = NULL WHERE status = 'error'")
      && !s.includes('cycle_id')
    ) {
      let changes = 0;
      for (const row of rows.values()) {
        if (row.status === 'error') {
          row.status = 'queued';
          row.error = null;
          changes++;
        }
      }
      return { changes };
    }

    if (
      s.startsWith("UPDATE image_download_queue SET status = 'queued', error = NULL, attempts = 0 WHERE status = 'error' AND cycle_id = ?")
    ) {
      const [cycleId] = params as [string];
      let changes = 0;
      for (const row of rows.values()) {
        if (row.status === 'error' && row.cycle_id === cycleId) {
          row.status = 'queued';
          row.error = null;
          row.attempts = 0;
          changes++;
        }
      }
      return { changes };
    }

    if (s.startsWith('DELETE FROM image_download_queue WHERE cover_art_id = ?')) {
      const [coverArtId] = params as [string];
      return { changes: rows.delete(coverArtId) ? 1 : 0 };
    }

    if (s.startsWith('DELETE FROM image_download_queue WHERE cycle_id = ?')) {
      const [cycleId] = params as [string];
      let changes = 0;
      for (const [id, row] of rows) {
        if (row.cycle_id === cycleId) {
          rows.delete(id);
          changes++;
        }
      }
      return { changes };
    }

    if (s === 'DELETE FROM image_download_queue;') {
      const c = rows.size;
      rows.clear();
      return { changes: c };
    }

    return { changes: 0 };
  };

  const getFirstSync = (rawSql: string, params: readonly unknown[] = []) => {
    const s = rawSql.replace(/\s+/g, ' ').trim();
    if (s.startsWith("SELECT COUNT(*) AS c FROM image_download_queue WHERE status = ?")) {
      const [status] = params as [string];
      let c = 0;
      for (const row of rows.values()) if (row.status === status) c++;
      return { c };
    }
    if (s.startsWith("SELECT COUNT(*) AS c FROM image_download_queue WHERE cycle_id = ?")) {
      const [cycleId] = params as [string];
      let c = 0;
      for (const row of rows.values()) if (row.cycle_id === cycleId) c++;
      return { c };
    }
    if (s.startsWith('SELECT cover_art_id, scope, status, error, attempts, added_at, cycle_id FROM image_download_queue WHERE status = \'queued\'')) {
      const arr = [...rows.values()]
        .filter((r) => r.status === 'queued')
        .sort((a, b) => a.added_at - b.added_at);
      return arr[0];
    }
    return undefined;
  };

  const getAllSync = (rawSql: string) => {
    const s = rawSql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT cover_art_id, scope, status, error, attempts, added_at, cycle_id FROM image_download_queue ORDER BY added_at ASC')) {
      return [...rows.values()].sort((a, b) => a.added_at - b.added_at);
    }
    return [];
  };

  const withTransactionSync = (fn: () => void): void => fn();
  const execSync = (): void => {};

  // Async delegates — the production module now uses the async DB API. Each
  // delegates to the sync in-memory impl so the fake stays a single source of
  // truth.
  return {
    runSync,
    getFirstSync,
    getAllSync,
    withTransactionSync,
    execSync,
    runAsync: (sql: string, params?: readonly unknown[]) => Promise.resolve(runSync(sql, params)),
    getFirstAsync: (sql: string, params?: readonly unknown[]) =>
      Promise.resolve(getFirstSync(sql, params)),
    getAllAsync: (sql: string) => Promise.resolve(getAllSync(sql)),
    _rows: rows,
  };
}

let fake: ReturnType<typeof makeFakeDb>;

beforeEach(() => {
  fake = makeFakeDb();
  __setDbForTests(fake as any);
});

afterEach(() => {
  __setDbForTests(null);
});

describe('imageDownloadQueueTable', () => {
  describe('enqueueImagesBulk', () => {
    it('inserts every new id and dedups duplicates', async () => {
      await enqueue('cov-1', 'refresh-downloads', 'cycle-A', 100);
      const inserted = await enqueueImagesBulk(
        ['cov-1', 'cov-2', 'cov-3'],
        'refresh-all',
        'cycle-B',
        200,
      );
      expect(inserted).toBe(2); // cov-1 was already there
      expect(fake._rows.size).toBe(3);
    });

    it('is a no-op on empty input', async () => {
      expect(await enqueueImagesBulk([], 'refresh-all', 'cycle-X')).toBe(0);
    });
  });

  describe('pickNextQueuedImageRow', () => {
    it('returns the oldest queued row', async () => {
      await enqueue('cov-a', 'refresh-all', 'cycle-A', 100);
      await enqueue('cov-b', 'refresh-all', 'cycle-A', 200);
      // Mark first as downloading so it's no longer 'queued'
      await markImageDownloading('cov-a');
      const next = await pickNextQueuedImageRow();
      expect(next?.coverArtId).toBe('cov-b');
    });

    it('returns null when queue is empty', async () => {
      expect(await pickNextQueuedImageRow()).toBeNull();
    });
  });

  describe('markImageDownloading / markImageError', () => {
    it('flips status from queued to downloading', async () => {
      await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
      await markImageDownloading('cov-1');
      expect(fake._rows.get('cov-1')?.status).toBe('downloading');
    });

    it('flips status to error, sets error string, increments attempts', async () => {
      await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
      await markImageError('cov-1', 'boom');
      const row = fake._rows.get('cov-1')!;
      expect(row.status).toBe('error');
      expect(row.error).toBe('boom');
      expect(row.attempts).toBe(1);
    });

    it('error -> downloading clears the error string (re-attempt path)', async () => {
      await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
      await markImageError('cov-1', 'first try');
      await markImageDownloading('cov-1');
      const row = fake._rows.get('cov-1')!;
      expect(row.status).toBe('downloading');
      expect(row.error).toBeNull();
    });
  });

  describe('removeImageFromQueue', () => {
    it('deletes the row on success', async () => {
      await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
      await removeImageFromQueue('cov-1');
      expect(fake._rows.has('cov-1')).toBe(false);
    });
  });

  describe('clearImageQueueByCycle (Cancel)', () => {
    it('drops only the named cycle\'s rows', async () => {
      await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
      await enqueue('cov-2', 'refresh-all', 'cycle-A', 200);
      await enqueue('cov-3', 'refresh-downloads', 'cycle-B', 300);
      const removed = await clearImageQueueByCycle('cycle-A');
      expect(removed).toBe(2);
      expect(fake._rows.has('cov-1')).toBe(false);
      expect(fake._rows.has('cov-2')).toBe(false);
      expect(fake._rows.has('cov-3')).toBe(true);
    });
  });

  describe('resetStalledImageRows (boot recovery)', () => {
    it('resets both downloading and error rows back to queued', async () => {
      await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
      await enqueue('cov-2', 'refresh-all', 'cycle-A', 200);
      await enqueue('cov-3', 'refresh-all', 'cycle-A', 300);
      await markImageDownloading('cov-1');
      await markImageError('cov-2', 'stale');
      const reset = await resetStalledImageRows();
      expect(reset).toBe(2);
      expect(fake._rows.get('cov-1')?.status).toBe('queued');
      expect(fake._rows.get('cov-1')?.attempts).toBe(1); // downloading-attempt counts
      expect(fake._rows.get('cov-2')?.status).toBe('queued');
      expect(fake._rows.get('cov-2')?.error).toBeNull();
      // cov-3 stays queued, untouched
      expect(fake._rows.get('cov-3')?.status).toBe('queued');
    });

    it('is idempotent — running again on a quiet queue is a no-op', async () => {
      await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
      expect(await resetStalledImageRows()).toBe(0);
      expect(fake._rows.get('cov-1')?.attempts).toBe(0);
    });
  });

  describe('resetErrorRowsForCycle (Retry failed)', () => {
    it('only resets the cycle\'s error rows', async () => {
      await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
      await enqueue('cov-2', 'refresh-all', 'cycle-B', 200);
      await markImageError('cov-1', 'fail-A');
      await markImageError('cov-2', 'fail-B');
      const reset = await resetErrorRowsForCycle('cycle-A');
      expect(reset).toBe(1);
      expect(fake._rows.get('cov-1')?.status).toBe('queued');
      expect(fake._rows.get('cov-1')?.attempts).toBe(0); // reset
      expect(fake._rows.get('cov-2')?.status).toBe('error'); // untouched
    });
  });

  describe('counts', () => {
    it('counts by status', async () => {
      await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
      await enqueue('cov-2', 'refresh-all', 'cycle-A', 200);
      await enqueue('cov-3', 'refresh-all', 'cycle-A', 300);
      await markImageDownloading('cov-1');
      await markImageError('cov-2', 'oops');
      expect(await countImageQueueRowsByStatus('queued')).toBe(1);
      expect(await countImageQueueRowsByStatus('downloading')).toBe(1);
      expect(await countImageQueueRowsByStatus('error')).toBe(1);
    });

    it('counts by cycle', async () => {
      await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
      await enqueue('cov-2', 'refresh-all', 'cycle-A', 200);
      await enqueue('cov-3', 'refresh-downloads', 'cycle-B', 300);
      expect(await countImageQueueRowsByCycle('cycle-A')).toBe(2);
      expect(await countImageQueueRowsByCycle('cycle-B')).toBe(1);
      expect(await countImageQueueRowsByCycle('cycle-X')).toBe(0);
    });
  });

  describe('safe-default behaviour when db is null', () => {
    beforeEach(() => {
      __setDbForTests(null);
    });

    it('reads return safe defaults', async () => {
      expect(await pickNextQueuedImageRow()).toBeNull();
      expect(await countImageQueueRowsByStatus('queued')).toBe(0);
      expect(await countImageQueueRowsByCycle('cycle-A')).toBe(0);
    });

    it('writes silently no-op', async () => {
      expect(await enqueueImagesBulk(['cov-1'], 'refresh-all', 'cycle-A')).toBe(0);
      expect(await clearImageQueueByCycle('cycle-A')).toBe(0);
      expect(await resetStalledImageRows()).toBe(0);
      expect(await resetErrorRowsForCycle('cycle-A')).toBe(0);
      // No throws; markImageDownloading/Error and removeImageFromQueue
      // resolve to void but must not reject either.
      await expect(markImageDownloading('x')).resolves.toBeUndefined();
      await expect(markImageError('x', 'e')).resolves.toBeUndefined();
      await expect(removeImageFromQueue('x')).resolves.toBeUndefined();
    });
  });
});
