/**
 * `imageCacheTable` against REAL SQL: the row↔object mapping, the composite-key
 * upsert, the browser grouping, and the two degraded modes every function in the
 * module has to survive — no db handle at all, and a handle that throws on every
 * call.
 *
 * Runs against the generated schema (`src/db/normalizedDdl.ts`, created at import
 * by `persistence/db.ts`) on the better-sqlite3-backed op-SQLite substitute. Two things
 * the module owns are only expressible there: the `(cover_art_id, size)` primary
 * key the upsert conflicts on, and the `NOT IN (SELECT … FROM
 * image_download_queue)` filter that keeps an in-flight cover out of the
 * incomplete counts — both of which the previous hand-rolled fake emulated rather
 * than exercised, the queue join not at all.
 */
import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  bulkInsertCachedImages,
  clearAllCachedImages,
  countCachedImages,
  deleteCachedImageVariant,
  deleteCachedImagesForCoverArt,
  findIncompleteCovers,
  getAllCachedCoverArtIds,
  getCachedImagesForCoverArtAsync,
  hasCachedImage,
  hydrateImageCacheAggregatesAsync,
  listCachedImagesForBrowser,
  upsertCachedImage,
  type CachedImageRow,
} from '../imageCacheTable';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite substitute failed to open');
const realDb: InternalDb = handle;

function seedRow(overrides?: Partial<CachedImageRow>): CachedImageRow {
  return {
    coverArtId: 'cover-1',
    size: 300,
    ext: 'jpg',
    bytes: 5000,
    cachedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Put a cover in the download queue — the rows `findIncompleteCovers` excludes. */
function queueCover(coverArtId: string): void {
  realDb.runSync(
    `INSERT INTO image_download_queue
       (cover_art_id, scope, status, error, attempts, added_at, cycle_id)
       VALUES (?, 'refresh-all', 'queued', NULL, 0, 1, 'cycle-A');`,
    [coverArtId],
  );
}

beforeEach(() => {
  __setDbForTests(realDb);
  realDb.runSync('DELETE FROM cached_images;');
  realDb.runSync('DELETE FROM image_download_queue;');
});

afterEach(() => {
  __setDbForTests(realDb);
});

describe('imageCacheTable — upsertCachedImage', () => {
  it('inserts a row and makes it queryable', async () => {
    await upsertCachedImage(seedRow());
    expect(await countCachedImages()).toBe(1);
    expect(await hasCachedImage('cover-1', 300)).toBe(true);
    expect(await hasCachedImage('cover-1', 50)).toBe(false);
  });

  it('round-trips every column', async () => {
    await upsertCachedImage(seedRow({ ext: 'webp', bytes: 4242, cachedAt: 99 }));
    expect(await getCachedImagesForCoverArtAsync('cover-1')).toEqual([
      { coverArtId: 'cover-1', size: 300, ext: 'webp', bytes: 4242, cachedAt: 99 },
    ]);
  });

  it('conflicts on (cover_art_id, size) — a second write updates in place', async () => {
    await upsertCachedImage(seedRow({ bytes: 5000, cachedAt: 1000 }));
    await upsertCachedImage(seedRow({ bytes: 9999, cachedAt: 9999, ext: 'webp' }));
    expect(await countCachedImages()).toBe(1);
    expect(await getCachedImagesForCoverArtAsync('cover-1')).toEqual([
      { coverArtId: 'cover-1', size: 300, ext: 'webp', bytes: 9999, cachedAt: 9999 },
    ]);
  });

  it('treats a different size as a different row, not a conflict', async () => {
    await upsertCachedImage(seedRow({ size: 300 }));
    await upsertCachedImage(seedRow({ size: 600 }));
    expect(await countCachedImages()).toBe(2);
  });

  it('drops writes when coverArtId or size is missing', async () => {
    await upsertCachedImage(seedRow({ coverArtId: '' }));
    await upsertCachedImage(seedRow({ size: 0 }));
    expect(await countCachedImages()).toBe(0);
  });
});

describe('imageCacheTable — getCachedImagesForCoverArtAsync', () => {
  it('returns that cover only, size-ascending', async () => {
    await upsertCachedImage(seedRow({ coverArtId: 'a', size: 600 }));
    await upsertCachedImage(seedRow({ coverArtId: 'a', size: 50 }));
    await upsertCachedImage(seedRow({ coverArtId: 'a', size: 150 }));
    await upsertCachedImage(seedRow({ coverArtId: 'b', size: 300 }));
    expect((await getCachedImagesForCoverArtAsync('a')).map((r) => r.size)).toEqual([50, 150, 600]);
  });

  it('returns [] for a cover with no rows', async () => {
    expect(await getCachedImagesForCoverArtAsync('nobody')).toEqual([]);
  });
});

describe('imageCacheTable — hydrateImageCacheAggregatesAsync', () => {
  it('returns zeroed aggregates for an empty table', async () => {
    expect(await hydrateImageCacheAggregatesAsync()).toEqual({
      totalBytes: 0,
      fileCount: 0,
      imageCount: 0,
      incompleteCount: 0,
    });
  });

  it('sums bytes, counts variant files, and counts unique covers', async () => {
    await upsertCachedImage(seedRow({ coverArtId: 'a', size: 50, bytes: 100 }));
    await upsertCachedImage(seedRow({ coverArtId: 'a', size: 150, bytes: 200 }));
    await upsertCachedImage(seedRow({ coverArtId: 'a', size: 300, bytes: 300 }));
    await upsertCachedImage(seedRow({ coverArtId: 'a', size: 600, bytes: 400 }));
    await upsertCachedImage(seedRow({ coverArtId: 'b', size: 600, bytes: 999 }));
    expect(await hydrateImageCacheAggregatesAsync()).toEqual({
      totalBytes: 100 + 200 + 300 + 400 + 999,
      fileCount: 5,
      imageCount: 2,
      incompleteCount: 1, // 'b' has only size 600
    });
  });

  it('does not count a cover that is still in the download queue as incomplete', async () => {
    await upsertCachedImage(seedRow({ coverArtId: 'mid-refresh', size: 600, bytes: 10 }));
    queueCover('mid-refresh');
    expect(await hydrateImageCacheAggregatesAsync()).toEqual({
      totalBytes: 10,
      fileCount: 1,
      imageCount: 1,
      incompleteCount: 0,
    });
  });
});

describe('imageCacheTable — findIncompleteCovers', () => {
  beforeEach(async () => {
    await upsertCachedImage(seedRow({ coverArtId: 'complete', size: 50 }));
    await upsertCachedImage(seedRow({ coverArtId: 'complete', size: 150 }));
    await upsertCachedImage(seedRow({ coverArtId: 'complete', size: 300 }));
    await upsertCachedImage(seedRow({ coverArtId: 'complete', size: 600 }));
    await upsertCachedImage(seedRow({ coverArtId: 'partial', size: 300 }));
    await upsertCachedImage(seedRow({ coverArtId: 'source-only', size: 600 }));
  });

  it('lists only covers with < 4 variants, sorted', async () => {
    expect(await findIncompleteCovers()).toEqual(['partial', 'source-only']);
  });

  it('excludes a cover the refresh worker already holds in the queue', async () => {
    queueCover('partial');
    expect(await findIncompleteCovers()).toEqual(['source-only']);
  });
});

describe('imageCacheTable — getAllCachedCoverArtIds', () => {
  it('returns each cover once, whatever its variant count', async () => {
    await upsertCachedImage(seedRow({ coverArtId: 'b', size: 50 }));
    await upsertCachedImage(seedRow({ coverArtId: 'b', size: 600 }));
    await upsertCachedImage(seedRow({ coverArtId: 'a', size: 300 }));
    expect(await getAllCachedCoverArtIds()).toEqual(['a', 'b']);
  });

  it('returns [] on an empty cache', async () => {
    expect(await getAllCachedCoverArtIds()).toEqual([]);
  });

  it('ignores the download queue — every cached cover is re-downloadable', async () => {
    await upsertCachedImage(seedRow({ coverArtId: 'a', size: 300 }));
    queueCover('a');
    expect(await getAllCachedCoverArtIds()).toEqual(['a']);
  });
});

describe('imageCacheTable — deleteCachedImagesForCoverArt', () => {
  it('returns accurate freed bytes + count and removes every row', async () => {
    await upsertCachedImage(seedRow({ coverArtId: 'a', size: 50, bytes: 100 }));
    await upsertCachedImage(seedRow({ coverArtId: 'a', size: 300, bytes: 500 }));
    await upsertCachedImage(seedRow({ coverArtId: 'b', size: 300, bytes: 700 }));

    const freed = await deleteCachedImagesForCoverArt('a');
    expect(freed).toEqual({ bytes: 600, count: 2 });
    expect(await hasCachedImage('a', 50)).toBe(false);
    expect(await hasCachedImage('b', 300)).toBe(true);
  });

  it('returns zero freed when coverArtId has no rows', async () => {
    expect(await deleteCachedImagesForCoverArt('unknown')).toEqual({ bytes: 0, count: 0 });
  });

  it('refuses an empty coverArtId rather than matching a row', async () => {
    await upsertCachedImage(seedRow({ coverArtId: '', size: 300 }));
    expect(await deleteCachedImagesForCoverArt('')).toEqual({ bytes: 0, count: 0 });
  });
});

describe('imageCacheTable — deleteCachedImageVariant', () => {
  it('removes a single variant while leaving others intact', async () => {
    await upsertCachedImage(seedRow({ coverArtId: 'a', size: 300 }));
    await upsertCachedImage(seedRow({ coverArtId: 'a', size: 600 }));
    await deleteCachedImageVariant('a', 300);
    expect(await hasCachedImage('a', 300)).toBe(false);
    expect(await hasCachedImage('a', 600)).toBe(true);
  });
});

describe('imageCacheTable — clearAllCachedImages', () => {
  it('empties the table', async () => {
    await upsertCachedImage(seedRow({ coverArtId: 'a', size: 300 }));
    await upsertCachedImage(seedRow({ coverArtId: 'b', size: 600 }));
    await clearAllCachedImages();
    expect(await countCachedImages()).toBe(0);
  });
});

describe('imageCacheTable — listCachedImagesForBrowser', () => {
  beforeEach(async () => {
    await upsertCachedImage(seedRow({ coverArtId: 'complete', size: 50 }));
    await upsertCachedImage(seedRow({ coverArtId: 'complete', size: 150 }));
    await upsertCachedImage(seedRow({ coverArtId: 'complete', size: 300 }));
    await upsertCachedImage(seedRow({ coverArtId: 'complete', size: 600 }));
    await upsertCachedImage(seedRow({ coverArtId: 'partial', size: 300 }));
    await upsertCachedImage(seedRow({ coverArtId: 'partial', size: 600 }));
  });

  it('returns every entry grouped by coverArtId with size-sorted files', async () => {
    const entries = await listCachedImagesForBrowser('all');
    expect(entries).toHaveLength(2);
    const complete = entries.find((e) => e.coverArtId === 'complete')!;
    expect(complete.files.map((f) => f.size)).toEqual([50, 150, 300, 600]);
    expect(complete.complete).toBe(true);
    const partial = entries.find((e) => e.coverArtId === 'partial')!;
    expect(partial.files.map((f) => f.size)).toEqual([300, 600]);
    expect(partial.complete).toBe(false);
  });

  it('groups on the engine ordering, which is byte-wise — uppercase ids sort first', async () => {
    await upsertCachedImage(seedRow({ coverArtId: 'Zed', size: 300 }));
    await upsertCachedImage(seedRow({ coverArtId: 'Zed', size: 600 }));
    await upsertCachedImage(seedRow({ coverArtId: 'apple', size: 300 }));
    const entries = await listCachedImagesForBrowser('all');
    expect(entries.map((e) => e.coverArtId)).toEqual(['Zed', 'apple', 'complete', 'partial']);
    // Grouping is a single pass over the ordered rows, so each id appears once.
    expect(entries.find((e) => e.coverArtId === 'Zed')!.files).toHaveLength(2);
  });

  it('filter=complete excludes partials', async () => {
    const entries = await listCachedImagesForBrowser('complete');
    expect(entries.map((e) => e.coverArtId)).toEqual(['complete']);
  });

  it('filter=incomplete returns only partials', async () => {
    const entries = await listCachedImagesForBrowser('incomplete');
    expect(entries.map((e) => e.coverArtId)).toEqual(['partial']);
  });

  it('lists an in-queue cover — unlike the incomplete counts, the browser hides nothing', async () => {
    queueCover('partial');
    const entries = await listCachedImagesForBrowser('incomplete');
    expect(entries.map((e) => e.coverArtId)).toEqual(['partial']);
  });

  it('hides sentinel coverArtIds from all filters even if rows are present', async () => {
    // Simulate stale rows from an older app version where the sentinel
    // IDs were (incorrectly) routed through the disk cache.
    await upsertCachedImage(seedRow({ coverArtId: '__starred_cover__', size: 600 }));
    await upsertCachedImage(seedRow({ coverArtId: '__various_artists_cover__', size: 600 }));

    const all = (await listCachedImagesForBrowser('all')).map((e) => e.coverArtId);
    expect(all).not.toContain('__starred_cover__');
    expect(all).not.toContain('__various_artists_cover__');

    const incomplete = (await listCachedImagesForBrowser('incomplete')).map((e) => e.coverArtId);
    expect(incomplete).not.toContain('__starred_cover__');
    expect(incomplete).not.toContain('__various_artists_cover__');
  });

  it('returns [] on an empty table', async () => {
    await clearAllCachedImages();
    expect(await listCachedImagesForBrowser('all')).toEqual([]);
  });
});

describe('imageCacheTable — bulkInsertCachedImages', () => {
  it('inserts every valid row', async () => {
    await bulkInsertCachedImages([
      seedRow({ coverArtId: 'a', size: 50 }),
      seedRow({ coverArtId: 'a', size: 150 }),
      seedRow({ coverArtId: 'b', size: 300 }),
    ]);
    expect(await countCachedImages()).toBe(3);
  });

  it('skips rows missing coverArtId or size and writes the rest', async () => {
    await bulkInsertCachedImages([
      seedRow({ coverArtId: '', size: 50 }),
      seedRow({ coverArtId: 'a', size: 0 }),
      seedRow({ coverArtId: 'a', size: 300 }),
    ]);
    expect(await countCachedImages()).toBe(1);
    expect(await hasCachedImage('a', 300)).toBe(true);
  });

  it('is idempotent on re-run (UPSERT)', async () => {
    const rows = [
      seedRow({ coverArtId: 'a', size: 50, bytes: 100 }),
      seedRow({ coverArtId: 'a', size: 150, bytes: 200 }),
    ];
    await bulkInsertCachedImages(rows);
    await bulkInsertCachedImages(rows.map((r) => ({ ...r, bytes: r.bytes * 2 })));
    expect(await countCachedImages()).toBe(2);
    expect((await getCachedImagesForCoverArtAsync('a')).map((r) => r.bytes)).toEqual([200, 400]);
  });

  it('collapses a duplicate key WITHIN one batch — last write wins', async () => {
    await bulkInsertCachedImages([
      seedRow({ coverArtId: 'a', size: 300, bytes: 1 }),
      seedRow({ coverArtId: 'a', size: 300, bytes: 2 }),
    ]);
    expect(await countCachedImages()).toBe(1);
    expect((await getCachedImagesForCoverArtAsync('a'))[0].bytes).toBe(2);
  });

  it('no-op on empty input', async () => {
    await bulkInsertCachedImages([]);
    expect(await countCachedImages()).toBe(0);
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

    it('every read returns its empty default', async () => {
      expect(await hydrateImageCacheAggregatesAsync()).toEqual({
        totalBytes: 0,
        fileCount: 0,
        imageCount: 0,
        incompleteCount: 0,
      });
      expect(await countCachedImages()).toBe(0);
      expect(await hasCachedImage('x', 300)).toBe(false);
      expect(await getCachedImagesForCoverArtAsync('x')).toEqual([]);
      expect(await getAllCachedCoverArtIds()).toEqual([]);
      expect(await findIncompleteCovers()).toEqual([]);
      expect(await listCachedImagesForBrowser('all')).toEqual([]);
      expect(await deleteCachedImagesForCoverArt('x')).toEqual({ bytes: 0, count: 0 });
    });

    it('every write resolves without throwing', async () => {
      await expect(upsertCachedImage(seedRow())).resolves.toBeUndefined();
      await expect(deleteCachedImageVariant('x', 300)).resolves.toBeUndefined();
      await expect(clearAllCachedImages()).resolves.toBeUndefined();
      await expect(bulkInsertCachedImages([seedRow()])).resolves.toBeUndefined();
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
