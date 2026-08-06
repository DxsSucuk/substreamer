// Mock expo-sqlite with a minimal no-op DB so `persistence/db.ts`'s
// module-scope init succeeds on import. Individual tests override the
// shared handle via `db.__setDbForTests` with a richer fake.
jest.mock('expo-sqlite', () => ({
  openDatabaseSync: () => ({
    getFirstSync: () => undefined,
    getAllSync: () => [],
    runSync: () => {},
    execSync: () => {},
    withTransactionSync: (fn: () => void) => fn(),
  }),
}));

import { defaultCollator } from '../../../utils/intl';
import { __setDbForTests } from '../db';
import {
  bulkInsertCachedImages,
  clearAllCachedImages,
  countCachedImages,
  deleteCachedImageVariant,
  deleteCachedImagesForCoverArt,
  findIncompleteCovers,
  getCachedImagesForCoverArtAsync,
  hasCachedImage,
  hydrateImageCacheAggregatesAsync,
  listCachedImagesForBrowser,
  upsertCachedImage,
  type CachedImageRow,
} from '../imageCacheTable';

/** Fake DB that maps the small set of SQL statements used by imageCacheTable. */
function makeFakeDb() {
  // Composite key "coverArtId::size" → row
  const rows = new Map<
    string,
    { cover_art_id: string; size: number; ext: string; bytes: number; cached_at: number }
  >();
  const rowKey = (coverArtId: string, size: number) => `${coverArtId}::${size}`;

  function incompleteCovers(): string[] {
    const byCover = new Map<string, number>();
    for (const row of rows.values()) {
      byCover.set(row.cover_art_id, (byCover.get(row.cover_art_id) ?? 0) + 1);
    }
    const out: string[] = [];
    for (const [id, count] of byCover) {
      if (count < 4) out.push(id);
    }
    out.sort();
    return out;
  }

  const runSync = (rawSql: string, params: readonly unknown[] = []): void => {
    const s = rawSql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('INSERT INTO cached_images')) {
      const [coverArtId, size, ext, bytes, cachedAt] = params as [
        string,
        number,
        string,
        number,
        number,
      ];
      rows.set(rowKey(coverArtId, size), {
        cover_art_id: coverArtId,
        size,
        ext,
        bytes,
        cached_at: cachedAt,
      });
      return;
    }
    if (
      s.startsWith('DELETE FROM cached_images WHERE cover_art_id = ? AND size = ?')
    ) {
      const [coverArtId, size] = params as [string, number];
      rows.delete(rowKey(coverArtId, size));
      return;
    }
    if (s.startsWith('DELETE FROM cached_images WHERE cover_art_id = ?')) {
      const [coverArtId] = params as [string];
      for (const key of [...rows.keys()]) {
        if (rows.get(key)!.cover_art_id === coverArtId) rows.delete(key);
      }
      return;
    }
    if (s === 'DELETE FROM cached_images;') {
      rows.clear();
      return;
    }
    throw new Error(`unhandled SQL in fake: ${s}`);
  };

  const getFirstSync = <T,>(rawSql: string, params: readonly unknown[] = []): T | undefined => {
    const s = rawSql.replace(/\s+/g, ' ').trim();
    // Specific matches first — the per-coverArtId aggregate shares a prefix
    // with the whole-table one, so order of checks matters here.
    if (s.startsWith('SELECT COALESCE(SUM(bytes), 0) AS total_bytes, COUNT(*) AS file_count FROM cached_images WHERE cover_art_id = ?')) {
      const [coverArtId] = params as [string];
      let totalBytes = 0;
      let count = 0;
      for (const row of rows.values()) {
        if (row.cover_art_id === coverArtId) {
          totalBytes += row.bytes;
          count++;
        }
      }
      return { total_bytes: totalBytes, file_count: count } as T;
    }
    if (s.includes('COALESCE(SUM(bytes), 0) AS total_bytes') && s.includes('image_count')) {
      let totalBytes = 0;
      const covers = new Set<string>();
      for (const row of rows.values()) {
        totalBytes += row.bytes;
        covers.add(row.cover_art_id);
      }
      return {
        total_bytes: totalBytes,
        file_count: rows.size,
        image_count: covers.size,
      } as T;
    }
    if (
      s.includes('SELECT COUNT(*) AS c FROM ( SELECT cover_art_id FROM cached_images')
      && s.includes('GROUP BY cover_art_id HAVING COUNT(*) < 4')
    ) {
      // Matches both the legacy form and the new form with the
      // NOT IN (SELECT cover_art_id FROM image_download_queue) filter.
      // Tests don't seed the queue, so the filter never excludes anything.
      return { c: incompleteCovers().length } as T;
    }
    if (s.startsWith('SELECT 1 AS c FROM cached_images WHERE cover_art_id = ? AND size = ?')) {
      const [coverArtId, size] = params as [string, number];
      return rows.has(rowKey(coverArtId, size)) ? ({ c: 1 } as T) : undefined;
    }
    if (s.startsWith('SELECT COUNT(*) AS c FROM cached_images')) {
      return { c: rows.size } as T;
    }
    return undefined;
  };

  const getAllSync = <T,>(rawSql: string, params: readonly unknown[] = []): T[] => {
    const s = rawSql.replace(/\s+/g, ' ').trim();
    if (
      s.startsWith(
        'SELECT cover_art_id, size, ext, bytes, cached_at FROM cached_images WHERE cover_art_id = ?',
      )
    ) {
      const [coverArtId] = params as [string];
      return [...rows.values()]
        .filter((r) => r.cover_art_id === coverArtId)
        .sort((a, b) => a.size - b.size) as T[];
    }
    if (
      s.startsWith('SELECT cover_art_id, size, ext, bytes, cached_at FROM cached_images ORDER BY cover_art_id')
    ) {
      return [...rows.values()].sort(
        (a, b) =>
          defaultCollator.compare(a.cover_art_id, b.cover_art_id) || a.size - b.size,
      ) as T[];
    }
    if (
      s.startsWith('SELECT cover_art_id FROM cached_images')
      && s.includes('GROUP BY cover_art_id HAVING COUNT(*) < 4')
    ) {
      // Matches both the legacy form and the new form with the
      // NOT IN (SELECT cover_art_id FROM image_download_queue) filter.
      return incompleteCovers().map((cover_art_id) => ({ cover_art_id })) as T[];
    }
    return [];
  };

  return {
    rows,
    getFirstSync,
    getAllSync,
    runSync,
    execSync: () => {},
    withTransactionSync: (fn: () => void) => fn(),
    // Async delegates — the module now uses the async DB API.
    runAsync: (sql: string, params?: readonly unknown[]) => Promise.resolve(runSync(sql, params) as any),
    getFirstAsync: <T,>(sql: string, params?: readonly unknown[]) =>
      Promise.resolve(getFirstSync<T>(sql, params)),
    getAllAsync: <T,>(sql: string, params?: readonly unknown[]) =>
      Promise.resolve(getAllSync<T>(sql, params)),
    runAtomicBatchAsync: async (commands: ReadonlyArray<readonly [string, readonly unknown[]]>) => {
      for (const [sql, params] of commands) runSync(sql, params);
    },
  };
}

let fakeDb: ReturnType<typeof makeFakeDb>;

beforeEach(() => {
  fakeDb = makeFakeDb();
  __setDbForTests(fakeDb as any);
});

afterEach(() => {
  __setDbForTests(null);
});

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

describe('imageCacheTable — upsertCachedImage', () => {
  it('inserts a row and makes it queryable', async () => {
    await upsertCachedImage(seedRow());
    expect(await countCachedImages()).toBe(1);
    expect(await hasCachedImage('cover-1', 300)).toBe(true);
    expect(await hasCachedImage('cover-1', 50)).toBe(false);
  });

  it('upserts on conflict — second write replaces bytes / cachedAt / ext in place', async () => {
    await upsertCachedImage(seedRow({ bytes: 5000, cachedAt: 1000 }));
    await upsertCachedImage(seedRow({ bytes: 9999, cachedAt: 9999, ext: 'webp' }));
    expect(await countCachedImages()).toBe(1);
    const entries = await getCachedImagesForCoverArtAsync('cover-1');
    expect(entries).toHaveLength(1);
    expect(entries[0].bytes).toBe(9999);
    expect(entries[0].cachedAt).toBe(9999);
    expect(entries[0].ext).toBe('webp');
  });

  it('drops writes when coverArtId or size is missing', async () => {
    await upsertCachedImage(seedRow({ coverArtId: '' }));
    await upsertCachedImage(seedRow({ size: 0 }));
    expect(await countCachedImages()).toBe(0);
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

  it('filter=complete excludes partials', async () => {
    const entries = await listCachedImagesForBrowser('complete');
    expect(entries.map((e) => e.coverArtId)).toEqual(['complete']);
  });

  it('filter=incomplete returns only partials', async () => {
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
});

describe('imageCacheTable — bulkInsertCachedImages', () => {
  it('inserts every valid row inside one transaction', async () => {
    await bulkInsertCachedImages([
      seedRow({ coverArtId: 'a', size: 50 }),
      seedRow({ coverArtId: 'a', size: 150 }),
      seedRow({ coverArtId: 'b', size: 300 }),
    ]);
    expect(await countCachedImages()).toBe(3);
  });

  it('is idempotent on re-run (UPSERT)', async () => {
    const rows = [
      seedRow({ coverArtId: 'a', size: 50, bytes: 100 }),
      seedRow({ coverArtId: 'a', size: 150, bytes: 200 }),
    ];
    await bulkInsertCachedImages(rows);
    await bulkInsertCachedImages(rows);
    expect(await countCachedImages()).toBe(2);
  });

  it('no-op on empty input', async () => {
    await bulkInsertCachedImages([]);
    expect(await countCachedImages()).toBe(0);
  });
});

describe('imageCacheTable — null-handle safety', () => {
  beforeEach(() => {
    __setDbForTests(null);
  });

  it('every read returns its empty default, every write is a no-op', async () => {
    expect(await hydrateImageCacheAggregatesAsync()).toEqual({
      totalBytes: 0,
      fileCount: 0,
      imageCount: 0,
      incompleteCount: 0,
    });
    expect(await countCachedImages()).toBe(0);
    expect(await hasCachedImage('x', 300)).toBe(false);
    expect(await getCachedImagesForCoverArtAsync('x')).toEqual([]);
    expect(await findIncompleteCovers()).toEqual([]);
    expect(await listCachedImagesForBrowser('all')).toEqual([]);
    await expect(upsertCachedImage(seedRow())).resolves.toBeUndefined();
    expect(await deleteCachedImagesForCoverArt('x')).toEqual({ bytes: 0, count: 0 });
    await expect(deleteCachedImageVariant('x', 300)).resolves.toBeUndefined();
    await expect(clearAllCachedImages()).resolves.toBeUndefined();
    await expect(bulkInsertCachedImages([seedRow()])).resolves.toBeUndefined();
  });
});
