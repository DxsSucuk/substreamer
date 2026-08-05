/**
 * `enqueueImagesBulk` against REAL SQL.
 *
 * A sibling of `imageDownloadQueueTable.test.ts` rather than part of it: that
 * suite drives a hand-rolled string-matching fake, which cannot evaluate
 * `json_each` or the PRIMARY KEY that `INSERT OR IGNORE` dedupes against — and
 * the returned count is the image-refresh banner's denominator, so it has to be
 * exact. This suite runs against the generated schema (`src/db/normalizedDdl.ts`,
 * created at import by `persistence/db.ts`) on the better-sqlite3-backed
 * op-SQLite seam.
 */
import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  countImageQueueRowsByCycle,
  enqueueImagesBulk,
  type ImageDownloadQueueRow,
} from '../imageDownloadQueueTable';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
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

beforeEach(() => {
  __setDbForTests(realDb);
  realDb.runSync('DELETE FROM image_download_queue;');
});

afterEach(() => {
  __setDbForTests(realDb);
});

describe('enqueueImagesBulk (real SQL)', () => {
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

  it('returns 0 without a db handle', async () => {
    __setDbForTests(null);
    expect(await enqueueImagesBulk(['cov-1'], 'refresh-all', 'cycle-A')).toBe(0);
  });

  it('returns 0 rather than throwing when the statement fails', async () => {
    // `scope` is NOT NULL — force a constraint failure through the real engine.
    const broken: InternalDb = {
      ...realDb,
      runAsync: (sql: string, params?: readonly unknown[]) =>
        realDb.runAsync(sql, params ? [null, ...params.slice(1)] : params),
    };
    __setDbForTests(broken);
    expect(
      await enqueueImagesBulk(['cov-1'], 'refresh-all' as ImageDownloadQueueRow['scope'], 'cycle-A'),
    ).toBe(0);
    __setDbForTests(realDb);
    expect(allRows()).toHaveLength(0);
  });
});
