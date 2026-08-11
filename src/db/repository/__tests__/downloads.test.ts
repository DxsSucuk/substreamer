import { getDb } from '../../../store/persistence/db';
import {
  upsertCachedItem,
  upsertCachedSong,
  type CachedSongRow,
} from '../../../store/persistence/musicCacheTables';
import { getSortKey, letterOfSortKey } from '../../../utils/sortHelpers';
import { ensureNormalizedSchema } from '../../createNormalizedTables';
import { albumListRowToAlbumID3, listAlbums, upsertAlbums } from '../albums';
import { listAllStarredAlbums, markStarredAlbums } from '../favorites';
import {
  downloadedClause,
  isItemDownloaded,
  listDownloadedAlbumIds,
  listDownloadedAlbums,
  listDownloadedPlaylistIds,
  listDownloadedPlaylists,
  listDownloadedSongs,
  downloadedAlbumSortKey,
  downloadedPlaylistSortKey,
  downloadedSongRowToChild,
  downloadedSongSortKey,
  partialGate,
} from '../downloads';
import { playlistListRowToPlaylist } from '../playlists';

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
  type: 'album' | 'playlist' | 'favorites',
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

const seedPlaylistMeta = (itemId: string, sortTitle?: string): void => {
  db().runSync(
    'INSERT INTO cached_playlists (item_id, name, song_count, sort_title) VALUES (?, ?, ?, ?)',
    [itemId, `Playlist ${itemId}`, 2, sortTitle ?? `playlist ${itemId}`],
  );
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

  it('projects the stored sort keys — the list orders in SQL, not JS', async () => {
    seedItem('al1', 'album', 1, ['s1']);
    seedAlbumMeta('al1', { sort_title: 'album al1', sort_artist: 'someone' });
    const row = (await listDownloadedAlbums(db()))[0];
    expect(row.sort_title).toBe('album al1');
    expect(row.sort_artist).toBe('someone');
  });
});

/** The downloaded list is BOUNDED, so it is a whole-set read — but it still comes back
 *  in the same order the keyset browse would put those albums in, on the same keys. */
describe('listDownloadedAlbums — the ORDER BY', () => {
  const seedSortable = (id: string, title: string, artistKey: string): void => {
    seedItem(id, 'album', 1, [`song-${id}`]);
    seedAlbumMeta(id, { sort_title: title, sort_artist: artistKey });
  };

  it('orders by title when asked', async () => {
    seedSortable('c', 'charlie', 'zulu');
    seedSortable('a', 'alpha', 'yankee');
    const rows = await listDownloadedAlbums(db(), { sortOrder: 'title' });
    expect(rows.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('defaults to title order when no sort order is given', async () => {
    seedSortable('c', 'charlie', 'zulu');
    seedSortable('a', 'alpha', 'yankee');
    expect((await listDownloadedAlbums(db())).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('orders by (artist, title) when asked — the compound browse key', async () => {
    seedSortable('z2', 'zulu', 'one band');
    seedSortable('z1', 'alpha', 'one band');
    seedSortable('other', 'alpha', 'zzz band');
    const rows = await listDownloadedAlbums(db(), { sortOrder: 'artist' });
    expect(rows.map((r) => r.id)).toEqual(['z1', 'z2', 'other']);
  });

  it('breaks a full tie on item_id, so the order is total and stable', async () => {
    seedSortable('b', 'same', 'same');
    seedSortable('a', 'same', 'same');
    expect((await listDownloadedAlbums(db(), { sortOrder: 'artist' })).map((r) => r.id)).toEqual([
      'a',
      'b',
    ]);
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
    expect(playlistListRowToPlaylist((await listDownloadedPlaylists(db()))[0])).toMatchObject({
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

  it('orders by the stored sort_title, the same key the playlist browse pages on', async () => {
    seedItem('p-c', 'playlist', 0);
    seedPlaylistMeta('p-c', 'charlie');
    seedItem('p-a', 'playlist', 0);
    seedPlaylistMeta('p-a', 'alpha');
    const rows = await listDownloadedPlaylists(db());
    expect(rows.map((r) => r.id)).toEqual(['p-a', 'p-c']);
    expect(rows.map((r) => r.sort_title)).toEqual(['alpha', 'charlie']);
    // The key the screen hands the scroller IS the column the ORDER BY led with.
    expect(rows.map(downloadedPlaylistSortKey)).toEqual(['alpha', 'charlie']);
    expect(rows.map((r) => letterOfSortKey(downloadedPlaylistSortKey(r)))).toEqual(['A', 'C']);
  });
});

describe('listDownloadedPlaylistIds — the MEMBERSHIP predicate', () => {
  it('includes a playlist with NO component row, unlike the visibility read', async () => {
    // The same asymmetry `listDownloadedAlbumIds` has, and the reason this module keeps
    // the two predicates apart: the CarPlay playlist node already holds the metadata from
    // the `playlists` table, so an item row alone means "downloaded". Requiring a
    // `cached_playlists` row here would drop a downloaded playlist off the offline tree.
    seedItem('pl1', 'playlist', 0); // no cached_playlists row
    expect(await listDownloadedPlaylists(db())).toEqual([]);
    expect([...(await listDownloadedPlaylistIds(db()))]).toEqual(['pl1']);
  });

  it('excludes albums', async () => {
    seedItem('al1', 'album', 1, ['s1']);
    seedAlbumMeta('al1');
    expect([...(await listDownloadedPlaylistIds(db()))]).toEqual([]);
  });

  it('applies NO partial gate — playlists download atomically', async () => {
    // `expected_song_count` far above the edges on disk. For an album this is a partial and
    // is hidden; for a playlist there is no partial state, so it must still be a member.
    seedItem('pl1', 'playlist', 99);
    expect([...(await listDownloadedPlaylistIds(db()))]).toEqual(['pl1']);
  });

  it('is empty when nothing is downloaded', async () => {
    expect(await listDownloadedPlaylistIds(db())).toEqual(new Set());
  });
});

describe('isItemDownloaded', () => {
  it('is true for a `favorites` item row, which has no component table at all', async () => {
    // MEMBERSHIP again, and the reason this probe is type-agnostic: the `__starred__`
    // aggregate is a `favorites` intent — neither `cached_albums` nor `cached_playlists`
    // will ever hold a row for it, so any visibility-style join makes it permanently false.
    seedItem('__starred__', 'favorites', 0);
    expect(await isItemDownloaded(db(), '__starred__')).toBe(true);
  });

  it('is false for an id that was never downloaded', async () => {
    seedItem('pl1', 'playlist', 0);
    expect(await isItemDownloaded(db(), '__starred__')).toBe(false);
  });

  it('ignores the partial gate — an under-filled item is still downloaded', async () => {
    seedItem('al1', 'album', 3, ['s1']); // 1 of 3 on disk
    expect(await isItemDownloaded(db(), 'al1')).toBe(true);
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

/**
 * The point of step 3b: ONE ordering. These go through the real download writer and
 * compare the filtered list against the unfiltered keyset browse over the same albums —
 * if the two ever disagree, toggling the Downloaded chip reorders the screen.
 */
describe('the downloaded list and the browse list are the SAME order', () => {
  const NAMES: readonly [string, string][] = [
    ['"Heroes"', 'David Bowie'],
    ['(How to Live) As Ghosts', 'Thrice'],
    ["'74 Jailbreak", 'AC/DC'],
    ['The Wall', 'Pink Floyd'],
    ['Abbey Road', 'The Beatles'],
    ['Élise', 'Beethoven'],
  ];

  const seedBoth = async (): Promise<void> => {
    for (const [i, [name, artist]] of NAMES.entries()) {
      const id = `a${i}`;
      // eslint-disable-next-line no-await-in-loop
      await upsertAlbums(db(), [{ id, name, artist, duration: 0, songCount: 0 }] as never);
      // eslint-disable-next-line no-await-in-loop
      await upsertCachedItem({
        itemId: id,
        type: 'album',
        name,
        expectedSongCount: 0,
        lastSyncAt: 0,
        downloadedAt: 0,
        albumMeta: { name, artist },
      });
    }
  };

  it.each(['title', 'artist'] as const)('agrees under the %s order', async (sortOrder) => {
    await seedBoth();
    const browse = await listAlbums(db(), { limit: 100, sortOrder });
    const downloaded = await listDownloadedAlbums(db(), { sortOrder });
    expect(downloaded.map((r) => r.id)).toEqual(browse.rows.map((r) => r.id));
    // Same keys, not merely the same sequence — a coincidence would still be a defect.
    expect(downloaded.map((r) => [r.sort_title, r.sort_artist])).toEqual(
      browse.rows.map((r) => [r.sort_title, r.sort_artist]),
    );
  });

  it('files each row where the alphabet scroller says it is', async () => {
    await seedBoth();
    const rows = await listDownloadedAlbums(db(), { sortOrder: 'title' });
    // `"Heroes"` under H, `(How to Live)` under H, `'74 Jailbreak` in `#`.
    expect(rows.map((r) => letterOfSortKey(downloadedAlbumSortKey(r, 'title')))).toEqual([
      '#', // '74 Jailbreak
      'A', // Abbey Road
      'E', // Élise
      'H', // "Heroes"
      'H', // (How to Live) As Ghosts
      'W', // The Wall
    ]);
    // Each row's letter is `charAt(0)` of the very key it was ordered by — that is what
    // makes an A–Z tap land on the row it points at. The key accessor is what the screen
    // hands the scroller, so this asserts the exact chain the list uses.
    for (const r of rows) {
      expect(downloadedAlbumSortKey(r, 'title')).toBe(r.sort_title ?? '');
      expect(letterOfSortKey(downloadedAlbumSortKey(r, 'title'))).toBe(
        letterOfSortKey(getSortKey(r.name ?? '')),
      );
    }
  });
});

/** A downloaded song with an explicit directory vs server-album split. `srcAlbumId: null`
 *  is a row written before `src_album_id` existed. */
const seedSongWithAlbums = (
  id: string,
  dirAlbumId: string,
  srcAlbumId: string | null,
): void => {
  db().runSync(
    'INSERT INTO cached_songs (song_id, album_id, src_album_id, suffix, bytes, ' +
      'format_captured_at, downloaded_at, title, artist, duration, cover_art) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, dirAlbumId, srcAlbumId, 'mp3', 1, 0, 0, `Song ${id}`, 'The Artist', 100, `co-${id}`],
  );
};

describe('listDownloadedSongs', () => {
  it('projects exactly the fields the song rows render', async () => {
    seedSongWithAlbums('s1', 'dir-1', 'srv-1');
    const rows = await listDownloadedSongs(db());
    expect(rows).toHaveLength(1);
    // Exact shape: widening this is a deliberate follow-up, not a drive-by.
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'album_id', 'artist', 'cover_art', 'duration', 'id', 'sort_artist', 'sort_name',
        'sort_title', 'title', 'user_rating',
      ].sort(),
    );
  });

  it('carries the star rating the rows display', async () => {
    seedSongWithAlbums('s1', 'dir-1', 'srv-1');
    db().runSync('UPDATE cached_songs SET user_rating = 4 WHERE song_id = ?;', ['s1']);
    const [row] = await listDownloadedSongs(db());
    expect(row.user_rating).toBe(4);
    expect(downloadedSongRowToChild(row).userRating).toBe(4);
  });

  it('leaves an unrated song without a rating rather than a zero', async () => {
    seedSongWithAlbums('s1', 'dir-1', 'srv-1');
    const [row] = await listDownloadedSongs(db());
    expect(row.user_rating).toBeNull();
    expect(downloadedSongRowToChild(row).userRating).toBeUndefined();
  });

  it('adapts to the Child the song rows render', async () => {
    seedSongWithAlbums('s1', 'dir-1', 'srv-1');
    expect(downloadedSongRowToChild((await listDownloadedSongs(db()))[0])).toEqual({
      id: 's1',
      title: 'Song s1',
      artist: 'The Artist',
      albumId: 'srv-1',
      duration: 100,
      coverArt: 'co-s1',
      isDir: false,
    });
  });

  // `cached_songs.album_id` is the file's DIRECTORY; the server's album is `src_album_id`
  // (schema.ts and CachedSongRow both say so). The map walk this read replaced projected the
  // directory into `Child.albumId`, which is what "go to album" and album-mode cover art read.
  it('uses the SERVER album, not the file directory', async () => {
    seedSongWithAlbums('s1', 'dir-1', 'srv-1');
    expect((await listDownloadedSongs(db()))[0].album_id).toBe('srv-1');
  });

  it('falls back to the directory when the server album is unknown', async () => {
    // Rows predating `src_album_id`: the directory is the only answer there is.
    seedSongWithAlbums('s1', 'dir-1', null);
    expect((await listDownloadedSongs(db()))[0].album_id).toBe('dir-1');
  });

  it('is empty when nothing is downloaded', async () => {
    expect(await listDownloadedSongs(db())).toEqual([]);
  });
});

/**
 * The Downloaded filter orders in SQL on the keys the download WRITER stored, so these
 * go through `upsertCachedSong` rather than seeding the columns by hand — the derivation
 * and the `ORDER BY` are both under test.
 */
describe('listDownloadedSongs — the sort order', () => {
  const seedSong = (id: string, title: string, extra: Partial<CachedSongRow> = {}): Promise<void> =>
    upsertCachedSong({
      id,
      title,
      albumId: 'dir',
      bytes: 1,
      duration: 1,
      suffix: 'mp3',
      formatCapturedAt: 0,
      downloadedAt: 0,
      ...extra,
    });

  it('defaults to title order', async () => {
    await seedSong('s-z', 'Zulu', { artist: 'Alpaca' });
    await seedSong('s-a', 'Alpha', { artist: 'Zebra' });
    expect((await listDownloadedSongs(db())).map((r) => r.id)).toEqual(['s-a', 's-z']);
  });

  it('groups by artist then title when asked', async () => {
    await seedSong('s-z', 'Zulu', { artist: 'Alpaca' });
    await seedSong('s-a', 'Alpha', { artist: 'Zebra' });
    expect((await listDownloadedSongs(db(), { sortOrder: 'artist' })).map((r) => r.id)).toEqual([
      's-z',
      's-a',
    ]);
  });

  it('breaks an artist tie on the title key, exactly as the browse keyset does', async () => {
    // Ids run OPPOSITE to the titles, so an order that fell through to `song_id` instead
    // of `sort_title` gives the other answer.
    await seedSong('aaa', 'Zulu', { artist: 'One Band' });
    await seedSong('zzz', 'Alpha', { artist: 'One Band' });
    expect((await listDownloadedSongs(db(), { sortOrder: 'artist' })).map((r) => r.id)).toEqual([
      'zzz',
      'aaa',
    ]);
  });

  it('uses the SONG artist derivation — `artist ?? title`, not the album chain', async () => {
    await seedSong('s-1', 'One', { artist: 'Zebra', displayArtist: 'Alpaca' });
    await seedSong('s-2', 'Two', { artist: 'Alpaca', displayArtist: 'Zebra' });
    expect((await listDownloadedSongs(db(), { sortOrder: 'artist' })).map((r) => r.id)).toEqual([
      's-2',
      's-1',
    ]);
  });

  it('falls back to the title when the song has no artist at all', async () => {
    await seedSong('s-z', 'Zulu');
    await seedSong('s-a', 'Alpha');
    expect((await listDownloadedSongs(db(), { sortOrder: 'artist' })).map((r) => r.id)).toEqual([
      's-a',
      's-z',
    ]);
  });

  it('files a punctuation-leading title where the scroller says it is', async () => {
    await seedSong('s-h', '"Heroes"');
    await seedSong('s-g', 'Ghosts');
    await seedSong('s-i', 'Ivy');
    const rows = await listDownloadedSongs(db());
    expect(rows.map((r) => r.id)).toEqual(['s-g', 's-h', 's-i']);
    expect(rows.map((r) => letterOfSortKey(downloadedSongSortKey(r)))).toEqual(['G', 'H', 'I']);
  });

  it('carries the key it ORDERED BY, so the scroller letter cannot disagree', async () => {
    // `getSortKey` prefers a server-stripped `sortName`; a projection that drops it
    // leaves the scroller recomputing from the raw title — filing the row under A
    // while the list sorts it at H. The key is projected, so the letter is read off
    // the same column the ORDER BY used.
    await seedSong('s-h', 'A Horse With No Name', { sortName: 'Horse With No Name' });
    await seedSong('s-g', 'Ghosts');
    await seedSong('s-i', 'Ivy');
    const rows = await listDownloadedSongs(db());
    expect(rows.map((r) => r.id)).toEqual(['s-g', 's-h', 's-i']);
    expect(rows.map((r) => letterOfSortKey(downloadedSongSortKey(r)))).toEqual(['G', 'H', 'I']);
  });

  it('hands the ARTIST key under artist order, the title key otherwise', async () => {
    await seedSong('s1', 'Zulu', { artist: 'Alpaca' });
    const [r] = await listDownloadedSongs(db());
    expect(downloadedSongSortKey(r, 'artist')).toBe('alpaca');
    expect(downloadedSongSortKey(r, 'title')).toBe('zulu');
    expect(downloadedSongSortKey(r)).toBe('zulu');
  });

  it('breaks a title tie on the id, so the order is total', async () => {
    // Inserted in the OPPOSITE order to their ids: with no `song_id` tiebreak the scan
    // returns rowid order, and the list would shuffle whenever a row is rewritten.
    await seedSong('z-dup', 'Same Title');
    await seedSong('a-dup', 'Same Title');
    expect((await listDownloadedSongs(db())).map((r) => r.id)).toEqual(['a-dup', 'z-dup']);
  });

  it('refreshes the keys when an existing row is re-written', async () => {
    // A re-tag on the server followed by a metadata refresh or a re-download upserts the
    // row with a new title/artist; the keys are written unconditionally alongside them,
    // so the row moves. Left on the previous values it would sort where it used to.
    await seedSong('s1', 'Zulu', { artist: 'Zebra' });
    await seedSong('s2', 'Mike', { artist: 'Mongoose' });
    await seedSong('s1', 'Alpha', { artist: 'Alpaca' });
    expect(
      db().getFirstSync<{ sort_title: string; sort_artist: string }>(
        'SELECT sort_title, sort_artist FROM cached_songs WHERE song_id = ?',
        ['s1'],
      ),
    ).toEqual({ sort_title: 'alpha', sort_artist: 'alpaca' });
    expect((await listDownloadedSongs(db())).map((r) => r.id)).toEqual(['s1', 's2']);
  });

  it('writes the keys from the same row that supplies title and artist', async () => {
    await seedSong('s1', 'The Wall', { artist: 'Pink Floyd' });
    expect(
      db().getFirstSync<{ sort_title: string; sort_artist: string }>(
        'SELECT sort_title, sort_artist FROM cached_songs WHERE song_id = ?',
        ['s1'],
      ),
    ).toEqual({ sort_title: 'wall', sort_artist: 'pink floyd' });
  });
});
