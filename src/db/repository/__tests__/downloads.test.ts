import { getDb } from '../../../store/persistence/db';
import { ensureNormalizedSchema } from '../../createNormalizedTables';
import { albumListRowToAlbumID3, upsertAlbums } from '../albums';
import { listAllStarredAlbums, markStarredAlbums } from '../favorites';
import {
  downloadedClause,
  listDownloadedAlbumIds,
  listDownloadedAlbums,
  listDownloadedPlaylists,
  listDownloadedPlaylistsAsPlaylist,
  partialGate,
} from '../downloads';

const db = () => getDb()!;

// Children before parents — `cached_item_songs.song_id` has an FK to `cached_songs`.
const TABLES = [
  'cached_item_songs',
  'cached_albums',
  'cached_playlists',
  'cached_items',
  'cached_songs',
  'albums',
];

beforeAll(() => ensureNormalizedSchema(db()));
beforeEach(() => {
  for (const t of TABLES) db().runSync(`DELETE FROM ${t}`);
});

const seedCachedSong = (id: string): void => {
  db().runSync(
    'INSERT INTO cached_songs (song_id, album_id, suffix, bytes, format_captured_at, ' +
      'downloaded_at, title, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, 'a1', 'mp3', 1, 0, 0, 'T', 100],
  );
};

/** An item row plus its edges. `present.length < expected` is a PARTIAL download. */
const seedItem = (
  itemId: string,
  type: 'album' | 'playlist',
  expected: number,
  present: string[] = [],
): void => {
  db().runSync(
    'INSERT INTO cached_items (item_id, type, name, expected_song_count, last_sync_at, ' +
      'downloaded_at) VALUES (?, ?, ?, ?, ?, ?)',
    [itemId, type, `Item ${itemId}`, expected, 0, 0],
  );
  present.forEach((songId, i) => {
    seedCachedSong(songId);
    db().runSync('INSERT INTO cached_item_songs (item_id, position, song_id) VALUES (?, ?, ?)', [
      itemId,
      i,
      songId,
    ]);
  });
};

/** The component row that makes an item RENDERABLE. Absent = metadata not populated. */
type ColValue = string | number | null;

const seedAlbumMeta = (itemId: string, extra: Record<string, ColValue> = {}): void => {
  const cols: Record<string, ColValue> = {
    name: `Album ${itemId}`,
    artist_id: null,
    year: null,
    genre: null,
    ...extra,
  };
  const keys = Object.keys(cols);
  db().runSync(
    `INSERT INTO cached_albums (item_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`,
    [itemId, ...keys.map((k) => cols[k])],
  );
};

const seedPlaylistMeta = (itemId: string): void => {
  db().runSync('INSERT INTO cached_playlists (item_id, name, song_count) VALUES (?, ?, ?)', [
    itemId,
    `Playlist ${itemId}`,
    2,
  ]);
};

describe('listDownloadedAlbums — the VISIBILITY predicate', () => {
  it('returns a complete download with its metadata rebuilt from cached_albums', async () => {
    seedItem('al1', 'album', 2, ['s1', 's2']);
    seedAlbumMeta('al1', { year: 1999, genre: 'Rock', artist_id: 'ar1' });

    const rows = await listDownloadedAlbums(db());
    expect(rows.map((r) => r.id)).toEqual(['al1']);
    // The columns the earlier truncated-DDL read wrongly concluded were missing.
    expect(rows[0].year).toBe(1999);
    expect(rows[0].genre).toBe('Rock');
    expect(rows[0].artist_id).toBe('ar1');
  });

  it('adapts to an AlbumID3 the list components can render', async () => {
    seedItem('al1', 'album', 1, ['s1']);
    seedAlbumMeta('al1', { year: 1999 });
    const album = albumListRowToAlbumID3((await listDownloadedAlbums(db()))[0]);
    expect(album).toMatchObject({ id: 'al1', name: 'Album al1', year: 1999 });
  });

  it('HIDES an item with no component row — a derived partial carries no metadata', async () => {
    // The store helper it replaces skipped these via `if (item.albumMeta)`. Falling back to
    // `cached_items.name` would surface rows that are hidden today.
    seedItem('al1', 'album', 1, ['s1']); // no seedAlbumMeta
    expect(await listDownloadedAlbums(db())).toEqual([]);
  });

  it('hides a PARTIAL download unless includePartial', async () => {
    seedItem('full', 'album', 2, ['s1', 's2']);
    seedAlbumMeta('full');
    seedItem('part', 'album', 3, ['s3']); // 1 of 3 on disk
    seedAlbumMeta('part');

    expect((await listDownloadedAlbums(db())).map((r) => r.id)).toEqual(['full']);
    expect(
      (await listDownloadedAlbums(db(), { includePartial: true })).map((r) => r.id).sort(),
    ).toEqual(['full', 'part']);
  });

  it('treats an over-complete item (more edges than expected) as complete', async () => {
    seedItem('al1', 'album', 1, ['s1', 's2']);
    seedAlbumMeta('al1');
    expect((await listDownloadedAlbums(db())).map((r) => r.id)).toEqual(['al1']);
  });

  it('never returns a playlist', async () => {
    seedItem('pl1', 'playlist', 0);
    seedPlaylistMeta('pl1');
    expect(await listDownloadedAlbums(db())).toEqual([]);
  });

  it('keeps an album whose artist_id is NULL', async () => {
    seedItem('al1', 'album', 1, ['s1']);
    seedAlbumMeta('al1', { artist_id: null });
    const rows = await listDownloadedAlbums(db());
    expect(rows.map((r) => r.id)).toEqual(['al1']);
    expect(rows[0].artist_id).toBeNull();
  });

  it('projects the sort keys as NULL — the bounded list sorts in JS, not SQL', async () => {
    seedItem('al1', 'album', 1, ['s1']);
    seedAlbumMeta('al1');
    const row = (await listDownloadedAlbums(db()))[0];
    expect(row.sort_title).toBeNull();
    expect(row.sort_artist).toBeNull();
  });
});

describe('listDownloadedAlbumIds — the MEMBERSHIP predicate', () => {
  it('includes an item with NO component row, unlike the visibility read', async () => {
    // This is the deliberate asymmetry: search/home already hold the metadata, so an item
    // row alone makes the album downloaded. Conflating the two predicates would hide
    // downloaded albums from search.
    seedItem('al1', 'album', 1, ['s1']); // no cached_albums row
    expect(await listDownloadedAlbums(db())).toEqual([]);
    expect([...(await listDownloadedAlbumIds(db()))]).toEqual(['al1']);
  });

  it('honours the partial gate the same way', async () => {
    seedItem('part', 'album', 3, ['s1']);
    expect([...(await listDownloadedAlbumIds(db()))]).toEqual([]);
    expect([...(await listDownloadedAlbumIds(db(), { includePartial: true }))]).toEqual(['part']);
  });

  it('excludes playlists', async () => {
    seedItem('pl1', 'playlist', 0);
    expect([...(await listDownloadedAlbumIds(db()))]).toEqual([]);
  });

  it('is empty when nothing is downloaded', async () => {
    expect(await listDownloadedAlbumIds(db())).toEqual(new Set());
  });
});

describe('listDownloadedPlaylists', () => {
  it('returns downloaded playlists with their metadata', async () => {
    seedItem('pl1', 'playlist', 0);
    seedPlaylistMeta('pl1');
    const rows = await listDownloadedPlaylists(db());
    expect(rows.map((r) => r.id)).toEqual(['pl1']);
    expect(rows[0].song_count).toBe(2);
  });

  it('adapts to a Playlist the list components can render', async () => {
    seedItem('pl1', 'playlist', 0);
    seedPlaylistMeta('pl1');
    expect((await listDownloadedPlaylistsAsPlaylist(db()))[0]).toMatchObject({
      id: 'pl1',
      name: 'Playlist pl1',
      songCount: 2,
    });
  });

  it('hides a playlist with no component row', async () => {
    seedItem('pl1', 'playlist', 0);
    expect(await listDownloadedPlaylists(db())).toEqual([]);
  });

  it('never returns an album, and applies NO partial gate', async () => {
    // Playlists download atomically — there is no partial state to include or exclude, so
    // an expected_song_count that exceeds the edges must NOT hide one.
    seedItem('al1', 'album', 1, ['s1']);
    seedAlbumMeta('al1');
    seedItem('pl1', 'playlist', 99);
    seedPlaylistMeta('pl1');
    expect((await listDownloadedPlaylists(db())).map((r) => r.id)).toEqual(['pl1']);
  });
});

describe('the shared predicates', () => {
  it('partialGate is empty when partials are included', () => {
    expect(partialGate(true)).toBe('');
    expect(partialGate(false)).toContain('expected_song_count');
  });

  it('downloadedClause probes the download tables, never the library', () => {
    expect(downloadedClause('songs', false)).toContain('cached_songs');
    expect(downloadedClause('albums', false)).toContain('cached_items');
    // The reap/offline-exposure rule: no join to `albums`/`songs` in either form.
    expect(downloadedClause('albums', true)).not.toMatch(/\bFROM albums\b/);
    expect(downloadedClause('songs', true)).not.toMatch(/\bFROM songs\b/);
  });

  it('is the SAME clause the favourites filter uses — one definition, no drift', async () => {
    // `favorites.ts` imports `downloadedClause` from this module; if it ever forks its own
    // copy, the two filters can disagree and this stops matching.
    await upsertAlbums(db(), [
      { id: 'al1', name: 'A', duration: 0, songCount: 0 },
      { id: 'al2', name: 'B', duration: 0, songCount: 0 },
    ] as never);
    await markStarredAlbums(db(), [
      { id: 'al1', starredAt: 1 },
      { id: 'al2', starredAt: 2 },
    ]);
    seedItem('al1', 'album', 1, ['s1']);
    seedAlbumMeta('al1');

    const starredDownloaded = await listAllStarredAlbums(db(), { downloadedOnly: true });
    expect(starredDownloaded.map((a) => a.id)).toEqual([...(await listDownloadedAlbumIds(db()))]);
  });
});
