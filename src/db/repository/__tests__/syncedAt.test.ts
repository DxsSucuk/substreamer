/**
 * `synced_at` — the stamp every `albums`/`songs` writer leaves, against REAL SQL on
 * the better-sqlite3-backed op-SQLite substitute.
 *
 * It lives in `bulkUpsert`, so it has to hold under BOTH upsert policies. The merge
 * policy is `COALESCE(excluded.col, col)`; the stamp is always supplied, so `excluded`
 * is never NULL and wins — asserted here rather than assumed, because a supplementary
 * writer that failed to refresh it would leave a live row looking stale.
 */
import type { AlbumID3, Child } from 'subsonic-api';

import { getDb } from '../../../store/persistence/db';
import { ensureNormalizedSchema } from '../../createNormalizedTables';
import { upsertAlbums } from '../albums';
import { upsertArtists } from '../artists';
import { upsertSongs } from '../songs';

const db = () => getDb()!;

/** A fixed epoch to key every assertion off — never the wall clock. */
const E = 1_800_000_000_000;

/** Run a write with the clock pinned, so the stamp is a value the test chose. */
async function at<T>(nowMs: number, run: () => Promise<T>): Promise<T> {
  const spy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

const stampOf = (table: 'albums' | 'songs', id: string): number | null =>
  db().getFirstSync<{ synced_at: number | null }>(
    `SELECT synced_at FROM ${table} WHERE id = ?`,
    [id],
  )?.synced_at ?? null;

const album = (id: string, extra: Partial<AlbumID3> = {}): AlbumID3 => ({
  id,
  name: `Album ${id}`,
  created: new Date('2020-01-01'),
  duration: 100,
  songCount: 1,
  ...extra,
});
const song = (id: string, extra: Partial<Child> = {}): Child =>
  ({ id, title: `Song ${id}`, isDir: false, ...extra }) as Child;

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  for (const t of ['albums', 'songs', 'artists']) db().runSync(`DELETE FROM ${t}`);
});

describe('synced_at — stamped by the shared write layer', () => {
  it('an authoritative write stamps both albums and songs', async () => {
    await at(E, async () => {
      await upsertAlbums(db(), [album('a1')]);
      await upsertSongs(db(), [song('s1', { albumId: 'a1' })]);
    });

    expect(stampOf('albums', 'a1')).toBe(E);
    expect(stampOf('songs', 's1')).toBe(E);
  });

  it('a merge write refreshes the stamp AND keeps the columns its payload omits', async () => {
    await at(E, () =>
      upsertAlbums(db(), [album('a1', { year: 1999, genre: 'Rock', musicBrainzId: 'mb-1' })]),
    );

    // The supplementary shape (an artist's album array): the same album, none of the
    // detail columns.
    await at(E + 60_000, () =>
      upsertAlbums(db(), [album('a1')], undefined, undefined, { merge: true }),
    );

    const row = db().getFirstSync<{
      year: number | null;
      genre: string | null;
      music_brainz_id: string | null;
      synced_at: number | null;
    }>('SELECT year, genre, music_brainz_id, synced_at FROM albums WHERE id = ?', ['a1']);

    // COALESCE protected the omitted columns …
    expect(row).toMatchObject({ year: 1999, genre: 'Rock', music_brainz_id: 'mb-1' });
    // … and did NOT protect the stamp, which is supplied on every write.
    expect(row?.synced_at).toBe(E + 60_000);
  });

  it('an out-of-band write is never older than the run that preceded it', async () => {
    // A full run at E.
    await at(E, async () => {
      await upsertAlbums(db(), [album('a1')]);
      await upsertSongs(db(), [song('s1', { albumId: 'a1' })]);
    });

    // A detail fetch (authoritative) and a carousel refresh (merge) landing after it.
    await at(E + 5_000, () => upsertSongs(db(), [song('s1', { albumId: 'a1' })]));
    await at(E + 5_000, () =>
      upsertAlbums(db(), [album('a1')], undefined, undefined, { merge: true }),
    );

    expect(stampOf('albums', 'a1')).toBeGreaterThanOrEqual(E);
    expect(stampOf('songs', 's1')).toBeGreaterThanOrEqual(E);
    expect(stampOf('albums', 'a1')).toBe(E + 5_000);
    expect(stampOf('songs', 's1')).toBe(E + 5_000);
  });

  it('a row that predates the column is stamped on its next write', async () => {
    db().runSync("INSERT INTO albums (id, name) VALUES ('a-old', 'Legacy')");
    db().runSync("INSERT INTO songs (id, title) VALUES ('s-old', 'Legacy')");
    expect(stampOf('albums', 'a-old')).toBeNull();
    expect(stampOf('songs', 's-old')).toBeNull();

    // Merge is the harder case: the row's own value is NULL, so only the supplied
    // stamp can satisfy the COALESCE.
    await at(E, () => upsertAlbums(db(), [album('a-old')], undefined, undefined, { merge: true }));
    await at(E, () => upsertSongs(db(), [song('s-old')]));

    expect(stampOf('albums', 'a-old')).toBe(E);
    expect(stampOf('songs', 's-old')).toBe(E);
  });

  it('leaves artists and playlists unstamped — both reconcile by set difference', async () => {
    for (const table of ['artists', 'playlists']) {
      expect(
        db().getAllSync<{ name: string }>(`PRAGMA table_info("${table}")`).map((r) => r.name),
      ).not.toContain('synced_at');
    }
    // The same write layer, so a stamp keyed on the wrong table set would fail here
    // with `no such column`.
    await at(E, () => upsertArtists(db(), [{ id: 'ar1', name: 'Artist', albumCount: 1 }]));
    expect(
      db().getFirstSync<{ id: string }>('SELECT id FROM artists WHERE id = ?', ['ar1'])?.id,
    ).toBe('ar1');
  });
});
