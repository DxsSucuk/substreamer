/**
 * `musicCacheTables` against REAL SQL: the row↔object mappers behind the three
 * hydrates, the whole-table replace/truncate paths, the partial queue update, and
 * the two degraded modes every function in the module has to survive — no db handle
 * at all, and a handle that throws on every call.
 *
 * The paths whose behaviour is a property of the CONSTRAINTS rather than of the
 * mapping live in the siblings, and are asserted there against both rowid orders:
 * `musicCacheTables.atomic.test.ts` (`markDownloadComplete`, the edge positional
 * shifts, `orphanSongIfUnreferencedAsync`), `downloadQueue.atomic.test.ts` (the
 * unique `queue_position` — SQL owns the slot, so nothing here supplies one) and
 * `musicCacheTables.conversion.test.ts` (the legacy-envelope promotion + the FK
 * cascades of the rows it writes).
 *
 * Runs against the generated schema (`src/db/normalizedDdl.ts`, created at import by
 * `persistence/db.ts`) on the better-sqlite3-backed op-SQLite seam, which enables
 * `PRAGMA foreign_keys` — so an edge needs its item AND its song to exist.
 */
import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  bulkReplace,
  clearAllMusicCacheRows,
  countCachedItems,
  countCachedItemSongs,
  countCachedSongs,
  countDownloadQueueItems,
  deleteCachedItem,
  deleteCachedSong,
  hydrateCachedItems,
  hydrateCachedSongs,
  hydrateDownloadQueueAsync,
  insertCachedItemSong,
  insertDownloadQueueItem,
  markDownloadComplete,
  deleteDownloadQueueSongs,
  readDownloadQueueAlbumIdsAsync,
  readDownloadQueuePayloadRowsAsync,
  readDownloadQueueSongRefsAsync,
  readDownloadQueueSongsAsync,
  readQueuedSongStatus,
  readStoredQueueSongIdsAsync,
  replaceDownloadQueueSongs,
  removeCachedItemSong,
  removeDownloadQueueItem,
  reorderCachedItemSongs,
  reorderDownloadQueue,
  updateDownloadQueueItem,
  upsertCachedItem,
  upsertCachedSong,
  type CachedItemRow,
  type CachedSongRow,
  type DownloadQueueRow,
  type LegacyDownloadQueueRow,
} from '../musicCacheTables';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
const realDb: InternalDb = handle;

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

type ItemInput = Omit<CachedItemRow, 'songIds'>;
/** Every writer but `bulkReplace` takes the row WITHOUT a slot — SQL assigns it. */
type QueueInput = Omit<DownloadQueueRow, 'queuePosition'>;

function makeSong(overrides: Partial<CachedSongRow> = {}): CachedSongRow {
  return {
    id: 's1',
    title: 'Track 1',
    artist: 'Some Artist',
    album: 'Some Album',
    albumId: 'alb-1',
    coverArt: 'cov-1',
    bytes: 1_000_000,
    duration: 240,
    suffix: 'mp3',
    bitRate: 320,
    bitDepth: 16,
    samplingRate: 44100,
    formatCapturedAt: 1_700_000_000_000,
    downloadedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeItem(overrides: Partial<ItemInput> = {}): ItemInput {
  return {
    itemId: 'alb-1',
    type: 'album',
    name: 'Some Album',
    artist: 'Some Artist',
    coverArtId: 'cov-1',
    expectedSongCount: 10,
    lastSyncAt: 1_700_000_000_000,
    downloadedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeQueueRow(overrides: Partial<QueueInput> = {}): QueueInput {
  return {
    queueId: 'q-1',
    itemId: 'alb-1',
    type: 'album',
    name: 'Some Album',
    artist: 'Some Artist',
    coverArtId: 'cov-1',
    status: 'queued',
    totalSongs: 10,
    completedSongs: 0,
    addedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** The restore form `bulkReplace` replays — the only caller that supplies a slot,
 *  and the only one still handing over the legacy blob (Migration 14 replays v1). */
const makeRestoreRow = (
  queuePosition: number,
  overrides: Partial<QueueInput> = {},
): LegacyDownloadQueueRow => ({ ...makeQueueRow(overrides), queuePosition, songsJson: '[]' });

/** An item plus its songs plus dense 1..N edges. The FKs make all three necessary. */
async function seedHolder(itemId: string, songIds: string[]): Promise<void> {
  await upsertCachedItem(makeItem({ itemId, expectedSongCount: songIds.length }));
  for (let i = 0; i < songIds.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    await upsertCachedSong(makeSong({ id: songIds[i] }));
    // eslint-disable-next-line no-await-in-loop
    await insertCachedItemSong(itemId, i + 1, songIds[i]);
  }
}

const songIdsOf = (itemId: string): string[] => hydrateCachedItems()[itemId]?.songIds ?? [];

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
/*  cached_songs                                                       */
/* ------------------------------------------------------------------ */

describe('cached_songs', () => {
  it('upsertCachedSong + hydrateCachedSongs round-trips every field', async () => {
    await upsertCachedSong(makeSong());
    expect(hydrateCachedSongs().s1).toEqual({
      id: 's1',
      title: 'Track 1',
      artist: 'Some Artist',
      album: 'Some Album',
      albumId: 'alb-1',
      coverArt: 'cov-1',
      bytes: 1_000_000,
      duration: 240,
      suffix: 'mp3',
      bitRate: 320,
      bitDepth: 16,
      samplingRate: 44100,
      formatCapturedAt: 1_700_000_000_000,
      downloadedAt: 1_700_000_000_000,
    });
  });

  it('leaves optional fields absent — a NULL column is not a key on the row', async () => {
    await upsertCachedSong(
      makeSong({
        id: 's2',
        artist: undefined,
        album: undefined,
        coverArt: undefined,
        bitRate: undefined,
        bitDepth: undefined,
        samplingRate: undefined,
      }),
    );
    const row = hydrateCachedSongs().s2;
    expect(row).toBeDefined();
    expect(row.artist).toBeUndefined();
    expect(row.album).toBeUndefined();
    expect(row.coverArt).toBeUndefined();
    expect(row.bitRate).toBeUndefined();
    expect(row.bitDepth).toBeUndefined();
    expect(row.samplingRate).toBeUndefined();
    // Required fields still present.
    expect(row.id).toBe('s2');
    expect(row.albumId).toBe('alb-1');
  });

  it('drops a write missing id or albumId', async () => {
    await upsertCachedSong(makeSong({ id: '' }));
    await upsertCachedSong(makeSong({ id: 'no-album', albumId: '' }));
    expect(countCachedSongs()).toBe(0);
  });

  it('updates an existing song in place rather than adding a second row', async () => {
    await upsertCachedSong(makeSong({ bytes: 1 }));
    await upsertCachedSong(makeSong({ bytes: 999 }));
    expect(countCachedSongs()).toBe(1);
    expect(hydrateCachedSongs().s1.bytes).toBe(999);
  });

  it('hydrateCachedSongs skips a row with an empty song_id', async () => {
    await upsertCachedSong(makeSong());
    // `upsertCachedSong` refuses to write one, so seed it raw — the guard exists for
    // rows a pre-guard build left behind.
    realDb.runSync(
      `INSERT INTO cached_songs (song_id, title, album_id, bytes, duration, suffix,
         format_captured_at, downloaded_at) VALUES ('', 'x', 'alb-x', 0, 0, 'mp3', 0, 0);`,
    );
    expect(countCachedSongs()).toBe(2);
    expect(Object.keys(hydrateCachedSongs())).toEqual(['s1']);
  });
});

/* ------------------------------------------------------------------ */
/*  cached_items + edges                                               */
/* ------------------------------------------------------------------ */

describe('cached_items + edges', () => {
  it('upsertCachedItem + hydrateCachedItems round-trips the item', async () => {
    await upsertCachedItem(makeItem());
    expect(hydrateCachedItems()['alb-1']).toEqual({
      itemId: 'alb-1',
      type: 'album',
      name: 'Some Album',
      artist: 'Some Artist',
      coverArtId: 'cov-1',
      expectedSongCount: 10,
      lastSyncAt: 1_700_000_000_000,
      downloadedAt: 1_700_000_000_000,
      songIds: [],
      // `mapItemRow` sets `derived` unconditionally (NULL → false), so a
      // real (non-derived) holder always hydrates with `derived: false`.
      derived: false,
    });
  });

  it('joins songIds in position order, not insertion order', async () => {
    await upsertCachedItem(makeItem({ itemId: 'pl-1', type: 'playlist' }));
    for (const id of ['s-a', 's-b', 's-c']) {
      // eslint-disable-next-line no-await-in-loop
      await upsertCachedSong(makeSong({ id }));
    }
    await insertCachedItemSong('pl-1', 3, 's-c');
    await insertCachedItemSong('pl-1', 1, 's-a');
    await insertCachedItemSong('pl-1', 2, 's-b');
    expect(songIdsOf('pl-1')).toEqual(['s-a', 's-b', 's-c']);
  });

  it('leaves optional fields absent when the column is NULL', async () => {
    await upsertCachedItem(
      makeItem({
        itemId: 'song:x',
        type: 'song',
        name: 'Lone',
        artist: undefined,
        coverArtId: undefined,
        parentAlbumId: 'alb-9',
      }),
    );
    const row = hydrateCachedItems()['song:x'];
    expect(row.artist).toBeUndefined();
    expect(row.coverArtId).toBeUndefined();
    expect(row.parentAlbumId).toBe('alb-9');
  });

  it('drops a write missing itemId', async () => {
    await upsertCachedItem(makeItem({ itemId: '' }));
    expect(countCachedItems()).toBe(0);
  });

  // `INSERT OR REPLACE` on a parent row is DELETE-then-INSERT, and the DELETE fires
  // `ON DELETE CASCADE` on the edges: a sync pass re-writing an item's metadata
  // empties every offline playlist, and the next reconcile deletes the empty shells.
  // UPSERT updates in place instead.
  it('preserves an items edges when a later write touches the parent row', async () => {
    await seedHolder('pl-1', ['s-a', 's-b']);
    expect(songIdsOf('pl-1')).toEqual(['s-a', 's-b']);

    await upsertCachedItem(makeItem({ itemId: 'pl-1', type: 'playlist', name: 'Renamed' }));

    expect(songIdsOf('pl-1')).toEqual(['s-a', 's-b']);
  });

  it('updates columns on conflict without adding a row', async () => {
    await upsertCachedItem(makeItem({ itemId: 'pl-1', name: 'Original', artist: 'First' }));
    await upsertCachedItem(makeItem({ itemId: 'pl-1', name: 'Renamed', artist: 'Second' }));
    const row = hydrateCachedItems()['pl-1'];
    expect(row.name).toBe('Renamed');
    expect(row.artist).toBe('Second');
    expect(countCachedItems()).toBe(1);
  });

  it('insertCachedItemSong ignores a second song at a position already taken', async () => {
    await upsertCachedItem(makeItem());
    await upsertCachedSong(makeSong({ id: 's1' }));
    await upsertCachedSong(makeSong({ id: 's2' }));
    await insertCachedItemSong('alb-1', 1, 's1');
    await insertCachedItemSong('alb-1', 1, 's2');
    expect(songIdsOf('alb-1')).toEqual(['s1']);
  });

  it('insertCachedItemSong ignores a write missing itemId or songId', async () => {
    // Empty-id parents seeded raw, so the FKs would ACCEPT both edges — the JS guard
    // is then the only thing that can keep the table empty.
    await seedHolder('alb-1', ['s1']);
    await upsertCachedItem(makeItem({ itemId: 'placeholder' }));
    realDb.runSync("UPDATE cached_items SET item_id = '' WHERE item_id = 'placeholder';");
    realDb.runSync(
      `INSERT INTO cached_songs (song_id, title, album_id, bytes, duration, suffix,
         format_captured_at, downloaded_at) VALUES ('', 'x', 'alb-x', 0, 0, 'mp3', 0, 0);`,
    );

    await insertCachedItemSong('', 1, 's1');
    await insertCachedItemSong('alb-1', 2, '');

    expect(countCachedItemSongs()).toBe(1);
    expect(songIdsOf('alb-1')).toEqual(['s1']);
  });

  it('deleteCachedItem cascades to the edges', async () => {
    await seedHolder('alb-1', ['s1', 's2']);
    await deleteCachedItem('alb-1');
    expect(countCachedItems()).toBe(0);
    expect(countCachedItemSongs()).toBe(0);
    // The songs themselves are NOT children of the item — only the edges are.
    expect(countCachedSongs()).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/*  download_queue                                                     */
/* ------------------------------------------------------------------ */

describe('download_queue', () => {
  it('insertDownloadQueueItem + hydrateDownloadQueueAsync round-trips every field', async () => {
    await insertDownloadQueueItem(makeQueueRow(), []);
    expect(await hydrateDownloadQueueAsync()).toEqual([
      {
        queueId: 'q-1',
        itemId: 'alb-1',
        type: 'album',
        name: 'Some Album',
        artist: 'Some Artist',
        coverArtId: 'cov-1',
        status: 'queued',
        totalSongs: 10,
        completedSongs: 0,
        addedAt: 1_700_000_000_000,
        queuePosition: 1,
      },
    ]);
  });

  it('leaves optional fields absent when the column is NULL', async () => {
    await insertDownloadQueueItem(
      makeQueueRow({ artist: undefined, coverArtId: undefined, error: undefined }),
      [],
    );
    const row = (await hydrateDownloadQueueAsync())[0];
    expect(row.artist).toBeUndefined();
    expect(row.coverArtId).toBeUndefined();
    expect(row.error).toBeUndefined();
  });

  it('drops a write missing queueId, and reports it as unassigned', async () => {
    expect(await insertDownloadQueueItem(makeQueueRow({ queueId: '' }), [])).toBeNull();
    expect(countDownloadQueueItems()).toBe(0);
  });

  it('hydrates in queue_position order, not insertion order', async () => {
    // Appended a, b, c — so insertion order and slot order agree. The reorder
    // separates them, which is what makes the ORDER BY observable.
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-a' }), []);
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-b' }), []);
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-c' }), []);
    await reorderDownloadQueue(3, 1);
    const hydrated = await hydrateDownloadQueueAsync();
    expect(hydrated.map((q) => q.queueId)).toEqual(['q-c', 'q-a', 'q-b']);
    expect(hydrated.map((q) => q.queuePosition)).toEqual([1, 2, 3]);
  });

  describe('updateDownloadQueueItem', () => {
    beforeEach(async () => {
      await insertDownloadQueueItem(makeQueueRow(), []);
    });

    it('updates status only', async () => {
      await updateDownloadQueueItem('q-1', { status: 'downloading' });
      const row = (await hydrateDownloadQueueAsync())[0];
      expect(row.status).toBe('downloading');
      expect(row.completedSongs).toBe(0);
      expect(row.error).toBeUndefined();
    });

    it('updates completedSongs only', async () => {
      await updateDownloadQueueItem('q-1', { completedSongs: 7 });
      const row = (await hydrateDownloadQueueAsync())[0];
      expect(row.completedSongs).toBe(7);
      expect(row.status).toBe('queued');
    });

    it('updates error only', async () => {
      await updateDownloadQueueItem('q-1', { error: 'network fail' });
      const row = (await hydrateDownloadQueueAsync())[0];
      expect(row.error).toBe('network fail');
      expect(row.status).toBe('queued');
    });

    it('updates several fields in one statement', async () => {
      await updateDownloadQueueItem('q-1', {
        status: 'error',
        completedSongs: 3,
        error: 'boom',
      });
      const row = (await hydrateDownloadQueueAsync())[0];
      expect(row.status).toBe('error');
      expect(row.completedSongs).toBe(3);
      expect(row.error).toBe('boom');
    });

    it('is a no-op for an empty update', async () => {
      await updateDownloadQueueItem('q-1', {});
      expect((await hydrateDownloadQueueAsync())[0].status).toBe('queued');
    });

    it('touches nothing for a queue_id that is not there', async () => {
      await updateDownloadQueueItem('q-nope', { status: 'error' });
      expect((await hydrateDownloadQueueAsync())[0].status).toBe('queued');
    });
  });
});

/* ------------------------------------------------------------------ */
/*  bulkReplace                                                        */
/* ------------------------------------------------------------------ */

describe('bulkReplace', () => {
  it('wipes all four tables and re-inserts the supplied state', async () => {
    await seedHolder('old-item', ['old-song']);
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'old-q' }), []);

    await bulkReplace({
      items: [makeItem({ itemId: 'alb-new' }), makeItem({ itemId: 'pl-new', type: 'playlist' })],
      songs: [makeSong({ id: 's-new-1' }), makeSong({ id: 's-new-2' })],
      edges: [
        { itemId: 'alb-new', position: 1, songId: 's-new-1' },
        { itemId: 'alb-new', position: 2, songId: 's-new-2' },
        { itemId: 'pl-new', position: 1, songId: 's-new-1' },
      ],
      queue: [makeRestoreRow(1, { queueId: 'q-new' })],
    });

    expect(countCachedItems()).toBe(2);
    expect(countCachedSongs()).toBe(2);
    expect(countDownloadQueueItems()).toBe(1);
    expect(songIdsOf('alb-new')).toEqual(['s-new-1', 's-new-2']);
    expect(songIdsOf('pl-new')).toEqual(['s-new-1']);
    expect(hydrateCachedItems()['old-item']).toBeUndefined();
    expect(hydrateCachedSongs()['old-song']).toBeUndefined();
    expect((await hydrateDownloadQueueAsync()).map((q) => q.queueId)).toEqual(['q-new']);
  });

  it('replays the slots the snapshot carries rather than reassigning them', async () => {
    // The restore form is the ONE writer whose slot the caller owns — a queue
    // renumbered on the way in would not survive a migration round-trip.
    await bulkReplace({
      items: [],
      songs: [],
      edges: [],
      queue: [makeRestoreRow(4, { queueId: 'q-a' }), makeRestoreRow(9, { queueId: 'q-b' })],
    });
    expect((await hydrateDownloadQueueAsync()).map((q) => q.queuePosition)).toEqual([4, 9]);
  });

  it('silently skips the invalid rows and writes the rest', async () => {
    await bulkReplace({
      items: [makeItem({ itemId: '' }), makeItem({ itemId: 'ok-item' })],
      songs: [
        makeSong({ id: '' }),
        makeSong({ id: 'ok-song', albumId: '' }),
        makeSong({ id: 'real-song' }),
      ],
      edges: [
        { itemId: '', position: 1, songId: 'real-song' },
        { itemId: 'ok-item', position: 1, songId: '' },
        { itemId: 'ok-item', position: 2, songId: 'real-song' },
      ],
      queue: [makeRestoreRow(1, { queueId: '' }), makeRestoreRow(2, { queueId: 'ok-q' })],
    });

    expect(countCachedItems()).toBe(1);
    expect(countCachedSongs()).toBe(1);
    expect(countDownloadQueueItems()).toBe(1);
    expect(songIdsOf('ok-item')).toEqual(['real-song']);
  });

  it('truncates to empty tables for empty inputs', async () => {
    await seedHolder('alb-1', ['s1']);
    await insertDownloadQueueItem(makeQueueRow(), []);

    await bulkReplace({ items: [], songs: [], edges: [], queue: [] });

    expect(countCachedItems()).toBe(0);
    expect(countCachedSongs()).toBe(0);
    expect(countCachedItemSongs()).toBe(0);
    expect(countDownloadQueueItems()).toBe(0);
  });

  // The music-downloads-v2 durability bug: bulkReplace wipes and re-inserts, so a
  // per-row `INSERT OR REPLACE` on the FK-parent would cascade the edges away
  // between two runs of the SAME input. With UPSERT the second run is a no-op.
  it('survives re-running with identical input — edges intact, counts unchanged', async () => {
    const payload = {
      items: [makeItem({ itemId: 'pl-1', type: 'playlist' as const, expectedSongCount: 2 })],
      songs: [makeSong({ id: 's-a', albumId: 'alb-A' }), makeSong({ id: 's-b', albumId: 'alb-B' })],
      edges: [
        { itemId: 'pl-1', position: 1, songId: 's-a' },
        { itemId: 'pl-1', position: 2, songId: 's-b' },
      ],
      queue: [],
    };

    await bulkReplace(payload);
    expect(countCachedItems()).toBe(1);
    expect(countCachedSongs()).toBe(2);
    expect(songIdsOf('pl-1')).toEqual(['s-a', 's-b']);

    await bulkReplace(payload);
    expect(countCachedItems()).toBe(1);
    expect(countCachedSongs()).toBe(2);
    expect(songIdsOf('pl-1')).toEqual(['s-a', 's-b']);
  });
});

/* ------------------------------------------------------------------ */
/*  clearAllMusicCacheRows                                             */
/* ------------------------------------------------------------------ */

describe('clearAllMusicCacheRows', () => {
  it('empties every download table, component rows included', async () => {
    await seedHolder('alb-1', ['s1']);
    await upsertCachedItem(
      makeItem({ itemId: 'pl-1', type: 'playlist', playlistMeta: { name: 'Road Trip' } }),
    );
    await insertDownloadQueueItem(makeQueueRow(), []);

    await clearAllMusicCacheRows();

    for (const table of TABLES_TO_CLEAR) {
      expect(realDb.getFirstSync<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table};`)?.c).toBe(0);
    }
  });

  it('is safe to call on empty tables', async () => {
    await expect(clearAllMusicCacheRows()).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Degraded modes                                                     */
/* ------------------------------------------------------------------ */

/**
 * Reads return their safe default and writes resolve; nothing throws out of the
 * module. Run twice — once with no handle (`isDbHealthy() === false`), once with a
 * handle whose every method throws or rejects.
 */
function describeDegraded(label: string, install: () => void): void {
  describe(label, () => {
    beforeEach(install);

    it('every read returns a safe default', async () => {
      expect(hydrateCachedSongs()).toEqual({});
      expect(hydrateCachedItems()).toEqual({});
      expect(await hydrateDownloadQueueAsync()).toEqual([]);
      expect(countCachedSongs()).toBe(0);
      expect(countCachedItems()).toBe(0);
      expect(countCachedItemSongs()).toBe(0);
      expect(countDownloadQueueItems()).toBe(0);
      expect(await readDownloadQueueSongsAsync('q-1')).toEqual([]);
      expect(await readDownloadQueueSongRefsAsync('q-1')).toEqual([]);
      expect(await readDownloadQueueAlbumIdsAsync('q-1')).toEqual([]);
      expect(await readDownloadQueuePayloadRowsAsync()).toEqual([]);
      expect(readQueuedSongStatus('s1')).toBeNull();
      // Null, NOT `[]`: the conversion reads this back to decide whether a queued
      // download's songs landed, and an unreadable DB must not look like "they did not".
      expect(await readStoredQueueSongIdsAsync('q-1')).toBeNull();
    });

    it('every write resolves without throwing', async () => {
      await expect(upsertCachedSong(makeSong())).resolves.toBeUndefined();
      await expect(deleteCachedSong('s1')).resolves.toBeUndefined();
      await expect(upsertCachedItem(makeItem())).resolves.toBeUndefined();
      await expect(deleteCachedItem('alb-1')).resolves.toBeUndefined();
      await expect(insertCachedItemSong('alb-1', 1, 's1')).resolves.toBeUndefined();
      await expect(removeCachedItemSong('alb-1', 1)).resolves.toBeUndefined();
      await expect(reorderCachedItemSongs('alb-1', 1, 2)).resolves.toBeUndefined();
      await expect(insertDownloadQueueItem(makeQueueRow(), [])).resolves.toBeNull();
      await expect(removeDownloadQueueItem('q-1')).resolves.toBeUndefined();
      await expect(
        updateDownloadQueueItem('q-1', { status: 'downloading' }),
      ).resolves.toBeUndefined();
      await expect(reorderDownloadQueue(1, 2)).resolves.toBeUndefined();
      await expect(
        markDownloadComplete('q-1', makeItem(), [makeSong()], [{ songId: 's1', position: 1 }]),
      ).resolves.toBeUndefined();
      await expect(
        bulkReplace({ items: [], songs: [], edges: [], queue: [] }),
      ).resolves.toBeUndefined();
      await expect(replaceDownloadQueueSongs('q-1', [])).resolves.toBe(false);
      await expect(deleteDownloadQueueSongs('q-1')).resolves.toBeUndefined();
      await expect(clearAllMusicCacheRows()).resolves.toBeUndefined();
    });
  });
}

describeDegraded('no db handle (isDbHealthy false)', () => {
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
