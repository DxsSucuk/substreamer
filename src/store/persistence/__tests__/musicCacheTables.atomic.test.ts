/**
 * `markDownloadComplete` and `orphanSongIfUnreferencedAsync` against REAL SQL.
 *
 * Both push their decisions into the statements themselves — SQL-computed edge
 * positions on one side, self-guarded destructive statements on the other — so
 * neither can be asserted through `musicCacheTables.test.ts`'s hand-rolled
 * string-matching fake, which models neither the foreign keys nor
 * `UNIQUE (item_id, song_id)` those decisions turn on. This suite runs against
 * the generated schema (`src/db/normalizedDdl.ts`, created at import by
 * `persistence/db.ts`) on the better-sqlite3-backed op-SQLite seam, which
 * enables `PRAGMA foreign_keys`.
 */
import type { Child } from 'subsonic-api';

import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  insertCachedItemSong,
  insertDownloadQueueItem,
  markDownloadComplete,
  orphanSongIfUnreferencedAsync,
  upsertCachedItem,
  upsertCachedSong,
  type CachedItemRow,
  type CachedSongRow,
  type DownloadQueueRow,
} from '../musicCacheTables';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
const realDb: InternalDb = handle;

/* ------------------------------------------------------------------ */
/*  Fixtures + raw readers                                             */
/* ------------------------------------------------------------------ */

type ItemInput = Omit<CachedItemRow, 'songIds'>;

const makeItem = (overrides: Partial<ItemInput> = {}): ItemInput => ({
  itemId: 'alb-1',
  type: 'album',
  name: 'Album One',
  artist: 'Artist One',
  coverArtId: 'cov-1',
  expectedSongCount: 3,
  lastSyncAt: 1_700_000_000_000,
  downloadedAt: 1_700_000_000_000,
  ...overrides,
});

const makeSong = (overrides: Partial<CachedSongRow> = {}): CachedSongRow => ({
  id: 's1',
  title: 'Track One',
  artist: 'Artist One',
  album: 'Album One',
  albumId: 'alb-1',
  coverArt: 'cov-1',
  bytes: 1_000_000,
  duration: 240,
  suffix: 'mp3',
  formatCapturedAt: 1_700_000_000_000,
  downloadedAt: 1_700_000_000_000,
  ...overrides,
});

const makeQueueRow = (overrides: Partial<DownloadQueueRow> = {}): DownloadQueueRow => ({
  queueId: 'q-1',
  itemId: 'alb-1',
  type: 'album',
  name: 'Album One',
  status: 'queued',
  totalSongs: 3,
  completedSongs: 0,
  addedAt: 1_700_000_000_000,
  queuePosition: 1,
  songsJson: '[]',
  ...overrides,
});

/** Edges for an item in position order — the shape every positional assertion uses. */
const edgesOf = (itemId: string): Array<{ position: number; song_id: string }> =>
  realDb.getAllSync<{ position: number; song_id: string }>(
    'SELECT position, song_id FROM cached_item_songs WHERE item_id = ? ORDER BY position;',
    [itemId],
  );

const positionsOf = (itemId: string): number[] => edgesOf(itemId).map((e) => e.position);
const songOrderOf = (itemId: string): string[] => edgesOf(itemId).map((e) => e.song_id);

const count = (table: string, where = '', params: readonly unknown[] = []): number =>
  realDb.getFirstSync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM ${table} ${where};`,
    params,
  )?.c ?? -1;

const songExists = (songId: string): boolean =>
  count('cached_songs', 'WHERE song_id = ?', [songId]) === 1;

const itemExists = (itemId: string): boolean =>
  count('cached_items', 'WHERE item_id = ?', [itemId]) === 1;

/**
 * Seed a holder with dense 1..N edges over the given songs. `order` controls the
 * INSERT sequence and therefore the rowid order: `'descending'` reproduces what
 * `reorderCachedItemSongs` leaves behind, which is the layout that makes a naive
 * `position = position - 1` shift fail the composite PK.
 */
async function seedHolder(
  itemId: string,
  songIds: string[],
  opts: { derived?: boolean; order?: 'ascending' | 'descending' } = {},
): Promise<void> {
  await upsertCachedItem(
    makeItem({
      itemId,
      expectedSongCount: songIds.length,
      ...(opts.derived === true ? { derived: true } : {}),
    }),
  );
  const slots = songIds.map((songId, i) => ({ songId, position: i + 1 }));
  if (opts.order === 'descending') slots.reverse();
  for (const slot of slots) {
    // eslint-disable-next-line no-await-in-loop
    await upsertCachedSong(makeSong({ id: slot.songId }));
    // eslint-disable-next-line no-await-in-loop
    await insertCachedItemSong(itemId, slot.position, slot.songId);
  }
}

/** Children before parents so the wipe doesn't depend on cascade order. */
const TABLES_TO_CLEAR = [
  'cached_song_genres',
  'cached_song_artists',
  'cached_song_album_artists',
  'cached_song_contributors',
  'cached_song_moods',
  'cached_albums',
  'cached_playlists',
  'cached_item_songs',
  'download_queue',
  'cached_items',
  'cached_songs',
] as const;

beforeEach(() => {
  __setDbForTests(realDb);
  for (const table of TABLES_TO_CLEAR) realDb.runSync(`DELETE FROM ${table};`);
});

afterEach(() => {
  __setDbForTests(realDb);
});

/* ------------------------------------------------------------------ */
/*  markDownloadComplete                                               */
/* ------------------------------------------------------------------ */

describe('markDownloadComplete (real SQL)', () => {
  it('drops the queue row and writes item + songs + dense 1..N edges', async () => {
    await insertDownloadQueueItem(makeQueueRow());
    await markDownloadComplete(
      'q-1',
      makeItem(),
      [makeSong({ id: 's1' }), makeSong({ id: 's2' }), makeSong({ id: 's3' })],
      [
        { songId: 's1', position: 1 },
        { songId: 's2', position: 2 },
        { songId: 's3', position: 3 },
      ],
    );

    expect(count('download_queue')).toBe(0);
    expect(itemExists('alb-1')).toBe(true);
    expect(count('cached_songs')).toBe(3);
    expect(edgesOf('alb-1')).toEqual([
      { position: 1, song_id: 's1' },
      { position: 2, song_id: 's2' },
      { position: 3, song_id: 's3' },
    ]);
  });

  it('orders edges by the caller position, not by array order', async () => {
    await markDownloadComplete(
      'q-1',
      makeItem(),
      [makeSong({ id: 's1' }), makeSong({ id: 's2' }), makeSong({ id: 's3' })],
      [
        { songId: 's3', position: 30 },
        { songId: 's1', position: 10 },
        { songId: 's2', position: 20 },
      ],
    );
    expect(songOrderOf('alb-1')).toEqual(['s1', 's2', 's3']);
    expect(positionsOf('alb-1')).toEqual([1, 2, 3]);
  });

  it('appends after the edges an item already holds (top-up)', async () => {
    await seedHolder('alb-1', ['s1', 's2']);
    await markDownloadComplete(
      'q-1',
      makeItem(),
      [makeSong({ id: 's3' }), makeSong({ id: 's4' })],
      [
        { songId: 's3', position: 1 },
        { songId: 's4', position: 2 },
      ],
    );
    expect(edgesOf('alb-1')).toEqual([
      { position: 1, song_id: 's1' },
      { position: 2, song_id: 's2' },
      { position: 3, song_id: 's3' },
      { position: 4, song_id: 's4' },
    ]);
  });

  it('leaves NO hole when a re-sent song is already an edge of the item', async () => {
    // The regression: a JS position counter advances past the ignored duplicate
    // and strands `1,2,4`, which breaks the store's `songIds[position-1]` mapping.
    await seedHolder('alb-1', ['s1', 's2']);
    await markDownloadComplete(
      'q-1',
      makeItem(),
      [makeSong({ id: 's1' }), makeSong({ id: 's3' })],
      [
        { songId: 's1', position: 1 },
        { songId: 's3', position: 2 },
      ],
    );
    expect(positionsOf('alb-1')).toEqual([1, 2, 3]);
    expect(songOrderOf('alb-1')).toEqual(['s1', 's2', 's3']);
  });

  it('collapses duplicate song ids WITHIN one call without a hole', async () => {
    await markDownloadComplete(
      'q-1',
      makeItem(),
      [makeSong({ id: 's1' }), makeSong({ id: 's2' })],
      [
        { songId: 's1', position: 1 },
        { songId: 's1', position: 2 },
        { songId: 's2', position: 3 },
      ],
    );
    expect(edgesOf('alb-1')).toEqual([
      { position: 1, song_id: 's1' },
      { position: 2, song_id: 's2' },
    ]);
  });

  it('skips songs and edges missing required identifiers', async () => {
    await markDownloadComplete(
      'q-1',
      makeItem(),
      [
        makeSong({ id: 's1' }),
        makeSong({ id: '', albumId: 'alb-1' }),
        makeSong({ id: 's2', albumId: '' }),
      ],
      [
        { songId: 's1', position: 1 },
        { songId: '', position: 2 },
      ],
    );
    expect(count('cached_songs')).toBe(1);
    expect(songExists('s1')).toBe(true);
    expect(edgesOf('alb-1')).toEqual([{ position: 1, song_id: 's1' }]);
  });

  it('rewrites the cached_song_* mirrors only for ids in childBySongId', async () => {
    const child = {
      id: 's1',
      title: 'Track One',
      isDir: false,
      genres: [{ name: 'Rock' }, { name: 'Pop' }],
      moods: ['mellow'],
    } as unknown as Child;
    await markDownloadComplete(
      'q-1',
      makeItem(),
      [makeSong({ id: 's1' }), makeSong({ id: 's2' })],
      [
        { songId: 's1', position: 1 },
        { songId: 's2', position: 2 },
      ],
      new Map([['s1', child]]),
    );
    expect(count('cached_song_genres', 'WHERE song_id = ?', ['s1'])).toBe(2);
    expect(count('cached_song_moods', 'WHERE song_id = ?', ['s1'])).toBe(1);
    expect(count('cached_song_genres', 'WHERE song_id = ?', ['s2'])).toBe(0);
  });

  it('rolls the WHOLE batch back when a statement fails — the queue row survives', async () => {
    await insertDownloadQueueItem(makeQueueRow());
    // 's-missing' has no `cached_songs` row and is not in `songs`, so its edge
    // violates the FK on `cached_item_songs.song_id`.
    await markDownloadComplete(
      'q-1',
      makeItem(),
      [makeSong({ id: 's1' })],
      [
        { songId: 's1', position: 1 },
        { songId: 's-missing', position: 2 },
      ],
    );
    expect(count('download_queue')).toBe(1);
    expect(itemExists('alb-1')).toBe(false);
    expect(count('cached_songs')).toBe(0);
    expect(count('cached_item_songs')).toBe(0);
  });

  it('is a silent no-op without a db handle', async () => {
    __setDbForTests(null);
    await expect(
      markDownloadComplete('q-1', makeItem(), [makeSong()], [{ songId: 's1', position: 1 }]),
    ).resolves.toBeUndefined();
    __setDbForTests(realDb);
    expect(count('cached_items')).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  orphanSongIfUnreferencedAsync                                      */
/* ------------------------------------------------------------------ */

describe('orphanSongIfUnreferencedAsync (real SQL)', () => {
  describe('the real-holder guard', () => {
    it('keeps everything while a real holder still has the song', async () => {
      await seedHolder('alb-1', ['s1', 's2']);
      await seedHolder('album:x', ['s1'], { derived: true });

      const result = await orphanSongIfUnreferencedAsync('s1');

      expect(result).toEqual({ orphaned: false, affectedItems: [], prunedItems: [] });
      expect(songExists('s1')).toBe(true);
      expect(itemExists('album:x')).toBe(true);
      expect(songOrderOf('alb-1')).toEqual(['s1', 's2']);
      expect(songOrderOf('album:x')).toEqual(['s1']);
    });

    it('treats a legacy derived IS NULL holder as REAL', async () => {
      await seedHolder('alb-1', ['s1']);
      realDb.runSync('UPDATE cached_items SET derived = NULL WHERE item_id = ?;', ['alb-1']);

      expect(await orphanSongIfUnreferencedAsync('s1')).toEqual({
        orphaned: false,
        affectedItems: [],
        prunedItems: [],
      });
      expect(songExists('s1')).toBe(true);
    });

    it('orphans when only derived holders remain', async () => {
      await seedHolder('album:x', ['s1', 's2'], { derived: true });

      const result = await orphanSongIfUnreferencedAsync('s1');

      expect(result.orphaned).toBe(true);
      expect(result.affectedItems).toEqual(['album:x']);
      expect(result.prunedItems).toEqual([]);
      expect(songExists('s1')).toBe(false);
      expect(songOrderOf('album:x')).toEqual(['s2']);
    });
  });

  describe('holder pruning', () => {
    it('prunes a derived holder whose only song was this one, cascading its edge', async () => {
      await seedHolder('album:x', ['s1'], { derived: true });

      const result = await orphanSongIfUnreferencedAsync('s1');

      expect(result.orphaned).toBe(true);
      expect(result.affectedItems).toEqual(['album:x']);
      expect(result.prunedItems).toEqual(['album:x']);
      expect(itemExists('album:x')).toBe(false);
      expect(count('cached_item_songs')).toBe(0);
      expect(songExists('s1')).toBe(false);
    });

    it('never prunes a REAL holder left empty', async () => {
      // A real holder blocks the orphan outright, so an empty real holder can
      // only arise from an unrelated path — assert it survives regardless.
      await seedHolder('alb-1', ['s1']);
      await upsertCachedItem(makeItem({ itemId: 'alb-2', derived: false }));
      expect(itemExists('alb-2')).toBe(true);

      await orphanSongIfUnreferencedAsync('s1');

      expect(itemExists('alb-2')).toBe(true);
    });
  });

  describe('position repack — always dense 1..N', () => {
    it('repacks when the target sits in the middle', async () => {
      await seedHolder('album:x', ['s1', 's2', 's3', 's4'], { derived: true });
      await orphanSongIfUnreferencedAsync('s2');
      expect(edgesOf('album:x')).toEqual([
        { position: 1, song_id: 's1' },
        { position: 2, song_id: 's3' },
        { position: 3, song_id: 's4' },
      ]);
    });

    it('repacks when the target is first', async () => {
      await seedHolder('album:x', ['s1', 's2', 's3'], { derived: true });
      await orphanSongIfUnreferencedAsync('s1');
      expect(edgesOf('album:x')).toEqual([
        { position: 1, song_id: 's2' },
        { position: 2, song_id: 's3' },
      ]);
    });

    it('repacks when the target is last', async () => {
      await seedHolder('album:x', ['s1', 's2', 's3'], { derived: true });
      await orphanSongIfUnreferencedAsync('s3');
      expect(edgesOf('album:x')).toEqual([
        { position: 1, song_id: 's1' },
        { position: 2, song_id: 's2' },
      ]);
    });

    it('repacks with rowid order DESCENDING relative to position', async () => {
      // The layout `reorderCachedItemSongs` leaves behind. A naive
      // `position = position - 1` shift throws `UNIQUE constraint failed` here.
      await seedHolder('album:x', ['s1', 's2', 's3', 's4'], {
        derived: true,
        order: 'descending',
      });
      const result = await orphanSongIfUnreferencedAsync('s2');
      expect(result.orphaned).toBe(true);
      expect(edgesOf('album:x')).toEqual([
        { position: 1, song_id: 's1' },
        { position: 2, song_id: 's3' },
        { position: 3, song_id: 's4' },
      ]);
    });

    it('repacks two holders with tails in one batch', async () => {
      await seedHolder('album:x', ['s1', 's2', 's3'], { derived: true });
      await seedHolder('album:y', ['s4', 's2', 's3'], { derived: true });

      const result = await orphanSongIfUnreferencedAsync('s2');

      expect(result.affectedItems.sort()).toEqual(['album:x', 'album:y']);
      expect(result.prunedItems).toEqual([]);
      expect(edgesOf('album:x')).toEqual([
        { position: 1, song_id: 's1' },
        { position: 2, song_id: 's3' },
      ]);
      expect(edgesOf('album:y')).toEqual([
        { position: 1, song_id: 's4' },
        { position: 2, song_id: 's3' },
      ]);
    });

    it('leaves no negative position behind', async () => {
      await seedHolder('album:x', ['s1', 's2', 's3'], { derived: true });
      await orphanSongIfUnreferencedAsync('s1');
      expect(count('cached_item_songs', 'WHERE position < 0')).toBe(0);
    });
  });

  describe('degenerate inputs', () => {
    it('deletes a song row that has no edges at all', async () => {
      await upsertCachedSong(makeSong({ id: 's1' }));
      const result = await orphanSongIfUnreferencedAsync('s1');
      expect(result.orphaned).toBe(true);
      expect(result.affectedItems).toEqual([]);
      expect(songExists('s1')).toBe(false);
    });

    it('changes nothing on a second call', async () => {
      await seedHolder('album:x', ['s1', 's2'], { derived: true });
      await orphanSongIfUnreferencedAsync('s1');
      const before = edgesOf('album:x');

      // `orphaned` is absence-based, so a song that is already gone still reads
      // as orphaned — the point of this test is that the DB does not move.
      const second = await orphanSongIfUnreferencedAsync('s1');

      expect(second.affectedItems).toEqual([]);
      expect(second.prunedItems).toEqual([]);
      expect(edgesOf('album:x')).toEqual(before);
      expect(count('cached_songs')).toBe(1);
    });

    it('returns the safe default without a db handle', async () => {
      __setDbForTests(null);
      expect(await orphanSongIfUnreferencedAsync('s1')).toEqual({
        orphaned: false,
        affectedItems: [],
        prunedItems: [],
      });
    });
  });

  it('reports orphaned:false when the batch rolls back, and keeps the song', async () => {
    // The pre-existing bug: `orphaned` used to be set BEFORE the writes, so a
    // rollback still reported success and the store dropped a song the DB held.
    await seedHolder('album:x', ['s1', 's2'], { derived: true });
    const poisoned: InternalDb = {
      ...realDb,
      runAtomicBatchAsync: (commands) =>
        realDb.runAtomicBatchAsync([...commands, ['SELECT no_such_column FROM cached_songs;', []]]),
    };
    __setDbForTests(poisoned);

    const result = await orphanSongIfUnreferencedAsync('s1');

    __setDbForTests(realDb);
    expect(result.orphaned).toBe(false);
    expect(songExists('s1')).toBe(true);
    expect(edgesOf('album:x')).toEqual([
      { position: 1, song_id: 's1' },
      { position: 2, song_id: 's2' },
    ]);
  });
});
