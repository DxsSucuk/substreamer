/**
 * The offline critical path, end to end on REAL SQL:
 *
 *   play offline → insertPendingScrobble → app restart → hydratePendingScrobblesAsync
 *   → back online → processScrobbles submits `item.song.id` and hands the whole `song`
 *   to `addCompleted`, which derives the completed row from it.
 *
 * `pending_scrobble_events` has no `song_json` column at all now, so every field below
 * survives only through the typed columns and the five `pending_scrobble_*` child
 * tables. What pending loses, the listening history loses too — which is why this asserts the whole
 * `Child` at the `addCompleted` hand-off and again after it lands in `scrobble_events`.
 *
 * Per AGENTS.md §11 the substitute proves SQL semantics, never concurrency.
 */
jest.mock('../../../services/subsonicService');
jest.mock('../../../services/playStatsService', () => ({ applyLocalPlay: jest.fn() }));

import type { Child } from 'subsonic-api';

import { addCompletedScrobble, initScrobbleService } from '../../../services/scrobbleService';
import { getApi } from '../../../services/subsonicService';
import { completedScrobbleStore, type CompletedScrobble } from '../../completedScrobbleStore';
import { pendingScrobbleStore } from '../../pendingScrobbleStore';
import { getDb, type InternalDb } from '../db';
import { hydrateScrobblesAsync } from '../scrobbleTable';

const handle = getDb();
if (handle === null) throw new Error('test DB unavailable — the op-SQLite substitute failed to open');
const realDb: InternalDb = handle;

const mockGetApi = getApi as jest.Mock;

/** A play with every field the plan's §2.2 consumer table names, plus all five
 *  arrays — none of which survives an envelope-free write unless the columns and the
 *  child tables carry it. */
const fullSong = {
  id: 's-full',
  title: 'Full Song',
  artist: 'The Artist',
  album: 'The Album',
  isDir: false,
  coverArt: 'cov-1',
  duration: 210,
  albumId: 'al-1',
  artistId: 'ar-1',
  year: 1999,
  track: 4,
  discNumber: 2,
  suffix: 'flac',
  bitRate: 960,
  size: 12_345_678,
  contentType: 'audio/flac',
  bpm: 128,
  path: 'The Artist/The Album/04 Full Song.flac',
  parent: 'al-1',
  sortName: 'Full Song, The',
  musicBrainzId: 'mb-1',
  explicitStatus: 'clean',
  userRating: 4,
  averageRating: 4.5,
  playCount: 12,
  created: new Date('2020-05-06T07:08:09.000Z'),
  starred: new Date('2021-06-07T08:09:10.000Z'),
  played: '2024-01-02T03:04:05Z',
  displayArtist: 'The Artist feat. Feature',
  displayComposer: 'Composer',
  replayGain: { trackGain: -7.5, trackPeak: 0.98 },
  genres: [{ name: 'Rock' }, { name: 'Indie' }],
  artists: [
    { id: 'ar-1', name: 'The Artist' },
    { id: 'ar-2', name: 'Feature' },
  ],
  albumArtists: [{ id: 'ar-3', name: 'Various' }],
  contributors: [
    { role: 'composer', subRole: 'lyrics', artist: { id: 'ar-4', name: 'Composer' } },
    { role: 'producer' },
  ],
  moods: ['energetic', 'happy'],
} as unknown as Child;

/** `fullSong` as the columns + child tables give it back. `genres` normalises to
 *  `string[]`, artist credits carry `albumCount: 0` and `genre` is derived from the
 *  first genre — the same three normalisations the completed table already applies. */
const restoredFullSong = {
  id: 's-full',
  title: 'Full Song',
  isDir: false,
  artist: 'The Artist',
  album: 'The Album',
  coverArt: 'cov-1',
  duration: 210,
  albumId: 'al-1',
  artistId: 'ar-1',
  displayArtist: 'The Artist feat. Feature',
  displayComposer: 'Composer',
  track: 4,
  discNumber: 2,
  year: 1999,
  genre: 'Rock',
  suffix: 'flac',
  bitRate: 960,
  size: 12_345_678,
  contentType: 'audio/flac',
  bpm: 128,
  path: 'The Artist/The Album/04 Full Song.flac',
  parent: 'al-1',
  sortName: 'Full Song, The',
  musicBrainzId: 'mb-1',
  explicitStatus: 'clean',
  userRating: 4,
  averageRating: 4.5,
  playCount: 12,
  created: new Date('2020-05-06T07:08:09.000Z'),
  starred: new Date('2021-06-07T08:09:10.000Z'),
  played: '2024-01-02T03:04:05Z',
  replayGain: { trackGain: -7.5, trackPeak: 0.98 },
  genres: ['Rock', 'Indie'],
  artists: [
    { id: 'ar-1', name: 'The Artist', albumCount: 0 },
    { id: 'ar-2', name: 'Feature', albumCount: 0 },
  ],
  albumArtists: [{ id: 'ar-3', name: 'Various', albumCount: 0 }],
  contributors: [
    { role: 'composer', subRole: 'lyrics', artist: { id: 'ar-4', name: 'Composer', albumCount: 0 } },
    { role: 'producer' },
  ],
  moods: ['energetic', 'happy'],
};

const countRows = (table: string): number =>
  realDb.getFirstSync<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table};`)?.c ?? 0;

/** Poll a condition on real timers — the store persists fire-and-forget, so the row
 *  lands a microtask or two after the call returns. */
async function waitUntil(label: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

beforeEach(() => {
  realDb.runSync('DELETE FROM pending_scrobble_events;');
  realDb.runSync('DELETE FROM scrobble_events;');
  pendingScrobbleStore.setState({ pendingScrobbles: [] });
  completedScrobbleStore.setState({ recentScrobbles: [] });
  mockGetApi.mockReset();
});

it('an offline play survives a restart and reaches addCompleted intact', async () => {
  // 1. Offline: no API, so the play is queued and nothing is submitted.
  mockGetApi.mockReturnValue(null);
  addCompletedScrobble(fullSong);

  const queued = pendingScrobbleStore.getState().pendingScrobbles;
  expect(queued).toHaveLength(1);
  const { id: queuedId, time: queuedTime } = queued[0];
  await waitUntil('the pending row to be persisted', () => countRows('pending_scrobble_events') > 0);

  // No envelope to fall back on — the columns and the child tables are the record.
  expect(
    realDb
      .getAllSync<{ name: string }>('PRAGMA table_info(pending_scrobble_events);')
      .map((c) => c.name),
  ).not.toContain('song_json');
  expect(countRows('pending_scrobble_genres')).toBe(2);
  expect(countRows('pending_scrobble_moods')).toBe(2);

  // 2. Restart: memory is empty, the queue comes back from SQL alone.
  pendingScrobbleStore.setState({ pendingScrobbles: [] });
  await pendingScrobbleStore.getState().hydrateFromDbAsync();

  const restored = pendingScrobbleStore.getState().pendingScrobbles;
  expect(restored).toHaveLength(1);
  expect(restored[0].id).toBe(queuedId);
  expect(restored[0].time).toBe(queuedTime);
  expect(restored[0].song).toEqual(restoredFullSong);

  // 3. Back online: capture what `processScrobbles` hands to `addCompleted`, and let
  //    the real implementation run so the completed row is derived from it.
  const submitted: unknown[] = [];
  mockGetApi.mockReturnValue({
    scrobble: (args: unknown) => {
      submitted.push(args);
      return Promise.resolve();
    },
  });
  const seen: CompletedScrobble[] = [];
  const realAddCompleted = completedScrobbleStore.getState().addCompleted;
  completedScrobbleStore.setState({
    addCompleted: (s) => {
      seen.push(s);
      realAddCompleted(s);
    },
  });

  initScrobbleService();
  await waitUntil('the queue to drain', () => seen.length > 0);

  // The server gets the SONG's id and the play's time, not the queue-entry id.
  expect(submitted).toEqual([{ id: 's-full', time: queuedTime, submission: true }]);

  // THE ASSERTION THIS SUITE EXISTS FOR: the `Child` handed to `addCompleted` is the
  // whole song, five arrays included, reconstructed from columns alone.
  expect(seen).toHaveLength(1);
  expect(seen[0].id).toBe(queuedId);
  expect(seen[0].time).toBe(queuedTime);
  expect(seen[0].song).toEqual(restoredFullSong);

  // 4. The queue row is gone (children cascaded) and the history row carries the set.
  await waitUntil('the pending row to be deleted', () => countRows('pending_scrobble_events') === 0);
  expect(countRows('pending_scrobble_genres')).toBe(0);
  expect(countRows('pending_scrobble_contributors')).toBe(0);

  await waitUntil('the completed row to be written', () => countRows('scrobble_events') === 1);
  const [completed] = await hydrateScrobblesAsync();
  expect(completed.id).toBe(queuedId);
  expect(completed.song).toEqual(restoredFullSong);
});
