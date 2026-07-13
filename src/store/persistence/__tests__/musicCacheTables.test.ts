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

import { __setDbForTests } from '../db';
import {
  bulkReplace,
  clearAllMusicCacheRows,
  countCachedItems,
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
} from '../musicCacheTables';

/* ------------------------------------------------------------------ */
/*  Fake in-memory DB                                                  */
/* ------------------------------------------------------------------ */

interface SongRec {
  song_id: string;
  title: string;
  artist: string | null;
  album: string | null;
  album_id: string;
  cover_art: string | null;
  bytes: number;
  duration: number;
  suffix: string;
  bit_rate: number | null;
  bit_depth: number | null;
  sampling_rate: number | null;
  format_captured_at: number;
  downloaded_at: number;
}

interface ItemRec {
  item_id: string;
  type: string;
  name: string;
  artist: string | null;
  cover_art_id: string | null;
  expected_song_count: number;
  parent_album_id: string | null;
  last_sync_at: number;
  downloaded_at: number;
  raw_json: string | null;
  derived: number | null;
}

interface EdgeRec {
  item_id: string;
  position: number;
  song_id: string;
}

interface QueueRec {
  queue_id: string;
  item_id: string;
  type: string;
  name: string;
  artist: string | null;
  cover_art_id: string | null;
  status: string;
  total_songs: number;
  completed_songs: number;
  error: string | null;
  added_at: number;
  queue_position: number;
  songs_json: string;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function makeFakeDb() {
  const songs = new Map<string, SongRec>();
  const items = new Map<string, ItemRec>();
  // Edges keyed by `${item_id}::${position}` for composite PK.
  const edges = new Map<string, EdgeRec>();
  const queue = new Map<string, QueueRec>();

  const edgeKey = (item_id: string, position: number) => `${item_id}::${position}`;

  const runSync = (rawSql: string, params: readonly unknown[] = []): void => {
    const s = normalize(rawSql);

    // ---- cached_songs ----
    // `cached_songs` has no ON DELETE CASCADE children, but we still emulate
    // DELETE-then-INSERT semantics faithfully for REPLACE so the fake
    // mirrors SQLite behavior consistently.
    if (
      s.startsWith('INSERT OR REPLACE INTO cached_songs') ||
      (s.startsWith('INSERT INTO cached_songs') && s.includes('ON CONFLICT'))
    ) {
      const [
        song_id,
        title,
        artist,
        album,
        album_id,
        cover_art,
        bytes,
        duration,
        suffix,
        bit_rate,
        bit_depth,
        sampling_rate,
        format_captured_at,
        downloaded_at,
      ] = params as [
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        number,
        number,
        string,
        number | null,
        number | null,
        number | null,
        number,
        number,
      ];
      songs.set(song_id, {
        song_id,
        title,
        artist,
        album,
        album_id,
        cover_art,
        bytes,
        duration,
        suffix,
        bit_rate,
        bit_depth,
        sampling_rate,
        format_captured_at,
        downloaded_at,
      });
      return;
    }
    if (s.startsWith('DELETE FROM cached_songs WHERE song_id = ?')) {
      songs.delete(params[0] as string);
      return;
    }
    if (s === 'DELETE FROM cached_songs;') {
      songs.clear();
      return;
    }

    // ---- cached_items ----
    // SQLite semantics: `INSERT OR REPLACE` is DELETE-then-INSERT when a
    // row with the conflicting primary key already exists. The DELETE fires
    // `ON DELETE CASCADE` on `cached_item_songs`, wiping that item's edges.
    // We faithfully emulate this here because code that relies on
    // `INSERT OR REPLACE` to an FK-parent is buggy (music-downloads-v2 bug),
    // and tests must be able to catch that.
    if (s.startsWith('INSERT OR REPLACE INTO cached_items')) {
      const [
        item_id,
        type,
        name,
        artist,
        cover_art_id,
        expected_song_count,
        parent_album_id,
        last_sync_at,
        downloaded_at,
        raw_json,
        derived,
      ] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        number,
        string | null,
        number,
        number,
        string | null,
        number | null,
      ];
      if (items.has(item_id)) {
        items.delete(item_id);
        for (const [k, edge] of edges) {
          if (edge.item_id === item_id) edges.delete(k);
        }
      }
      items.set(item_id, {
        item_id,
        type,
        name,
        artist,
        cover_art_id,
        expected_song_count,
        parent_album_id,
        last_sync_at,
        downloaded_at,
        raw_json: raw_json ?? null,
        derived: derived ?? null,
      });
      return;
    }
    if (s.startsWith('INSERT INTO cached_items') && s.includes('ON CONFLICT')) {
      // UPSERT: insert if absent, update in place if present. No DELETE, no
      // CASCADE. This is the correct pattern for FK-parent tables.
      const [
        item_id,
        type,
        name,
        artist,
        cover_art_id,
        expected_song_count,
        parent_album_id,
        last_sync_at,
        downloaded_at,
        raw_json,
        derived,
      ] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        number,
        string | null,
        number,
        number,
        string | null,
        number | null,
      ];
      // Mirror the real ON CONFLICT clause:
      //   raw_json = COALESCE(excluded.raw_json, raw_json) — preserve a richer
      //     existing envelope when the incoming write has none.
      //   derived  = excluded.derived — always overwrite.
      const prev = items.get(item_id);
      items.set(item_id, {
        item_id,
        type,
        name,
        artist,
        cover_art_id,
        expected_song_count,
        parent_album_id,
        last_sync_at,
        downloaded_at,
        raw_json: (raw_json ?? null) !== null ? raw_json ?? null : prev?.raw_json ?? null,
        derived: derived ?? null,
      });
      return;
    }
    if (s.startsWith('DELETE FROM cached_items WHERE item_id = ?')) {
      const id = params[0] as string;
      items.delete(id);
      // Emulate FK ON DELETE CASCADE for the edge table.
      for (const [k, edge] of edges) {
        if (edge.item_id === id) edges.delete(k);
      }
      return;
    }
    if (s === 'DELETE FROM cached_items;') {
      items.clear();
      return;
    }

    // ---- cached_item_songs ----
    if (s.startsWith('INSERT OR IGNORE INTO cached_item_songs')) {
      const [item_id, position, song_id] = params as [string, number, string];
      const k = edgeKey(item_id, position);
      if (!edges.has(k)) {
        edges.set(k, { item_id, position, song_id });
      }
      return;
    }
    if (s.startsWith('DELETE FROM cached_item_songs WHERE item_id = ? AND position = ?')) {
      const [item_id, position] = params as [string, number];
      edges.delete(edgeKey(item_id, position));
      return;
    }
    if (s.startsWith('DELETE FROM cached_item_songs WHERE song_id = ?')) {
      const [songId] = params as [string];
      for (const [k, edge] of edges) {
        if (edge.song_id === songId) edges.delete(k);
      }
      return;
    }
    // Order of these branches matters — the forward-reorder SQL's prefix
    // matches the removeCachedItemSong SQL's prefix, so check the more
    // specific one (with the extra `AND position <= ?` clause) first.
    if (
      s.startsWith(
        'UPDATE cached_item_songs SET position = position - 1 WHERE item_id = ? AND position > ? AND position <= ?',
      )
    ) {
      const [item_id, lo, hi] = params as [string, number, number];
      const toUpdate: EdgeRec[] = [];
      for (const [k, edge] of edges) {
        if (edge.item_id === item_id && edge.position > lo && edge.position <= hi) {
          toUpdate.push(edge);
          edges.delete(k);
        }
      }
      // Ascending order avoids collisions while shifting down.
      toUpdate.sort((a, b) => a.position - b.position);
      for (const edge of toUpdate) {
        const newPos = edge.position - 1;
        if (edges.has(edgeKey(item_id, newPos))) {
          throw new Error('PK collision during forward reorder');
        }
        edges.set(edgeKey(item_id, newPos), { ...edge, position: newPos });
      }
      return;
    }
    if (
      s.startsWith('UPDATE cached_item_songs SET position = position - 1 WHERE item_id = ? AND position > ?')
    ) {
      const [item_id, position] = params as [string, number];
      const toUpdate: EdgeRec[] = [];
      for (const [k, edge] of edges) {
        if (edge.item_id === item_id && edge.position > position) {
          toUpdate.push(edge);
          edges.delete(k);
        }
      }
      toUpdate.sort((a, b) => a.position - b.position);
      for (const edge of toUpdate) {
        edges.set(edgeKey(edge.item_id, edge.position - 1), {
          ...edge,
          position: edge.position - 1,
        });
      }
      return;
    }
    if (s.startsWith('UPDATE cached_item_songs SET position = -1 WHERE item_id = ? AND position = ?')) {
      const [item_id, position] = params as [string, number];
      const k = edgeKey(item_id, position);
      const edge = edges.get(k);
      if (edge) {
        edges.delete(k);
        const newKey = edgeKey(item_id, -1);
        if (edges.has(newKey)) {
          throw new Error('PK collision on sentinel -1');
        }
        edges.set(newKey, { ...edge, position: -1 });
      }
      return;
    }
    if (
      s.startsWith(
        'UPDATE cached_item_songs SET position = position + 1 WHERE item_id = ? AND position >= ? AND position < ?',
      )
    ) {
      const [item_id, lo, hi] = params as [string, number, number];
      const toUpdate: EdgeRec[] = [];
      for (const [k, edge] of edges) {
        if (edge.item_id === item_id && edge.position >= lo && edge.position < hi) {
          toUpdate.push(edge);
          edges.delete(k);
        }
      }
      // Sort descending to avoid collisions while shifting up.
      toUpdate.sort((a, b) => b.position - a.position);
      for (const edge of toUpdate) {
        const newPos = edge.position + 1;
        if (edges.has(edgeKey(item_id, newPos))) {
          throw new Error('PK collision during backward reorder');
        }
        edges.set(edgeKey(item_id, newPos), { ...edge, position: newPos });
      }
      return;
    }
    if (s.startsWith('UPDATE cached_item_songs SET position = ? WHERE item_id = ? AND position = -1')) {
      const [newPos, item_id] = params as [number, string];
      const sentinelKey = edgeKey(item_id, -1);
      const edge = edges.get(sentinelKey);
      if (edge) {
        edges.delete(sentinelKey);
        const finalKey = edgeKey(item_id, newPos);
        if (edges.has(finalKey)) throw new Error('PK collision on final placement');
        edges.set(finalKey, { ...edge, position: newPos });
      }
      return;
    }
    if (s === 'DELETE FROM cached_item_songs;') {
      edges.clear();
      return;
    }

    // ---- download_queue ----
    // `download_queue` has no FK children so REPLACE and UPSERT behave
    // identically here, but we accept both forms so either is allowed.
    if (
      s.startsWith('INSERT OR REPLACE INTO download_queue') ||
      (s.startsWith('INSERT INTO download_queue') && s.includes('ON CONFLICT'))
    ) {
      const [
        queue_id,
        item_id,
        type,
        name,
        artist,
        cover_art_id,
        status,
        total_songs,
        completed_songs,
        error,
        added_at,
        queue_position,
        songs_json,
      ] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        number,
        number,
        string | null,
        number,
        number,
        string,
      ];
      queue.set(queue_id, {
        queue_id,
        item_id,
        type,
        name,
        artist,
        cover_art_id,
        status,
        total_songs,
        completed_songs,
        error,
        added_at,
        queue_position,
        songs_json,
      });
      return;
    }
    if (s.startsWith('DELETE FROM download_queue WHERE queue_id = ?')) {
      queue.delete(params[0] as string);
      return;
    }
    if (s === 'DELETE FROM download_queue;') {
      queue.clear();
      return;
    }
    if (s.startsWith('UPDATE download_queue SET')) {
      // Partial update path and queue reorder path share this prefix.
      if (s.startsWith('UPDATE download_queue SET queue_position = -1 WHERE queue_position = ?')) {
        const pos = params[0] as number;
        for (const [k, q] of queue) {
          if (q.queue_position === pos) {
            queue.set(k, { ...q, queue_position: -1 });
          }
        }
        return;
      }
      if (
        s.startsWith(
          'UPDATE download_queue SET queue_position = queue_position - 1 WHERE queue_position > ? AND queue_position <= ?',
        )
      ) {
        const [lo, hi] = params as [number, number];
        for (const [k, q] of queue) {
          if (q.queue_position > lo && q.queue_position <= hi) {
            queue.set(k, { ...q, queue_position: q.queue_position - 1 });
          }
        }
        return;
      }
      if (
        s.startsWith(
          'UPDATE download_queue SET queue_position = queue_position + 1 WHERE queue_position >= ? AND queue_position < ?',
        )
      ) {
        const [lo, hi] = params as [number, number];
        for (const [k, q] of queue) {
          if (q.queue_position >= lo && q.queue_position < hi) {
            queue.set(k, { ...q, queue_position: q.queue_position + 1 });
          }
        }
        return;
      }
      if (s.startsWith('UPDATE download_queue SET queue_position = ? WHERE queue_position = -1')) {
        const newPos = params[0] as number;
        for (const [k, q] of queue) {
          if (q.queue_position === -1) {
            queue.set(k, { ...q, queue_position: newPos });
          }
        }
        return;
      }
      // Partial update: parse SET clauses like 'status = ?, completed_songs = ?' etc.
      // Params are [...values, queueId].
      const queueId = params[params.length - 1] as string;
      const values = params.slice(0, params.length - 1);
      const setClause = s.substring('UPDATE download_queue SET '.length, s.indexOf(' WHERE'));
      const fields = setClause.split(',').map((c) => c.trim().split(' ')[0]);
      const existing = queue.get(queueId);
      if (!existing) return;
      const next: QueueRec = { ...existing };
      fields.forEach((field, i) => {
        (next as any)[field] = values[i];
      });
      queue.set(queueId, next);
      return;
    }

    throw new Error(`unhandled SQL in fake: ${s}`);
  };

  const handle = {
    songs,
    items,
    edges,
    queue,

    getFirstSync<T>(rawSql: string, params: readonly unknown[] = []): T | undefined {
      const s = normalize(rawSql);
      if (s === 'SELECT COUNT(*) AS c FROM cached_songs;') {
        return { c: songs.size } as T;
      }
      if (s === 'SELECT COUNT(*) AS c FROM cached_items;') {
        return { c: items.size } as T;
      }
      if (s === 'SELECT COUNT(*) AS c FROM download_queue;') {
        return { c: queue.size } as T;
      }
      if (s === 'SELECT COUNT(*) AS c FROM cached_item_songs WHERE song_id = ?;') {
        const songId = params[0] as string;
        let c = 0;
        for (const edge of edges.values()) if (edge.song_id === songId) c += 1;
        return { c } as T;
      }
      // orphanSongIfUnreferencedAsync real-ref count — edges whose holder item
      // is NOT derived. `COALESCE(i.derived, 0) = 0` treats a legacy/NULL row as REAL.
      if (
        s ===
        'SELECT COUNT(*) AS c FROM cached_item_songs e JOIN cached_items i ON e.item_id = i.item_id WHERE e.song_id = ? AND COALESCE(i.derived, 0) = 0;'
      ) {
        const songId = params[0] as string;
        let c = 0;
        for (const edge of edges.values()) {
          if (edge.song_id !== songId) continue;
          const item = items.get(edge.item_id);
          // Missing item row can't join → not counted (INNER JOIN semantics).
          if (!item) continue;
          if ((item.derived ?? 0) === 0) c += 1;
        }
        return { c } as T;
      }
      // orphanSongIfUnreferencedAsync — per-holder remaining-edge count (prune check).
      if (s === 'SELECT COUNT(*) AS c FROM cached_item_songs WHERE item_id = ?;') {
        const itemId = params[0] as string;
        let c = 0;
        for (const edge of edges.values()) if (edge.item_id === itemId) c += 1;
        return { c } as T;
      }
      // orphanSongIfUnreferencedAsync — is this holder derived? NULL coalesces to 0.
      if (s === 'SELECT COALESCE(derived, 0) AS d FROM cached_items WHERE item_id = ?;') {
        const itemId = params[0] as string;
        const item = items.get(itemId);
        return { d: item ? item.derived ?? 0 : 0 } as T;
      }
      return undefined;
    },

    getAllSync<T>(rawSql: string, params: readonly unknown[] = []): T[] {
      const s = normalize(rawSql);
      if (s.startsWith('SELECT song_id, title, artist, album, album_id, cover_art')) {
        return Array.from(songs.values()) as T[];
      }
      if (s.startsWith('SELECT item_id, type, name, artist, cover_art_id, expected_song_count')) {
        return Array.from(items.values()) as T[];
      }
      if (s === 'SELECT item_id, song_id FROM cached_item_songs ORDER BY item_id, position ASC;') {
        return Array.from(edges.values())
          .sort((a, b) => {
            if (a.item_id < b.item_id) return -1;
            if (a.item_id > b.item_id) return 1;
            return a.position - b.position;
          })
          .map((e) => ({ item_id: e.item_id, song_id: e.song_id })) as T[];
      }
      if (s.startsWith('SELECT queue_id, item_id, type, name')) {
        return Array.from(queue.values()).sort(
          (a, b) => a.queue_position - b.queue_position,
        ) as T[];
      }
      // orphanSongIfUnreferencedAsync — every (item_id, position) edge for a song.
      if (s === 'SELECT item_id, position FROM cached_item_songs WHERE song_id = ?;') {
        const songId = params[0] as string;
        return Array.from(edges.values())
          .filter((e) => e.song_id === songId)
          .map((e) => ({ item_id: e.item_id, position: e.position })) as T[];
      }
      return [];
    },

    runSync,
    execSync: () => {},
    withTransactionSync: (fn: () => void) => fn(),
  };
  // Async delegates — the module's write API is async now; each delegates to
  // the sync in-memory impl so the fake stays a single source of truth.
  const h = handle as any;
  h.runAsync = (...a: unknown[]) => Promise.resolve(h.runSync(...a));
  h.getFirstAsync = (...a: unknown[]) => Promise.resolve(h.getFirstSync(...a));
  h.getAllAsync = (...a: unknown[]) => Promise.resolve(h.getAllSync(...a));
  h.withTransactionAsync = async (fn: () => Promise<void>) => { await fn(); };
  return handle;
}

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

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

function makeItem(overrides: Partial<Omit<CachedItemRow, 'songIds'>> = {}): Omit<CachedItemRow, 'songIds'> {
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

function makeQueueRow(overrides: Partial<DownloadQueueRow> = {}): DownloadQueueRow {
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
    queuePosition: 1,
    songsJson: '[]',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Test harness                                                       */
/* ------------------------------------------------------------------ */

let fakeDb: ReturnType<typeof makeFakeDb>;

beforeEach(async () => {
  fakeDb = makeFakeDb();
  __setDbForTests(fakeDb as any);
});

afterEach(() => {
  __setDbForTests(null);
});

/* ------------------------------------------------------------------ */
/*  cached_songs                                                       */
/* ------------------------------------------------------------------ */

describe('musicCacheTables — cached_songs', () => {
  it('upsertCachedSong + hydrateCachedSongs round-trips every field', async () => {
    await upsertCachedSong(makeSong());
    const hydrated = hydrateCachedSongs();
    expect(hydrated.s1).toBeDefined();
    expect(hydrated.s1).toEqual({
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

  it('upsertCachedSong leaves optional fields absent when null', async () => {
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
    const hydrated = hydrateCachedSongs();
    expect(hydrated.s2).toBeDefined();
    expect(hydrated.s2.artist).toBeUndefined();
    expect(hydrated.s2.album).toBeUndefined();
    expect(hydrated.s2.coverArt).toBeUndefined();
    expect(hydrated.s2.bitRate).toBeUndefined();
    expect(hydrated.s2.bitDepth).toBeUndefined();
    expect(hydrated.s2.samplingRate).toBeUndefined();
    // Required fields still present.
    expect(hydrated.s2.id).toBe('s2');
    expect(hydrated.s2.albumId).toBe('alb-1');
  });

  it('upsertCachedSong drops rows missing id or albumId', async () => {
    await upsertCachedSong(makeSong({ id: '' }));
    await upsertCachedSong(makeSong({ id: 'no-album', albumId: '' }));
    expect(countCachedSongs()).toBe(0);
  });

  it('upsertCachedSong replaces an existing song with the same id', async () => {
    await upsertCachedSong(makeSong({ bytes: 1 }));
    await upsertCachedSong(makeSong({ bytes: 999 }));
    expect(countCachedSongs()).toBe(1);
    expect(hydrateCachedSongs().s1.bytes).toBe(999);
  });

  it('deleteCachedSong removes the row', async () => {
    await upsertCachedSong(makeSong());
    await deleteCachedSong('s1');
    expect(countCachedSongs()).toBe(0);
  });

  it('hydrateCachedSongs skips rows with empty song_id', async () => {
    await upsertCachedSong(makeSong({ id: 's1' }));
    // Seed a bogus row directly via the fake to exercise the guard.
    fakeDb.songs.set('', {
      song_id: '',
      title: 'x',
      artist: null,
      album: null,
      album_id: 'alb-x',
      cover_art: null,
      bytes: 0,
      duration: 0,
      suffix: 'mp3',
      bit_rate: null,
      bit_depth: null,
      sampling_rate: null,
      format_captured_at: 0,
      downloaded_at: 0,
    });
    const hydrated = hydrateCachedSongs();
    expect(Object.keys(hydrated)).toEqual(['s1']);
  });
});

/* ------------------------------------------------------------------ */
/*  cached_items + edges                                               */
/* ------------------------------------------------------------------ */

describe('musicCacheTables — cached_items + edges', () => {
  it('upsertCachedItem + hydrateCachedItems round-trips the item', async () => {
    await upsertCachedItem(makeItem());
    const hydrated = hydrateCachedItems();
    expect(hydrated['alb-1']).toBeDefined();
    expect(hydrated['alb-1']).toEqual({
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

  it('hydrateCachedItems joins songIds in position order (not insertion order)', async () => {
    await upsertCachedItem(makeItem({ itemId: 'pl-1', type: 'playlist' }));
    await insertCachedItemSong('pl-1', 3, 's-c');
    await insertCachedItemSong('pl-1', 1, 's-a');
    await insertCachedItemSong('pl-1', 2, 's-b');
    const hydrated = hydrateCachedItems();
    expect(hydrated['pl-1'].songIds).toEqual(['s-a', 's-b', 's-c']);
  });

  it('hydrateCachedItems leaves optional fields absent when null', async () => {
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
    const hydrated = hydrateCachedItems();
    expect(hydrated['song:x'].artist).toBeUndefined();
    expect(hydrated['song:x'].coverArtId).toBeUndefined();
    expect(hydrated['song:x'].parentAlbumId).toBe('alb-9');
  });

  it('upsertCachedItem drops rows missing itemId', async () => {
    await upsertCachedItem(makeItem({ itemId: '' }));
    expect(countCachedItems()).toBe(0);
  });

  // Regression: SQLite `INSERT OR REPLACE` on a parent row is implemented as
  // DELETE-then-INSERT; when the parent has children via `ON DELETE CASCADE`,
  // the DELETE fires the cascade and wipes the children. This bit us during
  // music-downloads-v2 rollout: Task 14 migrated playlists correctly, but the
  // first downstream upsertCachedItem call (e.g. from a sync pass) silently
  // cascade-deleted every edge for that item — so on next hydrate the items
  // were empty shells and reconciliation deleted them. The fix is to use
  // UPSERT (`ON CONFLICT(item_id) DO UPDATE SET …`) which updates in place
  // without triggering any DELETE. This test locks in that guarantee.
  it('upsertCachedItem preserves edges when the parent row already exists', async () => {
    await upsertCachedItem(makeItem({ itemId: 'pl-1', type: 'playlist', name: 'Original' }));
    await insertCachedItemSong('pl-1', 1, 's-a');
    await insertCachedItemSong('pl-1', 2, 's-b');
    expect(hydrateCachedItems()['pl-1']?.songIds ?? []).toEqual(['s-a', 's-b']);

    // Simulate a downstream write touching the same item_id — e.g. a sync
    // pass that re-writes the item's metadata. Before the fix this would
    // fire ON DELETE CASCADE and drop both edges.
    await upsertCachedItem(makeItem({ itemId: 'pl-1', type: 'playlist', name: 'Renamed' }));

    expect(hydrateCachedItems()['pl-1']?.songIds ?? []).toEqual(['s-a', 's-b']);
  });

  it('upsertCachedItem updates columns on conflict without dropping the row', async () => {
    await upsertCachedItem(makeItem({ itemId: 'pl-1', name: 'Original', artist: 'First' }));
    await upsertCachedItem(
      makeItem({ itemId: 'pl-1', name: 'Renamed', artist: 'Second' }),
    );
    const hydrated = hydrateCachedItems();
    expect(hydrated['pl-1'].name).toBe('Renamed');
    expect(hydrated['pl-1'].artist).toBe('Second');
    expect(countCachedItems()).toBe(1);
  });

  it('insertCachedItemSong ignores duplicate (itemId, position) pairs', async () => {
    await upsertCachedItem(makeItem());
    await insertCachedItemSong('alb-1', 1, 's1');
    await insertCachedItemSong('alb-1', 1, 's2');
    const songs = hydrateCachedItems()['alb-1']?.songIds ?? [];
    expect(songs).toEqual(['s1']);
  });

  it('insertCachedItemSong ignores rows missing itemId or songId', async () => {
    await insertCachedItemSong('', 1, 's1');
    await insertCachedItemSong('alb-1', 1, '');
    expect(hydrateCachedItems()['alb-1']?.songIds ?? []).toEqual([]);
  });

  it('deleteCachedItem cascades to edges', async () => {
    await upsertCachedItem(makeItem());
    await insertCachedItemSong('alb-1', 1, 's1');
    await insertCachedItemSong('alb-1', 2, 's2');
    await deleteCachedItem('alb-1');
    expect(countCachedItems()).toBe(0);
    expect(hydrateCachedItems()['alb-1']?.songIds ?? []).toEqual([]);
  });

  it('removeCachedItemSong shifts higher positions down by 1', async () => {
    await upsertCachedItem(makeItem());
    await insertCachedItemSong('alb-1', 1, 's1');
    await insertCachedItemSong('alb-1', 2, 's2');
    await insertCachedItemSong('alb-1', 3, 's3');
    await insertCachedItemSong('alb-1', 4, 's4');
    await removeCachedItemSong('alb-1', 2);
    expect(hydrateCachedItems()['alb-1']?.songIds ?? []).toEqual(['s1', 's3', 's4']);
    // And positions are contiguous (1, 2, 3) — verified via ordering.
    const edgesList = Array.from(fakeDb.edges.values())
      .filter((e) => e.item_id === 'alb-1')
      .sort((a, b) => a.position - b.position);
    expect(edgesList.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it('reorderCachedItemSongs moves forward without PK collision', async () => {
    await upsertCachedItem(makeItem());
    await insertCachedItemSong('alb-1', 1, 's1');
    await insertCachedItemSong('alb-1', 2, 's2');
    await insertCachedItemSong('alb-1', 3, 's3');
    await insertCachedItemSong('alb-1', 4, 's4');
    // Move position 1 to position 3 — s2 and s3 shift down by 1.
    await reorderCachedItemSongs('alb-1', 1, 3);
    expect(hydrateCachedItems()['alb-1']?.songIds ?? []).toEqual(['s2', 's3', 's1', 's4']);
  });

  it('reorderCachedItemSongs moves backward without PK collision', async () => {
    await upsertCachedItem(makeItem());
    await insertCachedItemSong('alb-1', 1, 's1');
    await insertCachedItemSong('alb-1', 2, 's2');
    await insertCachedItemSong('alb-1', 3, 's3');
    await insertCachedItemSong('alb-1', 4, 's4');
    // Move position 4 to position 2 — s2 and s3 shift up by 1.
    await reorderCachedItemSongs('alb-1', 4, 2);
    expect(hydrateCachedItems()['alb-1']?.songIds ?? []).toEqual(['s1', 's4', 's2', 's3']);
  });

  it('reorderCachedItemSongs is a no-op when from == to', async () => {
    await upsertCachedItem(makeItem());
    await insertCachedItemSong('alb-1', 1, 's1');
    await insertCachedItemSong('alb-1', 2, 's2');
    await reorderCachedItemSongs('alb-1', 2, 2);
    expect(hydrateCachedItems()['alb-1']?.songIds ?? []).toEqual(['s1', 's2']);
  });
});

/* ------------------------------------------------------------------ */
/*  download_queue                                                     */
/* ------------------------------------------------------------------ */

describe('musicCacheTables — download_queue', () => {
  it('insertDownloadQueueItem + hydrateDownloadQueueAsync round-trips', async () => {
    await insertDownloadQueueItem(makeQueueRow());
    const hydrated = await hydrateDownloadQueueAsync();
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toEqual({
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
      songsJson: '[]',
    });
  });

  it('insertDownloadQueueItem drops rows missing queueId', async () => {
    await insertDownloadQueueItem(makeQueueRow({ queueId: '' }));
    expect(countDownloadQueueItems()).toBe(0);
  });

  it('removeDownloadQueueItem removes the row', async () => {
    await insertDownloadQueueItem(makeQueueRow());
    await removeDownloadQueueItem('q-1');
    expect(countDownloadQueueItems()).toBe(0);
  });

  it('hydrateDownloadQueueAsync returns rows ordered by queue_position ASC', async () => {
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-a', queuePosition: 5 }));
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-b', queuePosition: 1 }));
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-c', queuePosition: 3 }));
    const hydrated = await hydrateDownloadQueueAsync();
    expect(hydrated.map((q) => q.queueId)).toEqual(['q-b', 'q-c', 'q-a']);
  });

  it('updateDownloadQueueItem updates status only', async () => {
    await insertDownloadQueueItem(makeQueueRow());
    await updateDownloadQueueItem('q-1', { status: 'downloading' });
    expect((await hydrateDownloadQueueAsync())[0].status).toBe('downloading');
  });

  it('updateDownloadQueueItem updates completedSongs only', async () => {
    await insertDownloadQueueItem(makeQueueRow());
    await updateDownloadQueueItem('q-1', { completedSongs: 7 });
    expect((await hydrateDownloadQueueAsync())[0].completedSongs).toBe(7);
  });

  it('updateDownloadQueueItem updates error only', async () => {
    await insertDownloadQueueItem(makeQueueRow());
    await updateDownloadQueueItem('q-1', { error: 'network fail' });
    expect((await hydrateDownloadQueueAsync())[0].error).toBe('network fail');
  });

  it('updateDownloadQueueItem updates multiple fields at once', async () => {
    await insertDownloadQueueItem(makeQueueRow());
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

  it('updateDownloadQueueItem is a no-op when update is empty', async () => {
    await insertDownloadQueueItem(makeQueueRow());
    await updateDownloadQueueItem('q-1', {});
    expect((await hydrateDownloadQueueAsync())[0].status).toBe('queued');
  });

  it('reorderDownloadQueue shifts queue_position forward', async () => {
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-a', queuePosition: 1 }));
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-b', queuePosition: 2 }));
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-c', queuePosition: 3 }));
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-d', queuePosition: 4 }));
    // Move position 1 → position 3.
    await reorderDownloadQueue(1, 3);
    const order = await hydrateDownloadQueueAsync();
    expect(order.map((q) => q.queueId)).toEqual(['q-b', 'q-c', 'q-a', 'q-d']);
  });

  it('reorderDownloadQueue shifts queue_position backward', async () => {
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-a', queuePosition: 1 }));
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-b', queuePosition: 2 }));
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-c', queuePosition: 3 }));
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-d', queuePosition: 4 }));
    // Move position 4 → position 2.
    await reorderDownloadQueue(4, 2);
    const order = await hydrateDownloadQueueAsync();
    expect(order.map((q) => q.queueId)).toEqual(['q-a', 'q-d', 'q-b', 'q-c']);
  });

  it('reorderDownloadQueue is a no-op when from == to', async () => {
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'q-a', queuePosition: 1 }));
    await reorderDownloadQueue(1, 1);
    expect((await hydrateDownloadQueueAsync())[0].queueId).toBe('q-a');
  });

  it('insertDownloadQueueItem replaces rows with the same queue_id', async () => {
    await insertDownloadQueueItem(makeQueueRow({ totalSongs: 10 }));
    await insertDownloadQueueItem(makeQueueRow({ totalSongs: 99 }));
    expect(countDownloadQueueItems()).toBe(1);
    expect((await hydrateDownloadQueueAsync())[0].totalSongs).toBe(99);
  });
});

/* ------------------------------------------------------------------ */
/*  markDownloadComplete                                               */
/* ------------------------------------------------------------------ */

describe('musicCacheTables — markDownloadComplete', () => {
  it('atomically deletes the queue row and writes item + songs + edges', async () => {
    await insertDownloadQueueItem(makeQueueRow());
    await markDownloadComplete(
      'q-1',
      makeItem(),
      [
        makeSong({ id: 's1' }),
        makeSong({ id: 's2' }),
        makeSong({ id: 's3' }),
      ],
      [
        { songId: 's1', position: 1 },
        { songId: 's2', position: 2 },
        { songId: 's3', position: 3 },
      ],
    );

    expect(countDownloadQueueItems()).toBe(0);
    expect(countCachedItems()).toBe(1);
    expect(countCachedSongs()).toBe(3);
    const hydrated = hydrateCachedItems();
    expect(hydrated['alb-1'].songIds).toEqual(['s1', 's2', 's3']);
  });

  it('skips songs missing required identifiers inside the transaction', async () => {
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
        { songId: '', position: 2 }, // skipped
        { songId: 's2', position: 3 },
      ],
    );

    expect(countCachedSongs()).toBe(1);
    // Only the 's1' edge should make it in — 's2' was skipped due to empty songId? No, s2 edge is fine
    // but the songId on the edge list entry with '' must be filtered.
    // Note: position 3 edge songId 's2' is kept, but no row exists for s2; that's allowed
    // because we don't enforce FK on songs here and the store cleans up later.
    expect((hydrateCachedItems()['alb-1']?.songIds ?? []).sort()).toEqual(['s1', 's2']);
  });

  it('markDownloadComplete works for a fresh item that wasnt previously queued', async () => {
    // No queue row to delete; this is the common case when the service is
    // just committing a finished download in one shot.
    await markDownloadComplete(
      'missing-queue-id',
      makeItem({ itemId: 'song:x', type: 'song' }),
      [makeSong({ id: 's9', albumId: 'alb-9' })],
      [{ songId: 's9', position: 1 }],
    );
    expect(countCachedItems()).toBe(1);
    expect(countCachedSongs()).toBe(1);
    expect(hydrateCachedItems()['song:x'].songIds).toEqual(['s9']);
  });
});

/* ------------------------------------------------------------------ */
/*  bulkReplace                                                        */
/* ------------------------------------------------------------------ */

describe('musicCacheTables — bulkReplace', () => {
  it('wipes all four tables and re-inserts the supplied state', async () => {
    // Seed pre-existing state.
    await upsertCachedItem(makeItem({ itemId: 'old-item' }));
    await upsertCachedSong(makeSong({ id: 'old-song' }));
    await insertCachedItemSong('old-item', 1, 'old-song');
    await insertDownloadQueueItem(makeQueueRow({ queueId: 'old-q' }));

    await bulkReplace({
      items: [
        makeItem({ itemId: 'alb-new' }),
        makeItem({ itemId: 'pl-new', type: 'playlist' }),
      ],
      songs: [
        makeSong({ id: 's-new-1' }),
        makeSong({ id: 's-new-2' }),
      ],
      edges: [
        { itemId: 'alb-new', position: 1, songId: 's-new-1' },
        { itemId: 'alb-new', position: 2, songId: 's-new-2' },
        { itemId: 'pl-new', position: 1, songId: 's-new-1' },
      ],
      queue: [makeQueueRow({ queueId: 'q-new' })],
    });

    expect(countCachedItems()).toBe(2);
    expect(countCachedSongs()).toBe(2);
    expect(countDownloadQueueItems()).toBe(1);
    const hydrated = hydrateCachedItems();
    expect(hydrated['alb-new'].songIds).toEqual(['s-new-1', 's-new-2']);
    expect(hydrated['pl-new'].songIds).toEqual(['s-new-1']);
    expect(hydrated['old-item']).toBeUndefined();
    expect(hydrateCachedSongs()['old-song']).toBeUndefined();
  });

  it('silently skips invalid rows inside bulkReplace', async () => {
    await bulkReplace({
      items: [
        makeItem({ itemId: '' }),
        makeItem({ itemId: 'ok-item' }),
      ],
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
      queue: [
        makeQueueRow({ queueId: '' }),
        makeQueueRow({ queueId: 'ok-q' }),
      ],
    });

    expect(countCachedItems()).toBe(1);
    expect(countCachedSongs()).toBe(1);
    expect(countDownloadQueueItems()).toBe(1);
    expect(hydrateCachedItems()['ok-item'].songIds).toEqual(['real-song']);
  });

  it('bulkReplace with empty inputs truncates to empty tables', async () => {
    await upsertCachedItem(makeItem());
    await upsertCachedSong(makeSong());
    await insertCachedItemSong('alb-1', 1, 's1');
    await insertDownloadQueueItem(makeQueueRow());

    await bulkReplace({ items: [], songs: [], edges: [], queue: [] });

    expect(countCachedItems()).toBe(0);
    expect(countCachedSongs()).toBe(0);
    expect(countDownloadQueueItems()).toBe(0);
  });

  // Regression for the music-downloads-v2 durability bug. bulkReplace wipes
  // all four tables and re-inserts. If the per-row INSERTs use
  // `INSERT OR REPLACE` on a FK-parent table, calling bulkReplace twice with
  // identical input could cascade-delete edges between the runs. With UPSERT
  // the second call is a pure no-op (rows already match, UPDATE sets same
  // values, nothing cascades).
  it('survives re-running with identical input — edges intact, counts match', async () => {
    const payload = {
      items: [
        {
          itemId: 'pl-1',
          type: 'playlist' as const,
          name: 'Playlist One',
          artist: undefined,
          coverArtId: undefined,
          expectedSongCount: 2,
          parentAlbumId: undefined,
          lastSyncAt: 1000,
          downloadedAt: 1000,
        },
      ],
      songs: [
        { ...makeSong({ id: 's-a', albumId: 'alb-A' }) },
        { ...makeSong({ id: 's-b', albumId: 'alb-B' }) },
      ],
      edges: [
        { itemId: 'pl-1', position: 1, songId: 's-a' },
        { itemId: 'pl-1', position: 2, songId: 's-b' },
      ],
      queue: [],
    };

    await bulkReplace(payload);
    expect(countCachedItems()).toBe(1);
    expect(countCachedSongs()).toBe(2);
    expect(hydrateCachedItems()['pl-1']?.songIds ?? []).toEqual(['s-a', 's-b']);

    await bulkReplace(payload);
    expect(countCachedItems()).toBe(1);
    expect(countCachedSongs()).toBe(2);
    expect(hydrateCachedItems()['pl-1']?.songIds ?? []).toEqual(['s-a', 's-b']);
  });
});

/* ------------------------------------------------------------------ */
/*  clearAllMusicCacheRows                                             */
/* ------------------------------------------------------------------ */

describe('musicCacheTables — clearAllMusicCacheRows', () => {
  it('empties all four tables', async () => {
    await upsertCachedItem(makeItem());
    await upsertCachedSong(makeSong());
    await insertCachedItemSong('alb-1', 1, 's1');
    await insertDownloadQueueItem(makeQueueRow());

    await clearAllMusicCacheRows();

    expect(countCachedItems()).toBe(0);
    expect(countCachedSongs()).toBe(0);
    expect(countDownloadQueueItems()).toBe(0);
  });

  it('is safe to call on empty tables', async () => {
    await expect(clearAllMusicCacheRows()).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Disabled DB                                                        */
/* ------------------------------------------------------------------ */

describe('musicCacheTables — disabled db (healthy=false)', () => {
  beforeEach(async () => {
    __setDbForTests(null);
  });

  it('every read returns a safe default', async () => {
    expect(hydrateCachedSongs()).toEqual({});
    expect(hydrateCachedItems()).toEqual({});
    expect(await hydrateDownloadQueueAsync()).toEqual([]);
    expect(countCachedSongs()).toBe(0);
    expect(countCachedItems()).toBe(0);
    expect(countDownloadQueueItems()).toBe(0);
    expect(hydrateCachedItems()['alb-1']?.songIds ?? []).toEqual([]);
  });

  it('every write is a no-op', async () => {
    await expect(upsertCachedSong(makeSong())).resolves.toBeUndefined();
    await expect(deleteCachedSong('s1')).resolves.toBeUndefined();
    await expect(upsertCachedItem(makeItem())).resolves.toBeUndefined();
    await expect(deleteCachedItem('alb-1')).resolves.toBeUndefined();
    await expect(insertCachedItemSong('alb-1', 1, 's1')).resolves.toBeUndefined();
    await expect(removeCachedItemSong('alb-1', 1)).resolves.toBeUndefined();
    await expect(reorderCachedItemSongs('alb-1', 1, 2)).resolves.toBeUndefined();
    await expect(insertDownloadQueueItem(makeQueueRow())).resolves.toBeUndefined();
    await expect(removeDownloadQueueItem('q-1')).resolves.toBeUndefined();
    await expect(updateDownloadQueueItem('q-1', { status: 'downloading' })).resolves.toBeUndefined();
    await expect(reorderDownloadQueue(1, 2)).resolves.toBeUndefined();
    await expect(
      markDownloadComplete('q-1', makeItem(), [makeSong()], [{ songId: 's1', position: 1 }]),
    ).resolves.toBeUndefined();
    await expect(
      bulkReplace({ items: [], songs: [], edges: [], queue: [] }),
    ).resolves.toBeUndefined();
    await expect(clearAllMusicCacheRows()).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  DB throws (error swallow path)                                     */
/* ------------------------------------------------------------------ */

describe('musicCacheTables — db throws (error swallow path)', () => {
  const throwingDb = {
    getFirstSync() {
      throw new Error('boom');
    },
    getAllSync() {
      throw new Error('boom');
    },
    runSync() {
      throw new Error('boom');
    },
    execSync() {
      throw new Error('boom');
    },
    withTransactionSync() {
      throw new Error('boom');
    },
    getFirstAsync() {
      return Promise.reject(new Error('boom'));
    },
    getAllAsync() {
      return Promise.reject(new Error('boom'));
    },
    runAsync() {
      return Promise.reject(new Error('boom'));
    },
    withTransactionAsync() {
      return Promise.reject(new Error('boom'));
    },
  };

  beforeEach(async () => {
    __setDbForTests(throwingDb as any);
  });

  it('reads return safe defaults on error', async () => {
    expect(hydrateCachedSongs()).toEqual({});
    expect(hydrateCachedItems()).toEqual({});
    expect(await hydrateDownloadQueueAsync()).toEqual([]);
    expect(countCachedSongs()).toBe(0);
    expect(countCachedItems()).toBe(0);
    expect(countDownloadQueueItems()).toBe(0);
    expect(hydrateCachedItems()['alb-1']?.songIds ?? []).toEqual([]);
  });

  it('writes swallow errors and do not propagate', async () => {
    await expect(upsertCachedSong(makeSong())).resolves.toBeUndefined();
    await expect(deleteCachedSong('s1')).resolves.toBeUndefined();
    await expect(upsertCachedItem(makeItem())).resolves.toBeUndefined();
    await expect(deleteCachedItem('alb-1')).resolves.toBeUndefined();
    await expect(insertCachedItemSong('alb-1', 1, 's1')).resolves.toBeUndefined();
    await expect(removeCachedItemSong('alb-1', 1)).resolves.toBeUndefined();
    await expect(reorderCachedItemSongs('alb-1', 1, 2)).resolves.toBeUndefined();
    await expect(insertDownloadQueueItem(makeQueueRow())).resolves.toBeUndefined();
    await expect(removeDownloadQueueItem('q-1')).resolves.toBeUndefined();
    await expect(updateDownloadQueueItem('q-1', { status: 'downloading' })).resolves.toBeUndefined();
    await expect(reorderDownloadQueue(1, 2)).resolves.toBeUndefined();
    await expect(
      markDownloadComplete('q-1', makeItem(), [makeSong()], [{ songId: 's1', position: 1 }]),
    ).resolves.toBeUndefined();
    await expect(
      bulkReplace({ items: [], songs: [], edges: [], queue: [] }),
    ).resolves.toBeUndefined();
    await expect(clearAllMusicCacheRows()).resolves.toBeUndefined();
  });
});
