/**
 * `convertLegacyMetadataAsync` — the one-time promotion of the legacy `raw_json`
 * envelopes on `cached_songs` / `cached_items` into typed columns, component
 * rows and the five `cached_song_*` child tables. This is the data-migration
 * path every user upgrading from the shipped v8.0.91 runs on their first
 * post-upgrade hydrate, so each rule below is asserted directly.
 *
 * A sibling of `musicCacheTables.test.ts` rather than part of it: that suite
 * drives a hand-rolled fake DB that models `meta_v` alone, while everything
 * here is a property of REAL SQL — the work-set predicate, the `src_*` vs
 * file-fact split, the `json_group_array` genre projection and the FK cascades.
 * This suite therefore runs against the generated schema (`src/db/normalizedDdl.ts`,
 * created at import by `persistence/db.ts`) on the better-sqlite3-backed
 * op-SQLite seam, which enables `PRAGMA foreign_keys`.
 */
import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  convertLegacyMetadataAsync,
  deleteCachedItem,
  deleteCachedSong,
  hydrateCachedItemsAsync,
  hydrateCachedSongsAsync,
  readPragma,
} from '../musicCacheTables';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
/** The live better-sqlite3-backed handle. Tests that swap in a wrapper restore this. */
const realDb: InternalDb = handle;

/* ------------------------------------------------------------------ */
/*  Fixtures — a real download row + the envelope it was written with   */
/* ------------------------------------------------------------------ */

const CREATED_ISO = '2019-03-11T09:15:00.000Z';
const STARRED_ISO = '2024-01-02T03:04:05.000Z';
const PLAYED_ISO = '2025-05-05T12:00:00.000Z';
const CHANGED_ISO = '2025-06-01T10:30:00.000Z';

/**
 * The server's `Child`, exactly as `JSON.stringify(track)` stored it pre-cutover:
 * dates are ISO strings, and `genres` uses the `{name}` shape real OpenSubsonic
 * servers return. Its file-describing fields are DELIBERATELY different from the
 * downloaded file's — a 24/96 flac in a real album vs a transcoded mp3 in
 * `_unknown` — so a conversion writing a server value into `album_id`/`suffix`/
 * `bit_rate`/`bit_depth`/`sampling_rate` is caught.
 */
const sourceChild = (): Record<string, unknown> => ({
  id: 's1',
  parent: 'alb-real',
  isDir: false,
  isVideo: false,
  title: 'Blackbird',
  album: 'The Beatles',
  artist: 'The Beatles',
  albumId: 'alb-real',
  artistId: 'art-1',
  coverArt: 'cov-1',
  duration: 138,
  suffix: 'flac',
  bitRate: 1411,
  bitDepth: 24,
  samplingRate: 96_000,
  contentType: 'audio/flac',
  transcodedContentType: 'audio/mpeg',
  transcodedSuffix: 'mp3',
  channelCount: 2,
  size: 41_237_888,
  path: 'The Beatles/The Beatles/11 Blackbird.flac',
  track: 11,
  discNumber: 1,
  year: 1968,
  genre: 'Folk, World, & Country',
  genres: [{ name: 'Folk, World, & Country' }, { name: 'Rock' }],
  artists: [{ id: 'art-1', name: 'The Beatles' }],
  displayArtist: 'The Beatles',
  albumArtists: [{ id: 'art-1', name: 'The Beatles' }],
  displayAlbumArtist: 'The Beatles',
  contributors: [
    { role: 'composer', artist: { id: 'art-2', name: 'Paul McCartney' } },
    { role: 'performer', subRole: 'guitar', artist: { id: 'art-3', name: 'George Harrison' } },
  ],
  displayComposer: 'Paul McCartney',
  moods: ['mellow', 'acoustic'],
  replayGain: {
    trackGain: -7.5,
    albumGain: -8.1,
    trackPeak: 0.98,
    albumPeak: 0.99,
    baseGain: 0,
    fallbackGain: -6,
  },
  userRating: 4,
  averageRating: 4.5,
  playCount: 12,
  created: CREATED_ISO,
  starred: STARRED_ISO,
  played: PLAYED_ISO,
  type: 'music',
  bpm: 96,
  comment: 'Alternate take',
  sortName: 'Blackbird',
  musicBrainzId: 'mbid-track-1',
  explicitStatus: 'clean',
  bookmarkPosition: 42,
});

/** The reduced `AlbumID3` an `album` item's envelope carries. */
const albumEnvelope = (): Record<string, unknown> => ({
  id: 'alb-1',
  name: 'The Beatles',
  artist: 'The Beatles',
  artistId: 'art-1',
  displayArtist: 'The Beatles',
  coverArt: 'cov-1',
  songCount: 30,
  duration: 5_000,
  playCount: 3,
  created: CREATED_ISO,
  starred: STARRED_ISO,
  year: 1968,
  genre: 'Rock',
  played: PLAYED_ISO,
  userRating: 5,
  version: 'Remastered',
  musicBrainzId: 'mbid-album-1',
  sortName: 'Beatles, The',
  isCompilation: false,
  explicitStatus: 'clean',
  originalReleaseDate: { year: 1968, month: 11, day: 22 },
  releaseDate: { year: 1987, month: 8, day: 24 },
});

/** The `Playlist` a `playlist` item's envelope carries. */
const playlistEnvelope = (): Record<string, unknown> => ({
  id: 'pl-1',
  name: 'Road Trip',
  comment: 'the long way round',
  coverArt: 'pl-cov-1',
  created: CREATED_ISO,
  changed: CHANGED_ISO,
  duration: 3_600,
  owner: 'ghenry',
  public: true,
  songCount: 12,
});

/* ------------------------------------------------------------------ */
/*  Seeding + reading raw rows                                         */
/* ------------------------------------------------------------------ */

interface LegacySongSeed {
  songId: string;
  title: string;
  artist: string | null;
  album: string | null;
  /** The FILE's directory. */
  albumId: string;
  coverArt: string | null;
  bytes: number;
  duration: number;
  /** The FILE's extension, post-transcode. */
  suffix: string;
  bitRate: number | null;
  bitDepth: number | null;
  samplingRate: number | null;
  formatCapturedAt: number;
  downloadedAt: number;
  rawJson: string | null;
}

/** Insert a row in the shipped v8.0.91 shape: the 15 legacy columns + the
 *  envelope, every promoted column and `meta_v` left NULL. */
function insertLegacySong(overrides: Partial<LegacySongSeed> = {}): LegacySongSeed {
  const seed: LegacySongSeed = {
    songId: 's1',
    title: 'Blackbird',
    artist: 'The Beatles',
    album: 'The Beatles',
    albumId: '_unknown',
    coverArt: 'cov-1',
    bytes: 2_211_840,
    duration: 138,
    suffix: 'mp3',
    bitRate: 128,
    bitDepth: null,
    samplingRate: 44_100,
    formatCapturedAt: 1_700_000_000_000,
    downloadedAt: 1_700_000_000_000,
    rawJson: JSON.stringify(sourceChild()),
    ...overrides,
  };
  realDb.runSync(
    `INSERT INTO cached_songs
       (song_id, title, artist, album, album_id, cover_art, bytes, duration,
        suffix, bit_rate, bit_depth, sampling_rate, format_captured_at,
        downloaded_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      seed.songId,
      seed.title,
      seed.artist,
      seed.album,
      seed.albumId,
      seed.coverArt,
      seed.bytes,
      seed.duration,
      seed.suffix,
      seed.bitRate,
      seed.bitDepth,
      seed.samplingRate,
      seed.formatCapturedAt,
      seed.downloadedAt,
      seed.rawJson,
    ],
  );
  return seed;
}

interface LegacyItemSeed {
  itemId: string;
  type: 'album' | 'playlist' | 'favorites' | 'song';
  name: string;
  artist: string | null;
  coverArtId: string | null;
  expectedSongCount: number;
  parentAlbumId: string | null;
  lastSyncAt: number;
  downloadedAt: number;
  rawJson: string | null;
  derived: number;
}

function insertLegacyItem(overrides: Partial<LegacyItemSeed> = {}): LegacyItemSeed {
  const seed: LegacyItemSeed = {
    itemId: 'alb-1',
    type: 'album',
    name: 'The Beatles',
    artist: 'The Beatles',
    coverArtId: 'cov-1',
    expectedSongCount: 30,
    parentAlbumId: null,
    lastSyncAt: 1_700_000_000_000,
    downloadedAt: 1_700_000_000_000,
    rawJson: JSON.stringify(albumEnvelope()),
    derived: 0,
    ...overrides,
  };
  realDb.runSync(
    `INSERT INTO cached_items
       (item_id, type, name, artist, cover_art_id, expected_song_count,
        parent_album_id, last_sync_at, downloaded_at, raw_json, derived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      seed.itemId,
      seed.type,
      seed.name,
      seed.artist,
      seed.coverArtId,
      seed.expectedSongCount,
      seed.parentAlbumId,
      seed.lastSyncAt,
      seed.downloadedAt,
      seed.rawJson,
      seed.derived,
    ],
  );
  return seed;
}

type Row = Record<string, unknown>;

const songRow = (songId: string): Row | undefined =>
  realDb.getFirstSync<Row>('SELECT * FROM cached_songs WHERE song_id = ?;', [songId]);

const itemRow = (itemId: string): Row | undefined =>
  realDb.getFirstSync<Row>('SELECT * FROM cached_items WHERE item_id = ?;', [itemId]);

const albumRow = (itemId: string): Row | undefined =>
  realDb.getFirstSync<Row>('SELECT * FROM cached_albums WHERE item_id = ?;', [itemId]);

const playlistRow = (itemId: string): Row | undefined =>
  realDb.getFirstSync<Row>('SELECT * FROM cached_playlists WHERE item_id = ?;', [itemId]);

const childRows = (table: string, songId = 's1'): Row[] =>
  realDb.getAllSync<Row>(`SELECT * FROM ${table} WHERE song_id = ? ORDER BY pos;`, [songId]);

const countRows = (table: string): number =>
  realDb.getFirstSync<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table};`)?.c ?? -1;

/** Rows still in the conversion's work set — must be 0 once it returns. */
const workSetCount = (table: string): number =>
  realDb.getFirstSync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM ${table} WHERE meta_v IS NULL AND raw_json IS NOT NULL;`,
  )?.c ?? -1;

const SONG_CHILD_TABLES = [
  'cached_song_genres',
  'cached_song_artists',
  'cached_song_album_artists',
  'cached_song_contributors',
  'cached_song_moods',
] as const;

/** Any chunked read of a download table — the conversion's work-set query,
 *  matched on shape rather than on its predicate so a loop that changed the
 *  predicate is still counted. The hydrate SELECTs carry no LIMIT. */
const WORK_SET_QUERY = /FROM cached_(?:songs|items)[\s\S]*LIMIT/i;

/**
 * Run the conversion behind a pass-through handle that counts its chunked
 * work-set queries and its writes.
 *
 * The wrapper REJECTS past `limit` chunks, which the conversion swallows by
 * design — so a row that never leaves the work set fails as an assertion on the
 * counts (in milliseconds) instead of spinning the boot-path loop until the jest
 * timeout. Every test goes through here for that reason.
 */
async function runConversion(limit = 8): Promise<{ queries: number; writes: number }> {
  let queries = 0;
  let writes = 0;
  const guard: InternalDb = {
    ...realDb,
    getAllAsync<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      if (WORK_SET_QUERY.test(sql)) {
        queries += 1;
        if (queries > limit) {
          return Promise.reject(new Error('work-set query looped past the guard'));
        }
      }
      return realDb.getAllAsync<T>(sql, params);
    },
    runAsync(sql: string, params?: readonly unknown[]) {
      writes += 1;
      return realDb.runAsync(sql, params);
    },
  };
  __setDbForTests(guard);
  try {
    await convertLegacyMetadataAsync();
  } finally {
    __setDbForTests(realDb);
  }
  return { queries, writes };
}

beforeEach(() => {
  // Edges first (their song FK is ON DELETE no action), then the parents —
  // whose cascades take the component + child rows with them.
  realDb.runSync('DELETE FROM cached_item_songs;');
  realDb.runSync('DELETE FROM cached_items;');
  realDb.runSync('DELETE FROM cached_songs;');
});

/* ------------------------------------------------------------------ */
/*  cached_songs                                                       */
/* ------------------------------------------------------------------ */

describe('convertLegacyMetadataAsync — cached_songs', () => {
  it('promotes the envelope into columns + child rows and stamps meta_v in one pass', async () => {
    insertLegacySong();

    await runConversion();

    const row = songRow('s1')!;
    expect(row.meta_v).toBe(1);
    // Promoted `Child` scalars.
    expect(row.src_album_id).toBe('alb-real');
    expect(row.artist_id).toBe('art-1');
    expect(row.display_artist).toBe('The Beatles');
    expect(row.display_album_artist).toBe('The Beatles');
    expect(row.display_composer).toBe('Paul McCartney');
    expect(row.track).toBe(11);
    expect(row.disc_number).toBe(1);
    expect(row.year).toBe(1968);
    expect(row.genre).toBe('Folk, World, & Country');
    expect(row.size).toBe(41_237_888);
    expect(row.content_type).toBe('audio/flac');
    expect(row.transcoded_content_type).toBe('audio/mpeg');
    expect(row.transcoded_suffix).toBe('mp3');
    expect(row.channel_count).toBe(2);
    expect(row.path).toBe('The Beatles/The Beatles/11 Blackbird.flac');
    expect(row.user_rating).toBe(4);
    expect(row.average_rating).toBe(4.5);
    expect(row.play_count).toBe(12);
    expect(row.played).toBe(PLAYED_ISO);
    expect(row.type).toBe('music');
    expect(row.bpm).toBe(96);
    expect(row.comment).toBe('Alternate take');
    expect(row.sort_name).toBe('Blackbird');
    // The A–Z keys land in the SAME statement as `sort_name`, which is one of their
    // inputs — a conversion that skipped them would leave the row filed where it was
    // before its sort name arrived.
    expect(row.sort_title).toBe('blackbird');
    expect(row.sort_artist).toBe('beatles');
    expect(row.music_brainz_id).toBe('mbid-track-1');
    expect(row.explicit_status).toBe('clean');
    expect(row.bookmark_position).toBe(42);
    expect(row.parent).toBe('alb-real');
    // Dates come out of the envelope as ISO strings and store as epoch ms.
    expect(row.created).toBe(Date.parse(CREATED_ISO));
    expect(row.starred).toBe(Date.parse(STARRED_ISO));
    // Booleans store as 0/1.
    expect(row.is_video).toBe(0);
    expect(row.is_dir).toBe(0);
    // ReplayGain is flattened onto the row.
    expect(row.rg_track_gain).toBe(-7.5);
    expect(row.rg_album_gain).toBe(-8.1);
    expect(row.rg_track_peak).toBe(0.98);
    expect(row.rg_album_peak).toBe(0.99);
    expect(row.rg_base_gain).toBe(0);
    expect(row.rg_fallback_gain).toBe(-6);

    // All five `Child` multi-valued mirrors, in array order.
    expect(childRows('cached_song_genres')).toEqual([
      { song_id: 's1', pos: 0, name: 'Folk, World, & Country' },
      { song_id: 's1', pos: 1, name: 'Rock' },
    ]);
    expect(childRows('cached_song_artists')).toEqual([
      { song_id: 's1', pos: 0, artist_id: 'art-1', artist_name: 'The Beatles' },
    ]);
    expect(childRows('cached_song_album_artists')).toEqual([
      { song_id: 's1', pos: 0, artist_id: 'art-1', artist_name: 'The Beatles' },
    ]);
    expect(childRows('cached_song_contributors')).toEqual([
      {
        song_id: 's1',
        pos: 0,
        role: 'composer',
        sub_role: null,
        artist_id: 'art-2',
        artist_name: 'Paul McCartney',
      },
      {
        song_id: 's1',
        pos: 1,
        role: 'performer',
        sub_role: 'guitar',
        artist_id: 'art-3',
        artist_name: 'George Harrison',
      },
    ]);
    expect(childRows('cached_song_moods')).toEqual([
      { song_id: 's1', pos: 0, mood: 'mellow' },
      { song_id: 's1', pos: 1, mood: 'acoustic' },
    ]);

    // The work set is empty, so a re-entry has nothing to do.
    expect(workSetCount('cached_songs')).toBe(0);
  });

  it('recomputes the A–Z keys from the sort name the SAME statement lands', async () => {
    // A pre-column row: the keys are NULL and `sort_name` is not on the row yet. The
    // conversion supplies both, and `getSortKey` prefers a server-stripped `sortName`,
    // so the key must come out of the envelope's sort name rather than the raw title.
    insertLegacySong({
      songId: 's-sorted',
      title: 'A Horse With No Name',
      artist: 'America',
      rawJson: JSON.stringify({
        ...sourceChild(),
        id: 's-sorted',
        title: 'A Horse With No Name',
        artist: 'America',
        sortName: 'Horse With No Name',
      }),
    });

    await runConversion();

    const row = songRow('s-sorted')!;
    expect(row.sort_name).toBe('Horse With No Name');
    expect(row.sort_title).toBe('horse with no name');
    expect(row.sort_artist).toBe('america');
  });

  it('leaves raw_json INTACT — m18/m19 backfill WHERE raw_json IS NULL, and a v8.0.91 rollback still renders', async () => {
    const seed = insertLegacySong();

    await runConversion();

    // Byte-identical, not merely non-null: nulling it would make the migrations
    // overwrite a converted row from an older blob, and would empty the whole
    // Downloaded library on a rollback to the previous release.
    expect(songRow('s1')!.raw_json).toBe(seed.rawJson);
  });

  it('stamps a row whose envelope will not parse, so the chunked LIMIT loop terminates', async () => {
    insertLegacySong({ songId: 's-corrupt', rawJson: '{"id":"s-corrupt",' });

    const { queries } = await runConversion();

    const row = songRow('s-corrupt')!;
    expect(row.meta_v).toBe(1);
    // Stamped but NOT promoted — it falls through to the columns/skip branch on read.
    expect(row.src_album_id).toBeNull();
    expect(row.genre).toBeNull();
    expect(childRows('cached_song_genres', 's-corrupt')).toEqual([]);
    // The corrupt envelope is still there for a rollback / a later re-arm.
    expect(row.raw_json).toBe('{"id":"s-corrupt",');
    // The row left the work set, so the boot-path loop cannot spin on it: one
    // songs chunk + the empty songs query that breaks + one empty items query.
    expect(workSetCount('cached_songs')).toBe(0);
    expect(queries).toBe(3);
  });

  it('is idempotent — a second run issues no writes and does not re-promote', async () => {
    insertLegacySong();
    insertLegacyItem();
    await runConversion();

    // Tamper with the promoted state. A second pass that re-promoted would
    // restore these from the (still intact) envelope.
    realDb.runSync("UPDATE cached_songs SET genre = 'TAMPERED' WHERE song_id = 's1';");
    realDb.runSync("DELETE FROM cached_song_genres WHERE song_id = 's1';");
    realDb.runSync("UPDATE cached_albums SET name = 'TAMPERED' WHERE item_id = 'alb-1';");

    const { queries, writes } = await runConversion();

    // One empty songs query + one empty items query, and no write at all.
    expect(queries).toBe(2);
    expect(writes).toBe(0);
    expect(songRow('s1')!.genre).toBe('TAMPERED');
    expect(childRows('cached_song_genres')).toEqual([]);
    expect(albumRow('alb-1')!.name).toBe('TAMPERED');
  });

  it('resumes an interrupted pass without re-promoting an already-stamped row', async () => {
    // As if a previous run committed the stamp for this row and was then killed.
    insertLegacySong({ songId: 's-done' });
    realDb.runSync("UPDATE cached_songs SET meta_v = 1 WHERE song_id = 's-done';");
    insertLegacySong({ songId: 's-todo' });

    await runConversion();

    // Stamped ⇒ out of the work set ⇒ untouched, envelope or not.
    expect(songRow('s-done')!.src_album_id).toBeNull();
    expect(childRows('cached_song_genres', 's-done')).toEqual([]);
    // The unstamped row is picked up in the same pass.
    expect(songRow('s-todo')!.src_album_id).toBe('alb-real');
    expect(songRow('s-todo')!.meta_v).toBe(1);
    expect(childRows('cached_song_genres', 's-todo')).toHaveLength(2);
  });

  it('writes the SERVER values to src_* and leaves every file-fact column untouched', async () => {
    const seed = insertLegacySong();

    await runConversion();

    const row = songRow('s1')!;
    // THE FILE on disk: a transcoded 128kbps mp3 in the `_unknown` bucket.
    // `resolveSongFile` builds `{cache}/{album_id}/{song_id}.{suffix}` from
    // these, and the reconcile pass deletes the audio when they disagree.
    expect(row.album_id).toBe('_unknown');
    expect(row.suffix).toBe('mp3');
    expect(row.bit_rate).toBe(128);
    expect(row.bit_depth).toBeNull();
    expect(row.sampling_rate).toBe(44_100);
    expect(row.bytes).toBe(seed.bytes);
    // THE SERVER's source track: 24/96 flac in a real album.
    expect(row.src_album_id).toBe('alb-real');
    expect(row.src_suffix).toBe('flac');
    expect(row.src_bit_rate).toBe(1411);
    expect(row.src_bit_depth).toBe(24);
    expect(row.src_sampling_rate).toBe(96_000);
    // The five columns that mean the same on both sides are not rewritten either.
    expect(row.title).toBe('Blackbird');
    expect(row.artist).toBe('The Beatles');
    expect(row.album).toBe('The Beatles');
    expect(row.cover_art).toBe('cov-1');
    expect(row.duration).toBe(138);

    // The same split survives into the in-memory row the download paths read.
    const hydrated = await hydrateCachedSongsAsync();
    expect(hydrated.s1.albumId).toBe('_unknown');
    expect(hydrated.s1.suffix).toBe('mp3');
    expect(hydrated.s1.bitRate).toBe(128);
    expect(hydrated.s1.bitDepth).toBeUndefined();
    expect(hydrated.s1.samplingRate).toBe(44_100);
    expect(hydrated.s1.srcAlbumId).toBe('alb-real');
    expect(hydrated.s1.srcSuffix).toBe('flac');
    expect(hydrated.s1.srcBitRate).toBe(1411);
    expect(hydrated.s1.srcBitDepth).toBe(24);
    expect(hydrated.s1.srcSamplingRate).toBe(96_000);
  });

  it('round-trips genres with order and embedded commas preserved', async () => {
    insertLegacySong();
    // The other accepted shape: a plain `string[]`, with its own comma.
    insertLegacySong({
      songId: 's-strings',
      rawJson: JSON.stringify({
        ...sourceChild(),
        id: 's-strings',
        genres: ['Hip-Hop, Rap', 'Funk / Soul'],
      }),
    });

    await runConversion();

    expect(childRows('cached_song_genres').map((r) => r.name)).toEqual([
      'Folk, World, & Country',
      'Rock',
    ]);
    // The hydrate's `json_group_array` projection: a GROUP_CONCAT would split
    // "Folk, World, & Country" into three bogus genres here.
    const hydrated = await hydrateCachedSongsAsync();
    expect(hydrated.s1.genres).toEqual(['Folk, World, & Country', 'Rock']);
    expect(hydrated['s-strings'].genres).toEqual(['Hip-Hop, Rap', 'Funk / Soul']);
  });

  it('never converts or stamps a row with a NULL envelope (no library fallback)', async () => {
    // The derived partial-album rows are created with `rawJson: undefined`.
    insertLegacySong({ songId: 's-null', rawJson: null });

    await runConversion();

    const row = songRow('s-null')!;
    expect(row.meta_v).toBeNull();
    expect(row.src_album_id).toBeNull();
    expect(row.genre).toBeNull();
    expect(childRows('cached_song_genres', 's-null')).toEqual([]);
    // Outside the work set by definition — including it would make the pass
    // non-terminating, since nothing would ever mark such rows done.
    expect(workSetCount('cached_songs')).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  cached_items + component tables                                    */
/* ------------------------------------------------------------------ */

describe('convertLegacyMetadataAsync — cached_items', () => {
  it('writes cached_albums for an album item and cached_playlists for a playlist one', async () => {
    insertLegacyItem();
    insertLegacyItem({
      itemId: 'pl-1',
      type: 'playlist',
      name: 'Road Trip',
      artist: null,
      coverArtId: 'pl-cov-1',
      expectedSongCount: 12,
      rawJson: JSON.stringify(playlistEnvelope()),
    });

    await runConversion();

    const album = albumRow('alb-1')!;
    expect(album.name).toBe('The Beatles');
    expect(album.artist).toBe('The Beatles');
    expect(album.artist_id).toBe('art-1');
    expect(album.display_artist).toBe('The Beatles');
    expect(album.cover_art).toBe('cov-1');
    expect(album.song_count).toBe(30);
    expect(album.duration).toBe(5_000);
    expect(album.play_count).toBe(3);
    expect(album.created).toBe(Date.parse(CREATED_ISO));
    expect(album.starred).toBe(Date.parse(STARRED_ISO));
    expect(album.year).toBe(1968);
    expect(album.genre).toBe('Rock');
    expect(album.played).toBe(PLAYED_ISO);
    expect(album.user_rating).toBe(5);
    expect(album.version).toBe('Remastered');
    expect(album.music_brainz_id).toBe('mbid-album-1');
    expect(album.sort_name).toBe('Beatles, The');
    expect(album.is_compilation).toBe(0);
    expect(album.explicit_status).toBe('clean');
    expect(album.original_release_year).toBe(1968);
    expect(album.original_release_month).toBe(11);
    expect(album.original_release_day).toBe(22);
    expect(album.release_year).toBe(1987);
    expect(album.release_month).toBe(8);
    expect(album.release_day).toBe(24);
    expect(playlistRow('alb-1')).toBeUndefined();

    const playlist = playlistRow('pl-1')!;
    expect(playlist.name).toBe('Road Trip');
    expect(playlist.comment).toBe('the long way round');
    expect(playlist.cover_art).toBe('pl-cov-1');
    expect(playlist.created).toBe(Date.parse(CREATED_ISO));
    expect(playlist.changed).toBe(Date.parse(CHANGED_ISO));
    expect(playlist.duration).toBe(3_600);
    expect(playlist.owner).toBe('ghenry');
    expect(playlist.public).toBe(1);
    expect(playlist.song_count).toBe(12);
    expect(albumRow('pl-1')).toBeUndefined();

    expect(itemRow('alb-1')!.meta_v).toBe(1);
    expect(itemRow('pl-1')!.meta_v).toBe(1);
    expect(workSetCount('cached_items')).toBe(0);

    // The LEFT JOIN carries both onto the in-memory row.
    const hydrated = await hydrateCachedItemsAsync();
    expect(hydrated['alb-1'].albumMeta?.name).toBe('The Beatles');
    expect(hydrated['alb-1'].albumMeta?.isCompilation).toBe(false);
    expect(hydrated['alb-1'].playlistMeta).toBeUndefined();
    expect(hydrated['pl-1'].playlistMeta?.owner).toBe('ghenry');
    expect(hydrated['pl-1'].playlistMeta?.public).toBe(true);
    expect(hydrated['pl-1'].albumMeta).toBeUndefined();
  });

  it('gives favorites and song items no component row, and still stamps them', async () => {
    // Real rows of these types carry no envelope; these do, so they are IN the
    // work set — the point being that being converted gives them no component row.
    insertLegacyItem({
      itemId: 'favorites',
      type: 'favorites',
      name: 'Favorites',
      artist: null,
      coverArtId: null,
      rawJson: JSON.stringify({ id: 'favorites', name: 'Favorites' }),
    });
    insertLegacyItem({
      itemId: 'song:s1',
      type: 'song',
      name: 'Blackbird',
      expectedSongCount: 1,
      rawJson: JSON.stringify(sourceChild()),
    });

    await runConversion();

    for (const id of ['favorites', 'song:s1']) {
      expect(itemRow(id)!.meta_v).toBe(1);
      expect(albumRow(id)).toBeUndefined();
      expect(playlistRow(id)).toBeUndefined();
    }
    expect(countRows('cached_albums')).toBe(0);
    expect(countRows('cached_playlists')).toBe(0);
    expect(workSetCount('cached_items')).toBe(0);

    const hydrated = await hydrateCachedItemsAsync();
    expect(hydrated.favorites.albumMeta).toBeUndefined();
    expect(hydrated.favorites.playlistMeta).toBeUndefined();
    expect(hydrated['song:s1'].albumMeta).toBeUndefined();
  });

  it('stamps an item whose envelope will not parse, leaving no component row', async () => {
    insertLegacyItem({ rawJson: 'not json at all' });

    const { queries } = await runConversion();

    const row = itemRow('alb-1')!;
    expect(row.meta_v).toBe(1);
    expect(row.raw_json).toBe('not json at all');
    expect(albumRow('alb-1')).toBeUndefined();
    expect(workSetCount('cached_items')).toBe(0);
    // One empty songs query + one items chunk + the empty items query.
    expect(queries).toBe(3);
  });

  it('leaves an item raw_json intact and invents nothing for a NULL envelope', async () => {
    const seed = insertLegacyItem();
    // The derived partial-album grouping row: `rawJson: undefined` on write.
    insertLegacyItem({
      itemId: 'alb-derived',
      name: 'Derived Album',
      rawJson: null,
      derived: 1,
    });

    await runConversion();

    expect(itemRow('alb-1')!.raw_json).toBe(seed.rawJson);
    const derived = itemRow('alb-derived')!;
    expect(derived.meta_v).toBeNull();
    expect(albumRow('alb-derived')).toBeUndefined();
    expect(workSetCount('cached_items')).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Cascade                                                            */
/* ------------------------------------------------------------------ */

describe('convertLegacyMetadataAsync — cascade of the converted rows', () => {
  it('enforces foreign keys on the test connection', () => {
    // Without this the cascade assertions below would pass vacuously.
    expect(readPragma('foreign_keys')).toBe('1');
  });

  it('deleting a cached_songs row removes its cached_song_* rows', async () => {
    insertLegacySong();
    await runConversion();
    for (const table of SONG_CHILD_TABLES) expect(childRows(table).length).toBeGreaterThan(0);

    await deleteCachedSong('s1');

    expect(songRow('s1')).toBeUndefined();
    for (const table of SONG_CHILD_TABLES) expect(countRows(table)).toBe(0);
  });

  it('deleting a cached_items row removes its component row', async () => {
    insertLegacyItem();
    insertLegacyItem({
      itemId: 'pl-1',
      type: 'playlist',
      rawJson: JSON.stringify(playlistEnvelope()),
    });
    await runConversion();
    expect(albumRow('alb-1')).toBeDefined();
    expect(playlistRow('pl-1')).toBeDefined();

    await deleteCachedItem('alb-1');
    await deleteCachedItem('pl-1');

    expect(countRows('cached_albums')).toBe(0);
    expect(countRows('cached_playlists')).toBe(0);
  });
});
