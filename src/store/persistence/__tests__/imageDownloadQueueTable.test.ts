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
  clearImageDownloadQueue,
  clearImageQueueByCycle,
  countImageQueueRowsByCycle,
  countImageQueueRowsByStatus,
  enqueueImage,
  enqueueImagesBulk,
  hydrateImageDownloadQueue,
  markImageDownloading,
  markImageError,
  pickNextQueuedImageRow,
  removeImageFromQueue,
  resetErrorRowsForCycle,
  resetStalledImageRows,
} from '../imageDownloadQueueTable';

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

    if (s.startsWith('INSERT OR IGNORE INTO image_download_queue')) {
      const [coverArtId, scope, addedAt, cycleId] = params as [
        string,
        string,
        number,
        string,
      ];
      if (rows.has(coverArtId)) return { changes: 0 };
      rows.set(coverArtId, {
        cover_art_id: coverArtId,
        scope,
        status: 'queued',
        error: null,
        attempts: 0,
        added_at: addedAt,
        cycle_id: cycleId,
      });
      return { changes: 1 };
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

  return {
    runSync,
    getFirstSync,
    getAllSync,
    withTransactionSync,
    execSync,
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
  describe('enqueueImage', () => {
    it('inserts a new row and returns true', () => {
      const inserted = enqueueImage('cov-1', 'refresh-downloads', 'cycle-A', 1000);
      expect(inserted).toBe(true);
      expect(fake._rows.get('cov-1')).toEqual({
        cover_art_id: 'cov-1',
        scope: 'refresh-downloads',
        status: 'queued',
        error: null,
        attempts: 0,
        added_at: 1000,
        cycle_id: 'cycle-A',
      });
    });

    it('returns false on PK conflict (dedup)', () => {
      enqueueImage('cov-1', 'refresh-downloads', 'cycle-A', 1000);
      const second = enqueueImage('cov-1', 'refresh-all', 'cycle-B', 2000);
      expect(second).toBe(false);
      // Original row preserved
      expect(fake._rows.get('cov-1')?.scope).toBe('refresh-downloads');
      expect(fake._rows.get('cov-1')?.cycle_id).toBe('cycle-A');
    });
  });

  describe('enqueueImagesBulk', () => {
    it('inserts every new id and dedups duplicates', () => {
      enqueueImage('cov-1', 'refresh-downloads', 'cycle-A', 100);
      const inserted = enqueueImagesBulk(
        ['cov-1', 'cov-2', 'cov-3'],
        'refresh-all',
        'cycle-B',
        200,
      );
      expect(inserted).toBe(2); // cov-1 was already there
      expect(fake._rows.size).toBe(3);
    });

    it('is a no-op on empty input', () => {
      expect(enqueueImagesBulk([], 'refresh-all', 'cycle-X')).toBe(0);
    });
  });

  describe('hydrateImageDownloadQueue', () => {
    it('returns rows ordered by added_at ascending', () => {
      enqueueImage('cov-c', 'refresh-all', 'cycle-A', 300);
      enqueueImage('cov-a', 'refresh-all', 'cycle-A', 100);
      enqueueImage('cov-b', 'refresh-all', 'cycle-A', 200);
      const rows = hydrateImageDownloadQueue();
      expect(rows.map((r) => r.coverArtId)).toEqual(['cov-a', 'cov-b', 'cov-c']);
    });

    it('maps optional error to undefined when null', () => {
      enqueueImage('cov-1', 'refresh-all', 'cycle-A', 100);
      const [row] = hydrateImageDownloadQueue();
      expect(row.error).toBeUndefined();
    });
  });

  describe('pickNextQueuedImageRow', () => {
    it('returns the oldest queued row', () => {
      enqueueImage('cov-a', 'refresh-all', 'cycle-A', 100);
      enqueueImage('cov-b', 'refresh-all', 'cycle-A', 200);
      // Mark first as downloading so it's no longer 'queued'
      markImageDownloading('cov-a');
      const next = pickNextQueuedImageRow();
      expect(next?.coverArtId).toBe('cov-b');
    });

    it('returns null when queue is empty', () => {
      expect(pickNextQueuedImageRow()).toBeNull();
    });
  });

  describe('markImageDownloading / markImageError', () => {
    it('flips status from queued to downloading', () => {
      enqueueImage('cov-1', 'refresh-all', 'cycle-A', 100);
      markImageDownloading('cov-1');
      expect(fake._rows.get('cov-1')?.status).toBe('downloading');
    });

    it('flips status to error, sets error string, increments attempts', () => {
      enqueueImage('cov-1', 'refresh-all', 'cycle-A', 100);
      markImageError('cov-1', 'boom');
      const row = fake._rows.get('cov-1')!;
      expect(row.status).toBe('error');
      expect(row.error).toBe('boom');
      expect(row.attempts).toBe(1);
    });

    it('error -> downloading clears the error string (re-attempt path)', () => {
      enqueueImage('cov-1', 'refresh-all', 'cycle-A', 100);
      markImageError('cov-1', 'first try');
      markImageDownloading('cov-1');
      const row = fake._rows.get('cov-1')!;
      expect(row.status).toBe('downloading');
      expect(row.error).toBeNull();
    });
  });

  describe('removeImageFromQueue', () => {
    it('deletes the row on success', () => {
      enqueueImage('cov-1', 'refresh-all', 'cycle-A', 100);
      removeImageFromQueue('cov-1');
      expect(fake._rows.has('cov-1')).toBe(false);
    });
  });

  describe('clearImageQueueByCycle (Cancel)', () => {
    it('drops only the named cycle\'s rows', () => {
      enqueueImage('cov-1', 'refresh-all', 'cycle-A', 100);
      enqueueImage('cov-2', 'refresh-all', 'cycle-A', 200);
      enqueueImage('cov-3', 'refresh-downloads', 'cycle-B', 300);
      const removed = clearImageQueueByCycle('cycle-A');
      expect(removed).toBe(2);
      expect(fake._rows.has('cov-1')).toBe(false);
      expect(fake._rows.has('cov-2')).toBe(false);
      expect(fake._rows.has('cov-3')).toBe(true);
    });
  });

  describe('resetStalledImageRows (boot recovery)', () => {
    it('resets both downloading and error rows back to queued', () => {
      enqueueImage('cov-1', 'refresh-all', 'cycle-A', 100);
      enqueueImage('cov-2', 'refresh-all', 'cycle-A', 200);
      enqueueImage('cov-3', 'refresh-all', 'cycle-A', 300);
      markImageDownloading('cov-1');
      markImageError('cov-2', 'stale');
      const reset = resetStalledImageRows();
      expect(reset).toBe(2);
      expect(fake._rows.get('cov-1')?.status).toBe('queued');
      expect(fake._rows.get('cov-1')?.attempts).toBe(1); // downloading-attempt counts
      expect(fake._rows.get('cov-2')?.status).toBe('queued');
      expect(fake._rows.get('cov-2')?.error).toBeNull();
      // cov-3 stays queued, untouched
      expect(fake._rows.get('cov-3')?.status).toBe('queued');
    });

    it('is idempotent — running again on a quiet queue is a no-op', () => {
      enqueueImage('cov-1', 'refresh-all', 'cycle-A', 100);
      expect(resetStalledImageRows()).toBe(0);
      expect(fake._rows.get('cov-1')?.attempts).toBe(0);
    });
  });

  describe('resetErrorRowsForCycle (Retry failed)', () => {
    it('only resets the cycle\'s error rows', () => {
      enqueueImage('cov-1', 'refresh-all', 'cycle-A', 100);
      enqueueImage('cov-2', 'refresh-all', 'cycle-B', 200);
      markImageError('cov-1', 'fail-A');
      markImageError('cov-2', 'fail-B');
      const reset = resetErrorRowsForCycle('cycle-A');
      expect(reset).toBe(1);
      expect(fake._rows.get('cov-1')?.status).toBe('queued');
      expect(fake._rows.get('cov-1')?.attempts).toBe(0); // reset
      expect(fake._rows.get('cov-2')?.status).toBe('error'); // untouched
    });
  });

  describe('counts', () => {
    it('counts by status', () => {
      enqueueImage('cov-1', 'refresh-all', 'cycle-A', 100);
      enqueueImage('cov-2', 'refresh-all', 'cycle-A', 200);
      enqueueImage('cov-3', 'refresh-all', 'cycle-A', 300);
      markImageDownloading('cov-1');
      markImageError('cov-2', 'oops');
      expect(countImageQueueRowsByStatus('queued')).toBe(1);
      expect(countImageQueueRowsByStatus('downloading')).toBe(1);
      expect(countImageQueueRowsByStatus('error')).toBe(1);
    });

    it('counts by cycle', () => {
      enqueueImage('cov-1', 'refresh-all', 'cycle-A', 100);
      enqueueImage('cov-2', 'refresh-all', 'cycle-A', 200);
      enqueueImage('cov-3', 'refresh-downloads', 'cycle-B', 300);
      expect(countImageQueueRowsByCycle('cycle-A')).toBe(2);
      expect(countImageQueueRowsByCycle('cycle-B')).toBe(1);
      expect(countImageQueueRowsByCycle('cycle-X')).toBe(0);
    });
  });

  describe('clearImageDownloadQueue (diagnostic)', () => {
    it('empties the table', () => {
      enqueueImage('cov-1', 'refresh-all', 'cycle-A', 100);
      enqueueImage('cov-2', 'refresh-all', 'cycle-A', 200);
      clearImageDownloadQueue();
      expect(fake._rows.size).toBe(0);
    });
  });

  describe('safe-default behaviour when db is null', () => {
    beforeEach(() => {
      __setDbForTests(null);
    });

    it('reads return safe defaults', () => {
      expect(hydrateImageDownloadQueue()).toEqual([]);
      expect(pickNextQueuedImageRow()).toBeNull();
      expect(countImageQueueRowsByStatus('queued')).toBe(0);
      expect(countImageQueueRowsByCycle('cycle-A')).toBe(0);
    });

    it('writes silently no-op', () => {
      expect(enqueueImage('cov-1', 'refresh-all', 'cycle-A')).toBe(false);
      expect(enqueueImagesBulk(['cov-1'], 'refresh-all', 'cycle-A')).toBe(0);
      expect(clearImageQueueByCycle('cycle-A')).toBe(0);
      expect(resetStalledImageRows()).toBe(0);
      expect(resetErrorRowsForCycle('cycle-A')).toBe(0);
      // No throws; markImageDownloading/Error and removeImageFromQueue/clearImageDownloadQueue
      // return void but must not throw either.
      expect(() => markImageDownloading('x')).not.toThrow();
      expect(() => markImageError('x', 'e')).not.toThrow();
      expect(() => removeImageFromQueue('x')).not.toThrow();
      expect(() => clearImageDownloadQueue()).not.toThrow();
    });
  });
});
