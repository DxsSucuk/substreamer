/**
 * Schedule low-priority work for an idle window.
 *
 * `requestIdleCallback` is the framework-canonical deferral primitive on the
 * React Native New Architecture — `InteractionManager` was deprecated in 0.84
 * explicitly in its favour, and it schedules into the event-loop's idle period
 * (not the render/frame loop, so it is NOT subject to the rAF "never fires when
 * no render is in flight" stall).
 *
 * Two safety measures bake in the project's hard-won lessons:
 *  - a guaranteed-fire `timeout` so the callback can't be starved indefinitely
 *    under sustained load (mirrors the defensive `setTimeout` net we use
 *    elsewhere); and
 *  - a `setTimeout` fallback for environments where `requestIdleCallback` is
 *    absent (jest/Node), so callers don't each have to polyfill it.
 *
 * Returns a cancel function for callers that need to abort on unmount; pure
 * fire-and-forget callers can ignore it.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 2000;

export function runWhenIdle(
  fn: () => void | Promise<void>,
  options?: { timeout?: number },
): () => void {
  const timeout = options?.timeout ?? DEFAULT_IDLE_TIMEOUT_MS;

  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(() => { void fn(); }, { timeout });
    return () => {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(id);
    };
  }

  // No requestIdleCallback (e.g. jest): run on the next tick so behaviour and
  // cancellation still work; the idle distinction is moot off-device.
  const id = setTimeout(() => { void fn(); }, 0);
  return () => clearTimeout(id);
}
