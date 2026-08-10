/**
 * `mbid_overrides` and `scrobble_exclusions` — the write path, the hydration gate and
 * migration 42 — against REAL SQL on the better-sqlite3-backed op-SQLite seam.
 *
 * The load-bearing case is the UNMIGRATED one. Both stores are `persist`-wrapped, so
 * every `set` re-serialises the partialized slice back to KV: a hydrate that read an
 * unfilled table as "empty" would write that emptiness over the only copy of a set the
 * user typed by hand. So the assertions here are as much about what does NOT happen as
 * what does.
 *
 * Per AGENTS.md §11 the seam proves SQL semantics, never concurrency.
 */
jest.mock('../kvStorage', () => require('../__mocks__/kvStorage'));

import { settleDbWrites } from '../../../test-utils/settleDbWrites';
import { __setDbForTests, getDb, type InternalDb } from '../db';
import { clearKvStorage, kvStorage } from '../kvStorage';
import { flushAllPersistStorages } from '../debouncedStorage';
import {
  deleteMbidOverride,
  readMbidOverrides,
  replaceMbidOverrides,
  writeMbidOverrides,
} from '../mbidOverrideTable';
import {
  deleteScrobbleExclusion,
  readScrobbleExclusions,
  replaceScrobbleExclusions,
  writeScrobbleExclusions,
} from '../scrobbleExclusionTable';
import { migrateUserDataFromKv } from '../userDataMigration';
import { mbidOverrideStore, type MbidOverride } from '../../mbidOverrideStore';
import { scrobbleExclusionStore } from '../../scrobbleExclusionStore';
import {
  MODEL_TABLES,
  normalizedTableNames,
  resetNormalizedSchema,
} from '../../../db/createNormalizedTables';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
const realDb: InternalDb = handle;

const OVERRIDES_KEY = 'substreamer-mbid-overrides';
const EXCLUSIONS_KEY = 'substreamer-scrobble-exclusions';

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

/** The blob exactly as each store's persist middleware wrote it. */
const seedOverridesBlob = async (
  overrides: Record<string, MbidOverride>,
  rest: Record<string, unknown> = {},
): Promise<void> => {
  await kvStorage.setItem(
    OVERRIDES_KEY,
    JSON.stringify({ state: { overrides, ...rest }, version: 0 }),
  );
};

const seedExclusionsBlob = async (
  maps: Record<string, unknown>,
  rest: Record<string, unknown> = {},
): Promise<void> => {
  await kvStorage.setItem(
    EXCLUSIONS_KEY,
    JSON.stringify({ state: { ...maps, ...rest }, version: 0 }),
  );
};

const readBlob = async (key: string): Promise<{ state?: Record<string, unknown> }> => {
  const raw = await kvStorage.getItem(key);
  return raw === null ? {} : JSON.parse(raw);
};

const logs: string[] = [];
const log = (message: string): void => {
  logs.push(message);
};

/** The store's write-throughs are fire-and-forget, and a batch is parked on
 *  op-SQLite's transaction lock — one macrotask each. */
const settle = settleDbWrites;

const partializeOf = (store: { persist: unknown }): ((state: unknown) => unknown) =>
  (store.persist as { getOptions: () => { partialize: (s: unknown) => unknown } })
    .getOptions()
    .partialize;

const overrideRows = (): Array<Record<string, unknown>> =>
  realDb.getAllSync('SELECT * FROM mbid_overrides ORDER BY type, entity_id;');

const exclusionRows = (): Array<Record<string, unknown>> =>
  realDb.getAllSync('SELECT * FROM scrobble_exclusions ORDER BY type, entity_id;');

beforeEach(async () => {
  __setDbForTests(realDb);
  logs.length = 0;
  realDb.runSync('DELETE FROM mbid_overrides;');
  realDb.runSync('DELETE FROM scrobble_exclusions;');
  mbidOverrideStore.setState({ overrides: {}, sqlAuthoritative: false });
  scrobbleExclusionStore.setState({
    excludedAlbums: {},
    excludedArtists: {},
    excludedPlaylists: {},
    sqlAuthoritative: false,
  });
  // Last: the resets above go through `persist`, which rewrites both blobs.
  await flushAllPersistStorages();
  clearKvStorage();
});

/* ------------------------------------------------------------------ */
/*  Round trip — mbid overrides                                        */
/* ------------------------------------------------------------------ */

describe('mbid_overrides', () => {
  it('round-trips a correction through the table', async () => {
    mbidOverrideStore.getState().setOverride('artist', 'ar1', 'Radiohead', 'mbid-1');
    mbidOverrideStore.getState().setOverride('album', 'al1', 'OK Computer', 'mbid-2');
    await settle();

    expect(await readMbidOverrides()).toEqual([
      { type: 'album', entityId: 'al1', entityName: 'OK Computer', mbid: 'mbid-2' },
      { type: 'artist', entityId: 'ar1', entityName: 'Radiohead', mbid: 'mbid-1' },
    ]);
  });

  it('keys on the composite, so the same id can carry both types', async () => {
    mbidOverrideStore.getState().setOverride('artist', 'id1', 'As Artist', 'mbid-a');
    mbidOverrideStore.getState().setOverride('album', 'id1', 'As Album', 'mbid-b');
    await settle();

    expect(overrideRows()).toHaveLength(2);
    const rows = await readMbidOverrides();
    expect(rows?.map((o) => o.mbid).sort()).toEqual(['mbid-a', 'mbid-b']);
  });

  it('updates in place rather than duplicating', async () => {
    mbidOverrideStore.getState().setOverride('artist', 'ar1', 'Radiohead', 'old');
    mbidOverrideStore.getState().setOverride('artist', 'ar1', 'Radiohead', 'new');
    await settle();

    expect(overrideRows()).toHaveLength(1);
    expect((await readMbidOverrides())?.[0].mbid).toBe('new');
  });

  it('deletes only the row it was asked to', async () => {
    mbidOverrideStore.getState().setOverride('artist', 'ar1', 'A', 'mbid-1');
    mbidOverrideStore.getState().setOverride('artist', 'ar2', 'B', 'mbid-2');
    await settle();
    mbidOverrideStore.getState().removeOverride('artist', 'ar1');
    await settle();

    expect((await readMbidOverrides())?.map((o) => o.entityId)).toEqual(['ar2']);
  });

  it('clears the table with the map', async () => {
    mbidOverrideStore.getState().setOverride('artist', 'ar1', 'A', 'mbid-1');
    await settle();
    mbidOverrideStore.getState().clearOverrides();
    await settle();

    expect(await readMbidOverrides()).toEqual([]);
  });

  it('reads NULL, not an empty list, when the DB is unavailable', async () => {
    __setDbForTests(null);
    expect(await readMbidOverrides()).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Round trip — scrobble exclusions                                   */
/* ------------------------------------------------------------------ */

describe('scrobble_exclusions', () => {
  it('round-trips all three types through one table', async () => {
    scrobbleExclusionStore.getState().addExclusion('album', 'al1', 'Dark Side');
    scrobbleExclusionStore.getState().addExclusion('artist', 'ar1', 'Pink Floyd');
    scrobbleExclusionStore.getState().addExclusion('playlist', 'pl1', 'Sleep');
    await settle();

    expect(exclusionRows()).toHaveLength(3);
    expect(await readScrobbleExclusions()).toEqual({
      excludedAlbums: { al1: { id: 'al1', name: 'Dark Side' } },
      excludedArtists: { ar1: { id: 'ar1', name: 'Pink Floyd' } },
      excludedPlaylists: { pl1: { id: 'pl1', name: 'Sleep' } },
    });
  });

  it('keys on the composite, so one id can be excluded as two types', async () => {
    scrobbleExclusionStore.getState().addExclusion('album', 'id1', 'As Album');
    scrobbleExclusionStore.getState().addExclusion('artist', 'id1', 'As Artist');
    await settle();
    scrobbleExclusionStore.getState().removeExclusion('album', 'id1');
    await settle();

    const maps = await readScrobbleExclusions();
    expect(maps?.excludedAlbums).toEqual({});
    expect(maps?.excludedArtists.id1).toEqual({ id: 'id1', name: 'As Artist' });
  });

  it('ignores a row whose type is not one of the three', async () => {
    realDb.runSync(
      "INSERT INTO scrobble_exclusions (type, entity_id, name) VALUES ('podcast', 'p1', 'X');",
    );
    expect(await readScrobbleExclusions()).toEqual({
      excludedAlbums: {},
      excludedArtists: {},
      excludedPlaylists: {},
    });
  });

  it('reads NULL, not empty maps, when the DB is unavailable', async () => {
    __setDbForTests(null);
    expect(await readScrobbleExclusions()).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  The hydration gate — the data-loss guard                           */
/* ------------------------------------------------------------------ */

describe('an unmigrated store', () => {
  it('still serves its overrides from KV and is not read as empty', async () => {
    // What the launch before migration 42 looks like: the blob holds the set, the table
    // is empty because nothing has written through yet.
    const held = overrideMap(override('artist', 'ar1'), override('album', 'al1'));
    mbidOverrideStore.setState({ overrides: held, sqlAuthoritative: false });

    await mbidOverrideStore.getState().hydrateFromDbAsync();

    expect(mbidOverrideStore.getState().overrides).toEqual(held);
    expect(mbidOverrideStore.getState().sqlAuthoritative).toBe(false);
    // And the blob keeps being written, so the only complete copy survives the launch.
    // Asserted on the KV row itself, not just the partialize shape: the whole hazard is
    // that a `set` after an empty read re-serialises that emptiness over it.
    expect(partializeOf(mbidOverrideStore)(mbidOverrideStore.getState())).toEqual({
      overrides: held,
    });
    await flushAllPersistStorages();
    expect((await readBlob(OVERRIDES_KEY)).state).toEqual({ overrides: held });
  });

  it('still serves its exclusions from KV and is not read as empty', async () => {
    const held = {
      excludedAlbums: { al1: { id: 'al1', name: 'Dark Side' } },
      excludedArtists: {},
      excludedPlaylists: { pl1: { id: 'pl1', name: 'Sleep' } },
    };
    scrobbleExclusionStore.setState({ ...held, sqlAuthoritative: false });

    await scrobbleExclusionStore.getState().hydrateFromDbAsync();

    const state = scrobbleExclusionStore.getState();
    expect(state.excludedAlbums).toEqual(held.excludedAlbums);
    expect(state.excludedPlaylists).toEqual(held.excludedPlaylists);
    expect(state.sqlAuthoritative).toBe(false);
    expect(partializeOf(scrobbleExclusionStore)(state)).toEqual(held);
  });

  it('is not blanked by a failed DB open either', async () => {
    const held = overrideMap(override('artist', 'ar1'));
    mbidOverrideStore.setState({ overrides: held, sqlAuthoritative: false });
    __setDbForTests(null);

    await mbidOverrideStore.getState().hydrateFromDbAsync();

    expect(mbidOverrideStore.getState().overrides).toEqual(held);
    expect(mbidOverrideStore.getState().sqlAuthoritative).toBe(false);
  });

  it('keeps the gate shut when a row holds a different mbid than memory', async () => {
    const held = overrideMap(override('artist', 'ar1', { mbid: 'the-users-edit' }));
    realDb.runSync(
      "INSERT INTO mbid_overrides (type, entity_id, entity_name, mbid) " +
        "VALUES ('artist', 'ar1', 'Name ar1', 'stale');",
    );
    mbidOverrideStore.setState({ overrides: held, sqlAuthoritative: false });

    await mbidOverrideStore.getState().hydrateFromDbAsync();

    // The row is present but its content is not what memory holds, so the KV copy stays
    // authoritative rather than the launch reverting the user's latest edit.
    expect(mbidOverrideStore.getState().overrides).toEqual(held);
    expect(mbidOverrideStore.getState().sqlAuthoritative).toBe(false);
  });

  it('keeps the gate shut when an exclusion is missing from the rows', async () => {
    scrobbleExclusionStore.getState().addExclusion('album', 'al1', 'Stored');
    await settle();
    // A second one that only ever reached memory + KV.
    scrobbleExclusionStore.setState((s) => ({
      excludedArtists: { ...s.excludedArtists, ar1: { id: 'ar1', name: 'KV only' } },
    }));

    await scrobbleExclusionStore.getState().hydrateFromDbAsync();

    expect(scrobbleExclusionStore.getState().excludedArtists.ar1).toBeDefined();
    expect(scrobbleExclusionStore.getState().sqlAuthoritative).toBe(false);
  });
});

describe('a migrated store', () => {
  it('flips to the rows and stops writing the overrides blob', async () => {
    mbidOverrideStore.getState().setOverride('artist', 'ar1', 'Radiohead', 'mbid-1');
    await settle();
    // A row saved by another device / an earlier run that memory has never seen.
    realDb.runSync(
      "INSERT INTO mbid_overrides (type, entity_id, entity_name, mbid) " +
        "VALUES ('album', 'al9', 'From The Rows', 'mbid-9');",
    );

    await mbidOverrideStore.getState().hydrateFromDbAsync();

    expect(mbidOverrideStore.getState().sqlAuthoritative).toBe(true);
    expect(Object.keys(mbidOverrideStore.getState().overrides).sort()).toEqual([
      'album:al9',
      'artist:ar1',
    ]);
    // The retirement of the KV copy, on the row itself.
    expect(partializeOf(mbidOverrideStore)(mbidOverrideStore.getState())).toEqual({});
    await flushAllPersistStorages();
    expect((await readBlob(OVERRIDES_KEY)).state).toEqual({});
  });

  it('flips to the rows and stops writing the exclusions blob', async () => {
    scrobbleExclusionStore.getState().addExclusion('album', 'al1', 'Dark Side');
    await settle();

    await scrobbleExclusionStore.getState().hydrateFromDbAsync();

    expect(scrobbleExclusionStore.getState().sqlAuthoritative).toBe(true);
    expect(scrobbleExclusionStore.getState().excludedAlbums.al1.name).toBe('Dark Side');
    expect(partializeOf(scrobbleExclusionStore)(scrobbleExclusionStore.getState())).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/*  Migration 42                                                       */
/* ------------------------------------------------------------------ */

describe('migrateUserDataFromKv', () => {
  it('moves both blobs into rows and strips only the migrated fields', async () => {
    await seedOverridesBlob(overrideMap(override('artist', 'ar1'), override('album', 'al1')));
    await seedExclusionsBlob(
      {
        excludedAlbums: { al1: { id: 'al1', name: 'Dark Side' } },
        excludedArtists: { ar1: { id: 'ar1', name: 'Pink Floyd' } },
        excludedPlaylists: {},
      },
      { someOtherSetting: 'kept' },
    );

    await migrateUserDataFromKv(log);

    expect((await readMbidOverrides())?.map((o) => o.entityId).sort()).toEqual(['al1', 'ar1']);
    const maps = await readScrobbleExclusions();
    expect(maps?.excludedAlbums.al1.name).toBe('Dark Side');
    expect(maps?.excludedArtists.ar1.name).toBe('Pink Floyd');

    expect((await readBlob(OVERRIDES_KEY)).state).toEqual({});
    // Everything else sharing the envelope survives — it has no table of its own.
    expect((await readBlob(EXCLUSIONS_KEY)).state).toEqual({ someOtherSetting: 'kept' });
  });

  it('is idempotent', async () => {
    await seedOverridesBlob(overrideMap(override('artist', 'ar1')));
    await seedExclusionsBlob({ excludedAlbums: { al1: { id: 'al1', name: 'Dark Side' } } });

    await migrateUserDataFromKv(log);
    await migrateUserDataFromKv(log);

    expect(overrideRows()).toHaveLength(1);
    expect(exclusionRows()).toHaveLength(1);
  });

  it('adds to the rows without removing one the blob does not mention', async () => {
    // Saved after the upgrade but before the migration: it exists as a row while the
    // blob still lags behind it. A replacing write would delete it.
    realDb.runSync(
      "INSERT INTO mbid_overrides (type, entity_id, entity_name, mbid) " +
        "VALUES ('album', 'al9', 'Saved Since', 'mbid-9');",
    );
    await seedOverridesBlob(overrideMap(override('artist', 'ar1')));

    await migrateUserDataFromKv(log);

    expect((await readMbidOverrides())?.map((o) => o.entityId).sort()).toEqual(['al9', 'ar1']);
  });

  it('drops entries that could never store rather than aborting the batch', async () => {
    await seedOverridesBlob({
      'artist:ar1': override('artist', 'ar1'),
      'artist:bad': { type: 'artist', entityId: 'bad', entityName: 'No Mbid' } as MbidOverride,
      'artist:null': null as unknown as MbidOverride,
    });

    await migrateUserDataFromKv(log);

    expect((await readMbidOverrides())?.map((o) => o.entityId)).toEqual(['ar1']);
    expect((await readBlob(OVERRIDES_KEY)).state).toEqual({});
  });

  it('leaves the KV blob intact and the gate shut when the rows refuse the write', async () => {
    const blob = overrideMap(override('artist', 'ar1'));
    await seedOverridesBlob(blob);
    __setDbForTests({
      ...realDb,
      runAtomicBatchAsync: async () => {
        throw new Error('disk full');
      },
    } as unknown as InternalDb);

    await expect(migrateUserDataFromKv(log)).rejects.toThrow('did not store');

    // The counter does not advance, so the next launch retries — with the only copy of
    // the user's corrections still on disk.
    expect((await readBlob(OVERRIDES_KEY)).state).toEqual({ overrides: blob });

    __setDbForTests(realDb);
    mbidOverrideStore.setState({ overrides: blob, sqlAuthoritative: false });
    await mbidOverrideStore.getState().hydrateFromDbAsync();
    expect(mbidOverrideStore.getState().sqlAuthoritative).toBe(false);
    expect(mbidOverrideStore.getState().overrides).toEqual(blob);
  });

  it('throws rather than stripping the blob when the rows cannot be read back', async () => {
    const blob = overrideMap(override('artist', 'ar1'));
    await seedOverridesBlob(blob);
    __setDbForTests({
      ...realDb,
      getAllAsync: async () => {
        throw new Error('io error');
      },
    } as unknown as InternalDb);

    await expect(migrateUserDataFromKv(log)).rejects.toThrow('unreadable');
    expect((await readBlob(OVERRIDES_KEY)).state).toEqual({ overrides: blob });
  });

  it('leaves the exclusions blob intact when its rows refuse the write', async () => {
    const maps = { excludedAlbums: { al1: { id: 'al1', name: 'Dark Side' } } };
    await seedExclusionsBlob(maps);
    __setDbForTests({
      ...realDb,
      runAtomicBatchAsync: async () => {
        throw new Error('disk full');
      },
    } as unknown as InternalDb);

    await expect(migrateUserDataFromKv(log)).rejects.toThrow(
      'scrobble exclusions did not store',
    );

    __setDbForTests(realDb);
    expect((await readBlob(EXCLUSIONS_KEY)).state).toEqual(maps);
  });

  it('throws rather than stripping the exclusions blob when the rows cannot be read', async () => {
    const maps = { excludedAlbums: { al1: { id: 'al1', name: 'Dark Side' } } };
    await seedExclusionsBlob(maps);
    let reads = 0;
    __setDbForTests({
      ...realDb,
      // The overrides half has no blob here, so the first read is the exclusions one.
      getAllAsync: async () => {
        reads++;
        throw new Error('io error');
      },
    } as unknown as InternalDb);

    await expect(migrateUserDataFromKv(log)).rejects.toThrow(
      'scrobble_exclusions unreadable',
    );

    __setDbForTests(realDb);
    expect(reads).toBeGreaterThan(0);
    expect((await readBlob(EXCLUSIONS_KEY)).state).toEqual(maps);
  });

  it('stops before the exclusions half when the overrides half throws', async () => {
    await seedOverridesBlob(overrideMap(override('artist', 'ar1')));
    await seedExclusionsBlob({ excludedAlbums: { al1: { id: 'al1', name: 'Dark Side' } } });
    __setDbForTests({
      ...realDb,
      runAtomicBatchAsync: async () => {
        throw new Error('disk full');
      },
    } as unknown as InternalDb);

    await expect(migrateUserDataFromKv(log)).rejects.toThrow();

    __setDbForTests(realDb);
    expect((await readBlob(EXCLUSIONS_KEY)).state).toHaveProperty('excludedAlbums');
  });

  it('is a clean no-op on a fresh install', async () => {
    await migrateUserDataFromKv(log);

    expect(overrideRows()).toEqual([]);
    expect(exclusionRows()).toEqual([]);
    expect(logs.join('\n')).toContain('nothing to migrate');
  });

  it('leaves an unparseable blob in place', async () => {
    await kvStorage.setItem(OVERRIDES_KEY, '{not json');

    await migrateUserDataFromKv(log);

    expect(await kvStorage.getItem(OVERRIDES_KEY)).toBe('{not json');
    expect(logs.join('\n')).toContain('unparseable');
  });

  it('strips nothing when the blob holds no migratable entry', async () => {
    await seedOverridesBlob({}, { keepMe: 1 });

    await migrateUserDataFromKv(log);

    expect((await readBlob(OVERRIDES_KEY)).state).toEqual({ overrides: {}, keepMe: 1 });
  });
});

/* ------------------------------------------------------------------ */
/*  A hostile handle                                                   */
/* ------------------------------------------------------------------ */

describe('the table helpers', () => {
  const overrideOne = override('artist', 'ar1');
  const exclusionOne = { type: 'album' as const, id: 'al1', name: 'Dark Side' };

  const allWrites = async (): Promise<void> => {
    await writeMbidOverrides([overrideOne]);
    await replaceMbidOverrides([overrideOne]);
    await deleteMbidOverride('artist', 'ar1');
    await writeScrobbleExclusions([exclusionOne]);
    await replaceScrobbleExclusions([exclusionOne]);
    await deleteScrobbleExclusion('album', 'al1');
  };

  it('are silent no-ops when the DB is unavailable', async () => {
    __setDbForTests(null);
    await expect(allWrites()).resolves.toBeUndefined();

    __setDbForTests(realDb);
    expect(overrideRows()).toEqual([]);
    expect(exclusionRows()).toEqual([]);
  });

  it('swallow a failing write rather than throwing at the caller', async () => {
    __setDbForTests({
      ...realDb,
      runAtomicBatchAsync: async () => {
        throw new Error('disk full');
      },
      runAsync: async () => {
        throw new Error('disk full');
      },
    } as unknown as InternalDb);

    await expect(allWrites()).resolves.toBeUndefined();
  });

  it('read NULL when the query itself fails', async () => {
    __setDbForTests({
      ...realDb,
      getAllAsync: async () => {
        throw new Error('io error');
      },
    } as unknown as InternalDb);

    expect(await readMbidOverrides()).toBeNull();
    expect(await readScrobbleExclusions()).toBeNull();
  });

  it('write nothing for an empty list rather than issuing a batch', async () => {
    let batches = 0;
    __setDbForTests({
      ...realDb,
      runAtomicBatchAsync: async () => {
        batches++;
      },
    } as unknown as InternalDb);

    await writeMbidOverrides([]);
    await writeScrobbleExclusions([]);

    expect(batches).toBe(0);
  });

  it('normalise display text that is not a string rather than binding it', async () => {
    await writeMbidOverrides([
      { ...overrideOne, entityName: undefined as unknown as string },
    ]);
    await writeScrobbleExclusions([
      { ...exclusionOne, name: 42 as unknown as string },
    ]);

    expect(overrideRows()[0].entity_name).toBe('');
    expect(exclusionRows()[0].name).toBe('');
    expect((await readMbidOverrides())?.[0].entityName).toBe('');
    expect((await readScrobbleExclusions())?.excludedAlbums.al1.name).toBe('');
  });

  it('read a NULL display column back as an empty string', async () => {
    realDb.runSync(
      "INSERT INTO mbid_overrides (type, entity_id, entity_name, mbid) " +
        "VALUES ('artist', 'ar1', NULL, 'mbid-1');",
    );
    realDb.runSync(
      "INSERT INTO scrobble_exclusions (type, entity_id, name) VALUES ('album', 'al1', NULL);",
    );

    expect((await readMbidOverrides())?.[0].entityName).toBe('');
    expect((await readScrobbleExclusions())?.excludedAlbums.al1.name).toBe('');
  });

  it('do not strand the gate on display text that is not a string', async () => {
    // The write coerces to NULL and the read to `''`; the gate normalises memory the
    // same way, so an entry a hand-edited backup produced still flips.
    mbidOverrideStore.setState({
      overrides: { 'artist:ar1': { ...overrideOne, entityName: undefined as unknown as string } },
      sqlAuthoritative: false,
    });
    await writeMbidOverrides([
      { ...overrideOne, entityName: undefined as unknown as string },
    ]);

    await mbidOverrideStore.getState().hydrateFromDbAsync();

    expect(mbidOverrideStore.getState().sqlAuthoritative).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Logout                                                             */
/* ------------------------------------------------------------------ */

describe('logout', () => {
  it('drops both tables — they are MODEL, keyed by server-scoped ids', async () => {
    mbidOverrideStore.getState().setOverride('artist', 'ar1', 'Radiohead', 'mbid-1');
    scrobbleExclusionStore.getState().addExclusion('album', 'al1', 'Dark Side');
    await settle();
    expect(overrideRows()).toHaveLength(1);
    expect(exclusionRows()).toHaveLength(1);

    expect(MODEL_TABLES).toContain('mbid_overrides');
    expect(MODEL_TABLES).toContain('scrobble_exclusions');
    expect(normalizedTableNames()).toEqual(
      expect.arrayContaining(['mbid_overrides', 'scrobble_exclusions']),
    );

    resetNormalizedSchema(realDb);

    // Recreated and empty, exactly as a different account needs them.
    expect(overrideRows()).toEqual([]);
    expect(exclusionRows()).toEqual([]);
  });
});
