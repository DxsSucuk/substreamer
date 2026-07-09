// Configure the RNQP player before the app entry so cold-start system wakes
// (lock screen / CarPlay / assistant) find it ready. Per the RNQP setup guide
// the engine must be configured from a module, not a React effect.
//
// Wrapped in try/catch (via require) so a bootstrap-side throw during a headless
// cold-launch — CarPlay / assistant, before any phone UI scene exists — cannot
// block expo-router's root registration and brick the whole app. Mirrors the
// RNQP demo entry.
try {
  require('./src/services/playerBootstrap');
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('[index] playerBootstrap failed:', e);
}

// Register the expo-router root component. MUST run even if bootstrap threw.
require('expo-router/entry');
