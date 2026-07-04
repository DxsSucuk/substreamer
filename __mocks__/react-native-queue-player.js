/**
 * Jest manual mock for react-native-queue-player.
 *
 * Auto-used for this node_modules package (root `__mocks__/`), so tests never
 * hit the native NitroModules TurboModule. `getTrackPlayer()` returns a shared
 * mock whose `on*` subscriptions record their callbacks; tests fire native
 * events via the exported `__emit(name, ...args)` helper and reset with
 * `__resetPlayerMock()`.
 */

const listeners = {};

function makeSub(name) {
  return (cb) => {
    (listeners[name] = listeners[name] || []).push(cb);
    return () => {
      listeners[name] = (listeners[name] || []).filter((c) => c !== cb);
    };
  };
}

const trackPlayer = {
  configure: jest.fn(() => Promise.resolve()),
  destroy: jest.fn(() => Promise.resolve()),
  setQueue: jest.fn(() => Promise.resolve()),
  addToQueue: jest.fn(() => Promise.resolve()),
  removeFromQueue: jest.fn(() => Promise.resolve()),
  moveInQueue: jest.fn(() => Promise.resolve()),
  getQueue: jest.fn(() => []),
  clearQueue: jest.fn(() => Promise.resolve()),
  play: jest.fn(() => Promise.resolve()),
  pause: jest.fn(() => Promise.resolve()),
  stop: jest.fn(() => Promise.resolve()),
  retry: jest.fn(() => Promise.resolve()),
  seekTo: jest.fn(() => Promise.resolve()),
  skipToIndex: jest.fn(() => Promise.resolve()),
  skipToNext: jest.fn(() => Promise.resolve()),
  skipToPrevious: jest.fn(() => Promise.resolve()),
  setPlaybackMode: jest.fn(() => Promise.resolve()),
  getPlaybackMode: jest.fn(() => ({ kind: 'gapless' })),
  setPlaybackSpeed: jest.fn(() => Promise.resolve()),
  setPitchCorrectionMode: jest.fn(() => Promise.resolve()),
  setVolume: jest.fn(() => Promise.resolve()),
  setRepeatMode: jest.fn(() => Promise.resolve()),
  setRemoteControls: jest.fn(() => Promise.resolve()),
  getRemoteControls: jest.fn(() => ({
    skipMode: 'track',
    forwardJumpInterval: 15,
    backwardJumpInterval: 15,
  })),
  setSleepTimer: jest.fn(() => Promise.resolve()),
  setSleepTimerToTrackEnd: jest.fn(() => Promise.resolve()),
  clearSleepTimer: jest.fn(() => Promise.resolve()),
  getSleepTimer: jest.fn(() => ({ active: false, endOfTrack: false })),
  shuffleQueue: jest.fn(() => Promise.resolve({ tracks: [], currentIndex: -1 })),
  getState: jest.fn(() => 'none'),
  getCurrentTrackIndex: jest.fn(() => -1),
  getCurrentTrackSource: jest.fn(() => undefined),
  getPlaybackSpeed: jest.fn(() => 1),
  getPitchCorrectionMode: jest.fn(() => 'none'),
  getVolume: jest.fn(() => 1),
  getBufferState: jest.fn(() => 'empty'),
  getIsSeekable: jest.fn(() => true),
  isFullyBuffered: jest.fn(() => false),
  getCanSkipNext: jest.fn(() => false),
  getCanSkipPrevious: jest.fn(() => false),
  getSkipCapability: jest.fn(() => ({ canSkipNext: false, canSkipPrevious: false })),
  setBrowseSnapshot: jest.fn(),
  donateVoiceVocabulary: jest.fn(),
  setLookaheadCache: jest.fn(() => Promise.resolve()),
  getLookaheadCacheStatus: jest.fn(() => ({
    enabled: true,
    currentSizeMb: 0,
    maxSizeMb: 512,
    tracksFullyCached: 0,
    currentlyCaching: [],
  })),
  clearLookaheadCache: jest.fn(() => Promise.resolve()),
  setReplayGainMode: jest.fn(() => Promise.resolve()),
  getReplayGainMode: jest.fn(() => 'off'),
  getNowPlayingFormat: jest.fn(() => null),
  // event subscriptions (return disposers; record callbacks for __emit)
  onStateChange: makeSub('stateChange'),
  onTrackChange: makeSub('trackChange'),
  onProgress: makeSub('progress'),
  onPlaybackMilestone: makeSub('milestone'),
  onError: makeSub('error'),
  onQueueEnd: makeSub('queueEnd'),
  onGaplessGap: makeSub('gaplessGap'),
  onSkipCapabilityChange: makeSub('skipCapability'),
  onSleepTimerChange: makeSub('sleepTimer'),
  onBufferStateChange: makeSub('bufferState'),
  onFullyBufferedChange: makeSub('fullyBuffered'),
  onNowPlayingFormatChange: makeSub('nowPlayingFormat'),
  onCarConnect: makeSub('carConnect'),
  onCarDisconnect: makeSub('carDisconnect'),
  onBrowseRequest: makeSub('browse'),
  onSearchRequest: makeSub('search'),
  onPlayFromSearchRequest: makeSub('playFromSearch'),
  onPlayFromIdRequest: makeSub('playFromId'),
  onServiceReady: makeSub('serviceReady'),
  onCacheStatusChange: makeSub('cacheStatus'),
};

const cast = {
  getSupportedProtocols: jest.fn(() => ['local']),
  isCastAvailable: jest.fn(() => false),
  startDiscovery: jest.fn(() => Promise.resolve()),
  stopDiscovery: jest.fn(() => Promise.resolve()),
  connect: jest.fn(() => Promise.resolve()),
  disconnect: jest.fn(() => Promise.resolve()),
  showSystemPicker: jest.fn(() => Promise.resolve()),
  CastErrorCodes: { CONNECT_FAILED: 'cast_connect_failed', AUTH_REQUIRED: 'cast_auth_required' },
};

module.exports = {
  __esModule: true,
  getTrackPlayer: jest.fn(() => trackPlayer),
  getEqualizer: jest.fn(() => ({})),
  getVisualizer: jest.fn(() => ({})),
  getCastManager: jest.fn(() => ({})),
  Cast: cast,
  // hooks
  useProgress: () => ({ position: 0, duration: 0, buffered: 0 }),
  usePlaybackState: () => ({ state: 'none', reason: 'system' }),
  useActiveTrack: () => ({ track: undefined, index: -1, reason: 'queue-replaced' }),
  useCanSkip: () => ({ canSkipNext: false, canSkipPrevious: false }),
  useSleepTimer: () => ({ active: false, endOfTrack: false }),
  useBufferState: () => 'empty',
  useNowPlayingFormat: () => null,
  useCast: () => ({
    route: { castProtocol: 'local', name: '', receiverId: '' },
    receivers: [],
    isDiscovering: false,
    permission: 'granted',
    isAvailable: true,
  }),
  useAudioRoute: () => ({ kind: 'speaker', name: '' }),
  useLookaheadCache: () => ({
    status: trackPlayer.getLookaheadCacheStatus(),
    setConfig: trackPlayer.setLookaheadCache,
    clear: trackPlayer.clearLookaheadCache,
  }),
  // test helpers
  __trackPlayer: trackPlayer,
  __emit: (name, ...args) => {
    (listeners[name] || []).forEach((cb) => cb(...args));
  },
  __resetPlayerMock: () => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    for (const key of Object.keys(trackPlayer)) {
      if (typeof trackPlayer[key]?.mockClear === 'function') trackPlayer[key].mockClear();
    }
  },
};
