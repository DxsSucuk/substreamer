/**
 * Tests for Migration 22 — cover-art ID reconciliation.
 *
 * Verifies:
 *   - {legacyStrippedKey → fullId} mapping is built from every table that
 *     held the full server ID before the strip was removed.
 *   - `cached_images` rows under legacy stripped keys are rewritten to the
 *     full ID; orphans evicted.
 *   - On-disk `image-cache/<dir>/` directories are renamed to the new
 *     percent-encoded path; orphan dirs deleted.
 *   - Multi-disc disc-cover IDs (`dc-xxx:N`) land at distinct paths.
 *   - PK collision on rename keeps the row with the newer `cached_at`.
 *   - Migration is idempotent on a second run.
 */

import { addColumnIfMissing as _unused } from '../../store/persistence/musicCacheTables';
void _unused; // keep import for jest module resolution side-effects

/* ------------------------------------------------------------------ */
/*  Module mocks                                                       */
/* ------------------------------------------------------------------ */

jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../../store/deviceIdentityStore', () => ({
  deviceIdentityStore: {
    getState: () => ({
      deviceId: 'mock-device-id',
      deviceName: null,
      deviceLabel: 'Mock',
      deviceLabelUserSet: false,
      refreshDeviceName: jest.fn(),
      ensureDefaultLabel: jest.fn(),
    }),
    setState: jest.fn(),
  },
  getDeviceShortId: () => 'mock1234',
}));

jest.mock('expo-sqlite', () => ({
  openDatabaseSync: () => {
    throw new Error('mocked — fake db injected per test');
  },
}));

// Stateful filesystem mock. The state lives inside the factory closure
// (Jest disallows referencing out-of-scope variables in `jest.mock`).
// The Directory/File classes consult a shared root which the test file
// reaches into via `require('expo-file-system').__fsRoot`.
jest.mock('expo-file-system', () => {
  const fsRoot = { type: 'dir' as const, children: new Map<string, any>() };

  function pathToParts(path: string): string[] {
    return path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  }

  function getNode(parts: string[]): any {
    let cur: any = fsRoot;
    for (const p of parts) {
      if (cur.type !== 'dir' || !cur.children) return undefined;
      const next = cur.children.get(p);
      if (!next) return undefined;
      cur = next;
    }
    return cur;
  }

  function ensureDir(parts: string[]): any {
    let cur: any = fsRoot;
    for (const p of parts) {
      if (cur.type !== 'dir' || !cur.children) throw new Error('not a dir');
      let next = cur.children.get(p);
      if (!next) {
        next = { type: 'dir', children: new Map() };
        cur.children.set(p, next);
      }
      cur = next;
    }
    return cur;
  }

  class Directory {
    _parts: string[];
    constructor(...parts: any[]) {
      const flat: string[] = [];
      for (const p of parts) {
        if (typeof p === 'string') flat.push(...pathToParts(p));
        else if (p instanceof Directory) flat.push(...p._parts);
      }
      this._parts = flat;
    }
    get uri(): string {
      return 'file:///' + this._parts.join('/');
    }
    get exists(): boolean {
      const n = getNode(this._parts);
      return n !== undefined && n.type === 'dir';
    }
    create(): void {
      ensureDir(this._parts);
    }
    delete(): void {
      if (this._parts.length === 0) return;
      const parent = getNode(this._parts.slice(0, -1));
      if (parent?.type !== 'dir' || !parent.children) return;
      parent.children.delete(this._parts[this._parts.length - 1]);
    }
  }

  class File {
    _parts: string[];
    constructor(...parts: any[]) {
      const flat: string[] = [];
      for (const p of parts) {
        if (typeof p === 'string') flat.push(...pathToParts(p));
        else if ((p as any)._parts) flat.push(...(p as any)._parts);
      }
      this._parts = flat;
    }
    get uri(): string {
      return 'file:///' + this._parts.join('/');
    }
    get exists(): boolean {
      const n = getNode(this._parts);
      return n !== undefined && n.type === 'file';
    }
    delete(): void {
      if (this._parts.length === 0) return;
      const parent = getNode(this._parts.slice(0, -1));
      if (parent?.type !== 'dir' || !parent.children) return;
      parent.children.delete(this._parts[this._parts.length - 1]);
    }
    move(dst: any): void {
      const parentSrc = getNode(this._parts.slice(0, -1));
      if (parentSrc?.type !== 'dir' || !parentSrc.children) return;
      const node = parentSrc.children.get(this._parts[this._parts.length - 1]);
      if (!node) return;
      parentSrc.children.delete(this._parts[this._parts.length - 1]);
      const parentDst = ensureDir(dst._parts.slice(0, -1));
      parentDst.children.set(dst._parts[dst._parts.length - 1], node);
    }
    write(_data: any): void { /* no-op */ }
  }

  return {
    File,
    Directory,
    Paths: { document: new Directory() },
    // Test-only helpers exposed for assertions / seeding.
    __fsRoot: fsRoot,
    __resetFs: () => {
      fsRoot.children = new Map();
    },
    __seedDir: (parts: string[]) => ensureDir(parts),
    __getNode: (parts: string[]) => getNode(parts),
    __pathToParts: pathToParts,
  };
});

jest.mock('expo-async-fs', () => ({
  listDirectoryAsync: jest.fn(async (uri: string) => {
    const fs = require('expo-file-system') as any;
    const parts = fs.__pathToParts(uri.replace(/^file:\/+/, ''));
    const node = fs.__getNode(parts);
    if (!node || node.type !== 'dir' || !node.children) return [];
    return Array.from(node.children.keys());
  }),
}));

jest.mock('expo-gzip', () => ({
  compressToFile: jest.fn().mockResolvedValue({ bytes: 0 }),
  decompressFromFile: jest.fn().mockResolvedValue(''),
}));

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

/* ------------------------------------------------------------------ */
/*  Imports (after mocks)                                              */
/* ------------------------------------------------------------------ */

import { runMigrations } from '../migrationService';
import { __setDbForTests as setDbForDetailTables } from '../../store/persistence/db';

const fs: any = require('expo-file-system');

/* ------------------------------------------------------------------ */
/*  Stateful SQL fake                                                  */
/* ------------------------------------------------------------------ */

interface CachedImageRow {
  cover_art_id: string;
  size: number;
  ext: string;
  bytes: number;
  cached_at: number;
}

interface FakeState {
  cached_items: { cover_art_id: string | null; raw_json: string | null }[];
  cached_songs: { cover_art: string | null; raw_json: string | null }[];
  download_queue: { cover_art_id: string | null }[];
  song_index: { coverArt: string | null }[];
  cached_images: CachedImageRow[];
}

let fake: FakeState;

function makeFakeDb() {
  return {
    getFirstSync<T>(sql: string, params: readonly unknown[] = []): T | undefined {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/SELECT COUNT\(\*\) AS c FROM cached_images WHERE cover_art_id = \?/i.test(s)) {
        const [cid] = params as [string];
        const c = fake.cached_images.filter((r) => r.cover_art_id === cid).length;
        return ({ c } as any) as T;
      }
      if (/SELECT cached_at FROM cached_images WHERE cover_art_id = \? AND size = \?/i.test(s)) {
        const [cid, size] = params as [string, number];
        const row = fake.cached_images.find((r) => r.cover_art_id === cid && r.size === size);
        return row ? (({ cached_at: row.cached_at } as any) as T) : undefined;
      }
      return undefined;
    },
    getAllSync<T>(sql: string, params: readonly unknown[] = []): T[] {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (/SELECT DISTINCT cover_art_id FROM cached_items WHERE cover_art_id IS NOT NULL/i.test(s)) {
        const set = new Set(fake.cached_items.map((r) => r.cover_art_id).filter(Boolean) as string[]);
        return Array.from(set).map((v) => ({ cover_art_id: v } as any)) as T[];
      }
      if (/SELECT cover_art_id AS v FROM cached_items WHERE cover_art_id IS NOT NULL/i.test(s)) {
        const set = new Set(fake.cached_items.map((r) => r.cover_art_id).filter(Boolean) as string[]);
        return Array.from(set).map((v) => ({ v } as any)) as T[];
      }
      if (/SELECT DISTINCT cover_art FROM cached_songs WHERE cover_art IS NOT NULL/i.test(s)) {
        const set = new Set(fake.cached_songs.map((r) => r.cover_art).filter(Boolean) as string[]);
        return Array.from(set).map((v) => ({ cover_art: v } as any)) as T[];
      }
      if (/SELECT cover_art AS v FROM cached_songs WHERE cover_art IS NOT NULL/i.test(s)) {
        const set = new Set(fake.cached_songs.map((r) => r.cover_art).filter(Boolean) as string[]);
        return Array.from(set).map((v) => ({ v } as any)) as T[];
      }
      if (/SELECT DISTINCT cover_art_id FROM download_queue WHERE cover_art_id IS NOT NULL/i.test(s)) {
        const set = new Set(fake.download_queue.map((r) => r.cover_art_id).filter(Boolean) as string[]);
        return Array.from(set).map((v) => ({ cover_art_id: v } as any)) as T[];
      }
      if (/SELECT DISTINCT coverArt FROM song_index WHERE coverArt IS NOT NULL/i.test(s)) {
        const set = new Set(fake.song_index.map((r) => r.coverArt).filter(Boolean) as string[]);
        return Array.from(set).map((v) => ({ coverArt: v } as any)) as T[];
      }
      if (/SELECT coverArt AS v FROM song_index WHERE coverArt IS NOT NULL/i.test(s)) {
        const set = new Set(fake.song_index.map((r) => r.coverArt).filter(Boolean) as string[]);
        return Array.from(set).map((v) => ({ v } as any)) as T[];
      }
      if (/SELECT DISTINCT json_extract\(raw_json, '\$\.coverArt'\) AS c FROM cached_items/i.test(s)) {
        const set = new Set<string>();
        for (const r of fake.cached_items) {
          if (!r.raw_json) continue;
          try {
            const parsed = JSON.parse(r.raw_json);
            if (parsed?.coverArt) set.add(parsed.coverArt);
          } catch { /* ignore */ }
        }
        return Array.from(set).map((v) => ({ c: v } as any)) as T[];
      }
      if (/SELECT DISTINCT json_extract\(raw_json, '\$\.coverArt'\) AS c FROM cached_songs/i.test(s)) {
        const set = new Set<string>();
        for (const r of fake.cached_songs) {
          if (!r.raw_json) continue;
          try {
            const parsed = JSON.parse(r.raw_json);
            if (parsed?.coverArt) set.add(parsed.coverArt);
          } catch { /* ignore */ }
        }
        return Array.from(set).map((v) => ({ c: v } as any)) as T[];
      }
      if (/SELECT DISTINCT cover_art_id FROM cached_images/i.test(s)) {
        const set = new Set(fake.cached_images.map((r) => r.cover_art_id));
        return Array.from(set).map((v) => ({ cover_art_id: v } as any)) as T[];
      }
      if (/SELECT size, cached_at FROM cached_images WHERE cover_art_id = \?/i.test(s)) {
        const [cid] = params as [string];
        return fake.cached_images
          .filter((r) => r.cover_art_id === cid)
          .map((r) => ({ size: r.size, cached_at: r.cached_at } as any)) as T[];
      }
      return [];
    },
    runSync(sql: string, params: readonly unknown[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/^DELETE FROM cached_images WHERE cover_art_id = \? AND size = \?/i.test(s)) {
        const [cid, size] = params as [string, number];
        fake.cached_images = fake.cached_images.filter(
          (r) => !(r.cover_art_id === cid && r.size === size),
        );
        return;
      }
      if (/^DELETE FROM cached_images WHERE cover_art_id = \?/i.test(s)) {
        const [cid] = params as [string];
        fake.cached_images = fake.cached_images.filter((r) => r.cover_art_id !== cid);
        return;
      }
      if (/^UPDATE cached_images SET cover_art_id = \? WHERE cover_art_id = \? AND size = \?/i.test(s)) {
        const [newId, oldId, size] = params as [string, string, number];
        for (const r of fake.cached_images) {
          if (r.cover_art_id === oldId && r.size === size) r.cover_art_id = newId;
        }
        return;
      }
    },
    execSync(_sql: string): void { /* no-op */ },
    withTransactionSync(fn: () => void): void { fn(); },
  };
}

/* ------------------------------------------------------------------ */
/*  Test helpers                                                       */
/* ------------------------------------------------------------------ */

function pathKey(id: string): string {
  return id.replace(/[%:\\/?<>*|"\x00]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'),
  );
}

function legacyKey(id: string): string {
  return id.replace(/[:\\/?<>*|"\x00]/g, '_');
}

function legacyStrip(id: string): string {
  const i = id.lastIndexOf('_');
  if (i <= 0) return id;
  const suffix = id.slice(i + 1);
  if (!/^[0-9a-f]+$/i.test(suffix)) return id;
  return id.slice(0, i);
}

function seedCacheDir(dirName: string, sizes: { size: number; cachedAt: number }[]): void {
  const dir = fs.__seedDir(['image-cache', dirName]);
  for (const s of sizes) {
    dir.children.set(`${s.size}.jpg`, { type: 'file', cachedAt: s.cachedAt, bytes: 100 });
  }
}

/* ------------------------------------------------------------------ */
/*  Test suite                                                         */
/* ------------------------------------------------------------------ */

describe('Migration 22 — image cache cover-art reconciliation', () => {
  beforeEach(() => {
    fs.__resetFs();
    fake = {
      cached_items: [],
      cached_songs: [],
      download_queue: [],
      song_index: [],
      cached_images: [],
    };
    setDbForDetailTables(makeFakeDb() as any);
  });

  afterEach(() => {
    setDbForDetailTables(null);
  });

  test('rewrites cached_images rows from legacy stripped keys to full IDs', async () => {
    const fullId = 'al-1_abc123';
    const stripped = legacyStrip(fullId); // 'al-1'

    fake.cached_items.push({ cover_art_id: fullId, raw_json: null });
    fake.cached_images.push(
      { cover_art_id: stripped, size: 50, ext: 'jpg', bytes: 100, cached_at: 1 },
      { cover_art_id: stripped, size: 600, ext: 'jpg', bytes: 1000, cached_at: 1 },
    );

    await runMigrations(21);

    expect(fake.cached_images.filter((r) => r.cover_art_id === fullId)).toHaveLength(2);
    expect(fake.cached_images.filter((r) => r.cover_art_id === stripped)).toHaveLength(0);
  });

  test('evicts orphan cached_images rows', async () => {
    fake.cached_images.push(
      { cover_art_id: 'orphan-1', size: 600, ext: 'jpg', bytes: 500, cached_at: 1 },
      { cover_art_id: 'orphan-1', size: 50, ext: 'jpg', bytes: 50, cached_at: 1 },
    );

    await runMigrations(21);

    expect(fake.cached_images).toHaveLength(0);
  });

  test('renames on-disk dirs from legacy form to percent-encoded full ID', async () => {
    const fullId = 'pl-2_deadbeef';
    const stripped = legacyStrip(fullId); // 'pl-2'

    fake.cached_items.push({ cover_art_id: fullId, raw_json: null });
    seedCacheDir(legacyKey(stripped), [{ size: 600, cachedAt: 1 }, { size: 50, cachedAt: 1 }]);

    await runMigrations(21);

    const newDirName = pathKey(fullId);
    expect(fs.__getNode(['image-cache', newDirName])).toBeDefined();
    expect(fs.__getNode(['image-cache', stripped])).toBeUndefined();
    expect(fs.__getNode(['image-cache', newDirName, '600.jpg'])?.type).toBe('file');
  });

  test('disc-cover IDs land at their distinct percent-encoded path', async () => {
    const discId = 'dc-cover:1';

    fake.cached_items.push({ cover_art_id: discId, raw_json: null });
    seedCacheDir(legacyKey(legacyStrip(discId)), [{ size: 600, cachedAt: 1 }]);
    fake.cached_images.push({
      cover_art_id: legacyStrip(discId),
      size: 600,
      ext: 'jpg',
      bytes: 500,
      cached_at: 1,
    });

    await runMigrations(21);

    expect(fs.__getNode(['image-cache', 'dc-cover%3A1'])).toBeDefined();
    expect(fs.__getNode(['image-cache', 'dc-cover'])).toBeUndefined();
    expect(fake.cached_images.filter((r) => r.cover_art_id === discId)).toHaveLength(1);
  });

  test('evicts orphan on-disk dirs', async () => {
    seedCacheDir('orphan-dir', [{ size: 600, cachedAt: 1 }]);

    await runMigrations(21);

    expect(fs.__getNode(['image-cache', 'orphan-dir'])).toBeUndefined();
  });

  test('PK collision on rename keeps newer cached_at', async () => {
    const fullId = 'al-9_aaaa';
    const stripped = legacyStrip(fullId);

    fake.cached_items.push({ cover_art_id: fullId, raw_json: null });
    fake.cached_images.push(
      { cover_art_id: stripped, size: 600, ext: 'jpg', bytes: 1000, cached_at: 200 },
      { cover_art_id: fullId, size: 600, ext: 'jpg', bytes: 800, cached_at: 100 },
    );

    await runMigrations(21);

    const survivors = fake.cached_images.filter((r) => r.cover_art_id === fullId && r.size === 600);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].bytes).toBe(1000);
  });

  test('PK collision keeps existing when it is newer', async () => {
    const fullId = 'al-9_aaaa';
    const stripped = legacyStrip(fullId);

    fake.cached_items.push({ cover_art_id: fullId, raw_json: null });
    fake.cached_images.push(
      { cover_art_id: stripped, size: 600, ext: 'jpg', bytes: 1000, cached_at: 100 },
      { cover_art_id: fullId, size: 600, ext: 'jpg', bytes: 800, cached_at: 200 },
    );

    await runMigrations(21);

    const survivors = fake.cached_images.filter((r) => r.cover_art_id === fullId && r.size === 600);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].bytes).toBe(800);
  });

  test('idempotent: re-running on clean state is a no-op', async () => {
    const fullId = 'al-1_abc123';
    const stripped = legacyStrip(fullId);
    fake.cached_items.push({ cover_art_id: fullId, raw_json: null });
    fake.cached_images.push({ cover_art_id: stripped, size: 600, ext: 'jpg', bytes: 1000, cached_at: 1 });
    seedCacheDir(legacyKey(stripped), [{ size: 600, cachedAt: 1 }]);

    await runMigrations(21);
    const sqlAfterFirst = JSON.parse(JSON.stringify(fake.cached_images));
    const fsAfterFirstKeys = Array.from(
      (fs.__fsRoot.children.get('image-cache') as any).children.keys(),
    );

    await runMigrations(21);
    const sqlAfterSecond = JSON.parse(JSON.stringify(fake.cached_images));
    const fsAfterSecondKeys = Array.from(
      (fs.__fsRoot.children.get('image-cache') as any).children.keys(),
    );

    expect(sqlAfterSecond).toEqual(sqlAfterFirst);
    expect(fsAfterSecondKeys).toEqual(fsAfterFirstKeys);
  });

  test('mapping built from raw_json when normalised columns are NULL', async () => {
    const fullId = 'al-7_beef';
    const stripped = legacyStrip(fullId);

    fake.cached_items.push({
      cover_art_id: null,
      raw_json: JSON.stringify({ id: 'al-7', name: 'A', coverArt: fullId }),
    });
    fake.cached_images.push({ cover_art_id: stripped, size: 600, ext: 'jpg', bytes: 500, cached_at: 1 });

    await runMigrations(21);

    expect(fake.cached_images[0].cover_art_id).toBe(fullId);
  });

  test('full IDs without a hex suffix are passed through untouched', async () => {
    const plainId = 'mf-12345';
    fake.cached_items.push({ cover_art_id: plainId, raw_json: null });
    fake.cached_images.push({ cover_art_id: plainId, size: 600, ext: 'jpg', bytes: 500, cached_at: 1 });
    seedCacheDir(plainId, [{ size: 600, cachedAt: 1 }]);

    await runMigrations(21);

    expect(fake.cached_images[0].cover_art_id).toBe(plainId);
    expect(fs.__getNode(['image-cache', plainId])).toBeDefined();
  });
});
