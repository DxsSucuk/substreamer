/**
 * Library → Songs → Downloaded, end to end on REAL SQL:
 *
 *   cached_songs row → listDownloadedSongs → downloadedSongRowToChild (nine of ~58
 *   columns) → playTrack → the queue → a completed play → the scrobble row.
 *
 * The list's projection is deliberately narrow, because widening it changes what
 * every rendered row costs. So the track has to become complete where it stops being
 * a ROW and becomes a QUEUE entry — the queue feeds the lock screen, the details
 * sheet and the permanent listening history.
 *
 * Per AGENTS.md §11 the SQLite substitute proves SQL semantics, never concurrency.
 */
jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  Platform: { OS: 'android' },
}));

jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../subsonicService');

jest.mock('../musicCacheService', () => ({
  getLocalTrackUri: jest.fn(() => 'file:///music/s-dl.flac'),
  waitForTrackMapsReady: jest.fn(() => Promise.resolve()),
}));

jest.mock('../imageCacheService', () => ({
  resolveCachedImageUri: jest.fn().mockResolvedValue(null),
}));

jest.mock('../queuePersistenceService', () => ({
  persistQueue: jest.fn(),
  persistCurrentIndex: jest.fn(),
  persistPositionIfDue: jest.fn(),
  flushPosition: jest.fn(),
  clearPersistedQueue: jest.fn(),
  getPersistedQueue: jest.fn(() => null),
  getPersistedPosition: jest.fn(() => null),
}));

jest.mock('../sslTrustService', () => ({ syncProxyUpstreams: jest.fn() }));

import type { Child } from 'subsonic-api';

import { ensureNormalizedSchema } from '../../db/createNormalizedTables';
import { downloadedSongRowToChild, listDownloadedSongs } from '../../db/repository/downloads';
import { musicCacheStore } from '../../store/musicCacheStore';
import { completedScrobbleStore } from '../../store/completedScrobbleStore';
import { pendingScrobbleStore } from '../../store/pendingScrobbleStore';
import { playerStore } from '../../store/playerStore';
import { getDb } from '../../store/persistence/db';
import { upsertCachedSong, type CachedSongRow } from '../../store/persistence/musicCacheTables';
import { settleDbWrites } from '../../test-utils/settleDbWrites';
import { addToQueue, initPlayer, playSongNext, playTrack } from '../playerService';
import { getApi, getStreamUrl } from '../subsonicService';

const db = () => getDb()!;
const rnqp = require('react-native-queue-player');
const emit = rnqp.__emit as (name: string, ...args: unknown[]) => void;

/**
 * A downloaded track as the writer stores it: the `src*` twins describe the SERVER's
 * track, the same-named columns the file on disk. Every field below is one the
 * nine-column list projection drops.
 */
const DOWNLOADED_ROW: CachedSongRow = {
  id: 's-dl',
  title: 'Shoegaze Anthem',
  artist: 'The Artist',
  album: 'The Album',
  albumId: 'dir-1',
  coverArt: 'cov-1',
  bytes: 9_000_000,
  duration: 210,
  suffix: 'mp3',
  bitRate: 320,
  formatCapturedAt: 0,
  downloadedAt: 0,
  srcAlbumId: 'srv-1',
  srcSuffix: 'flac',
  srcBitRate: 1000,
  srcBitDepth: 24,
  srcSamplingRate: 96_000,
  artistId: 'ar-1',
  track: 3,
  discNumber: 1,
  year: 1991,
  genre: 'Shoegaze',
  genres: ['Shoegaze'],
  size: 41_000_000,
  contentType: 'audio/flac',
  path: 'The Artist/The Album/03 Shoegaze Anthem.flac',
  musicBrainzId: 'mb-1',
  rgTrackGain: -6.5,
};

/** The `Child` the Downloaded filter hands its rows — via the real SQL read. */
const listChild = async (): Promise<Child> => {
  const rows = await listDownloadedSongs(db());
  return downloadedSongRowToChild(rows[0]);
};

/** Drive a completed play of queue index 0, as the milestone event does. */
const completePlay = async (id: string): Promise<void> => {
  emit('trackChange', { id }, 0, 'queue-replaced');
  emit('milestone', 50, 0);
  await settleDbWrites();
};

const scrobbleRow = (): Record<string, unknown> | null =>
  db().getFirstSync<Record<string, unknown>>(
    'SELECT * FROM scrobble_events WHERE song_id = ?;',
    ['s-dl'],
  ) ?? null;

beforeAll(async () => {
  ensureNormalizedSchema(db());
  await initPlayer();
});

beforeEach(async () => {
  (getStreamUrl as jest.Mock).mockReturnValue('https://server/stream?id=s-dl');
  (getApi as jest.Mock).mockReturnValue({ scrobble: jest.fn().mockResolvedValue(undefined) });
  db().runSync('DELETE FROM scrobble_events;');
  db().runSync('DELETE FROM cached_songs;');
  pendingScrobbleStore.setState({ pendingScrobbles: [] });
  completedScrobbleStore.setState({ recentScrobbles: [] });
  playerStore.setState({ queue: [], currentTrack: null, currentTrackIndex: null });
  await upsertCachedSong(DOWNLOADED_ROW);
  musicCacheStore.setState({ cachedSongs: { [DOWNLOADED_ROW.id]: DOWNLOADED_ROW } });
});

describe('the Downloaded filter hands the list a deliberately narrow row', () => {
  it('projects nine columns and nothing more', async () => {
    const child = await listChild();
    // The projection is the point of the A3 work; this asserts it is still narrow, so
    // the fix below cannot have been a quiet widening of the list read.
    expect(child.album).toBeUndefined();
    expect(child.year).toBeUndefined();
    expect(child.genre).toBeUndefined();
    expect(child.suffix).toBeUndefined();
    expect(child.bitRate).toBeUndefined();
    expect(child.size).toBeUndefined();
  });
});

describe('playing a track from the Downloaded filter', () => {
  it('writes a scrobble carrying the whole downloaded track, not nine columns', async () => {
    const child = await listChild();

    await playTrack(child, [child]);
    await completePlay(child.id);

    const row = scrobbleRow();
    expect(row).not.toBeNull();
    expect(row!.album).toBe('The Album');
    expect(row!.album).not.toBe('Unknown');
    expect(row!.year).toBe(1991);
    expect(row!.genre).toBe('Shoegaze');
    expect(row!.suffix).toBe('flac');
    expect(row!.bit_rate).toBe(1000);
    expect(row!.size).toBe(41_000_000);
    expect(row!.artist_id).toBe('ar-1');
    expect(row!.track).toBe(3);
    expect(row!.content_type).toBe('audio/flac');
    expect(row!.path).toBe('The Artist/The Album/03 Shoegaze Anthem.flac');
    expect(row!.music_brainz_id).toBe('mb-1');
    expect(row!.rg_track_gain).toBe(-6.5);
  });

  it('puts the complete track in the queue the player and the UI read', async () => {
    const child = await listChild();

    await playTrack(child, [child]);

    const queued = playerStore.getState().queue[0];
    expect(queued.album).toBe('The Album');
    expect(queued.suffix).toBe('flac');
    expect(queued.bitRate).toBe(1000);
    expect(queued.genres).toEqual(['Shoegaze']);
  });

  it('keeps the album id the list read resolved — the SERVER album, not the directory', async () => {
    const child = await listChild();

    await playTrack(child, [child]);

    expect(playerStore.getState().queue[0].albumId).toBe('srv-1');
  });
});

/** The long press opens the options sheet on the same narrow row; its queue actions
 *  reach the player through `addToQueue` / `playSongNext`. */
describe('the long-press queue actions from the Downloaded filter', () => {
  const otherTrack = (): Child =>
    ({ id: 'other', title: 'Other', isDir: false, duration: 100 }) as Child;

  it('adds a complete track to the end of the queue', async () => {
    await playTrack(otherTrack(), [otherTrack()]);
    const child = await listChild();

    await addToQueue([child]);

    const queued = playerStore.getState().queue.find((c) => c.id === 's-dl')!;
    expect(queued.album).toBe('The Album');
    expect(queued.suffix).toBe('flac');
    expect(queued.year).toBe(1991);
  });

  it('inserts a complete track when played next', async () => {
    await playTrack(otherTrack(), [otherTrack()]);
    const child = await listChild();

    await playSongNext(child);

    const queued = playerStore.getState().queue.find((c) => c.id === 's-dl')!;
    expect(queued.album).toBe('The Album');
    expect(queued.suffix).toBe('flac');
    expect(queued.size).toBe(41_000_000);
  });
});
