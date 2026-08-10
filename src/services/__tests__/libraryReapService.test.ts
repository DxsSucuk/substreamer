/**
 * The epoch reap, against REAL SQL on the better-sqlite3-backed op-SQLite substitute.
 *
 * The exclusions are the whole point of the feature, so each one gets a direct test:
 * the reap that deletes a genuinely server-deleted album has to leave a downloaded
 * album, a partially-downloaded album, a playlist's tracks, a starred row and an
 * un-stamped row exactly where they were.
 */
jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

import type { AlbumID3, Child } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { upsertAlbums } from '../../db/repository/albums';
import { setPlaylistSongs, upsertPlaylists } from '../../db/repository/playlists';
import { upsertSongs } from '../../db/repository/songs';
import { clearKvStorage, kvStorage } from '../../store/persistence';
import { __setDbForTests, getDb } from '../../store/persistence/db';
import { upsertCachedItem, upsertCachedSong } from '../../store/persistence/musicCacheTables';
import { syncStatusStore } from '../../store/syncStatusStore';
import { __resetLibraryReapForTests, runLibraryReapIfNeeded } from '../libraryReapService';

const db = () => getDb()!;

/** The epoch a completed full resync earned. Rows written before it are stale. */
const E = 1_800_000_000_000;
const STATE_KEY = 'substreamer-library-reap';

const TABLES = [
  'cached_item_songs',
  'cached_albums',
  'cached_playlists',
  'cached_items',
  'cached_songs',
  'playlist_songs',
  'playlists',
  'songs',
  'albums',
];

const album = (id: string): AlbumID3 => ({
  id,
  name: `Album ${id}`,
  created: new Date('2020-01-01'),
  duration: 100,
  songCount: 1,
});
const song = (id: string, albumId: string): Child =>
  ({ id, title: `Song ${id}`, albumId, isDir: false }) as Child;

/** Run a write with the clock pinned, so the row's `synced_at` is a value we chose. */
async function at<T>(nowMs: number, run: () => Promise<T>): Promise<T> {
  const spy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

const albumIds = (): string[] =>
  db()
    .getAllSync<{ id: string }>('SELECT id FROM albums ORDER BY id')
    .map((r) => r.id);
const songIds = (): string[] =>
  db()
    .getAllSync<{ id: string }>('SELECT id FROM songs ORDER BY id')
    .map((r) => r.id);

/** A downloaded track: the `cached_songs` row is the sole offline source for the file.
 *  `albumId` is the file's directory, which IS the server album id when it has one. */
const downloadSong = (id: string, albumId: string): Promise<void> =>
  upsertCachedSong({
    id,
    title: `Song ${id}`,
    albumId,
    bytes: 1,
    duration: 1,
    suffix: 'mp3',
    formatCapturedAt: 0,
    downloadedAt: 0,
  });

/** An album downloaded AS an album — the `cached_items` row a whole-album download makes. */
const downloadAlbumItem = (id: string): Promise<void> =>
  upsertCachedItem({
    itemId: id,
    type: 'album',
    name: `Album ${id}`,
    expectedSongCount: 1,
    lastSyncAt: 0,
    downloadedAt: 0,
  });

/**
 * The library a completed full resync at `E` left behind, plus one album the server
 * dropped (written BEFORE the run, so the run never restamped it).
 */
async function seedLibrary(): Promise<void> {
  await at(E - 60_000, async () => {
    await upsertAlbums(db(), [album('gone')]);
    await upsertSongs(db(), [song('gone-s1', 'gone'), song('gone-s2', 'gone')]);
  });
  await at(E + 1_000, async () => {
    await upsertAlbums(db(), [album('kept')]);
    await upsertSongs(db(), [song('kept-s1', 'kept')]);
  });
}

/** Authorise the reap: the epoch a full run that reached both markers would have left. */
const earnEpoch = (epoch: number | null = E): void => {
  syncStatusStore.setState({
    librarySyncComplete: true,
    songSyncComplete: true,
    fullResyncEpoch: epoch,
  });
};

beforeAll(() => ensureNormalizedSchema(db()));

beforeEach(() => {
  clearKvStorage();
  __resetLibraryReapForTests();
  syncStatusStore.setState({ fullResyncEpoch: null });
  for (const t of TABLES) db().runSync(`DELETE FROM ${t}`);
});

describe('runLibraryReapIfNeeded — the base case', () => {
  it('deletes a server-removed album and its songs after a completed full resync', async () => {
    await seedLibrary();
    earnEpoch();

    await runLibraryReapIfNeeded();

    expect(albumIds()).toEqual(['kept']);
    expect(songIds()).toEqual(['kept-s1']);
  });

  it('leaves a row written out-of-band mid-run alone — its stamp is >= the epoch', async () => {
    await seedLibrary();
    // A detail fetch / carousel refresh landing while the run was still walking: the
    // stamp is fresher than the epoch even though the sync itself never wrote the row.
    await at(E + 5, async () => {
      await upsertAlbums(db(), [album('out-of-band')]);
      await upsertSongs(db(), [song('out-of-band-s1', 'out-of-band')]);
    });
    earnEpoch();

    await runLibraryReapIfNeeded();

    expect(albumIds()).toEqual(['kept', 'out-of-band']);
    expect(songIds()).toEqual(['kept-s1', 'out-of-band-s1']);
  });
});

describe('runLibraryReapIfNeeded — the exclusions', () => {
  it("spares a downloaded album's songs while reaping everything else", async () => {
    await seedLibrary();
    await at(E - 60_000, async () => {
      await upsertAlbums(db(), [album('dl')]);
      await upsertSongs(db(), [song('dl-s1', 'dl'), song('dl-s2', 'dl')]);
    });
    await downloadAlbumItem('dl');
    await downloadSong('dl-s1', 'dl');
    await downloadSong('dl-s2', 'dl');
    earnEpoch();

    await runLibraryReapIfNeeded();

    // The whole album survives — and the server-deleted one still went.
    expect(albumIds()).toEqual(['dl', 'kept']);
    expect(songIds()).toEqual(['dl-s1', 'dl-s2', 'kept-s1']);
  });

  it('spares an album downloaded as an album before any track has landed', async () => {
    await seedLibrary();
    await at(E - 60_000, () => upsertAlbums(db(), [album('queued')]));
    // The `cached_items` row goes in when the download starts; a kill (or a stall)
    // before the first file lands leaves it with no `cached_songs` rows at all, so
    // nothing but the item row itself protects the album.
    await downloadAlbumItem('queued');
    earnEpoch();

    await runLibraryReapIfNeeded();

    expect(albumIds()).toEqual(['kept', 'queued']);
  });

  it('spares an album with only SOME of its tracks downloaded', async () => {
    await seedLibrary();
    await at(E - 60_000, async () => {
      await upsertAlbums(db(), [album('partial')]);
      await upsertSongs(db(), [
        song('partial-s1', 'partial'),
        song('partial-s2', 'partial'),
        song('partial-s3', 'partial'),
      ]);
    });
    // Three tracks in the library, ONE downloaded — and no `cached_items` row for the
    // album, which is exactly why the album exclusion cannot mirror the song one.
    await downloadSong('partial-s2', 'partial');
    expect(
      db().getFirstSync<{ n: number }>(
        "SELECT COUNT(*) AS n FROM cached_items WHERE item_id = 'partial'",
      )?.n,
    ).toBe(0);
    earnEpoch();

    await runLibraryReapIfNeeded();

    // The album row survives, so the offline detail screen and the CarPlay track list
    // (both `getAlbumDetail` → albums + songs) still resolve.
    expect(albumIds()).toEqual(['kept', 'partial']);
    // The downloaded track survives; its un-downloaded siblings are the server's call.
    expect(songIds()).toEqual(['kept-s1', 'partial-s2']);
  });

  it('spares the parent album recorded on a single-song download', async () => {
    await seedLibrary();
    await at(E - 60_000, () => upsertAlbums(db(), [album('single-parent')]));
    // A single-song download names its parent on the item row. The song's own
    // `cached_songs.album_id` is the file's directory, which is `_unknown` when the
    // server gave no album — so the item row is the only link back to the album.
    await upsertCachedItem({
      itemId: 'sng-1',
      type: 'song',
      name: 'Song sng-1',
      expectedSongCount: 1,
      parentAlbumId: 'single-parent',
      lastSyncAt: 0,
      downloadedAt: 0,
    });
    await downloadSong('sng-1', '_unknown');
    earnEpoch();

    await runLibraryReapIfNeeded();

    expect(albumIds()).toEqual(['kept', 'single-parent']);
  });

  it("spares a playlist's songs and leaves the playlist length unchanged", async () => {
    await seedLibrary();
    await at(E - 60_000, async () => {
      await upsertAlbums(db(), [album('pl-album')]);
      await upsertSongs(db(), [song('pl-s1', 'pl-album'), song('pl-s2', 'pl-album')]);
    });
    await upsertPlaylists(db(), [
      { id: 'p1', name: 'Mix', songCount: 2, duration: 2 } as never,
    ]);
    await setPlaylistSongs(db(), 'p1', ['pl-s1', 'pl-s2']);
    earnEpoch();

    await runLibraryReapIfNeeded();

    expect(songIds()).toContain('pl-s1');
    expect(songIds()).toContain('pl-s2');
    // `getPlaylistDetail` INNER JOINs `songs`, so a reaped member would shorten the
    // playlist with no error and no gap. Assert against the join, not the junction.
    const joined = db().getAllSync<{ id: string }>(
      'SELECT s.id FROM songs s JOIN playlist_songs ps ON ps.song_id = s.id ' +
        'WHERE ps.playlist_id = ? ORDER BY ps.position',
      ['p1'],
    );
    expect(joined.map((r) => r.id)).toEqual(['pl-s1', 'pl-s2']);
  });

  it('spares a starred song and a starred album', async () => {
    await seedLibrary();
    await at(E - 60_000, async () => {
      await upsertAlbums(db(), [album('starred-album')]);
      await upsertSongs(db(), [song('starred-s1', 'gone')]);
    });
    db().runSync('UPDATE albums SET starred = ? WHERE id = ?', [E - 90_000, 'starred-album']);
    db().runSync('UPDATE songs SET starred = ? WHERE id = ?', [E - 90_000, 'starred-s1']);
    earnEpoch();

    await runLibraryReapIfNeeded();

    // A starred-but-server-deleted row lingers forever. That is the trade: a stale row
    // costs a line in a list, a lost star costs the user something they chose.
    expect(albumIds()).toEqual(['kept', 'starred-album']);
    expect(songIds()).toEqual(['kept-s1', 'starred-s1']);
  });

  it('never reaps a row with a NULL synced_at', async () => {
    // What every row written before the stamp shipped looks like. `NULL < E` is NULL,
    // not true — the single biggest "deletes the whole library on upgrade" risk here.
    db().runSync("INSERT INTO albums (id, name) VALUES ('legacy-a', 'Legacy')");
    db().runSync("INSERT INTO songs (id, title, album_id) VALUES ('legacy-s', 'Legacy', 'legacy-a')");
    await seedLibrary();
    earnEpoch();

    await runLibraryReapIfNeeded();

    expect(albumIds()).toEqual(['kept', 'legacy-a']);
    expect(songIds()).toEqual(['kept-s1', 'legacy-s']);
  });
});

describe('runLibraryReapIfNeeded — the gate', () => {
  it('reaps nothing when no epoch has ever been earned', async () => {
    await seedLibrary();
    // A run that bailed, or an install that has never completed a full resync.
    syncStatusStore.setState({ fullResyncEpoch: null });

    await runLibraryReapIfNeeded();

    expect(albumIds()).toEqual(['gone', 'kept']);
    expect(songIds()).toEqual(['gone-s1', 'gone-s2', 'kept-s1']);
    expect(await kvStorage.getItem(STATE_KEY)).toBeNull();
  });

  it('does not reap the same epoch twice', async () => {
    await seedLibrary();
    earnEpoch();

    await runLibraryReapIfNeeded();
    expect(await kvStorage.getItem(STATE_KEY)).toBe(String(E));

    // A row that predates the epoch arriving after the pass — a legacy import, say.
    // The epoch is spent, so the next launch leaves it alone until a fresh full resync.
    await at(E - 60_000, () => upsertAlbums(db(), [album('late')]));
    __resetLibraryReapForTests();
    await runLibraryReapIfNeeded();

    expect(albumIds()).toEqual(['kept', 'late']);
  });

  it('reaps again once a later full resync earns a fresh epoch', async () => {
    await seedLibrary();
    earnEpoch();
    await runLibraryReapIfNeeded();

    await at(E - 60_000, () => upsertAlbums(db(), [album('late')]));

    // A second full resync: it mints E2 before its first write and restamps everything
    // the server still lists, which is what makes `late` provably absent from it.
    const E2 = E + 10_000;
    await at(E2 + 1_000, () => upsertAlbums(db(), [album('kept')]));
    __resetLibraryReapForTests();
    earnEpoch(E2);
    await runLibraryReapIfNeeded();

    expect(albumIds()).toEqual(['kept']);
    expect(await kvStorage.getItem(STATE_KEY)).toBe(String(E2));
  });

  it('does nothing when the database is unavailable', async () => {
    await seedLibrary();
    earnEpoch();
    const real = getDb()!;
    __setDbForTests(null);
    try {
      await runLibraryReapIfNeeded();
    } finally {
      __setDbForTests(real);
    }

    expect(albumIds()).toEqual(['gone', 'kept']);
    expect(await kvStorage.getItem(STATE_KEY)).toBeNull();
  });

  it('shares one pass between two callers rather than running it twice', async () => {
    await seedLibrary();
    earnEpoch();

    const first = runLibraryReapIfNeeded();
    expect(runLibraryReapIfNeeded()).toBe(first);
    await first;

    expect(albumIds()).toEqual(['kept']);
  });

  it('records nothing when the pass throws, so the next launch retries', async () => {
    await seedLibrary();
    earnEpoch();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const boom = jest
      .spyOn(db(), 'getAllAsync')
      .mockRejectedValueOnce(new Error('disk I/O error'));

    await runLibraryReapIfNeeded();
    expect(await kvStorage.getItem(STATE_KEY)).toBeNull();
    expect(albumIds()).toEqual(['gone', 'kept']);

    boom.mockRestore();
    __resetLibraryReapForTests();
    await runLibraryReapIfNeeded();
    expect(albumIds()).toEqual(['kept']);
    warn.mockRestore();
  });
});

describe('runLibraryReapIfNeeded — chunking', () => {
  it('walks past the chunk size in one pass', async () => {
    // 1200 stale songs over three chunks of 500, so the keyset cursor has to advance
    // correctly or the loop stalls or stops short.
    await at(E - 60_000, async () => {
      await upsertAlbums(db(), [album('bulk')]);
      await upsertSongs(
        db(),
        Array.from({ length: 1200 }, (_, i) => song(`b${String(i).padStart(5, '0')}`, 'bulk')),
      );
    });
    earnEpoch();

    await runLibraryReapIfNeeded();

    expect(songIds()).toEqual([]);
    expect(albumIds()).toEqual([]);
  });
});
