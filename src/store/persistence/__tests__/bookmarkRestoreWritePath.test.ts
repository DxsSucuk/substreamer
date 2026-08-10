/**
 * Backup RESTORE onto the shared snapshot table, against REAL SQL on the
 * better-sqlite3-backed op-SQLite substitute: merge mode writes the merged-in bookmarks
 * through without disturbing the ones that won their collision, replace mode removes
 * the old set BEFORE writing the file's, a statement failure part-way leaves the old
 * set whole rather than a mix of both, and an old backup file — the format is
 * unchanged — still restores.
 *
 * Export is asserted here too, because the SOURCE is the deliberate half of this: the
 * file is written from the store, which is the complete set, not from the table, which
 * holds only what has been saved since the upgrade until D1.4's migration runs.
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

import type { Child } from 'subsonic-api';

import { settleDbWrites } from '../../../test-utils/settleDbWrites';
import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  readSnapshotSync,
  replaceSnapshotTracks,
  SNAPSHOT_LIVE_ID,
  upsertSnapshot,
} from '../queueSnapshotTable';
import { bookmarksStore, type PlayQueueBookmark } from '../../bookmarksStore';
import { authStore } from '../../authStore';
import { createBackup, restoreBackup, type BackupEntry } from '../../../services/backupService';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite substitute failed to open');
const realDb: InternalDb = handle;

/** A `Child` carrying all five arrays, so a restored track is checked whole. */
const fullSong = {
  id: 's-full',
  title: 'Full Song',
  artist: 'The Artist',
  album: 'The Album',
  isDir: false,
  isVideo: false,
  coverArt: 'cov-1',
  duration: 210,
  albumId: 'al-1',
  artistId: 'ar-1',
  year: 1999,
  track: 4,
  suffix: 'flac',
  bitRate: 960,
  userRating: 4,
  genres: [{ name: 'Rock' }, { name: 'Indie' }],
  artists: [{ id: 'ar-1', name: 'The Artist' }],
  albumArtists: [{ id: 'ar-3', name: 'Various' }],
  contributors: [{ role: 'composer', artist: { id: 'ar-4', name: 'Composer' } }],
  moods: ['energetic'],
} as unknown as Child;

const song = (id: string): Child => ({ ...fullSong, id, title: `Title ${id}` });

const queueOf = (n: number, prefix: string): Child[] =>
  Array.from({ length: n }, (_, i) => song(`${prefix}-${i}`));

const bookmark = (id: string, overrides: Partial<PlayQueueBookmark> = {}): PlayQueueBookmark => ({
  id,
  name: `Bookmark ${id}`,
  createdAt: 1_700_000_000_000,
  queue: queueOf(3, id),
  currentIndex: 1,
  positionSec: 12.5,
  ...overrides,
});

const STEM = 'backup-test';
const TEST_SERVER = 'https://music.example.com';
const TEST_USER = 'testuser';

/** A listing entry pointing at a bookmarks-only backup file. */
const backupEntry = (bookmarkCount: number): BackupEntry => ({
  createdAt: '2026-08-09T00:00:00Z',
  scrobbleCount: 0,
  scrobbleSizeBytes: 0,
  mbidOverrideCount: 0,
  mbidOverrideSizeBytes: 0,
  scrobbleExclusionCount: 0,
  scrobbleExclusionSizeBytes: 0,
  bookmarkCount,
  bookmarkSizeBytes: 100,
  stem: STEM,
  serverUrl: TEST_SERVER,
  username: TEST_USER,
  deviceId: null,
  deviceName: null,
  deviceLabel: null,
});

/** Put a bookmarks dataset on "disk" and make `decompressFromFile` return it. */
function seedBackupFile(payload: unknown): void {
  mockFileInstances.set(`${STEM}.bookmarks.gz`, { exists: true, content: '' });
  mockDecompressFromFile.mockResolvedValue(JSON.stringify(payload));
}

const parentIds = (): string[] =>
  realDb
    .getAllSync<{ id: string }>(
      "SELECT id FROM queue_snapshots WHERE kind = 'bookmark' ORDER BY id;",
    )
    .map((r) => r.id);

const songRows = (snapshotId: string): unknown[] =>
  realDb.getAllSync('SELECT * FROM queue_snapshot_songs WHERE snapshot_id = ? ORDER BY pos;', [
    snapshotId,
  ]);

const CHILD_TABLES = [
  'queue_snapshot_songs',
  'queue_snapshot_song_genres',
  'queue_snapshot_song_artists',
  'queue_snapshot_song_album_artists',
  'queue_snapshot_song_contributors',
  'queue_snapshot_song_moods',
];

const countRows = (table: string, snapshotId: string): number =>
  realDb.getFirstSync<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE snapshot_id = ?;`, [
    snapshotId,
  ])?.c ?? 0;

/** The store's write-throughs are fire-and-forget, and a batch is parked on
 *  op-SQLite's transaction lock — one macrotask each. */
const settle = settleDbWrites;

/** Seed bookmarks the way the app does, through the store, so SQL holds them too. */
async function seedExisting(...bookmarks: PlayQueueBookmark[]): Promise<void> {
  for (const b of bookmarks) bookmarksStore.getState().addBookmark(b);
  await settle();
}

beforeEach(() => {
  __setDbForTests(realDb);
  realDb.runSync('DELETE FROM queue_snapshots;');
  bookmarksStore.setState({ bookmarks: {}, autoName: true, sortOrder: 'newest' });
  mockFileInstances.clear();
  mockCompressToFile.mockReset();
  mockDecompressFromFile.mockReset();
  authStore.setState({ serverUrl: TEST_SERVER, username: TEST_USER, isLoggedIn: true });
});

/* ------------------------------------------------------------------ */
/*  Merge mode                                                         */
/* ------------------------------------------------------------------ */

describe('restoreBackup — merge mode', () => {
  it('writes the merged-in bookmarks through with their full tracks', async () => {
    await seedExisting(bookmark('bm-local'));
    seedBackupFile({ 'bm-file': bookmark('bm-file', { name: 'From The File' }) });

    const counts = await restoreBackup(backupEntry(1), 'merge');
    await settle();

    expect(counts.bookmarkCount).toBe(1);
    expect(parentIds()).toEqual(['bm-file', 'bm-local']);
    const restored = readSnapshotSync('bm-file');
    expect(restored).toMatchObject({
      kind: 'bookmark',
      name: 'From The File',
      currentIndex: 1,
      positionSec: 12.5,
      trackCount: 3,
    });
    expect(restored?.tracks.map((t) => t.id)).toEqual(['bm-file-0', 'bm-file-1', 'bm-file-2']);
    // The five arrays travel with the track — the scrobble write path reads them
    // out of a restored queue.
    expect(restored?.tracks[0].genres).toEqual(['Rock', 'Indie']);
    expect(restored?.tracks[0].moods).toEqual(['energetic']);
    expect(restored?.tracks[0].contributors).toEqual([
      { role: 'composer', artist: { id: 'ar-4', name: 'Composer', albumCount: 0 } },
    ]);
  });

  it('leaves a bookmark that won its id collision exactly as it was', async () => {
    await seedExisting(bookmark('bm-local', { name: 'Local' }));
    const before = songRows('bm-local');
    seedBackupFile({
      'bm-local': bookmark('bm-local', { name: 'From The File', queue: queueOf(9, 'other') }),
      'bm-file': bookmark('bm-file'),
    });

    const counts = await restoreBackup(backupEntry(2), 'merge');
    await settle();

    expect(counts).toMatchObject({ bookmarkCount: 1, bookmarkSkipped: 1 });
    expect(readSnapshotSync('bm-local')?.name).toBe('Local');
    expect(songRows('bm-local')).toEqual(before);
    expect(readSnapshotSync('bm-local')?.trackCount).toBe(3);
  });

  it('drops malformed entries instead of writing them', async () => {
    seedBackupFile({
      ok: bookmark('ok'),
      noQueue: { id: 'noQueue', name: 'x', createdAt: 1, currentIndex: 0, positionSec: 0 },
      nullEntry: null,
    });

    const counts = await restoreBackup(backupEntry(3), 'merge');
    await settle();

    expect(counts).toMatchObject({ bookmarkCount: 1, bookmarkSkipped: 2 });
    expect(parentIds()).toEqual(['ok']);
  });
});

/* ------------------------------------------------------------------ */
/*  Replace mode — the inversion bug                                   */
/* ------------------------------------------------------------------ */

describe('restoreBackup — replace mode', () => {
  it('holds the file’s bookmarks and NOT the previous ones', async () => {
    await seedExisting(bookmark('old-1'), bookmark('old-2'));
    seedBackupFile({ 'new-1': bookmark('new-1'), 'new-2': bookmark('new-2') });

    const counts = await restoreBackup(backupEntry(2), 'replace');
    await settle();

    expect(counts.bookmarkCount).toBe(2);
    // Present: the file's.
    expect(parentIds()).toEqual(['new-1', 'new-2']);
    expect(readSnapshotSync('new-1')?.tracks.map((t) => t.id)).toEqual([
      'new-1-0',
      'new-1-1',
      'new-1-2',
    ]);
    // Absent: the ones the user asked to replace — parents and every child row.
    expect(readSnapshotSync('old-1')).toBeNull();
    expect(readSnapshotSync('old-2')).toBeNull();
    for (const table of CHILD_TABLES) {
      expect(countRows(table, 'old-1')).toBe(0);
      expect(countRows(table, 'old-2')).toBe(0);
    }
    expect(Object.keys(bookmarksStore.getState().bookmarks).sort()).toEqual(['new-1', 'new-2']);
  });

  it('never touches the live queue row', async () => {
    await upsertSnapshot({
      id: SNAPSHOT_LIVE_ID,
      kind: 'live',
      name: null,
      createdAt: 1_600_000_000_000,
      currentIndex: 2,
      positionSec: 30,
    });
    await replaceSnapshotTracks(SNAPSHOT_LIVE_ID, queueOf(4, 'live'));
    await seedExisting(bookmark('old-1'));
    seedBackupFile({ 'new-1': bookmark('new-1') });

    await restoreBackup(backupEntry(1), 'replace');
    await settle();

    const live = readSnapshotSync(SNAPSHOT_LIVE_ID);
    expect(live).toMatchObject({ kind: 'live', currentIndex: 2, positionSec: 30, trackCount: 4 });
    expect(live?.tracks.map((t) => t.id)).toEqual(queueOf(4, 'live').map((t) => t.id));
  });

  it('clears the rows when the file holds nothing valid', async () => {
    await seedExisting(bookmark('old-1'));
    seedBackupFile({ bad: { id: '', name: 'no id' }, worse: null });

    const counts = await restoreBackup(backupEntry(2), 'replace');
    await settle();

    expect(counts.bookmarkCount).toBe(0);
    expect(parentIds()).toEqual([]);
    expect(bookmarksStore.getState().bookmarks).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/*  Failure part-way                                                   */
/* ------------------------------------------------------------------ */

describe('a restore that fails part-way', () => {
  /** A queue whose second track binds an object where a scalar column is expected —
   *  what a corrupt or hand-edited backup file produces. It passes the entry
   *  validator (id + array queue) and aborts the batch at its INSERT. */
  const poisoned = (): Child[] => {
    const tracks = queueOf(3, 'new-2');
    tracks[1] = { ...tracks[1], duration: {} as unknown as number };
    return tracks;
  };

  it('leaves the old set whole rather than a mix of both', async () => {
    await seedExisting(bookmark('old-1'), bookmark('old-2'));
    const before = songRows('old-1');
    seedBackupFile({
      'new-1': bookmark('new-1'),
      'new-2': bookmark('new-2', { queue: poisoned() }),
    });

    await restoreBackup(backupEntry(2), 'replace');
    await settle();

    // The whole batch rolled back: the DELETE, the bookmark that had already been
    // written and the one that failed.
    expect(parentIds()).toEqual(['old-1', 'old-2']);
    expect(songRows('old-1')).toEqual(before);
    expect(readSnapshotSync('old-2')?.trackCount).toBe(3);
    expect(readSnapshotSync('new-1')).toBeNull();
    expect(readSnapshotSync('new-2')).toBeNull();
    // Memory takes the file either way — it is the KV blob's source, and today that
    // is what the user sees. The rows are the fail-safe half: never a mixed set.
    expect(Object.keys(bookmarksStore.getState().bookmarks).sort()).toEqual(['new-1', 'new-2']);
  });

  it('writes nothing at all in merge mode', async () => {
    await seedExisting(bookmark('old-1'));
    seedBackupFile({
      'new-1': bookmark('new-1'),
      'new-2': bookmark('new-2', { queue: poisoned() }),
    });

    await restoreBackup(backupEntry(2), 'merge');
    await settle();

    expect(parentIds()).toEqual(['old-1']);
  });
});

/* ------------------------------------------------------------------ */
/*  The file format does not change                                    */
/* ------------------------------------------------------------------ */

describe('an old backup file', () => {
  /** What a backup taken before the snapshot table holds: the same
   *  `Record<string, PlayQueueBookmark>`, with plain `Child`s straight out of the KV
   *  blob — no OpenSubsonic array fields, no extended columns. */
  const legacyPayload = {
    'legacy-1': {
      id: 'legacy-1',
      name: 'Old Friday Evening',
      createdAt: 1_600_000_000_000,
      currentIndex: 1,
      positionSec: 42,
      queue: [
        { id: 'l-1', title: 'Legacy One', artist: 'A', album: 'B', duration: 100, isDir: false },
        { id: 'l-2', title: 'Legacy Two', artist: 'A', album: 'B', duration: 120, isDir: false },
      ],
    },
  };

  it('restores in replace mode', async () => {
    seedBackupFile(legacyPayload);

    const counts = await restoreBackup(backupEntry(1), 'replace');
    await settle();

    expect(counts.bookmarkCount).toBe(1);
    const restored = readSnapshotSync('legacy-1');
    expect(restored).toMatchObject({
      kind: 'bookmark',
      name: 'Old Friday Evening',
      createdAt: 1_600_000_000_000,
      currentIndex: 1,
      positionSec: 42,
      trackCount: 2,
    });
    expect(restored?.tracks.map((t) => t.id)).toEqual(['l-1', 'l-2']);
    expect(restored?.tracks[0]).toMatchObject({
      title: 'Legacy One',
      artist: 'A',
      album: 'B',
      duration: 100,
    });
  });

  it('restores in merge mode alongside a newer bookmark', async () => {
    await seedExisting(bookmark('bm-local'));
    seedBackupFile(legacyPayload);

    await restoreBackup(backupEntry(1), 'merge');
    await settle();

    expect(parentIds()).toEqual(['bm-local', 'legacy-1']);
    expect(readSnapshotSync('legacy-1')?.tracks).toHaveLength(2);
    expect(readSnapshotSync('bm-local')?.tracks).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ */
/*  Export                                                             */
/* ------------------------------------------------------------------ */

describe('createBackup — the bookmarks dataset', () => {
  it('writes the store map unchanged, as the same Record<id, bookmark> shape', async () => {
    const one = bookmark('bm-1', { name: 'Tuesday Mid Morning' });
    bookmarksStore.setState({ bookmarks: { 'bm-1': one } });
    mockCompressToFile.mockResolvedValue({ bytes: 64 });

    await createBackup();

    const payloads = mockCompressToFile.mock.calls.filter(([, uri]) =>
      String(uri).includes('.bookmarks.gz'),
    );
    expect(payloads).toHaveLength(1);
    expect(JSON.parse(payloads[0][0] as string)).toEqual(
      JSON.parse(JSON.stringify({ 'bm-1': one })),
    );

    const metaEntry = Array.from(mockFileInstances.entries()).find(([k]) =>
      k.endsWith('.meta.json'),
    );
    const meta = JSON.parse(metaEntry?.[1].content ?? '{}');
    expect(meta.version).toBe(6);
    expect(meta.bookmarks).toEqual({ itemCount: 1, sizeBytes: 64 });
  });

  it('exports the store, not the table — a SQL-only row is not in the file', async () => {
    await seedExisting(bookmark('in-both'));
    // In SQL only: exporting from the repository would pick this up, and would drop
    // everything the (KV-hydrated) store holds that the table does not yet.
    await upsertSnapshot({
      id: 'sql-only',
      kind: 'bookmark',
      name: 'SQL only',
      createdAt: 1,
      currentIndex: 0,
      positionSec: 0,
    });
    mockCompressToFile.mockResolvedValue({ bytes: 10 });

    await createBackup();

    const payload = mockCompressToFile.mock.calls.find(([, uri]) =>
      String(uri).includes('.bookmarks.gz'),
    );
    expect(Object.keys(JSON.parse(payload?.[0] as string))).toEqual(['in-both']);
  });

  it('writes no bookmarks dataset when the store holds none', async () => {
    await seedExisting(bookmark('sql-only'));
    bookmarksStore.setState({ bookmarks: {} });
    mockCompressToFile.mockResolvedValue({ bytes: 10 });

    await createBackup();

    expect(
      mockCompressToFile.mock.calls.some(([, uri]) => String(uri).includes('.bookmarks.gz')),
    ).toBe(false);
  });
});
