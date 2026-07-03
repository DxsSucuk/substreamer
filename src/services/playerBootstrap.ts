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

void getTrackPlayer()
  .configure({
    audioContentType: 'music',
    userAgent: 'substreamer8',
    autoRetries: 3,
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.warn('[playerBootstrap] configure failed:', errMessage(e));
  });
