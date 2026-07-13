// detailTables-specific null-handle safety. The `dbHealthy` / `dbInitError`
// mechanics of the init-failure path itself live in `db.test.ts`; this file
// just proves that every detailTables public function gracefully falls
// through to its null-db default when `getDb()` returns null.
jest.mock('expo-sqlite', () => ({
  openDatabaseSync: () => ({
    getFirstSync: () => undefined,
    getAllSync: () => [],
    runSync: () => {},
    execSync: () => {},
    withTransactionSync: (fn: () => void) => fn(),
  }),
}));

import { __setDbForTests } from '../db';
import {
  countSongIndexAsync,
  getDetailedAlbumIdsAsync,
  hydrateAlbumDetails,
  upsertAlbumDetail,
} from '../detailTables';

describe('detailTables — null-handle safety', () => {
  beforeAll(() => {
    __setDbForTests(null);
  });

  afterAll(() => {
    __setDbForTests(null);
  });

  it('every public function gracefully falls through to null-db defaults', async () => {
    expect(() =>
      upsertAlbumDetail('x', { id: 'x', name: 'X', songCount: 0, duration: 0, created: '' } as any, 1),
    ).not.toThrow();
    expect((await getDetailedAlbumIdsAsync()).size).toBe(0);
    expect(await countSongIndexAsync()).toBe(0);
    expect(hydrateAlbumDetails()).toEqual({});
  });
});
