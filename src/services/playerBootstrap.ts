/**
 * Player bootstrap — configures the RNQP engine ONCE, at module load, before
 * the app UI mounts. Imported from `index.js` ahead of the expo-router entry so
 * the player is ready on every launch path, including cold-start system wakes
 * (lock screen, CarPlay, assistant) that can run JS before any screen mounts.
 *
 * Per the RNQP setup guide, `configure()` must run from a module — NOT a React
 * effect. Event-listener wiring, remote-control options, sleep-timer bridging
 * and the deferred queue restore stay in `initPlayer()` / boot effects, which
 * run once the UI boots (the engine is already configured by then).
 *
 * Subsonic stream URLs are self-authenticating (auth is in the query string, and
 * on iOS they route through the loopback SSL proxy), so no `httpHeaders` are
 * needed — only the shipped User-Agent.
 */
import { getTrackPlayer } from 'react-native-queue-player';

import { errMessage } from '../utils/errorMessage';
import { LOOKAHEAD_MAX_CACHE_MB } from '../store/playbackSettingsStore';

// The lookahead-cache disk budget AND eviction policy are fixed here at
// configure() — Android's Media3 SimpleCache is built at the right size (it
// can't resize live), and eviction is a configure-time property (changing it
// clears + rebuilds the cache). Enable + track count are then applied live via
// playerService.applyLookaheadCacheConfig().
void getTrackPlayer()
  .configure({
    audioContentType: 'music',
    userAgent: 'substreamer8',
    autoRetries: 3,
    lookaheadCacheMaxSizeMb: LOOKAHEAD_MAX_CACHE_MB,
    // LRU keeps the most-recently-played tracks (best for a client where users
    // re-listen). RNQP's default is already 'lru'; pinned here for clarity.
    lookaheadCacheEvictionPolicy: 'lru',
    // Progress fan-out: 500ms foreground; near-paused (10s) while backgrounded so
    // the off-screen progress firehose (and its re-render loop) is throttled
    // natively. Native re-emits immediately on foreground so the UI resumes live.
    progressUpdateIntervalMs: 500,
    backgroundProgressUpdateIntervalMs: 10000,
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.warn('[playerBootstrap] configure failed:', errMessage(e));
  });
