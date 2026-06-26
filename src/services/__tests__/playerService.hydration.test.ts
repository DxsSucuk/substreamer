/**
 * Tests for cold-start queue resume hydration.
 *
 * Covers the bulletproof 7-step sequence (reset → mute → add → verify → skip
 * → seek → pause → unmute) plus setupPlayer error classification and the
 * public-API hydration guards. Uses its own module cache (separate file)
 * so initPlayer() can run with a persisted queue populated.
 */

jest.mock('expo-sqlite', () => ({
  openDatabaseSync: () => ({
    getFirstSync: () => undefined,
    getAllSync: () => [],
    runSync: () => {},
    execSync: () => {},
    withTransactionSync: (fn: () => void) => fn(),
  }),
}));

jest.mock('react-native-track-player', () => ({
  __esModule: true,
  default: {
    setupPlayer: jest.fn().mockResolvedValue(undefined),
    updateOptions: jest.fn().mockResolvedValue(undefined),
    setRepeatMode: jest.fn().mockResolvedValue(undefined),
    setRate: jest.fn().mockResolvedValue(undefined),
    setVolume: jest.fn().mockResolvedValue(undefined),
    addEventListener: jest.fn(),
    reset: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
    skip: jest.fn().mockResolvedValue(undefined),
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(undefined),
    seekTo: jest.fn().mockResolvedValue(undefined),
    skipToNext: jest.fn().mockResolvedValue(undefined),
    skipToPrevious: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    setQueue: jest.fn().mockResolvedValue(undefined),
    retry: jest.fn().mockResolvedValue(undefined),
    load: jest.fn().mockResolvedValue(undefined),
    getPlaybackState: jest.fn().mockResolvedValue({ state: 2 }),
    getActiveTrack: jest.fn().mockResolvedValue(null),
    getActiveTrackIndex: jest.fn().mockResolvedValue(0),
    getProgress: jest.fn().mockResolvedValue({ position: 0, duration: 0, buffered: 0 }),
    getQueue: jest.fn().mockResolvedValue([]),
  },
  Capability: { Play: 0, Pause: 1, SkipToNext: 2, SkipToPrevious: 3, Stop: 4, SeekTo: 5, JumpForward: 6, JumpBackward: 7 },
  Event: {
    PlaybackState: 'playback-state',
    PlaybackError: 'playback-error',
    PlaybackActiveTrackChanged: 'playback-active-track-changed',
    PlaybackEndedWithReason: 'playback-ended-with-reason',
    PlaybackQueueEnded: 'playback-queue-ended',
    PlaybackStalled: 'playback-stalled',
    PlaybackErrorLog: 'playback-error-log',
    PlaybackBufferEmpty: 'playback-buffer-empty',
    PlaybackBufferFull: 'playback-buffer-full',
    PlaybackSeekCompleted: 'playback-seek-completed',
    PlaybackProgressUpdated: 'playback-progress-updated',
    SleepTimerChanged: 'sleep-timer-changed',
    SleepTimerComplete: 'sleep-timer-complete',
  },
  AppKilledPlaybackBehavior: {
    ContinuePlayback: 'continue-playback',
    PausePlayback: 'pause-playback',
    StopPlaybackAndRemoveNotification: 'stop-playback-and-remove-notification',
  },
  IOSCategory: { Playback: 'playback' },
  RepeatMode: { Off: 0, Track: 1, Queue: 2 },
  State: { Playing: 3, Paused: 2, Buffering: 6, Loading: 9, Stopped: 1, Ended: 11, None: 0, Ready: 8, Connecting: 7, Error: 10 },
}));

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  Platform: { OS: 'android' },
}));

jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

// Stateful mock — restorePersistedQueue() calls setCurrentTrack(child, index)
// at startup and then hydrateRestoredQueue() reads currentTrackIndex back to
// decide which track to seek to. A stateless stub would always return 0.
const playerStoreState: {
  currentTrack: unknown;
  currentTrackIndex: number | null;
  queue: unknown[];
  position: number;
  duration: number;
  error: string | null;
  retrying: boolean;
} = {
  currentTrack: null,
  currentTrackIndex: 0,
  queue: [],
  position: 0,
  duration: 100,
  error: null,
  retrying: false,
};

const mockSetCurrentTrack = jest.fn((track: unknown, index?: number | null) => {
  playerStoreState.currentTrack = track;
  if (index !== undefined) playerStoreState.currentTrackIndex = index;
});
const mockSetPlaybackState = jest.fn();
const mockSetQueue = jest.fn((q: unknown[]) => { playerStoreState.queue = q; });
const mockSetProgress = jest.fn();
const mockSetError = jest.fn();
const mockSetRetrying = jest.fn();
const mockSetQueueLoading = jest.fn();
const mockSetQueueFormats = jest.fn();
const mockClearQueueFormats = jest.fn();
const mockAddQueueFormat = jest.fn();

const buildPlayerState = () => ({
  ...playerStoreState,
  setCurrentTrack: mockSetCurrentTrack,
  setPlaybackState: mockSetPlaybackState,
  setQueue: mockSetQueue,
  setProgress: mockSetProgress,
  setError: mockSetError,
  setRetrying: mockSetRetrying,
  setQueueLoading: mockSetQueueLoading,
  setQueueFormats: mockSetQueueFormats,
  addQueueFormat: mockAddQueueFormat,
  clearQueueFormats: mockClearQueueFormats,
});

jest.mock('../../store/playerStore', () => ({
  playerStore: {
    getState: jest.fn(() => buildPlayerState()),
    setState: jest.fn(),
  },
}));

const mockToastFail = jest.fn();
jest.mock('../../store/playbackToastStore', () => ({
  playbackToastStore: {
    getState: jest.fn(() => ({
      show: jest.fn(),
      succeed: jest.fn(),
      fail: mockToastFail,
    })),
  },
}));

jest.mock('../../store/serverInfoStore', () => ({
  serverInfoStore: { getState: jest.fn(() => ({ extensions: [] })) },
}));

jest.mock('../scrobbleService', () => ({
  addCompletedScrobble: jest.fn(),
  sendNowPlaying: jest.fn(),
}));

jest.mock('../imageCacheService', () => ({ resolveCachedImageUri: jest.fn().mockResolvedValue(null) }));

jest.mock('../musicCacheService', () => ({
  getLocalTrackUri: jest.fn().mockReturnValue(null),
  waitForTrackMapsReady: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../store/musicCacheStore', () => ({
  musicCacheStore: { getState: jest.fn(() => ({ cachedSongs: {} })) },
}));

const mockOfflineMode = { offlineMode: false };
jest.mock('../../store/offlineModeStore', () => ({
  offlineModeStore: { getState: jest.fn(() => mockOfflineMode) },
}));

// Factory-based mock so the closure over `subsonicMocks` survives fresh
// isolateModules() loads — auto-mock (jest.mock(path)) creates a fresh
// jest.fn per isolation and discards our test-level setup.
const subsonicMocks = {
  streamUrl: 'https://example.com/stream.mp3' as string | null,
  coverArtUrl: 'https://example.com/art.jpg' as string | null,
};
jest.mock('../subsonicService', () => ({
  getStreamUrl: jest.fn(() => subsonicMocks.streamUrl),
  getCoverArtUrl: jest.fn(() => subsonicMocks.coverArtUrl),
  ensureCoverArtAuth: jest.fn(() => Promise.resolve()),
}));

const mockGetPersistedQueue = jest.fn().mockReturnValue(null);
const mockGetPersistedPosition = jest.fn().mockReturnValue(null);
jest.mock('../queuePersistenceService', () => ({
  persistQueue: jest.fn(),
  persistPositionIfDue: jest.fn(),
  flushPosition: jest.fn(),
  clearPersistedQueue: jest.fn(),
  getPersistedQueue: () => mockGetPersistedQueue(),
  getPersistedPosition: () => mockGetPersistedPosition(),
  resetPersistTimer: jest.fn(),
  PERSIST_INTERVAL_MS: 10_000,
}));

import TrackPlayer from 'react-native-track-player';
import type { Child } from '../subsonicService';

const mockTP = TrackPlayer as unknown as Record<string, jest.Mock>;

const makeChild = (id: string): Child => ({
  id,
  title: `Song ${id}`,
  artist: 'Test Artist',
  album: 'Test Album',
  coverArt: `cover-${id}`,
  duration: 200,
} as Child);

/**
 * Load a FRESH copy of playerService with all the mocks above re-applied.
 * Necessary because playerService has module-level `isPlayerReady` state
 * that makes initPlayer idempotent — to test cold-start hydration we need
 * a pristine module each time.
 */
function loadFreshPlayerService() {
  let svc: typeof import('../playerService');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    svc = require('../playerService');
  });
  return svc!;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();

  subsonicMocks.streamUrl = 'https://example.com/stream.mp3';
  subsonicMocks.coverArtUrl = 'https://example.com/art.jpg';

  mockGetPersistedQueue.mockReturnValue(null);
  mockGetPersistedPosition.mockReturnValue(null);
  mockOfflineMode.offlineMode = false;

  // Reset the stateful player-store mirror between tests.
  playerStoreState.currentTrack = null;
  playerStoreState.currentTrackIndex = 0;
  playerStoreState.queue = [];
  playerStoreState.position = 0;

  // Reset RNTP mocks to default (resolving, empty queue).
  mockTP.setupPlayer.mockResolvedValue(undefined);
  mockTP.reset.mockResolvedValue(undefined);
  mockTP.add.mockResolvedValue(undefined);
  mockTP.skip.mockResolvedValue(undefined);
  mockTP.seekTo.mockResolvedValue(undefined);
  mockTP.pause.mockResolvedValue(undefined);
  mockTP.setVolume.mockResolvedValue(undefined);
  mockTP.getQueue.mockResolvedValue([]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('cold-start hydration', () => {
  it('runs the mute → reset → add → seek → pause → unmute sequence in order', async () => {
    const queue = [makeChild('a'), makeChild('b'), makeChild('c')];
    mockGetPersistedQueue.mockReturnValue({ queue, currentTrackIndex: 1 });
    mockGetPersistedPosition.mockReturnValue({ trackId: 'b', position: 45 });
    mockTP.getQueue.mockResolvedValue(queue.map((c) => ({ id: c.id })));

    // Capture the ordering of RNTP calls across the hydration.
    const order: string[] = [];
    mockTP.reset.mockImplementation(async () => { order.push('reset'); });
    mockTP.setVolume.mockImplementation(async (v: number) => { order.push(`setVolume(${v})`); });
    mockTP.add.mockImplementation(async () => { order.push('add'); });
    mockTP.skip.mockImplementation(async () => { order.push('skip'); });
    mockTP.seekTo.mockImplementation(async (p: number) => { order.push(`seekTo(${p})`); });
    mockTP.pause.mockImplementation(async () => { order.push('pause'); });

    const svc = loadFreshPlayerService();
    await svc.initPlayer();
    svc.restorePersistedQueueAfterBoot();
    // Drain the async hydration kicked off by initPlayer.
    await svc.togglePlayPause();

    // Strip the unconditional post-setup reset that initPlayer runs
    // before hydration starts (we only care about the hydration sequence).
    const postHydrationOrder = order.slice(1);

    expect(postHydrationOrder).toEqual([
      'reset',
      'setVolume(0)',
      'add',
      'skip',
      'seekTo(45)',
      'pause',
      'setVolume(1)',
    ]);
  });

  it('skips the skip() call when starting at index 0', async () => {
    const queue = [makeChild('a'), makeChild('b')];
    mockGetPersistedQueue.mockReturnValue({ queue, currentTrackIndex: 0 });
    mockTP.getQueue.mockResolvedValue(queue.map((c) => ({ id: c.id })));

    const svc = loadFreshPlayerService();
    await svc.initPlayer();
    svc.restorePersistedQueueAfterBoot();
    await svc.togglePlayPause();

    expect(mockTP.skip).not.toHaveBeenCalled();
    expect(mockTP.add).toHaveBeenCalledTimes(1);
    expect(mockTP.pause).toHaveBeenCalled();
  });

  it('does not seek when the persisted position does not match the start track', async () => {
    const queue = [makeChild('a'), makeChild('b')];
    mockGetPersistedQueue.mockReturnValue({ queue, currentTrackIndex: 0 });
    // Persisted position for a different track → must be ignored.
    mockGetPersistedPosition.mockReturnValue({ trackId: 'something-else', position: 100 });
    mockTP.getQueue.mockResolvedValue(queue.map((c) => ({ id: c.id })));

    const svc = loadFreshPlayerService();
    await svc.initPlayer();
    svc.restorePersistedQueueAfterBoot();
    await svc.togglePlayPause();

    expect(mockTP.seekTo).not.toHaveBeenCalled();
  });

  it('retries once when add() leaves the native queue short', async () => {
    const queue = [makeChild('a'), makeChild('b'), makeChild('c')];
    mockGetPersistedQueue.mockReturnValue({ queue, currentTrackIndex: 0 });

    // First getQueue (post-add) returns empty → hydration should retry.
    // Second getQueue returns the full queue → success on retry.
    mockTP.getQueue
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(queue.map((c) => ({ id: c.id })));

    const svc = loadFreshPlayerService();
    await svc.initPlayer();
    svc.restorePersistedQueueAfterBoot();
    await svc.togglePlayPause();

    expect(mockTP.add).toHaveBeenCalledTimes(2);
    // reset fired: once post-setup + once during hydration step 2 + once on retry.
    expect(mockTP.reset).toHaveBeenCalledTimes(3);
    expect(mockTP.pause).toHaveBeenCalled();
  });

  it('clears state and surfaces a toast when both add attempts leave the queue short', async () => {
    const queue = [makeChild('a'), makeChild('b')];
    mockGetPersistedQueue.mockReturnValue({ queue, currentTrackIndex: 0 });
    // Both getQueue() checks return empty — native layer is refusing the queue.
    mockTP.getQueue.mockResolvedValue([]);

    const svc = loadFreshPlayerService();
    await svc.initPlayer();
    svc.restorePersistedQueueAfterBoot();
    await svc.togglePlayPause();

    expect(mockToastFail).toHaveBeenCalled();
    // Volume must be restored so the next action isn't silent.
    expect(mockTP.setVolume).toHaveBeenLastCalledWith(1);
  });

  it('awaits hydration before togglePlayPause fires play()', async () => {
    const queue = [makeChild('a')];
    mockGetPersistedQueue.mockReturnValue({ queue, currentTrackIndex: 0 });
    mockTP.getQueue.mockResolvedValue(queue.map((c) => ({ id: c.id })));

    // Stall add() — the user's first togglePlayPause must wait for it to
    // complete before touching RNTP, not fire play() while hydration is
    // mid-sequence.
    let resolveAdd: () => void = () => {};
    mockTP.add.mockImplementation(() => new Promise<void>((r) => { resolveAdd = r; }));

    const svc = loadFreshPlayerService();
    await svc.initPlayer();
    svc.restorePersistedQueueAfterBoot();
    // Hydration has a 100ms real-timer settle between its pre-load reset
    // and the add() call. Wait past it so add() is actually stalled.
    await new Promise((r) => setTimeout(r, 200));

    const togglePromise = svc.togglePlayPause();
    // Drain microtasks — play() must NOT have fired yet.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(mockTP.play).not.toHaveBeenCalled();

    // Release add(); hydration finishes, togglePlayPause proceeds.
    resolveAdd();
    await togglePromise;

    expect(mockTP.pause).toHaveBeenCalled(); // hydration's explicit pause
    expect(mockTP.play).toHaveBeenCalled();  // togglePlayPause's play after hydration
  });

  it('awaits hydration before playTrack replaces the queue', async () => {
    const queue = [makeChild('a')];
    mockGetPersistedQueue.mockReturnValue({ queue, currentTrackIndex: 0 });
    mockTP.getQueue.mockResolvedValue(queue.map((c) => ({ id: c.id })));

    let resolveAdd: () => void = () => {};
    mockTP.add.mockImplementationOnce(() => new Promise<void>((r) => { resolveAdd = r; }));

    const svc = loadFreshPlayerService();
    await svc.initPlayer();
    svc.restorePersistedQueueAfterBoot();
    // Let hydration advance past the 100ms settle so its add() is stalled.
    await new Promise((r) => setTimeout(r, 200));

    const newQueue = [makeChild('new-1'), makeChild('new-2')];
    const playPromise = svc.playTrack(newQueue[0], newQueue);

    // playTrack's second add() must not have fired while hydration's add()
    // is still stalled.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(mockTP.add).toHaveBeenCalledTimes(1); // only the hydration's add

    resolveAdd();
    await playPromise;

    // After hydration drains, playTrack's reset + add + play should run.
    expect(mockTP.add).toHaveBeenCalledTimes(2);
    expect(mockTP.play).toHaveBeenCalled();
  });

  it('bails out and toasts when every restored track is unplayable', async () => {
    // No local URIs and no stream URL either → childToTrack returns null
    // for every restored track → rnTracks empty → hydration bails before
    // touching RNTP add().
    subsonicMocks.streamUrl = null;
    const queue = [makeChild('a'), makeChild('b')];
    mockGetPersistedQueue.mockReturnValue({ queue, currentTrackIndex: 0 });

    const svc = loadFreshPlayerService();
    await svc.initPlayer();
    svc.restorePersistedQueueAfterBoot();
    // Give hydration time to run past its 100ms settle.
    await new Promise((r) => setTimeout(r, 200));

    expect(mockToastFail).toHaveBeenCalled();
    expect(mockTP.add).not.toHaveBeenCalled();
    expect(mockSetQueue).toHaveBeenCalledWith([]);
  });
});

describe('setupPlayer error classification', () => {
  it('treats player_already_initialized as zombie-recovery (not fatal)', async () => {
    mockTP.setupPlayer.mockRejectedValueOnce(
      Object.assign(new Error('player_already_initialized'), { code: 'player_already_initialized' }),
    );

    const svc = loadFreshPlayerService();
    await svc.initPlayer();
    svc.restorePersistedQueueAfterBoot();

    // Event listeners still registered — post-setup reset still ran.
    expect(mockTP.addEventListener).toHaveBeenCalled();
    expect(mockTP.reset).toHaveBeenCalled();
  });

  it('bails out of initPlayer when setupPlayer throws a non-already-initialized error', async () => {
    mockTP.setupPlayer.mockRejectedValueOnce(new Error('something_else_went_wrong'));

    const svc = loadFreshPlayerService();
    await svc.initPlayer();
    svc.restorePersistedQueueAfterBoot();

    // No event listeners registered, no reset, no hydration — we bailed.
    expect(mockTP.addEventListener).not.toHaveBeenCalled();
    expect(mockTP.reset).not.toHaveBeenCalled();
  });
});

describe('public API hydration guards (no persisted queue)', () => {
  it('is a near-no-op when there is no pending hydration', async () => {
    // Default mocks → no persisted queue → no hydration kicked off.
    const svc = loadFreshPlayerService();
    await svc.initPlayer();
    svc.restorePersistedQueueAfterBoot();

    jest.clearAllMocks();

    await svc.skipToNext();
    await svc.skipToPrevious();
    await svc.togglePlayPause();

    // These all pass through to the expected RNTP calls without waiting.
    expect(mockTP.skipToNext).toHaveBeenCalledTimes(1);
    expect(mockTP.skipToPrevious).toHaveBeenCalledTimes(1);
    // togglePlayPause calls getPlaybackState then play/pause.
    expect(mockTP.getPlaybackState).toHaveBeenCalled();
  });
});
