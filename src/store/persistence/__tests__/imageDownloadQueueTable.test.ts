/**
 * `imageDownloadQueueTable` against REAL SQL: the enqueue that dedupes on the
 * primary key, the status transitions, the cycle-scoped resets, and the two
 * degraded modes every function in the module has to survive — no db handle at
 * all, and a handle that throws on every call.
 *
 * Runs against the generated schema (`src/db/normalizedDdl.ts`, created at import
 * by `persistence/db.ts`) on the better-sqlite3-backed op-SQLite substitute. The enqueue
 * is the reason this suite has to: it is one `INSERT OR IGNORE … SELECT … FROM
 * json_each(?)`, so `json_each`, the PK conflict and the `changes` it returns are
 * all engine behaviour — and that count is the image-refresh banner's
 * denominator, so it has to be exact.
 */
import { __setDbForTests, getDb, type InternalDb } from '../db';
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

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite substitute failed to open');
const realDb: InternalDb = handle;

interface RawRow {
  cover_art_id: string;
  scope: string;
  status: string;
  error: string | null;
  attempts: number;
  added_at: number;
  cycle_id: string;
}

const allRows = (): RawRow[] =>
  realDb.getAllSync<RawRow>('SELECT * FROM image_download_queue ORDER BY cover_art_id;');

const rowFor = (coverArtId: string): RawRow | undefined =>
  realDb.getFirstSync<RawRow>('SELECT * FROM image_download_queue WHERE cover_art_id = ?;', [
    coverArtId,
  ]);

/** Single-id enqueue helper — `enqueueImagesBulk` is the only live enqueue API. */
const enqueue = (
  id: string,
  scope: Parameters<typeof enqueueImagesBulk>[1],
  cycle: string,
  t?: number,
): Promise<number> => enqueueImagesBulk([id], scope, cycle, t);

beforeEach(() => {
  __setDbForTests(realDb);
  realDb.runSync('DELETE FROM image_download_queue;');
});

afterEach(() => {
  __setDbForTests(realDb);
});

describe('enqueueImagesBulk', () => {
  it('inserts one row per id and returns that exact count', async () => {
    const inserted = await enqueueImagesBulk(
      ['cov-1', 'cov-2', 'cov-3'],
      'refresh-all',
      'cycle-A',
      1_700,
    );
    expect(inserted).toBe(3);
    expect(allRows().map((r) => r.cover_art_id)).toEqual(['cov-1', 'cov-2', 'cov-3']);
  });

  it('writes the full row shape — queued, no error, zero attempts', async () => {
    await enqueueImagesBulk(['cov-1'], 'refresh-downloads', 'cycle-A', 4_242);
    expect(rowFor('cov-1')).toEqual({
      cover_art_id: 'cov-1',
      scope: 'refresh-downloads',
      status: 'queued',
      error: null,
      attempts: 0,
      added_at: 4_242,
      cycle_id: 'cycle-A',
    });
  });

  it('counts only the ids that actually landed when some are already queued', async () => {
    await enqueueImagesBulk(['cov-1'], 'refresh-downloads', 'cycle-A', 100);
    const inserted = await enqueueImagesBulk(
      ['cov-1', 'cov-2', 'cov-3'],
      'refresh-all',
      'cycle-B',
      200,
    );
    expect(inserted).toBe(2);
    expect(allRows()).toHaveLength(3);
    // The pre-existing row keeps its original cycle — dedupe is a skip, not an update.
    expect(rowFor('cov-1')?.cycle_id).toBe('cycle-A');
    expect(rowFor('cov-1')?.scope).toBe('refresh-downloads');
  });

  it('collapses duplicates WITHIN one call — the count matches the rows written', async () => {
    const inserted = await enqueueImagesBulk(
      ['cov-1', 'cov-2', 'cov-1', 'cov-2', 'cov-1'],
      'refresh-all',
      'cycle-A',
      100,
    );
    expect(inserted).toBe(2);
    expect(allRows()).toHaveLength(2);
  });

  it('handles a batch far past the SQLite bound-variable ceiling', async () => {
    const ids = Array.from({ length: 5_000 }, (_, i) => `cov-${i}`);
    expect(await enqueueImagesBulk(ids, 'refresh-all', 'cycle-A', 100)).toBe(5_000);
    expect(await countImageQueueRowsByCycle('cycle-A')).toBe(5_000);
  });

  it('is a no-op on empty input and writes nothing', async () => {
    expect(await enqueueImagesBulk([], 'refresh-all', 'cycle-A')).toBe(0);
    expect(allRows()).toHaveLength(0);
  });
});

describe('pickNextQueuedImageRow', () => {
  it('returns the oldest queued row, fully mapped', async () => {
    await enqueue('cov-a', 'refresh-all', 'cycle-A', 100);
    await enqueue('cov-b', 'refresh-downloads', 'cycle-B', 200);
    await markImageDownloading('cov-a');
    expect(await pickNextQueuedImageRow()).toEqual({
      coverArtId: 'cov-b',
      scope: 'refresh-downloads',
      status: 'queued',
      attempts: 0,
      addedAt: 200,
      cycleId: 'cycle-B',
    });
  });

  it('ignores downloading and error rows', async () => {
    await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
    await enqueue('cov-2', 'refresh-all', 'cycle-A', 200);
    await markImageDownloading('cov-1');
    await markImageError('cov-2', 'boom');
    expect(await pickNextQueuedImageRow()).toBeNull();
  });

  it('returns null when queue is empty', async () => {
    expect(await pickNextQueuedImageRow()).toBeNull();
  });
});

describe('markImageDownloading / markImageError', () => {
  it('flips status from queued to downloading', async () => {
    await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
    await markImageDownloading('cov-1');
    expect(rowFor('cov-1')?.status).toBe('downloading');
  });

  it('flips status to error, sets error string, increments attempts', async () => {
    await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
    await markImageError('cov-1', 'boom');
    expect(rowFor('cov-1')).toMatchObject({ status: 'error', error: 'boom', attempts: 1 });
  });

  it('error -> downloading clears the error string (re-attempt path)', async () => {
    await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
    await markImageError('cov-1', 'first try');
    await markImageDownloading('cov-1');
    expect(rowFor('cov-1')).toMatchObject({ status: 'downloading', error: null });
  });

  it('an unknown id updates nothing and creates nothing', async () => {
    await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
    await markImageDownloading('ghost');
    await markImageError('ghost', 'boom');
    expect(allRows()).toHaveLength(1);
    expect(rowFor('cov-1')?.status).toBe('queued');
  });
});

describe('removeImageFromQueue', () => {
  it('deletes the row on success', async () => {
    await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
    await enqueue('cov-2', 'refresh-all', 'cycle-A', 200);
    await removeImageFromQueue('cov-1');
    expect(allRows().map((r) => r.cover_art_id)).toEqual(['cov-2']);
  });

  it('is a no-op for an id that is not queued', async () => {
    await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
    await removeImageFromQueue('ghost');
    expect(allRows()).toHaveLength(1);
  });
});

describe('clearImageQueueByCycle (Cancel)', () => {
  it("drops only the named cycle's rows", async () => {
    await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
    await enqueue('cov-2', 'refresh-all', 'cycle-A', 200);
    await enqueue('cov-3', 'refresh-downloads', 'cycle-B', 300);
    expect(await clearImageQueueByCycle('cycle-A')).toBe(2);
    expect(allRows().map((r) => r.cover_art_id)).toEqual(['cov-3']);
  });

  it('returns 0 for a cycle with no rows', async () => {
    expect(await clearImageQueueByCycle('cycle-X')).toBe(0);
  });
});

describe('resetStalledImageRows (boot recovery)', () => {
  it('resets both downloading and error rows back to queued', async () => {
    await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
    await enqueue('cov-2', 'refresh-all', 'cycle-A', 200);
    await enqueue('cov-3', 'refresh-all', 'cycle-A', 300);
    await markImageDownloading('cov-1');
    await markImageError('cov-2', 'stale');
    expect(await resetStalledImageRows()).toBe(2);
    // A dead 'downloading' row spent an attempt; an errored one already
    // counted its own, and the reset deliberately leaves that alone.
    expect(rowFor('cov-1')).toMatchObject({ status: 'queued', attempts: 1 });
    expect(rowFor('cov-2')).toMatchObject({ status: 'queued', error: null, attempts: 1 });
    expect(rowFor('cov-3')).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('is idempotent — running again on a quiet queue is a no-op', async () => {
    await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
    expect(await resetStalledImageRows()).toBe(0);
    expect(rowFor('cov-1')?.attempts).toBe(0);
  });
});

describe('resetErrorRowsForCycle (Retry failed)', () => {
  it("only resets the cycle's error rows", async () => {
    await enqueue('cov-1', 'refresh-all', 'cycle-A', 100);
    await enqueue('cov-2', 'refresh-all', 'cycle-B', 200);
    await enqueue('cov-3', 'refresh-all', 'cycle-A', 300);
    await markImageError('cov-1', 'fail-A');
    await markImageError('cov-2', 'fail-B');
    expect(await resetErrorRowsForCycle('cycle-A')).toBe(1);
    // Retry is a clean slate, unlike boot recovery: attempts go back to 0.
    expect(rowFor('cov-1')).toMatchObject({ status: 'queued', error: null, attempts: 0 });
    expect(rowFor('cov-2')).toMatchObject({ status: 'error', error: 'fail-B' });
    expect(rowFor('cov-3')?.status).toBe('queued');
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

/* ------------------------------------------------------------------ */
/*  Degraded modes                                                     */
/* ------------------------------------------------------------------ */

/**
 * Reads return their safe default and writes resolve; nothing throws out of the
 * module. Run twice — once with no handle, once with a handle whose every method
 * throws or rejects.
 */
function describeDegraded(label: string, install: () => void): void {
  describe(label, () => {
    beforeEach(install);

    it('every read returns a safe default', async () => {
      expect(await pickNextQueuedImageRow()).toBeNull();
      expect(await countImageQueueRowsByStatus('queued')).toBe(0);
      expect(await countImageQueueRowsByCycle('cycle-A')).toBe(0);
    });

    it('every write resolves, reporting that nothing changed', async () => {
      expect(await enqueueImagesBulk(['cov-1'], 'refresh-all', 'cycle-A')).toBe(0);
      expect(await clearImageQueueByCycle('cycle-A')).toBe(0);
      expect(await resetStalledImageRows()).toBe(0);
      expect(await resetErrorRowsForCycle('cycle-A')).toBe(0);
      await expect(markImageDownloading('x')).resolves.toBeUndefined();
      await expect(markImageError('x', 'e')).resolves.toBeUndefined();
      await expect(removeImageFromQueue('x')).resolves.toBeUndefined();
    });
  });
}

describeDegraded('no db handle', () => {
  __setDbForTests(null);
});

describeDegraded('db throws on every call', () => {
  const boom = (): never => {
    throw new Error('boom');
  };
  const rejects = (): Promise<never> => Promise.reject(new Error('boom'));
  __setDbForTests({
    getFirstSync: boom,
    getAllSync: boom,
    runSync: boom,
    execSync: boom,
    withTransactionSync: boom,
    getFirstAsync: rejects,
    getAllAsync: rejects,
    runAsync: rejects,
    runBatchAsync: rejects,
    runAtomicBatchAsync: rejects,
  } as unknown as InternalDb);
});
