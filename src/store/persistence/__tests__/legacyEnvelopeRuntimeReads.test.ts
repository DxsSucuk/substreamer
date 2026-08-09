/**
 * Step 11B — no `raw_json` read at runtime.
 *
 * The three runtime envelope readers are gone; the typed columns are the only
 * runtime source. What makes that safe is ORDER: `hydrateFromDbAsync` AWAITS the
 * conversion, which resolves TRUE only once the work set
 * (`meta_v IS NULL AND raw_json IS NOT NULL`) is empty on BOTH tables. A row can
 * therefore never be published ahead of its own promotion.
 *
 * Every rule here is a property of REAL SQL — the work-set predicate, the
 * per-row atomicity that makes a failed run lose nothing, and the upsert that no
 * longer re-arms `meta_v`. So this suite runs the generated schema on the
 * better-sqlite3-backed op-SQLite seam, against the real store.
 */
jest.mock('../../../services/subsonicService');
jest.mock('../kvStorage', () => require('../__mocks__/kvStorage'));

import { __setDbForTests, getDb, type InternalDb } from '../db';
import {
  convertLegacyMetadataAsync,
  upsertCachedItem,
  upsertCachedSong,
  type CachedItemRow,
  type CachedSongRow,
} from '../musicCacheTables';
import { getSongEnvelope, musicCacheStore } from '../../musicCacheStore';
import { getOfflineGenresPresent, getOfflineSongsByGenre } from '../../../services/searchService';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite seam failed to open');
const realDb: InternalDb = handle;

const CREATED_ISO = '2019-03-11T09:15:00.000Z';
const STARRED_ISO = '2024-01-02T03:04:05.000Z';

/** The server `Child` a pre-cutover download stored verbatim in `raw_json`. Its
 *  file-describing fields differ from the downloaded file's on purpose, so a
 *  reader that confuses the two is caught. */
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
  displayArtist: 'The Beatles',
  displayAlbumArtist: 'The Beatles',
  displayComposer: 'Paul McCartney',
  replayGain: { trackGain: -7.5, albumGain: -8.1, trackPeak: 0.98, albumPeak: 0.99 },
  userRating: 4,
  averageRating: 4.5,
  playCount: 12,
  created: CREATED_ISO,
  starred: STARRED_ISO,
  type: 'music',
  bpm: 96,
  comment: 'Alternate take',
  sortName: 'Blackbird',
  musicBrainzId: 'mbid-track-1',
  explicitStatus: 'clean',
  bookmarkPosition: 42,
});

const albumEnvelope = (): Record<string, unknown> => ({
  id: 'alb-1',
  name: 'The Beatles',
  artist: 'The Beatles',
  artistId: 'art-1',
  coverArt: 'cov-1',
  songCount: 30,
  duration: 5_000,
  created: CREATED_ISO,
  year: 1968,
  genre: 'Rock',
});

/** A row in the shipped v8.0.91 shape: the 15 file columns + the envelope, every
 *  promoted column and `meta_v` NULL. */
function insertLegacySong(songId = 's1', rawJson: string | null = JSON.stringify(sourceChild())) {
  realDb.runSync(
    `INSERT INTO cached_songs
       (song_id, title, artist, album, album_id, cover_art, bytes, duration,
        suffix, bit_rate, bit_depth, sampling_rate, format_captured_at,
        downloaded_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [songId, 'Blackbird', 'The Beatles', 'The Beatles', '_unknown', 'cov-1', 2_211_840, 138,
      'mp3', 128, null, 44_100, 1_700_000_000_000, 1_700_000_000_000, rawJson],
  );
}

function insertLegacyItem(itemId = 'alb-1', songIds: string[] = ['s1']) {
  realDb.runSync(
    `INSERT INTO cached_items
       (item_id, type, name, artist, cover_art_id, expected_song_count,
        parent_album_id, last_sync_at, downloaded_at, raw_json, derived)
       VALUES (?, 'album', ?, ?, ?, ?, NULL, ?, ?, ?, 0);`,
    [itemId, 'The Beatles', 'The Beatles', 'cov-1', 30, 1_700_000_000_000, 1_700_000_000_000,
      JSON.stringify(albumEnvelope())],
  );
  songIds.forEach((songId, i) => {
    realDb.runSync(
      'INSERT INTO cached_item_songs (item_id, position, song_id) VALUES (?, ?, ?);',
      [itemId, i + 1, songId],
    );
  });
}

type Row = Record<string, unknown>;
const songRow = (songId = 's1'): Row | undefined =>
  realDb.getFirstSync<Row>('SELECT * FROM cached_songs WHERE song_id = ?;', [songId]);
const itemRow = (itemId = 'alb-1'): Row | undefined =>
  realDb.getFirstSync<Row>('SELECT * FROM cached_items WHERE item_id = ?;', [itemId]);

/** The conversion's work set, read exactly as the assertion inside it does. */
const workSet = (table: string): number =>
  realDb.getFirstSync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM ${table} WHERE meta_v IS NULL AND raw_json IS NOT NULL;`,
  )?.c ?? -1;

/** Run `body` with every atomic write rejecting — the only way the conversion can
 *  fail to clear its work set, and the case the whole ordering guards. */
async function withFailingWrites<T>(body: () => Promise<T>): Promise<T> {
  const guard: InternalDb = {
    ...realDb,
    runAtomicBatchAsync: () => Promise.reject(new Error('disk I/O error')),
  };
  __setDbForTests(guard);
  try {
    return await body();
  } finally {
    __setDbForTests(realDb);
  }
}

beforeEach(() => {
  realDb.runSync('DELETE FROM cached_item_songs;');
  realDb.runSync('DELETE FROM cached_items;');
  realDb.runSync('DELETE FROM cached_songs;');
  musicCacheStore.getState().reset();
});

/* ------------------------------------------------------------------ */
/*  The conversion is authoritative                                     */
/* ------------------------------------------------------------------ */

describe('convertLegacyMetadataAsync — the completion verdict', () => {
  it('resolves true only once the work set is empty on BOTH tables', async () => {
    insertLegacySong();
    insertLegacyItem();
    expect(workSet('cached_songs')).toBe(1);
    expect(workSet('cached_items')).toBe(1);

    await expect(convertLegacyMetadataAsync()).resolves.toBe(true);

    expect(workSet('cached_songs')).toBe(0);
    expect(workSet('cached_items')).toBe(0);
  });

  it('resolves true with nothing to do — the every-launch fast path', async () => {
    await expect(convertLegacyMetadataAsync()).resolves.toBe(true);
  });

  it('resolves false when there is no DB handle', async () => {
    __setDbForTests(null);
    try {
      await expect(convertLegacyMetadataAsync()).resolves.toBe(false);
    } finally {
      __setDbForTests(realDb);
    }
  });

  /* THE DATA-LOSS GUARD. A run that cannot promote must report NOT complete and
   * must leave the envelope exactly as it found it. Every batch is atomic, so a
   * row is either fully promoted or untouched — never stamped without its
   * columns, which is the state that would strand metadata behind a reader that
   * no longer exists. */
  it('resolves false and leaves every envelope intact when the promotion cannot be written', async () => {
    insertLegacySong();
    insertLegacyItem();
    const envelopeBefore = songRow()!.raw_json;

    await withFailingWrites(async () => {
      await expect(convertLegacyMetadataAsync()).resolves.toBe(false);
    });

    // Nothing stamped, nothing promoted, nothing lost.
    expect(songRow()!.meta_v).toBeNull();
    expect(songRow()!.raw_json).toBe(envelopeBefore);
    expect(songRow()!.genre).toBeNull();
    expect(itemRow()!.meta_v).toBeNull();
    expect(itemRow()!.raw_json).not.toBeNull();
    expect(workSet('cached_songs')).toBe(1);
    expect(workSet('cached_items')).toBe(1);
  });

  /* The work-set assertion itself, not the error path. Migrations 18/19 write
   * `raw_json = ?, meta_v = NULL` directly, so an envelope can land AFTER the
   * song phase has walked past it: the loops finish without throwing and the
   * work set is still non-empty. The verdict has to be false or the next launch
   * would never retry — and that row's metadata would never reach a column. */
  it('resolves false when an envelope lands after its phase has walked past', async () => {
    insertLegacySong();
    insertLegacyItem('alb-1', []);
    const guard: InternalDb = {
      ...realDb,
      async runAtomicBatchAsync(commands) {
        await realDb.runAtomicBatchAsync(commands);
        if (String(commands[commands.length - 1]?.[0]).includes('cached_items')) {
          insertLegacySong('s-late');
        }
      },
    };
    __setDbForTests(guard);
    try {
      await expect(convertLegacyMetadataAsync()).resolves.toBe(false);
    } finally {
      __setDbForTests(realDb);
    }

    expect(songRow()!.meta_v).toBe(1);
    expect(workSet('cached_songs')).toBe(1);
    expect(workSet('cached_items')).toBe(0);
  });

  it('recovers every field on the next run after a failed one', async () => {
    insertLegacySong();
    await withFailingWrites(() => convertLegacyMetadataAsync());

    await expect(convertLegacyMetadataAsync()).resolves.toBe(true);

    const row = songRow()!;
    expect(row.meta_v).toBe(1);
    expect(row.genre).toBe('Folk, World, & Country');
    expect(row.track).toBe(11);
    expect(row.src_album_id).toBe('alb-real');
  });
});

/* ------------------------------------------------------------------ */
/*  The removal is gated on the conversion                              */
/* ------------------------------------------------------------------ */

describe('hydrateFromDbAsync — a row is never published ahead of its conversion', () => {
  /* The gate. With the readers deleted, a legacy row published before the
   * conversion reaches it would serve empty metadata columns; the hydrate awaits
   * the conversion instead, so the columns are already filled by the time the
   * store publishes. Detaching the conversion again fails this. */
  it('converts first, so a legacy download answers from columns on the same launch', async () => {
    insertLegacySong();
    insertLegacyItem();

    await musicCacheStore.getState().hydrateFromDbAsync();

    const child = getSongEnvelope('s1')!;
    expect(child.genre).toBe('Folk, World, & Country');
    expect(child.genres).toEqual(['Folk, World, & Country', 'Rock']);
    expect(child.track).toBe(11);
    expect(musicCacheStore.getState().cachedItems['alb-1'].albumMeta?.name).toBe('The Beatles');
  });

  /* The other half: a work set that CANNOT be cleared blocks the promotion
   * rather than half-applying it. The store still publishes — the app has to
   * work — but the envelope is untouched on disk and the next launch recovers
   * every field, so nothing is lost to the deleted readers. */
  it('leaves the work set and the envelopes intact when the conversion cannot complete', async () => {
    insertLegacySong();

    await withFailingWrites(() => musicCacheStore.getState().hydrateFromDbAsync());

    expect(workSet('cached_songs')).toBe(1);
    expect(songRow()!.raw_json).not.toBeNull();
    expect(songRow()!.meta_v).toBeNull();
    // The retry — a later launch — recovers everything the envelope held.
    await musicCacheStore.getState().hydrateFromDbAsync();
    expect(getSongEnvelope('s1')!.genre).toBe('Folk, World, & Country');
  });
});

/* ------------------------------------------------------------------ */
/*  Consumer parity                                                     */
/* ------------------------------------------------------------------ */

describe('the envelope path vs the columns — same answers', () => {
  beforeEach(async () => {
    insertLegacySong();
    insertLegacyItem();
    await musicCacheStore.getState().hydrateFromDbAsync();
  });

  /* `getSongEnvelope` used to `JSON.parse` this exact blob. Field by field, the
   * columns give back what the parse did. */
  it('getSongEnvelope rebuilds the Child the envelope carried', () => {
    const envelope = sourceChild();
    const child = getSongEnvelope('s1') as unknown as Record<string, unknown>;

    for (const key of [
      'id', 'title', 'artist', 'album', 'albumId', 'artistId', 'coverArt', 'duration',
      'suffix', 'bitRate', 'bitDepth', 'samplingRate', 'contentType',
      'transcodedContentType', 'transcodedSuffix', 'channelCount', 'size', 'path',
      'track', 'discNumber', 'year', 'genre', 'displayArtist', 'displayAlbumArtist',
      'displayComposer', 'userRating', 'averageRating', 'playCount', 'type', 'bpm',
      'comment', 'sortName', 'musicBrainzId', 'explicitStatus', 'bookmarkPosition',
      'isVideo', 'isDir', 'parent',
    ]) {
      expect([key, child[key]]).toEqual([key, envelope[key]]);
    }
    // Dates round-trip as Date objects rather than the envelope's ISO strings.
    expect((child.created as Date).toISOString()).toBe(CREATED_ISO);
    expect((child.starred as Date).toISOString()).toBe(STARRED_ISO);
    // `genres` normalises the `{name}` shape into the `cached_song_genres` rows.
    expect(child.genres).toEqual(['Folk, World, & Country', 'Rock']);
    expect(child.replayGain).toEqual({
      trackGain: -7.5, albumGain: -8.1, trackPeak: 0.98, albumPeak: 0.99,
      baseGain: undefined, fallbackGain: undefined,
    });
  });

  /* The two consumers of the deleted reader: the offline genre mixes Tuned-In
   * builds from, and the genre set it picks them out of. */
  it('the Tuned-In offline mixes still find the song by genre', () => {
    expect(getOfflineSongsByGenre('folk, world, & country').map((s) => s.id)).toEqual(['s1']);
    expect(getOfflineSongsByGenre('rock').map((s) => s.id)).toEqual(['s1']);
    expect(getOfflineSongsByGenre('jazz')).toEqual([]);
    expect([...getOfflineGenresPresent()].sort()).toEqual(['folk, world, & country', 'rock']);
  });
});

/* ------------------------------------------------------------------ */
/*  The upsert no longer re-arms meta_v                                 */
/* ------------------------------------------------------------------ */

describe('the upsert leaves meta_v alone', () => {
  it('a download landing a NEW song envelope does not re-arm a converted row', async () => {
    insertLegacySong();
    await convertLegacyMetadataAsync();
    expect(songRow()!.meta_v).toBe(1);

    await upsertCachedSong({
      id: 's1',
      title: 'Blackbird',
      albumId: '_unknown',
      bytes: 2_211_840,
      duration: 138,
      suffix: 'mp3',
      formatCapturedAt: 1_700_000_001_000,
      downloadedAt: 1_700_000_001_000,
      rawJson: JSON.stringify({ ...sourceChild(), genre: 'Rewritten' }),
    } as CachedSongRow);

    // Still stamped: the promoted columns hold the metadata, so there is nothing
    // for a re-arm to promote — and re-arming would send the conversion back over
    // a row whose columns are already fresher.
    expect(songRow()!.meta_v).toBe(1);
    expect(songRow()!.genre).toBe('Folk, World, & Country');
    expect(workSet('cached_songs')).toBe(0);
  });

  it('a download landing a NEW item envelope does not re-arm a converted row', async () => {
    insertLegacyItem('alb-1', []);
    await convertLegacyMetadataAsync();
    expect(itemRow()!.meta_v).toBe(1);

    await upsertCachedItem({
      itemId: 'alb-1',
      type: 'album',
      name: 'The Beatles',
      expectedSongCount: 30,
      lastSyncAt: 1_700_000_001_000,
      downloadedAt: 1_700_000_001_000,
      rawJson: JSON.stringify({ ...albumEnvelope(), name: 'Rewritten' }),
    } as Omit<CachedItemRow, 'songIds'>);

    expect(itemRow()!.meta_v).toBe(1);
    expect(workSet('cached_items')).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  The migration path keeps its column                                 */
/* ------------------------------------------------------------------ */

describe('raw_json survives for the migration path', () => {
  /* Migrations 18/19 backfill `WHERE raw_json IS NULL` and Migration 20 preloads
   * `WHERE raw_json IS NOT NULL`. The runtime must not empty the column out from
   * under them — the physical drop is a later migration, not this step. */
  it('is preserved by the conversion, the hydrate and a write-back', async () => {
    insertLegacySong();
    const envelope = songRow()!.raw_json;

    await musicCacheStore.getState().hydrateFromDbAsync();
    const row = musicCacheStore.getState().cachedSongs.s1;
    await upsertCachedSong({ ...row, bytes: 999 } as CachedSongRow);

    expect(songRow()!.raw_json).toBe(envelope);
    expect(songRow()!.bytes).toBe(999);
    // Still visible to Migration 20's preload predicate.
    expect(
      realDb.getFirstSync<{ c: number }>(
        'SELECT COUNT(*) AS c FROM cached_songs WHERE raw_json IS NOT NULL;',
      )!.c,
    ).toBe(1);
  });
});
