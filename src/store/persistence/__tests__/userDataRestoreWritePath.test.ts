/**
 * Backup RESTORE onto `mbid_overrides` and `scrobble_exclusions`, against REAL SQL on the
 * better-sqlite3-backed op-SQLite substitute: merge mode writes the merged-in entries through
 * without disturbing the ones that won their collision, replace mode removes the old set
 * BEFORE writing the file's, a failure part-way leaves the old set whole rather than a
 * mix, and an old backup file — the format is unchanged — still restores in both modes.
 *
 * These are the two bugs step 6 found in the bookmark equivalents, in a different
 * costume: a merge that never reached the repository, and a replace that neither wrote
 * the file's entries nor deleted the existing rows. Both were invisible while KV was
 * authoritative and become silent data loss the moment reads flip.
 *
 * Export is asserted here too, because the SOURCE is the deliberate half: the file is
 * written from the store, which is the complete set, not from the table, which holds only
 * what has been written since the upgrade until migration 42 runs.
 *
 * Per AGENTS.md §11 the substitute proves SQL semantics, never concurrency.
 */
const mockFileInstances = new Map<string, { exists: boolean; content: string }>();
const mockCompressToFile = jest.fn();
const mockDecompressFromFile = jest.fn();

jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    _name: string;
    constructor(_base: unknown, ...parts: string[]) {
      this._name = parts.join('/');
      this.uri = `file:///backups/${this._name}`;
    }
    get exists() {
      return mockFileInstances.get(this._name)?.exists ?? false;
    }
    write(content: string) {
      mockFileInstances.set(this._name, { exists: true, content });
    }
    delete() {
      mockFileInstances.delete(this._name);
    }
    move(dest: MockFile) {
      const entry = mockFileInstances.get(this._name);
      if (entry) {
        mockFileInstances.set(dest._name, { ...entry });
        mockFileInstances.delete(this._name);
      }
    }
    async text() {
      return mockFileInstances.get(this._name)?.content ?? '';
    }
  }
  class MockDirectory {
    uri = 'file:///document/';
    exists = true;
    create() {
      /* already exists */
    }
    get parentDirectory() {
      return new MockDirectory();
    }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { document: new MockDirectory() } };
});

jest.mock('expo-async-fs', () => ({ listDirectoryAsync: jest.fn(async () => []) }));

jest.mock('expo-gzip', () => ({
  compressToFile: (...args: unknown[]) => mockCompressToFile(...args),
  decompressFromFile: (...args: unknown[]) => mockDecompressFromFile(...args),
}));

jest.mock('../kvStorage', () => require('../__mocks__/kvStorage'));

// expo-device / expo-crypto have no bridge under Jest, and the stem carries the
// device short id.
jest.mock('../../deviceIdentityStore', () => ({
  deviceIdentityStore: {
    getState: () => ({ deviceId: 'dev-1', deviceName: 'Test', deviceLabel: 'Test' }),
    setState: jest.fn(),
  },
  getDeviceShortId: () => 'dev1',
}));

import { settleDbWrites } from '../../../test-utils/settleDbWrites';
import { __setDbForTests, getDb, type InternalDb } from '../db';
import { readMbidOverrides } from '../mbidOverrideTable';
import { readScrobbleExclusions } from '../scrobbleExclusionTable';
import { mbidOverrideStore, type MbidOverride } from '../../mbidOverrideStore';
import {
  scrobbleExclusionStore,
  type ScrobbleExclusion,
} from '../../scrobbleExclusionStore';
import { authStore } from '../../authStore';
import { createBackup, restoreBackup, type BackupEntry } from '../../../services/backupService';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite substitute failed to open');
const realDb: InternalDb = handle;

const STEM = 'backup-test';
const TEST_SERVER = 'https://music.example.com';
const TEST_USER = 'testuser';

const override = (
  type: 'artist' | 'album',
  entityId: string,
  overrides: Partial<MbidOverride> = {},
): MbidOverride => ({
  type,
  entityId,
  entityName: `Name ${entityId}`,
  mbid: `mbid-${entityId}`,
  ...overrides,
});

const overrideMap = (...list: MbidOverride[]): Record<string, MbidOverride> =>
  Object.fromEntries(list.map((o) => [`${o.type}:${o.entityId}`, o]));

const exclusionMaps = (
  maps: Partial<{
    excludedAlbums: Record<string, ScrobbleExclusion>;
    excludedArtists: Record<string, ScrobbleExclusion>;
    excludedPlaylists: Record<string, ScrobbleExclusion>;
  }> = {},
) => ({
  excludedAlbums: {},
  excludedArtists: {},
  excludedPlaylists: {},
  ...maps,
});

/** A listing entry pointing at whichever datasets the test seeded. */
const backupEntry = (counts: {
  mbid?: number;
  exclusions?: number;
}): BackupEntry => ({
  createdAt: '2026-08-10T00:00:00Z',
  scrobbleCount: 0,
  scrobbleSizeBytes: 0,
  mbidOverrideCount: counts.mbid ?? 0,
  mbidOverrideSizeBytes: 100,
  scrobbleExclusionCount: counts.exclusions ?? 0,
  scrobbleExclusionSizeBytes: 100,
  bookmarkCount: 0,
  bookmarkSizeBytes: 0,
  stem: STEM,
  serverUrl: TEST_SERVER,
  username: TEST_USER,
  deviceId: null,
  deviceName: null,
  deviceLabel: null,
});

/** Put one dataset on "disk" and make `decompressFromFile` return it by file name. */
const seededPayloads = new Map<string, unknown>();

function seedBackupFile(suffix: 'mbid' | 'exclusions', payload: unknown): void {
  mockFileInstances.set(`${STEM}.${suffix}.gz`, { exists: true, content: '' });
  seededPayloads.set(`${STEM}.${suffix}.gz`, payload);
}

/** The store's write-throughs are fire-and-forget, and a batch is parked on
 *  op-SQLite's transaction lock — one macrotask each. */
const settle = settleDbWrites;

const overrideIds = (): string[] =>
  realDb
    .getAllSync<{ type: string; entity_id: string }>(
      'SELECT type, entity_id FROM mbid_overrides ORDER BY type, entity_id;',
    )
    .map((r) => `${r.type}:${r.entity_id}`);

const exclusionIds = (): string[] =>
  realDb
    .getAllSync<{ type: string; entity_id: string }>(
      'SELECT type, entity_id FROM scrobble_exclusions ORDER BY type, entity_id;',
    )
    .map((r) => `${r.type}:${r.entity_id}`);

/** Seed the way the app does, through the store, so SQL holds them too. */
async function seedExistingOverrides(...list: MbidOverride[]): Promise<void> {
  for (const o of list) {
    mbidOverrideStore.getState().setOverride(o.type, o.entityId, o.entityName, o.mbid);
  }
  await settle();
}

async function seedExistingExclusions(
  ...list: Array<{ type: 'album' | 'artist' | 'playlist'; id: string; name: string }>
): Promise<void> {
  for (const e of list) scrobbleExclusionStore.getState().addExclusion(e.type, e.id, e.name);
  await settle();
}

beforeEach(() => {
  __setDbForTests(realDb);
  realDb.runSync('DELETE FROM mbid_overrides;');
  realDb.runSync('DELETE FROM scrobble_exclusions;');
  mbidOverrideStore.setState({ overrides: {}, sqlAuthoritative: false });
  scrobbleExclusionStore.setState({ ...exclusionMaps(), sqlAuthoritative: false });
  mockFileInstances.clear();
  seededPayloads.clear();
  mockCompressToFile.mockReset();
  mockDecompressFromFile.mockReset();
  mockDecompressFromFile.mockImplementation(async (uri: string) =>
    JSON.stringify(seededPayloads.get(String(uri).replace('file:///backups/', '')) ?? {}),
  );
  authStore.setState({ serverUrl: TEST_SERVER, username: TEST_USER, isLoggedIn: true });
});

/* ------------------------------------------------------------------ */
/*  Merge mode — the write-through bug                                 */
/* ------------------------------------------------------------------ */

describe('restoreBackup — merge mode', () => {
  it('writes the merged-in overrides through to the rows', async () => {
    await seedExistingOverrides(override('artist', 'ar-local'));
    seedBackupFile('mbid', overrideMap(override('album', 'al-file')));

    const counts = await restoreBackup(backupEntry({ mbid: 1 }), 'merge');
    await settle();

    expect(counts.mbidOverrideCount).toBe(1);
    expect(overrideIds()).toEqual(['album:al-file', 'artist:ar-local']);
    expect((await readMbidOverrides())?.find((o) => o.entityId === 'al-file')).toEqual({
      type: 'album',
      entityId: 'al-file',
      entityName: 'Name al-file',
      mbid: 'mbid-al-file',
    });
  });

  it('leaves an override that won its key collision exactly as it was', async () => {
    await seedExistingOverrides(override('artist', 'ar1', { mbid: 'local-mbid' }));
    seedBackupFile(
      'mbid',
      overrideMap(
        override('artist', 'ar1', { mbid: 'file-mbid', entityName: 'From The File' }),
        override('album', 'al1'),
      ),
    );

    const counts = await restoreBackup(backupEntry({ mbid: 2 }), 'merge');
    await settle();

    expect(counts).toMatchObject({ mbidOverrideCount: 1, mbidOverrideSkipped: 1 });
    const stored = (await readMbidOverrides())?.find((o) => o.entityId === 'ar1');
    expect(stored).toMatchObject({ mbid: 'local-mbid', entityName: 'Name ar1' });
  });

  it('writes the merged-in exclusions through to the rows', async () => {
    await seedExistingExclusions({ type: 'album', id: 'al-local', name: 'Local' });
    seedBackupFile(
      'exclusions',
      exclusionMaps({
        excludedArtists: { 'ar-file': { id: 'ar-file', name: 'From The File' } },
        excludedPlaylists: { 'pl-file': { id: 'pl-file', name: 'Sleep' } },
      }),
    );

    const counts = await restoreBackup(backupEntry({ exclusions: 2 }), 'merge');
    await settle();

    expect(counts.scrobbleExclusionCount).toBe(2);
    expect(exclusionIds()).toEqual(['album:al-local', 'artist:ar-file', 'playlist:pl-file']);
    const maps = await readScrobbleExclusions();
    expect(maps?.excludedArtists['ar-file'].name).toBe('From The File');
  });

  it('leaves an exclusion that won its key collision exactly as it was', async () => {
    await seedExistingExclusions({ type: 'album', id: 'al1', name: 'Local Name' });
    seedBackupFile(
      'exclusions',
      exclusionMaps({
        excludedAlbums: {
          al1: { id: 'al1', name: 'File Name' },
          al2: { id: 'al2', name: 'New' },
        },
      }),
    );

    const counts = await restoreBackup(backupEntry({ exclusions: 2 }), 'merge');
    await settle();

    expect(counts).toMatchObject({ scrobbleExclusionCount: 1, scrobbleExclusionSkipped: 1 });
    const maps = await readScrobbleExclusions();
    expect(maps?.excludedAlbums.al1.name).toBe('Local Name');
    expect(maps?.excludedAlbums.al2.name).toBe('New');
  });
});

/* ------------------------------------------------------------------ */
/*  Replace mode — the inversion bug                                   */
/* ------------------------------------------------------------------ */

describe('restoreBackup — replace mode', () => {
  it('holds the file’s overrides and NOT the previous ones', async () => {
    await seedExistingOverrides(override('artist', 'old-1'), override('album', 'old-2'));
    seedBackupFile('mbid', overrideMap(override('artist', 'new-1'), override('album', 'new-2')));

    const counts = await restoreBackup(backupEntry({ mbid: 2 }), 'replace');
    await settle();

    expect(counts.mbidOverrideCount).toBe(2);
    // Present: the file's. Absent: the ones the user asked to replace.
    expect(overrideIds()).toEqual(['album:new-2', 'artist:new-1']);
    expect(Object.keys(mbidOverrideStore.getState().overrides).sort()).toEqual([
      'album:new-2',
      'artist:new-1',
    ]);
  });

  it('holds the file’s exclusions and NOT the previous ones', async () => {
    await seedExistingExclusions(
      { type: 'album', id: 'old-1', name: 'Old' },
      { type: 'playlist', id: 'old-2', name: 'Old' },
    );
    seedBackupFile(
      'exclusions',
      exclusionMaps({ excludedArtists: { 'new-1': { id: 'new-1', name: 'New' } } }),
    );

    const counts = await restoreBackup(backupEntry({ exclusions: 1 }), 'replace');
    await settle();

    expect(counts.scrobbleExclusionCount).toBe(1);
    expect(exclusionIds()).toEqual(['artist:new-1']);
    const state = scrobbleExclusionStore.getState();
    expect(state.excludedAlbums).toEqual({});
    expect(state.excludedPlaylists).toEqual({});
    expect(state.excludedArtists['new-1'].name).toBe('New');
  });

  it('clears the rows when the file holds nothing valid', async () => {
    await seedExistingExclusions({ type: 'album', id: 'old-1', name: 'Old' });
    seedBackupFile(
      'exclusions',
      exclusionMaps({ excludedAlbums: { bad: { name: 'no id' } as ScrobbleExclusion } }),
    );

    const counts = await restoreBackup(backupEntry({ exclusions: 1 }), 'replace');
    await settle();

    expect(counts.scrobbleExclusionCount).toBe(0);
    expect(exclusionIds()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Failure part-way                                                   */
/* ------------------------------------------------------------------ */

describe('a restore that fails part-way', () => {
  /** The DELETE and the INSERTs share one `runAtomicBatchAsync`, so a statement failing
   *  rolls the whole thing back. Simulated at the handle, because nothing a backup file
   *  can carry survives `storableOverrides` to poison a binding. */
  const failingDb = (): InternalDb =>
    ({
      ...realDb,
      runAtomicBatchAsync: async () => {
        throw new Error('disk full');
      },
    }) as unknown as InternalDb;

  it('leaves the old overrides whole rather than a mix of both', async () => {
    await seedExistingOverrides(override('artist', 'old-1'), override('album', 'old-2'));
    seedBackupFile('mbid', overrideMap(override('artist', 'new-1')));
    __setDbForTests(failingDb());

    await restoreBackup(backupEntry({ mbid: 1 }), 'replace');
    await settle();
    __setDbForTests(realDb);

    // The whole batch rolled back: the DELETE as well as the INSERT.
    expect(overrideIds()).toEqual(['album:old-2', 'artist:old-1']);
    // Memory takes the file either way — it is the KV blob's source, and today that is
    // what the user sees. The rows are the fail-safe half: never a mixed set.
    expect(Object.keys(mbidOverrideStore.getState().overrides)).toEqual(['artist:new-1']);
  });

  it('leaves the old exclusions whole rather than a mix of both', async () => {
    await seedExistingExclusions(
      { type: 'album', id: 'old-1', name: 'Old' },
      { type: 'artist', id: 'old-2', name: 'Old' },
    );
    seedBackupFile(
      'exclusions',
      exclusionMaps({ excludedPlaylists: { 'new-1': { id: 'new-1', name: 'New' } } }),
    );
    __setDbForTests(failingDb());

    await restoreBackup(backupEntry({ exclusions: 1 }), 'replace');
    await settle();
    __setDbForTests(realDb);

    expect(exclusionIds()).toEqual(['album:old-1', 'artist:old-2']);
  });

  it('writes nothing at all in merge mode', async () => {
    await seedExistingOverrides(override('artist', 'old-1'));
    seedBackupFile('mbid', overrideMap(override('artist', 'new-1')));
    __setDbForTests(failingDb());

    await restoreBackup(backupEntry({ mbid: 1 }), 'merge');
    await settle();
    __setDbForTests(realDb);

    expect(overrideIds()).toEqual(['artist:old-1']);
  });
});

/* ------------------------------------------------------------------ */
/*  The file format does not change                                    */
/* ------------------------------------------------------------------ */

describe('an old backup file', () => {
  /** The pre-`type` MBID shape: keyed by artist id, `{ artistId, artistName, mbid }`.
   *  `restoreBackup` normalises it. */
  const legacyOverrides = {
    'ar-legacy': { artistId: 'ar-legacy', artistName: 'Old Artist', mbid: 'mbid-legacy' },
  };

  /** The exclusions shape is unchanged — an old file is the same three maps. */
  const legacyExclusions = {
    excludedAlbums: { 'al-legacy': { id: 'al-legacy', name: 'Old Album' } },
    excludedArtists: {},
    excludedPlaylists: {},
  };

  it('restores the legacy override shape in replace mode', async () => {
    seedBackupFile('mbid', legacyOverrides);

    const counts = await restoreBackup(backupEntry({ mbid: 1 }), 'replace');
    await settle();

    expect(counts.mbidOverrideCount).toBe(1);
    expect(await readMbidOverrides()).toEqual([
      {
        type: 'artist',
        entityId: 'ar-legacy',
        entityName: 'Old Artist',
        mbid: 'mbid-legacy',
      },
    ]);
  });

  it('restores the legacy override shape in merge mode alongside a newer one', async () => {
    await seedExistingOverrides(override('album', 'al1'));
    seedBackupFile('mbid', legacyOverrides);

    await restoreBackup(backupEntry({ mbid: 1 }), 'merge');
    await settle();

    expect(overrideIds()).toEqual(['album:al1', 'artist:ar-legacy']);
  });

  it('restores an old exclusions file in both modes', async () => {
    seedBackupFile('exclusions', legacyExclusions);

    await restoreBackup(backupEntry({ exclusions: 1 }), 'replace');
    await settle();
    expect(exclusionIds()).toEqual(['album:al-legacy']);

    realDb.runSync('DELETE FROM scrobble_exclusions;');
    scrobbleExclusionStore.setState(exclusionMaps());
    await restoreBackup(backupEntry({ exclusions: 1 }), 'merge');
    await settle();
    expect(exclusionIds()).toEqual(['album:al-legacy']);
  });
});

/* ------------------------------------------------------------------ */
/*  Export                                                             */
/* ------------------------------------------------------------------ */

describe('createBackup — the two datasets', () => {
  const payloadFor = (suffix: string): unknown =>
    JSON.parse(
      (mockCompressToFile.mock.calls.find(([, uri]) =>
        String(uri).includes(`.${suffix}.gz`),
      )?.[0] ?? 'null') as string,
    );

  it('writes the same file shape as before — the store maps, unchanged', async () => {
    const overrides = overrideMap(override('artist', 'ar1'), override('album', 'al1'));
    mbidOverrideStore.setState({ overrides });
    const maps = exclusionMaps({
      excludedAlbums: { al1: { id: 'al1', name: 'Dark Side' } },
      excludedPlaylists: { pl1: { id: 'pl1', name: 'Sleep' } },
    });
    scrobbleExclusionStore.setState(maps);
    mockCompressToFile.mockResolvedValue({ bytes: 64 });

    await createBackup();

    expect(payloadFor('mbid')).toEqual(overrides);
    expect(payloadFor('exclusions')).toEqual(maps);

    const metaEntry = Array.from(mockFileInstances.entries()).find(([k]) =>
      k.endsWith('.meta.json'),
    );
    const meta = JSON.parse(metaEntry?.[1].content ?? '{}');
    expect(meta.mbidOverrides).toEqual({ itemCount: 2, sizeBytes: 64 });
    expect(meta.scrobbleExclusions).toEqual({ itemCount: 2, sizeBytes: 64 });
  });

  it('exports the stores, not the tables — a SQL-only row is not in the file', async () => {
    await seedExistingOverrides(override('artist', 'in-both'));
    // In SQL only: exporting from the repository would pick this up, and would drop
    // everything the (KV-hydrated) store holds that the table does not yet.
    realDb.runSync(
      "INSERT INTO mbid_overrides (type, entity_id, entity_name, mbid) " +
        "VALUES ('album', 'sql-only', 'SQL Only', 'mbid-x');",
    );
    mockCompressToFile.mockResolvedValue({ bytes: 10 });

    await createBackup();

    expect(Object.keys(payloadFor('mbid') as object)).toEqual(['artist:in-both']);
  });
});
