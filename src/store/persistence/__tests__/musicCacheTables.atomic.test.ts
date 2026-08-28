/**
 * The `cached_item_songs` write paths against REAL SQL.
 *
 * They all push their decisions into the statements themselves — SQL-computed
 * edge positions, self-guarded destructive statements, positional shifts through
 * negative space — so none of them can be asserted through
 * `musicCacheTables.test.ts`'s hand-rolled string-matching fake, which models
 * neither the foreign keys, nor `UNIQUE (item_id, song_id)`, nor the row-at-a-time
 * `PRIMARY KEY (item_id, position)` enforcement those decisions turn on. This
 * suite runs against the generated schema (`src/db/normalizedDdl.ts`, created at
 * import by `persistence/db.ts`) on the better-sqlite3-backed op-SQLite substitute,
 * which enables `PRAGMA foreign_keys`.
 */
import type { Child } from 'subsonic-api';

import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  insertCachedItemSong,
  insertDownloadQueueItem,
  markDownloadComplete,
  orphanSongIfUnreferencedAsync,
  removeCachedItemSong,
  reorderCachedItemSongs,
  upsertCachedItem,
  upsertCachedSong,
  type CachedItemRow,
  type CachedSongRow,
  type DownloadQueueRow,
} from '../musicCacheTables';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite substitute failed to open');
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

/** Queue rows in slot order — `markDownloadComplete` deletes one of these, and the
 *  slots left behind have to stay dense. */
const queueSlotsOf = (): Array<{ queue_id: string; queue_position: number }> =>
  realDb.getAllSync('SELECT queue_id, queue_position FROM download_queue ORDER BY queue_position;');

/**
 * Three queue rows at slots 1..3. Raw, not `insertDownloadQueueItem`, because the
 * point is to control rowid order independently of slot order: `descending` inserts
 * back-to-front, the layout a completed reorder leaves behind and the one a naive
 * `queue_position - 1` shift collides on.
 */
function seedQueue(order: 'ascending' | 'descending'): void {
  const slots = [1, 2, 3];
  for (const slot of order === 'ascending' ? slots : [...slots].reverse()) {
    realDb.runSync(
      `INSERT INTO download_queue
         (queue_id, item_id, type, name, artist, cover_art_id, status, total_songs,
          completed_songs, error, added_at, queue_position, songs_json)
       VALUES (?, ?, 'album', 'Album', NULL, NULL, 'queued', 3, 0, NULL, ?, ?, '[]');`,
      [`q-${slot}`, `alb-${slot}`, 1_700_000_000_000 + slot, slot],
    );
  }
}

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
    await insertDownloadQueueItem(makeQueueRow(), []);
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
    // A JS position counter advances past the ignored duplicate and strands
    // `1,2,4`, which breaks the store's `songIds[position-1]` mapping.
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
    await insertDownloadQueueItem(makeQueueRow(), []);
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

  // Finishing a download vacates a slot and LEAVES it vacant. This is the path that
  // rules renumbering out: the queue drains from the front, so closing the gap here
  // would rewrite every remaining row once per completed album — O(N²) across a
  // full-library download. The survivors keep the slots they were given.
  describe.each(['ascending', 'descending'] as const)(
    'the queue slots it leaves behind (rowid %s)',
    (order) => {
      it('leaves a hole when the completed item is mid-queue', async () => {
        seedQueue(order);
        await markDownloadComplete(
          'q-2',
          makeItem({ itemId: 'alb-2' }),
          [makeSong({ id: 's1', albumId: 'alb-2' })],
          [{ songId: 's1', position: 1 }],
        );
        expect(queueSlotsOf()).toEqual([
          { queue_id: 'q-1', queue_position: 1 },
          { queue_id: 'q-3', queue_position: 3 },
        ]);
      });

      it('leaves a hole at the front when the completed item is first', async () => {
        seedQueue(order);
        await markDownloadComplete(
          'q-1',
          makeItem({ itemId: 'alb-1' }),
          [makeSong({ id: 's1', albumId: 'alb-1' })],
          [{ songId: 's1', position: 1 }],
        );
        expect(queueSlotsOf()).toEqual([
          { queue_id: 'q-2', queue_position: 2 },
          { queue_id: 'q-3', queue_position: 3 },
        ]);
      });

      it('leaves the rest alone when the completed item is at the back', async () => {
        seedQueue(order);
        await markDownloadComplete(
          'q-3',
          makeItem({ itemId: 'alb-3' }),
          [makeSong({ id: 's1', albumId: 'alb-3' })],
          [{ songId: 's1', position: 1 }],
        );
        expect(queueSlotsOf()).toEqual([
          { queue_id: 'q-1', queue_position: 1 },
          { queue_id: 'q-2', queue_position: 2 },
        ]);
      });

      it('touches no slot when the item was never queued', async () => {
        seedQueue(order);
        await markDownloadComplete(
          'q-nope',
          makeItem({ itemId: 'alb-9' }),
          [makeSong({ id: 's1', albumId: 'alb-9' })],
          [{ songId: 's1', position: 1 }],
        );
        expect(queueSlotsOf()).toEqual([
          { queue_id: 'q-1', queue_position: 1 },
          { queue_id: 'q-2', queue_position: 2 },
          { queue_id: 'q-3', queue_position: 3 },
        ]);
      });
    },
  );
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
    // `orphaned` must be set AFTER the writes: set before, a rollback still
    // reports success and the store drops a song the DB still holds.
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

/* ------------------------------------------------------------------ */
/*  removeCachedItemSong / reorderCachedItemSongs                       */
/* ------------------------------------------------------------------ */

/**
 * Both rowid orders, every time. SQLite enforces `PRIMARY KEY (item_id, position)`
 * after each row of an UPDATE, so a naive `position ± 1` shift survives one rowid
 * order and throws on the other — and which one is fatal flips with the direction
 * of travel. Only the pair proves anything.
 */
const ROWID_ORDERS = ['ascending', 'descending'] as const;

describe.each(ROWID_ORDERS)('removeCachedItemSong (real SQL, %s rowids)', (order) => {
  const seed = () => seedHolder('alb-1', ['s1', 's2', 's3', 's4'], { order });

  it('closes the hole when the first song goes', async () => {
    await seed();
    await removeCachedItemSong('alb-1', 1);
    expect(edgesOf('alb-1')).toEqual([
      { position: 1, song_id: 's2' },
      { position: 2, song_id: 's3' },
      { position: 3, song_id: 's4' },
    ]);
  });

  it('closes the hole when a middle song goes', async () => {
    await seed();
    await removeCachedItemSong('alb-1', 2);
    expect(edgesOf('alb-1')).toEqual([
      { position: 1, song_id: 's1' },
      { position: 2, song_id: 's3' },
      { position: 3, song_id: 's4' },
    ]);
  });

  it('leaves the rest untouched when the last song goes', async () => {
    await seed();
    await removeCachedItemSong('alb-1', 4);
    expect(edgesOf('alb-1')).toEqual([
      { position: 1, song_id: 's1' },
      { position: 2, song_id: 's2' },
      { position: 3, song_id: 's3' },
    ]);
  });

  it('never leaves a negative position behind, and never touches another item', async () => {
    await seed();
    await seedHolder('alb-2', ['s5', 's6'], { order });
    await removeCachedItemSong('alb-1', 2);
    expect(count('cached_item_songs', 'WHERE position < 0')).toBe(0);
    expect(edgesOf('alb-2')).toEqual([
      { position: 1, song_id: 's5' },
      { position: 2, song_id: 's6' },
    ]);
  });
});

describe.each(ROWID_ORDERS)('reorderCachedItemSongs (real SQL, %s rowids)', (order) => {
  const seed = () => seedHolder('alb-1', ['s1', 's2', 's3', 's4'], { order });

  it('moves a song DOWN the list, shifting the run it passes up one slot', async () => {
    await seed();
    await reorderCachedItemSongs('alb-1', 1, 3);
    expect(edgesOf('alb-1')).toEqual([
      { position: 1, song_id: 's2' },
      { position: 2, song_id: 's3' },
      { position: 3, song_id: 's1' },
      { position: 4, song_id: 's4' },
    ]);
  });

  it('moves a song UP the list, shifting the run it passes down one slot', async () => {
    await seed();
    await reorderCachedItemSongs('alb-1', 4, 2);
    expect(edgesOf('alb-1')).toEqual([
      { position: 1, song_id: 's1' },
      { position: 2, song_id: 's4' },
      { position: 3, song_id: 's2' },
      { position: 4, song_id: 's3' },
    ]);
  });

  it('moves a song to the FIRST slot', async () => {
    await seed();
    await reorderCachedItemSongs('alb-1', 4, 1);
    expect(songOrderOf('alb-1')).toEqual(['s4', 's1', 's2', 's3']);
    expect(positionsOf('alb-1')).toEqual([1, 2, 3, 4]);
  });

  it('moves a song to the LAST slot', async () => {
    await seed();
    await reorderCachedItemSongs('alb-1', 1, 4);
    expect(songOrderOf('alb-1')).toEqual(['s2', 's3', 's4', 's1']);
    expect(positionsOf('alb-1')).toEqual([1, 2, 3, 4]);
  });

  it('swaps an adjacent pair in either direction', async () => {
    await seed();
    await reorderCachedItemSongs('alb-1', 2, 3);
    expect(songOrderOf('alb-1')).toEqual(['s1', 's3', 's2', 's4']);

    await reorderCachedItemSongs('alb-1', 2, 3);
    expect(songOrderOf('alb-1')).toEqual(['s1', 's2', 's3', 's4']);
    expect(positionsOf('alb-1')).toEqual([1, 2, 3, 4]);
  });

  it('is a no-op when from == to', async () => {
    await seed();
    await reorderCachedItemSongs('alb-1', 2, 2);
    expect(songOrderOf('alb-1')).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('never leaves a negative position behind, and never touches another item', async () => {
    await seed();
    await seedHolder('alb-2', ['s5', 's6'], { order });
    await reorderCachedItemSongs('alb-1', 1, 4);
    expect(count('cached_item_songs', 'WHERE position < 0')).toBe(0);
    expect(edgesOf('alb-2')).toEqual([
      { position: 1, song_id: 's5' },
      { position: 2, song_id: 's6' },
    ]);
  });
});

describe('cached_item_songs position space survives repeated shifts', () => {
  // Every shift rewrites rows, so it also rewrites the rowid order the NEXT one
  // sees. These start from ascending rowids and let the operations themselves
  // produce whatever layout they produce.
  it('reorders twice in a row', async () => {
    await seedHolder('alb-1', ['s1', 's2', 's3', 's4']);
    await reorderCachedItemSongs('alb-1', 1, 4);
    expect(songOrderOf('alb-1')).toEqual(['s2', 's3', 's4', 's1']);

    await reorderCachedItemSongs('alb-1', 2, 4);
    expect(songOrderOf('alb-1')).toEqual(['s2', 's4', 's1', 's3']);
    expect(positionsOf('alb-1')).toEqual([1, 2, 3, 4]);
  });

  it('reorders back and forth to the same list it started with', async () => {
    await seedHolder('alb-1', ['s1', 's2', 's3', 's4']);
    await reorderCachedItemSongs('alb-1', 1, 4);
    await reorderCachedItemSongs('alb-1', 4, 1);
    expect(songOrderOf('alb-1')).toEqual(['s1', 's2', 's3', 's4']);
    expect(positionsOf('alb-1')).toEqual([1, 2, 3, 4]);
  });

  it('removes a song out of a freshly reordered list', async () => {
    await seedHolder('alb-1', ['s1', 's2', 's3', 's4']);
    await reorderCachedItemSongs('alb-1', 1, 4);
    await removeCachedItemSong('alb-1', 2);
    expect(edgesOf('alb-1')).toEqual([
      { position: 1, song_id: 's2' },
      { position: 2, song_id: 's4' },
      { position: 3, song_id: 's1' },
    ]);
  });

  it('orphans a song out of a freshly reordered derived holder', async () => {
    await seedHolder('album:x', ['s1', 's2', 's3', 's4'], { derived: true });
    await reorderCachedItemSongs('album:x', 1, 4);
    expect(await orphanSongIfUnreferencedAsync('s3')).toMatchObject({ orphaned: true });
    expect(edgesOf('album:x')).toEqual([
      { position: 1, song_id: 's2' },
      { position: 2, song_id: 's4' },
      { position: 3, song_id: 's1' },
    ]);
  });
});
