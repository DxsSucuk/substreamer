// `persistence/db.ts` imports `expo-sqlite` at module load; stub it.
jest.mock('expo-sqlite', () => ({
  openDatabaseSync: () => ({
    getFirstSync: () => undefined,
    getAllSync: () => [],
    runSync: () => {},
    execSync: () => {},
    withTransactionSync: (fn: () => void) => fn(),
  }),
}));

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  Platform: { OS: 'android' },
}));

jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

const mockSetCurrentTrack = jest.fn();
const mockSetPlaybackState = jest.fn();
const mockSetQueue = jest.fn();
const mockSetProgress = jest.fn();
const mockSetError = jest.fn();
const mockSetRetrying = jest.fn();
const mockSetQueueLoading = jest.fn();
const mockSetQueueFormats = jest.fn();
const mockAddQueueFormat = jest.fn();
const mockClearQueueFormats = jest.fn();
const mockSetTrackSource = jest.fn();
const mockPlayerStoreSetState = jest.fn();

jest.mock('../../store/playerStore', () => ({
  playerStore: {
    getState: jest.fn(() => ({
      currentTrack: null,
      currentTrackIndex: null,
      queue: [],
      position: 0,
      duration: 100,
      bufferedPosition: 0,
      error: null,
      retrying: false,
      playbackState: 'idle',
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
      setTrackSource: mockSetTrackSource,
    })),
    setState: (...args: unknown[]) => mockPlayerStoreSetState(...args),
  },
}));

const mockToastFail = jest.fn();
jest.mock('../../store/playbackToastStore', () => ({
  playbackToastStore: {
    getState: jest.fn(() => ({ show: jest.fn(), succeed: jest.fn(), fail: mockToastFail })),
  },
}));

jest.mock('../../store/serverInfoStore', () => ({
  serverInfoStore: { getState: jest.fn(() => ({ extensions: [] })) },
}));

jest.mock('../scrobbleService', () => ({
  addCompletedScrobble: jest.fn(),
  sendNowPlaying: jest.fn(),
}));

jest.mock('../imageCacheService', () => ({
  resolveCachedImageUri: jest.fn().mockResolvedValue(null),
}));

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

jest.mock('../subsonicService');

const mockPersistQueue = jest.fn();
const mockClearPersistedQueue = jest.fn();
const mockGetPersistedQueue = jest.fn().mockReturnValue(null);
const mockGetPersistedPosition = jest.fn().mockReturnValue(null);

jest.mock('../queuePersistenceService', () => ({
  persistQueue: (...args: unknown[]) => mockPersistQueue(...args),
  persistPositionIfDue: jest.fn(),
  flushPosition: jest.fn(),
  clearPersistedQueue: () => mockClearPersistedQueue(),
  getPersistedQueue: () => mockGetPersistedQueue(),
  getPersistedPosition: () => mockGetPersistedPosition(),
  resetPersistTimer: jest.fn(),
  PERSIST_INTERVAL_MS: 10_000,
}));

import { playbackSettingsStore } from '../../store/playbackSettingsStore';
import { addCompletedScrobble, sendNowPlaying } from '../scrobbleService';
import { getCoverArtUrl, getStreamUrl, type Child } from '../subsonicService';
import {
  initPlayer,
  playTrack,
  togglePlayPause,
  skipToNext,
  skipToPrevious,
  seekTo,
  skipToTrack,
  retryPlayback,
  clearQueue,
  addToQueue,
  removeFromQueue,
  cycleRepeatMode,
  applyPlaybackRate,
  shuffleQueue,
  canSkipToPrevious,
  applyLocalPlayToPlayer,
  playSongNext,
  rebuildQueueForServerSwitch,
  updateRemoteCapabilities,
  applyPlaybackMode,
} from '../playerService';

// The global __mocks__/react-native-queue-player.js exposes the shared player
// instance + an event emitter.
const rnqp = require('react-native-queue-player');
const mockTP = rnqp.__trackPlayer as Record<string, jest.Mock>;
const emit = rnqp.__emit as (name: string, ...args: unknown[]) => void;

const makeChild = (id: string, overrides?: Partial<Child>): Child => ({
  id,
  title: `Song ${id}`,
  artist: 'Test Artist',
  album: 'Test Album',
  coverArt: `cover-${id}`,
  duration: 200,
  ...overrides,
} as Child);

const defaultPlayerState = () => ({
  currentTrack: null,
  currentTrackIndex: null,
  queue: [],
  position: 0,
  duration: 100,
  bufferedPosition: 0,
  error: null,
  retrying: false,
  playbackState: 'idle',
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
  setTrackSource: mockSetTrackSource,
});

beforeAll(async () => {
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
  // initPlayer is idempotent; call once to register the RNQP event listeners.
  await initPlayer();
});

afterAll(() => {
  jest.restoreAllMocks();
});

beforeEach(async () => {
  await clearQueue();
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();

  const { playerStore } = require('../../store/playerStore');
  (playerStore.getState as jest.Mock).mockReturnValue(defaultPlayerState());

  playbackSettingsStore.setState({
    repeatMode: 'off',
    playbackRate: 1,
    maxBitRate: null,
    streamFormat: 'raw',
    estimateContentLength: false,
    remoteControlMode: 'skip-track',
    skipForwardInterval: 15,
    skipBackwardInterval: 15,
  } as any);

  (getCoverArtUrl as jest.Mock).mockReturnValue('https://example.com/art.jpg');
  (getStreamUrl as jest.Mock).mockReturnValue('https://example.com/stream.mp3');
  mockGetPersistedQueue.mockReturnValue(null);
  mockGetPersistedPosition.mockReturnValue(null);
  mockOfflineMode.offlineMode = false;
});

describe('initPlayer', () => {
  it('registered the RNQP player + emitter used by these tests', () => {
    expect(typeof mockTP.setQueue).toBe('function');
    expect(typeof emit).toBe('function');
  });
});

describe('playTrack', () => {
  it('loads the queue at the tapped index and plays', async () => {
    const queue = [makeChild('t1'), makeChild('t2'), makeChild('t3')];
    await playTrack(queue[1], queue);

    expect(mockTP.setQueue).toHaveBeenCalledTimes(1);
    const [tracks, startIndex] = mockTP.setQueue.mock.calls[0];
    expect(tracks).toHaveLength(3);
    expect(tracks[0].id).toBe('t1');
    expect(startIndex).toBe(1);
    expect(mockTP.play).toHaveBeenCalled();
  });

  it('starts at 0 when the tapped track is the first', async () => {
    const queue = [makeChild('t1'), makeChild('t2')];
    await playTrack(queue[0], queue);
    expect(mockTP.setQueue.mock.calls[0][1]).toBe(0);
  });

  it('shows failure toast on error', async () => {
    mockTP.setQueue.mockRejectedValueOnce(new Error('boom'));
    await playTrack(makeChild('t1'), [makeChild('t1')]);
    expect(mockToastFail).toHaveBeenCalled();
  });

  it('updates the queue in the store', async () => {
    const queue = [makeChild('t1')];
    await playTrack(queue[0], queue);
    expect(mockSetQueue).toHaveBeenCalledWith(queue);
  });
});

describe('togglePlayPause', () => {
  it('pauses when playing', async () => {
    mockTP.getState.mockReturnValueOnce('playing');
    await togglePlayPause();
    expect(mockTP.pause).toHaveBeenCalled();
  });

  it('plays when paused', async () => {
    mockTP.getState.mockReturnValueOnce('paused');
    await togglePlayPause();
    expect(mockTP.play).toHaveBeenCalled();
  });
});

describe('transport passthroughs', () => {
  it('skipToNext / skipToPrevious', async () => {
    await skipToNext();
    expect(mockTP.skipToNext).toHaveBeenCalled();
    await skipToPrevious();
    expect(mockTP.skipToPrevious).toHaveBeenCalled();
  });

  it('seekTo passes through and clamps negatives to 0', async () => {
    await seekTo(60);
    expect(mockTP.seekTo).toHaveBeenCalledWith(60);
    await seekTo(-10);
    expect(mockTP.seekTo).toHaveBeenCalledWith(0);
  });

  it('skipToTrack skips to the index and plays', async () => {
    await skipToTrack(3);
    expect(mockTP.skipToIndex).toHaveBeenCalledWith(3);
    expect(mockTP.play).toHaveBeenCalled();
  });

  it('retryPlayback clears the error and re-attempts', async () => {
    await retryPlayback();
    expect(mockSetError).toHaveBeenCalledWith(null);
    expect(mockTP.retry).toHaveBeenCalled();
  });
});

describe('canSkipToPrevious', () => {
  it('false when no track / empty queue', () => {
    const { playerStore } = require('../../store/playerStore');
    (playerStore.getState as jest.Mock).mockReturnValue({
      ...defaultPlayerState(), currentTrackIndex: null, queue: [],
    });
    expect(canSkipToPrevious()).toBe(false);
  });

  it('true when a track is loaded', () => {
    const { playerStore } = require('../../store/playerStore');
    (playerStore.getState as jest.Mock).mockReturnValue({
      ...defaultPlayerState(), currentTrackIndex: 0, queue: [{ id: '1' }],
    });
    expect(canSkipToPrevious()).toBe(true);
  });
});

describe('clearQueue', () => {
  it('clears the native queue and resets store state', async () => {
    await clearQueue();
    expect(mockTP.clearQueue).toHaveBeenCalled();
    expect(mockSetCurrentTrack).toHaveBeenCalledWith(null);
    expect(mockSetQueue).toHaveBeenCalledWith([]);
    expect(mockSetPlaybackState).toHaveBeenCalledWith('idle');
    expect(mockSetProgress).toHaveBeenCalledWith(0, 0, 0);
    expect(mockClearPersistedQueue).toHaveBeenCalled();
  });
});

describe('rebuildQueueForServerSwitch', () => {
  it('no-ops when the queue is empty', async () => {
    mockTP.setQueue.mockClear();
    await rebuildQueueForServerSwitch();
    expect(mockTP.setQueue).not.toHaveBeenCalled();
  });

  it('rebuilds with new URLs, preserves index + position, resumes playback', async () => {
    const queue = [makeChild('t1'), makeChild('t2'), makeChild('t3')];
    await playTrack(queue[1], queue);
    mockTP.setQueue.mockClear();
    mockTP.play.mockClear();
    mockTP.seekTo.mockClear();

    const { playerStore } = require('../../store/playerStore');
    (playerStore.getState as jest.Mock).mockReturnValue({
      ...defaultPlayerState(), currentTrackIndex: 1, position: 42, playbackState: 'playing', queue,
    });
    (getStreamUrl as jest.Mock).mockImplementation((id: string) => `https://secondary.example.com/stream/${id}`);

    await rebuildQueueForServerSwitch();

    expect(mockTP.setQueue).toHaveBeenCalledTimes(1);
    const [tracks, idx] = mockTP.setQueue.mock.calls[0];
    expect(tracks).toHaveLength(3);
    expect(tracks[1].url).toBe('https://secondary.example.com/stream/t2');
    expect(idx).toBe(1);
    expect(mockTP.seekTo).toHaveBeenCalledWith(42);
    expect(mockTP.play).toHaveBeenCalledTimes(1);
  });

  it('does not resume play when paused', async () => {
    const queue = [makeChild('t1')];
    await playTrack(queue[0], queue);
    mockTP.play.mockClear();
    const { playerStore } = require('../../store/playerStore');
    (playerStore.getState as jest.Mock).mockReturnValue({
      ...defaultPlayerState(), currentTrackIndex: 0, playbackState: 'paused', queue,
    });
    await rebuildQueueForServerSwitch();
    expect(mockTP.play).not.toHaveBeenCalled();
  });
});

describe('playSongNext', () => {
  it('starts fresh playback when the queue is empty', async () => {
    await clearQueue();
    mockTP.setQueue.mockClear();
    mockTP.play.mockClear();
    await playSongNext(makeChild('new-song'));
    expect(mockTP.setQueue).toHaveBeenCalled();
    expect(mockTP.play).toHaveBeenCalled();
    expect(mockTP.setQueue.mock.calls[0][0][0].id).toBe('new-song');
  });

  it('inserts at currentIndex + 1 when the queue has tracks', async () => {
    const queue = [makeChild('a'), makeChild('b'), makeChild('c')];
    await playTrack(queue[1], queue);
    mockTP.addToQueue.mockClear();
    const { playerStore } = require('../../store/playerStore');
    (playerStore.getState as jest.Mock).mockReturnValue({
      ...defaultPlayerState(), currentTrackIndex: 1, queue,
    });
    await playSongNext(makeChild('inserted'));
    expect(mockTP.addToQueue).toHaveBeenCalledTimes(1);
    expect(mockTP.addToQueue.mock.calls[0][0][0].id).toBe('inserted');
    expect(mockTP.addToQueue.mock.calls[0][1]).toBe(2);
  });

  it('does not disturb current playback (no setQueue/play)', async () => {
    const queue = [makeChild('a'), makeChild('b')];
    await playTrack(queue[0], queue);
    mockTP.setQueue.mockClear();
    mockTP.play.mockClear();
    const { playerStore } = require('../../store/playerStore');
    (playerStore.getState as jest.Mock).mockReturnValue({
      ...defaultPlayerState(), currentTrackIndex: 0, queue,
    });
    await playSongNext(makeChild('next'));
    expect(mockTP.setQueue).not.toHaveBeenCalled();
    expect(mockTP.play).not.toHaveBeenCalled();
  });
});

describe('offline-mode queue building', () => {
  it('playTrack filters non-cached tracks when offline and refocuses on a cached one', async () => {
    const { getLocalTrackUri } = require('../musicCacheService');
    (getLocalTrackUri as jest.Mock).mockImplementation((id: string) => (id === 't2' ? '/local/t2.mp3' : null));
    mockOfflineMode.offlineMode = true;
    await playTrack(makeChild('t1'), [makeChild('t1'), makeChild('t2'), makeChild('t3')]);
    const tracks = mockTP.setQueue.mock.calls.at(-1)?.[0] as Array<{ id: string }>;
    expect(tracks.map((t) => t.id)).toEqual(['t2']);
    expect(mockTP.setQueue.mock.calls.at(-1)?.[1]).toBe(0);
    expect(mockTP.play).toHaveBeenCalled();
  });

  it('playTrack clears + toasts when all tracks are non-cached offline', async () => {
    const { getLocalTrackUri } = require('../musicCacheService');
    (getLocalTrackUri as jest.Mock).mockReturnValue(null);
    mockOfflineMode.offlineMode = true;
    mockTP.setQueue.mockClear();
    await playTrack(makeChild('t1'), [makeChild('t1'), makeChild('t2')]);
    expect(mockTP.setQueue).not.toHaveBeenCalled();
    expect(mockToastFail).toHaveBeenCalled();
    expect(mockSetQueue).toHaveBeenCalledWith([]);
  });

  it('leaves non-cached tracks when online', async () => {
    const { getLocalTrackUri } = require('../musicCacheService');
    (getLocalTrackUri as jest.Mock).mockReturnValue(null);
    mockOfflineMode.offlineMode = false;
    await playTrack(makeChild('t1'), [makeChild('t1'), makeChild('t2'), makeChild('t3')]);
    const tracks = mockTP.setQueue.mock.calls.at(-1)?.[0] as Array<{ id: string }>;
    expect(tracks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });
});

describe('addToQueue', () => {
  it('does nothing for an empty array', async () => {
    await addToQueue([]);
    expect(mockTP.addToQueue).not.toHaveBeenCalled();
  });

  it('starts playback when the queue is empty', async () => {
    await clearQueue();
    mockTP.setQueue.mockClear();
    await addToQueue([makeChild('t1'), makeChild('t2')]);
    expect(mockTP.setQueue).toHaveBeenCalled();
    expect(mockTP.play).toHaveBeenCalled();
  });

  it('appends when the queue has items', async () => {
    await playTrack(makeChild('t1'), [makeChild('t1')]);
    mockTP.addToQueue.mockClear();
    await addToQueue([makeChild('t2'), makeChild('t3')]);
    expect(mockTP.addToQueue).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 't2' }),
        expect.objectContaining({ id: 't3' }),
      ]),
    );
  });
});

describe('removeFromQueue', () => {
  it('ignores out-of-bounds index', async () => {
    await playTrack(makeChild('t1'), [makeChild('t1')]);
    mockTP.removeFromQueue.mockClear();
    await removeFromQueue(5);
    expect(mockTP.removeFromQueue).not.toHaveBeenCalled();
  });

  it('clears the queue when removing the only track', async () => {
    await playTrack(makeChild('t1'), [makeChild('t1')]);
    mockTP.clearQueue.mockClear();
    await removeFromQueue(0);
    expect(mockTP.clearQueue).toHaveBeenCalled();
  });

  it('removes by index batch when more than one track', async () => {
    await playTrack(makeChild('a'), [makeChild('a'), makeChild('b')]);
    mockTP.removeFromQueue.mockClear();
    await removeFromQueue(0);
    expect(mockTP.removeFromQueue).toHaveBeenCalledWith([0]);
  });
});

describe('cycleRepeatMode', () => {
  it('off -> all (queue)', async () => {
    playbackSettingsStore.setState({ repeatMode: 'off' } as any);
    await cycleRepeatMode();
    expect(playbackSettingsStore.getState().repeatMode).toBe('all');
    expect(mockTP.setRepeatMode).toHaveBeenCalledWith('queue');
  });
  it('all -> one (track)', async () => {
    playbackSettingsStore.setState({ repeatMode: 'all' } as any);
    await cycleRepeatMode();
    expect(mockTP.setRepeatMode).toHaveBeenCalledWith('track');
  });
  it('one -> off', async () => {
    playbackSettingsStore.setState({ repeatMode: 'one' } as any);
    await cycleRepeatMode();
    expect(mockTP.setRepeatMode).toHaveBeenCalledWith('off');
  });
});

describe('applyPlaybackRate', () => {
  it('sets the store rate and the native speed', async () => {
    playbackSettingsStore.setState({ playbackRate: 1 } as any);
    await applyPlaybackRate(1.5);
    expect(playbackSettingsStore.getState().playbackRate).toBe(1.5);
    expect(mockTP.setPlaybackSpeed).toHaveBeenCalledWith(1.5);
  });
});

describe('updateRemoteCapabilities', () => {
  it('maps skip-track mode', async () => {
    playbackSettingsStore.setState({ remoteControlMode: 'skip-track', skipForwardInterval: 15, skipBackwardInterval: 15 } as any);
    await updateRemoteCapabilities();
    expect(mockTP.setRemoteControls).toHaveBeenCalledWith({
      skipMode: 'track', forwardJumpInterval: 15, backwardJumpInterval: 15,
    });
  });
  it('maps skip-interval mode', async () => {
    playbackSettingsStore.setState({ remoteControlMode: 'skip-interval', skipForwardInterval: 30, skipBackwardInterval: 10 } as any);
    await updateRemoteCapabilities();
    expect(mockTP.setRemoteControls).toHaveBeenCalledWith({
      skipMode: 'interval', forwardJumpInterval: 30, backwardJumpInterval: 10,
    });
  });
});

describe('shuffleQueue', () => {
  it('does nothing with fewer than 2 tracks', async () => {
    await playTrack(makeChild('t1'), [makeChild('t1')]);
    mockTP.setQueue.mockClear();
    await shuffleQueue();
    expect(mockTP.setQueue).not.toHaveBeenCalled();
  });

  it('replaces the queue via setQueue(_, 0) and plays', async () => {
    const queue = Array.from({ length: 5 }, (_, i) => makeChild(`t${i}`));
    await playTrack(queue[0], queue);
    mockTP.setQueue.mockClear();
    mockTP.play.mockClear();
    await shuffleQueue();
    expect(mockTP.setQueue).toHaveBeenCalledTimes(1);
    expect(mockTP.setQueue.mock.calls[0][1]).toBe(0);
    expect(mockTP.play).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Event handlers (driven through the RNQP mock emitter)              */
/* ------------------------------------------------------------------ */

describe('onStateChange', () => {
  it('maps native states to PlaybackStatus', () => {
    emit('stateChange', 'playing');
    expect(mockSetPlaybackState).toHaveBeenCalledWith('playing');
    emit('stateChange', 'paused');
    expect(mockSetPlaybackState).toHaveBeenCalledWith('paused');
    emit('stateChange', 'buffering');
    expect(mockSetPlaybackState).toHaveBeenCalledWith('buffering');
    emit('stateChange', 'ended');
    expect(mockSetPlaybackState).toHaveBeenCalledWith('stopped');
    emit('stateChange', 'none');
    expect(mockSetPlaybackState).toHaveBeenCalledWith('idle');
  });

  it('clears error + retrying when transitioning to playing', () => {
    const { playerStore } = require('../../store/playerStore');
    (playerStore.getState as jest.Mock).mockReturnValue({
      ...defaultPlayerState(), error: 'boom', retrying: true,
    });
    emit('stateChange', 'playing');
    expect(mockSetError).toHaveBeenCalledWith(null);
    expect(mockSetRetrying).toHaveBeenCalledWith(false);
  });
});

describe('onProgress', () => {
  it('writes position/duration + absolute buffered edge (position + buffered-ahead)', () => {
    // RNQP `buffered` is seconds AHEAD of position; the store holds the absolute
    // edge. Background throttling of onProgress is native (configure), not here.
    emit('progress', { position: 12, duration: 200, buffered: 30 });
    expect(mockSetProgress).toHaveBeenCalledWith(12, 200, 42);
  });
});

describe('onTrackChange', () => {
  it('sets the current track + sends now-playing when resolved', async () => {
    const queue = [makeChild('t1'), makeChild('t2')];
    await playTrack(queue[0], queue);
    jest.clearAllMocks();
    emit('trackChange', { id: 't2' }, 1, 'auto-advance');
    expect(mockSetCurrentTrack).toHaveBeenCalledWith(expect.objectContaining({ id: 't2' }), 1);
    expect(sendNowPlaying).toHaveBeenCalledWith(expect.objectContaining({ id: 't2' }), undefined);
  });

  it('sets current track to null when track is empty', () => {
    emit('trackChange', undefined, -1, 'queue-replaced');
    expect(mockSetCurrentTrack).toHaveBeenCalledWith(null, null);
  });
});

describe('playback-report scrobble', () => {
  // Reset the per-play guard to track index 0 (queue-replaced ⇒ no completion
  // scrobble), then clear mocks so each case starts from a known state.
  async function armPlay(trigger: number) {
    playbackSettingsStore.setState({ scrobbleTrigger: trigger } as any);
    const queue = [makeChild('t1'), makeChild('t2')];
    await playTrack(queue[0], queue);
    emit('trackChange', { id: 't1' }, 0, 'queue-replaced');
    jest.clearAllMocks();
  }

  it('scrobbles at exactly the configured milestone (default 50%)', async () => {
    await armPlay(50);
    emit('milestone', 50, 0);
    expect(addCompletedScrobble).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), undefined);
  });

  it('does not scrobble at other milestones', async () => {
    await armPlay(50);
    emit('milestone', 25, 0);
    emit('milestone', 75, 0);
    expect(addCompletedScrobble).not.toHaveBeenCalled();
  });

  it('reports exactly once per play (milestone, not again on later milestones or completion)', async () => {
    await armPlay(50);
    emit('milestone', 50, 0);
    emit('milestone', 75, 0);
    emit('milestone', 90, 0);
    emit('trackChange', { id: 't2' }, 1, 'auto-advance');
    expect(addCompletedScrobble).toHaveBeenCalledTimes(1);
  });

  it('completion fallback reports when the milestone was skipped by a seek', async () => {
    await armPlay(50);
    // The 50 milestone is consumed silently by a seek → never emitted; the track
    // then finishes and auto-advances.
    emit('trackChange', { id: 't2' }, 1, 'auto-advance');
    expect(addCompletedScrobble).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), undefined);
  });

  it('does not report on a user skip (not a natural completion)', async () => {
    await armPlay(50);
    emit('trackChange', { id: 't2' }, 1, 'user-skip-next');
    expect(addCompletedScrobble).not.toHaveBeenCalled();
  });

  it('trigger 100 reports only on completion, never on a milestone', async () => {
    await armPlay(100);
    emit('milestone', 25, 0);
    emit('milestone', 50, 0);
    emit('milestone', 90, 0);
    expect(addCompletedScrobble).not.toHaveBeenCalled();
    emit('trackChange', { id: 't2' }, 1, 'auto-advance');
    expect(addCompletedScrobble).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), undefined);
  });

  it('re-scrobbles each repeat-one loop (milestone value wraps down)', async () => {
    await armPlay(50);
    emit('milestone', 50, 0); // loop 1
    emit('milestone', 90, 0);
    emit('milestone', 25, 0); // loop 2 begins → guard resets
    emit('milestone', 50, 0); // loop 2
    expect(addCompletedScrobble).toHaveBeenCalledTimes(2);
  });
});

describe('onError', () => {
  it('surfaces the error message', () => {
    emit('error', { message: 'Network error', fatal: false });
    expect(mockSetError).toHaveBeenCalledWith('Network error');
    expect(mockSetRetrying).toHaveBeenCalledWith(false);
  });

  it('falls back to a default message', () => {
    emit('error', { fatal: true });
    expect(mockSetError).toHaveBeenCalledWith('Playback error occurred');
  });
});

describe('onQueueEnd', () => {
  it('pins progress to the end of the current track', () => {
    const { playerStore } = require('../../store/playerStore');
    (playerStore.getState as jest.Mock).mockReturnValue({
      ...defaultPlayerState(), currentTrack: makeChild('t1', { duration: 240 }),
    });
    emit('queueEnd');
    expect(mockSetProgress).toHaveBeenCalledWith(240, 240, 240);
  });

  it('no-ops when there is no current track', () => {
    emit('queueEnd');
    expect(mockSetProgress).not.toHaveBeenCalled();
  });
});

describe('applyLocalPlayToPlayer', () => {
  const now = '2026-07-03T10:00:00.000Z';

  it('updates playerStore.currentTrack when it is the scrobbled song', async () => {
    const track = makeChild('s1', { playCount: 7 });
    await playTrack(track, [track]);
    const { playerStore } = require('../../store/playerStore');
    (playerStore.getState as jest.Mock).mockReturnValueOnce({
      ...defaultPlayerState(), currentTrack: track,
    });
    applyLocalPlayToPlayer('s1', now);
    expect(mockPlayerStoreSetState).toHaveBeenCalledWith({
      currentTrack: { ...track, playCount: 8, played: now },
    });
  });

  it('does not update when a different song is scrobbled', async () => {
    const playing = makeChild('current');
    await playTrack(playing, [playing]);
    const { playerStore } = require('../../store/playerStore');
    (playerStore.getState as jest.Mock).mockReturnValueOnce({
      ...defaultPlayerState(), currentTrack: playing,
    });
    applyLocalPlayToPlayer('other', now);
    expect(mockPlayerStoreSetState).not.toHaveBeenCalled();
  });
});

describe('applyPlaybackMode', () => {
  afterEach(() => playbackSettingsStore.setState({ playbackMode: 'gapless', crossfadeDurationMs: 5000 } as any));

  it('sends gapless with no crossfade duration', async () => {
    playbackSettingsStore.setState({ playbackMode: 'gapless', crossfadeDurationMs: 5000 } as any);
    mockTP.setPlaybackMode.mockClear();
    await applyPlaybackMode();
    expect(mockTP.setPlaybackMode).toHaveBeenCalledWith({
      kind: 'gapless',
      crossfadeDurationMs: undefined,
    });
  });

  it('sends crossfade with the configured duration', async () => {
    playbackSettingsStore.setState({ playbackMode: 'crossfade', crossfadeDurationMs: 8000 } as any);
    mockTP.setPlaybackMode.mockClear();
    await applyPlaybackMode();
    expect(mockTP.setPlaybackMode).toHaveBeenCalledWith({
      kind: 'crossfade',
      crossfadeDurationMs: 8000,
    });
  });
});
