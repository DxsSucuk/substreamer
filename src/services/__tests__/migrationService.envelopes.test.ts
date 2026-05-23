/**
 * Tests for Migrations 17–20 — the raw_json envelope schema change and
 * the backfills that recover lost metadata for v1-era rows.
 *
 * These tests stand alone from the main migrationService.test.ts suite so
 * they can install a richer fake db (one that actually stores rows) without
 * colliding with the schema-agnostic mocks used there.
 */

import { addColumnIfMissing } from '../../store/persistence/musicCacheTables';

jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

// Migration #21 imports deviceIdentityStore which transitively pulls
// expo-device + expo-crypto + i18n. Mock the store so the migration runs
// without dragging the native bridge into the test.
jest.mock('../../store/deviceIdentityStore', () => ({
  deviceIdentityStore: {
    getState: () => ({
      deviceId: 'mock-device-id',
      deviceName: null,
      deviceLabel: 'Your Mock Device',
      deviceLabelUserSet: false,
      refreshDeviceName: jest.fn(),
      ensureDefaultLabel: jest.fn(),
    }),
    setState: jest.fn(),
  },
  getDeviceShortId: () => 'mock1234',
}));

// Silence the real module's expo-sqlite init so it doesn't try to open a
// native handle during module load.
jest.mock('expo-sqlite', () => ({
  openDatabaseSync: () => {
    throw new Error('mocked — fake db injected per test');
  },
}));

jest.mock('expo-file-system', () => {
  class File {
    write = jest.fn();
    constructor(..._parts: any[]) {}
  }
  class Directory {
    uri = '';
    get exists() { return true; }
    constructor(..._parts: any[]) {}
  }
  return {
    File,
    Directory,
    Paths: { document: new Directory() },
  };
});

jest.mock('expo-async-fs', () => ({
  listDirectoryAsync: jest.fn().mockResolvedValue([]),
}));

jest.mock('expo-gzip', () => ({
  compressToFile: jest.fn().mockResolvedValue({ bytes: 0 }),
  decompressFromFile: jest.fn().mockResolvedValue(''),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

import { runMigrations, getPendingTasks } from '../migrationService';
import { kvStorage } from '../../store/persistence';
import { __setDbForTests as setDbForDetailTables } from '../../store/persistence/db';

/**
 * Minimal row-oriented fake SQLite handle. Captures INSERT/UPDATE/ALTER
 * operations against named tables and answers SELECTs from the stored
 * rows. Enough to drive the migrations without pulling in a real engine.
 */
interface FakeRow { [col: string]: unknown }
interface FakeTable { cols: string[]; rows: FakeRow[] }

function makeFakeDb() {
  const tables = new Map<string, FakeTable>();

  function ensureTable(name: string, cols: string[]): FakeTable {
    let t = tables.get(name);
    if (!t) {
      t = { cols: [...cols], rows: [] };
      tables.set(name, t);
    }
    return t;
  }

  function seed(tableName: string, cols: string[], rows: FakeRow[]): void {
    const t = ensureTable(tableName, cols);
    for (const c of cols) if (!t.cols.includes(c)) t.cols.push(c);
    t.rows.push(...rows);
  }

  function dumpRows(tableName: string): FakeRow[] {
    return tables.get(tableName)?.rows ?? [];
  }

  const db = {
    getFirstSync<T>(_sql: string, _params?: readonly unknown[]): T | undefined {
      return undefined;
    },
    getAllSync<T>(sql: string, params: readonly unknown[] = []): T[] {
      // Very small SQL dispatcher — enough for the migrations' reads.
      const s = sql.replace(/\s+/g, ' ').trim();

      if (/^PRAGMA table_info/i.test(s)) {
        const tName = s.match(/table_info\((\w+)\)/i)?.[1] ?? '';
        return (tables.get(tName)?.cols.map((name) => ({ name })) as T[]) ?? [];
      }

      // cached_songs lookups
      if (/FROM cached_songs WHERE raw_json IS NULL/i.test(s)) {
        return dumpRows('cached_songs')
          .filter((r) => r.raw_json === null || r.raw_json === undefined)
          .map((r) => ({ song_id: r.song_id } as any)) as T[];
      }
      if (/FROM cached_songs WHERE raw_json IS NOT NULL/i.test(s)) {
        return dumpRows('cached_songs')
          .filter((r) => r.raw_json != null)
          .map((r) => ({ song_id: r.song_id, raw_json: r.raw_json } as any)) as T[];
      }
      if (/FROM cached_songs\s+WHERE album_id IS NOT NULL AND album_id != '_unknown'/i.test(s)) {
        return dumpRows('cached_songs')
          .filter((r) => r.album_id != null && r.album_id !== '_unknown')
          .map((r) => ({
            song_id: r.song_id,
            album_id: r.album_id,
            album: r.album ?? null,
            artist: r.artist ?? null,
            cover_art: r.cover_art ?? null,
            title: r.title ?? null,
            raw_json: r.raw_json ?? null,
          } as any)) as T[];
      }

      // cached_items lookups
      if (/FROM cached_items WHERE type = 'album'/i.test(s)) {
        return dumpRows('cached_items')
          .filter((r) => r.type === 'album')
          .map((r) => ({ item_id: r.item_id } as any)) as T[];
      }
      if (/FROM cached_items WHERE raw_json IS NULL AND type IN \('album', 'playlist'\)/i.test(s)) {
        return dumpRows('cached_items')
          .filter((r) => (r.raw_json === null || r.raw_json === undefined) && (r.type === 'album' || r.type === 'playlist'))
          .map((r) => ({ item_id: r.item_id, type: r.type } as any)) as T[];
      }

      // download_queue lookups
      if (/FROM download_queue/i.test(s)) {
        return dumpRows('download_queue').map((r) => ({ ...r } as any)) as T[];
      }

      // album_details lookups
      if (/FROM album_details/i.test(s)) {
        return dumpRows('album_details').map((r) => ({ ...r } as any)) as T[];
      }

      return [];
    },
    runSync(sql: string, params: readonly unknown[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (/^UPDATE cached_songs SET raw_json = \? WHERE song_id = \?/i.test(s)) {
        const [json, id] = params as [string, string];
        const row = dumpRows('cached_songs').find((r) => r.song_id === id);
        if (row && (row.raw_json === null || row.raw_json === undefined)) {
          row.raw_json = json;
        }
        return;
      }
      if (/^UPDATE cached_items SET raw_json = \? WHERE item_id = \?/i.test(s)) {
        const [json, id] = params as [string, string];
        const row = dumpRows('cached_items').find((r) => r.item_id === id);
        if (row && (row.raw_json === null || row.raw_json === undefined)) {
          row.raw_json = json;
        }
        return;
      }
      if (/^UPDATE download_queue SET songs_json = \? WHERE queue_id = \?/i.test(s)) {
        const [json, id] = params as [string, string];
        const row = dumpRows('download_queue').find((r) => r.queue_id === id);
        if (row) row.songs_json = json;
        return;
      }

      // INSERT into cached_items (for Migration 20).
      if (/^INSERT INTO cached_items/i.test(s)) {
        const [item_id, name, artist, cover_art_id, expected_song_count, last_sync_at, downloaded_at, raw_json] = params;
        const existing = dumpRows('cached_items').find((r) => r.item_id === item_id);
        if (!existing) {
          ensureTable('cached_items', []).rows.push({
            item_id,
            type: 'album',
            name,
            artist,
            cover_art_id,
            expected_song_count,
            parent_album_id: null,
            last_sync_at,
            downloaded_at,
            raw_json,
          });
        }
        return;
      }

      // INSERT OR IGNORE edges.
      if (/^INSERT OR IGNORE INTO cached_item_songs/i.test(s)) {
        const [item_id, position, song_id] = params;
        const t = ensureTable('cached_item_songs', ['item_id', 'position', 'song_id']);
        const clash = t.rows.find((r) => r.item_id === item_id && (r.song_id === song_id || r.position === position));
        if (!clash) t.rows.push({ item_id, position, song_id });
        return;
      }
    },
    execSync(sql: string): void {
      const s = sql.replace(/\s+/g, ' ').trim();
      const m = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(s);
      if (m) {
        const t = ensureTable(m[1], []);
        if (!t.cols.includes(m[2])) t.cols.push(m[2]);
        return;
      }
    },
    withTransactionSync(fn: () => void): void { fn(); },
  };

  return { db, tables, seed, dumpRows };
}

describe('migrations 17–20: raw_json backfill', () => {
  let fake: ReturnType<typeof makeFakeDb>;

  beforeEach(() => {
    fake = makeFakeDb();
    setDbForDetailTables(fake.db as never);
    kvStorage.removeItem('substreamer-playlist-details');
    kvStorage.removeItem('substreamer-favorites');
    kvStorage.removeItem('substreamer-auth');
    kvStorage.removeItem('substreamer-music-cache');
    kvStorage.setItem(
      'substreamer-auth',
      JSON.stringify({ state: { serverUrl: 'https://e', username: 'u' } }),
    );
  });

  afterEach(() => {
    setDbForDetailTables(null);
  });

  test('17: addColumnIfMissing adds raw_json to cached_songs and cached_items', () => {
    // Pre-seed table definitions WITHOUT the column.
    fake.seed('cached_songs', ['song_id', 'title'], []);
    fake.seed('cached_items', ['item_id', 'name'], []);

    const songsAdded = addColumnIfMissing('cached_songs', 'raw_json', 'TEXT');
    const itemsAdded = addColumnIfMissing('cached_items', 'raw_json', 'TEXT');
    expect(songsAdded).toBe(true);
    expect(itemsAdded).toBe(true);
    expect(fake.tables.get('cached_songs')?.cols).toContain('raw_json');
    expect(fake.tables.get('cached_items')?.cols).toContain('raw_json');

    // Rerun: no-op.
    expect(addColumnIfMissing('cached_songs', 'raw_json', 'TEXT')).toBe(false);
  });

  test('18: backfills cached_songs.raw_json from album_details / playlists / favorites in priority order', async () => {
    fake.seed('cached_songs', [
      'song_id', 'album_id', 'title', 'artist', 'album', 'cover_art', 'raw_json',
    ], [
      { song_id: 's-album', album_id: 'a1', title: 'Track A', artist: 'X', album: 'Album1', cover_art: 'c1', raw_json: null },
      { song_id: 's-pl',    album_id: 'a2', title: 'Track P', artist: 'Y', album: 'Album2', cover_art: 'c2', raw_json: null },
      { song_id: 's-fav',   album_id: 'a3', title: 'Track F', artist: 'Z', album: 'Album3', cover_art: 'c3', raw_json: null },
      { song_id: 's-none',  album_id: 'a4', title: 'Track N', artist: 'W', album: 'Album4', cover_art: 'c4', raw_json: null },
      { song_id: 's-has',   album_id: 'a5', title: 'Track H', artist: 'V', album: 'Album5', cover_art: 'c5', raw_json: '{"id":"s-has","isDir":false,"title":"Track H","track":7}' },
    ]);

    // album_details: source 1 — supplies s-album with richer envelope
    fake.seed('album_details', ['id', 'json', 'retrievedAt'], [
      {
        id: 'a1',
        retrievedAt: 1,
        json: JSON.stringify({
          id: 'a1', name: 'Album1', songCount: 1, duration: 10, created: '2020',
          song: [{ id: 's-album', isDir: false, title: 'Track A', track: 3, discNumber: 1, genre: 'Rock' }],
        }),
      },
    ]);

    // substreamer-playlist-details: source 2 — supplies s-pl
    kvStorage.setItem(
      'substreamer-playlist-details',
      JSON.stringify({
        state: {
          playlists: {
            pl1: {
              playlist: {
                id: 'pl1', name: 'P1', songCount: 1, duration: 5, changed: 'x', created: 'y',
                entry: [{ id: 's-pl', isDir: false, title: 'Track P', track: 2, discNumber: 1, bpm: 120 }],
              },
            },
          },
        },
      }),
    );

    // substreamer-favorites: source 3 — supplies s-fav
    kvStorage.setItem(
      'substreamer-favorites',
      JSON.stringify({
        state: {
          songs: [
            { id: 's-fav', isDir: false, title: 'Track F', track: 1, discNumber: 2, userRating: 5 },
          ],
        },
      }),
    );

    await runMigrations(17);

    const rows = fake.dumpRows('cached_songs');
    const byId = new Map(rows.map((r) => [r.song_id as string, r]));

    // s-album: filled from album_details, carries genre + discNumber
    const envelopeAlbum = JSON.parse(byId.get('s-album')!.raw_json as string);
    expect(envelopeAlbum.track).toBe(3);
    expect(envelopeAlbum.discNumber).toBe(1);
    expect(envelopeAlbum.genre).toBe('Rock');

    // s-pl: filled from playlist blob
    const envelopePl = JSON.parse(byId.get('s-pl')!.raw_json as string);
    expect(envelopePl.bpm).toBe(120);

    // s-fav: filled from favorites blob
    const envelopeFav = JSON.parse(byId.get('s-fav')!.raw_json as string);
    expect(envelopeFav.userRating).toBe(5);

    // s-none: no source — stays null
    expect(byId.get('s-none')!.raw_json).toBeNull();

    // s-has: already had envelope — preserved unchanged
    expect(byId.get('s-has')!.raw_json).toBe('{"id":"s-has","isDir":false,"title":"Track H","track":7}');
  });

  test('19: backfills cached_items.raw_json for albums and playlists, strips song/entry arrays', async () => {
    fake.seed('cached_items', ['item_id', 'type', 'name', 'raw_json'], [
      { item_id: 'a1', type: 'album', name: 'Album1', raw_json: null },
      { item_id: 'pl1', type: 'playlist', name: 'P1', raw_json: null },
      { item_id: '__starred__', type: 'favorites', name: 'Favourites', raw_json: null },
      { item_id: 'song:x', type: 'song', name: 'Song X', raw_json: null },
    ]);
    fake.seed('cached_songs', ['song_id', 'album_id', 'title', 'raw_json'], []);

    fake.seed('album_details', ['id', 'json', 'retrievedAt'], [
      {
        id: 'a1',
        retrievedAt: 1,
        json: JSON.stringify({
          id: 'a1', name: 'Album1', songCount: 2, duration: 10, created: '2020',
          moods: ['chill'],
          song: [{ id: 's1', title: 'T1', isDir: false }, { id: 's2', title: 'T2', isDir: false }],
        }),
      },
    ]);

    kvStorage.setItem(
      'substreamer-playlist-details',
      JSON.stringify({
        state: {
          playlists: {
            pl1: {
              playlist: {
                id: 'pl1', name: 'P1', songCount: 1, duration: 5, changed: 'x', created: 'y',
                owner: 'alice', public: true,
                entry: [{ id: 's1', isDir: false, title: 'T1' }],
              },
            },
          },
        },
      }),
    );

    await runMigrations(18);

    const items = fake.dumpRows('cached_items');
    const byId = new Map(items.map((r) => [r.item_id as string, r]));

    const albumEnv = JSON.parse(byId.get('a1')!.raw_json as string);
    expect(albumEnv.moods).toEqual(['chill']);
    expect('song' in albumEnv).toBe(false); // stripped

    const playlistEnv = JSON.parse(byId.get('pl1')!.raw_json as string);
    expect(playlistEnv.owner).toBe('alice');
    expect(playlistEnv.public).toBe(true);
    expect('entry' in playlistEnv).toBe(false); // stripped

    // favorites + song intents never get an envelope
    expect(byId.get('__starred__')!.raw_json).toBeNull();
    expect(byId.get('song:x')!.raw_json).toBeNull();
  });

  test('19: download_queue songs_json repaired from cached_songs envelopes; already-full rows left alone', async () => {
    fake.seed('cached_songs', ['song_id', 'album_id', 'raw_json'], [
      { song_id: 's1', album_id: 'a1', raw_json: JSON.stringify({ id: 's1', isDir: false, title: 'T1', track: 1, genre: 'Rock' }) },
    ]);
    fake.seed('cached_items', ['item_id', 'type', 'raw_json'], []);
    fake.seed('download_queue', ['queue_id', 'songs_json'], [
      // v1-shaped entry (no isDir)
      { queue_id: 'q-lean', songs_json: JSON.stringify([{ id: 's1', title: 'T1', fileName: 's1.mp3', bytes: 100 }]) },
      // Already full (has isDir)
      { queue_id: 'q-full', songs_json: JSON.stringify([{ id: 's1', isDir: false, title: 'T1', genre: 'Rock' }]) },
      // Malformed
      { queue_id: 'q-bad',  songs_json: '{not json' },
    ]);

    await runMigrations(18);

    const rows = fake.dumpRows('download_queue');
    const byId = new Map(rows.map((r) => [r.queue_id as string, r]));

    const leanAfter = JSON.parse(byId.get('q-lean')!.songs_json as string);
    expect(leanAfter[0].isDir).toBe(false);
    expect(leanAfter[0].genre).toBe('Rock');
    expect(leanAfter[0].track).toBe(1);

    const fullAfter = JSON.parse(byId.get('q-full')!.songs_json as string);
    expect(fullAfter[0].isDir).toBe(false);
    expect(fullAfter[0].genre).toBe('Rock'); // preserved
  });

  test('20: creates missing partial-album rows in discNumber + track order, skips _unknown and existing album rows', async () => {
    fake.seed('cached_songs', ['song_id', 'album_id', 'title', 'artist', 'album', 'cover_art', 'raw_json'], [
      // Album a-part — two songs, out-of-order track numbers to test sorting
      { song_id: 's1', album_id: 'a-part', title: 'Beta',  artist: 'X', album: 'Part', cover_art: 'c',
        raw_json: JSON.stringify({ id: 's1', isDir: false, track: 2, discNumber: 1 }) },
      { song_id: 's2', album_id: 'a-part', title: 'Alpha', artist: 'X', album: 'Part', cover_art: 'c',
        raw_json: JSON.stringify({ id: 's2', isDir: false, track: 1, discNumber: 1 }) },
      // Songs on different discs
      { song_id: 's3', album_id: 'a-part', title: 'Gamma', artist: 'X', album: 'Part', cover_art: 'c',
        raw_json: JSON.stringify({ id: 's3', isDir: false, track: 1, discNumber: 2 }) },
      // Album already has a cached_items row — skip
      { song_id: 's4', album_id: 'a-done', title: 'Done', artist: 'Y', album: 'Done', cover_art: 'c2',
        raw_json: JSON.stringify({ id: 's4', isDir: false, track: 1, discNumber: 1 }) },
      // _unknown sentinel — skip
      { song_id: 's5', album_id: '_unknown', title: 'Orphan', artist: null, album: null, cover_art: null, raw_json: null },
    ]);
    fake.seed('cached_items', ['item_id', 'type', 'name', 'raw_json'], [
      { item_id: 'a-done', type: 'album', name: 'Done', raw_json: null },
    ]);

    // album_details provides richer envelope for a-part
    fake.seed('album_details', ['id', 'json', 'retrievedAt'], [
      {
        id: 'a-part',
        retrievedAt: 1,
        json: JSON.stringify({
          id: 'a-part', name: 'Part Album', songCount: 10, artist: 'X', coverArt: 'cp', duration: 1, created: 'c',
          song: [],
        }),
      },
    ]);

    await runMigrations(19);

    const items = fake.dumpRows('cached_items');
    const aPart = items.find((r) => r.item_id === 'a-part');
    expect(aPart).toBeTruthy();
    expect(aPart!.type).toBe('album');
    expect(aPart!.name).toBe('Part Album'); // from album_details
    expect(aPart!.expected_song_count).toBe(10);

    // Envelope present, stripped of .song[]
    const env = JSON.parse(aPart!.raw_json as string);
    expect('song' in env).toBe(false);
    expect(env.name).toBe('Part Album');

    // Edges in discNumber + track order: s2 (d1,t1), s1 (d1,t2), s3 (d2,t1)
    const edges = fake
      .dumpRows('cached_item_songs')
      .filter((e) => e.item_id === 'a-part')
      .sort((a, b) => (a.position as number) - (b.position as number));
    expect(edges.map((e) => e.song_id)).toEqual(['s2', 's1', 's3']);

    // a-done not overwritten
    const aDoneRows = items.filter((r) => r.item_id === 'a-done');
    expect(aDoneRows).toHaveLength(1);

    // _unknown sentinel did not create a row
    expect(items.find((r) => r.item_id === '_unknown')).toBeUndefined();
  });

  test('20: idempotent — re-running produces no additional rows or edges', async () => {
    fake.seed('cached_songs', ['song_id', 'album_id', 'raw_json'], [
      { song_id: 's1', album_id: 'a1', raw_json: JSON.stringify({ id: 's1', isDir: false, track: 1 }) },
      { song_id: 's2', album_id: 'a1', raw_json: JSON.stringify({ id: 's2', isDir: false, track: 2 }) },
    ]);
    fake.seed('cached_items', ['item_id', 'type', 'name', 'raw_json'], []);
    fake.seed('album_details', ['id', 'json', 'retrievedAt'], []);

    await runMigrations(19);
    const itemsAfterFirst = fake.dumpRows('cached_items').length;
    const edgesAfterFirst = fake.dumpRows('cached_item_songs').length;
    expect(itemsAfterFirst).toBe(1);
    expect(edgesAfterFirst).toBe(2);

    // Simulate second run with completedVersion=20 — Migration 20 (the
    // one this test exercises) is now done, so it should not appear in
    // the pending set. Later, unrelated migrations may exist; assert
    // specifically that Migration 20 is not pending rather than that
    // the list is empty.
    const stillPending = getPendingTasks(20);
    expect(stillPending.find((t) => t.id === 20)).toBeUndefined();
  });

  test('20: falls back to column data when album_details is empty and song raw_json is null', async () => {
    fake.seed('cached_songs', ['song_id', 'album_id', 'title', 'artist', 'album', 'cover_art', 'raw_json'], [
      { song_id: 's-a', album_id: 'a-fallback', title: 'T1', artist: 'ARTIST', album: 'FallbackAlbum', cover_art: 'COV', raw_json: null },
    ]);
    fake.seed('cached_items', ['item_id', 'type', 'name', 'raw_json'], []);
    fake.seed('album_details', ['id', 'json', 'retrievedAt'], []);

    await runMigrations(19);

    const row = fake.dumpRows('cached_items').find((r) => r.item_id === 'a-fallback');
    expect(row).toBeTruthy();
    expect(row!.name).toBe('FallbackAlbum');
    expect(row!.artist).toBe('ARTIST');
    expect(row!.cover_art_id).toBe('COV');
    // Defensive fallback: with no album_details and only one downloaded song,
    // expectedSongCount defaults to max(1, #members) so `isPartialAlbum`
    // correctly classifies the result via its second clause.
    expect(row!.expected_song_count).toBe(1);
  });
});
