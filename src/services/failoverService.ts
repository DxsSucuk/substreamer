/**
 * Primary / secondary server failover.
 *
 * Three public surfaces:
 *
 *   - `switchToServer(target, cause)` — atomic swap of the active slot.
 *     Used by both manual (user tap) and automatic (connectivity-driven)
 *     paths. Mirrors `applyServerUrlChange()`'s orchestration with one
 *     deliberate omission: serverInfoStore is NOT cleared because
 *     primary and secondary serve the same Subsonic instance through
 *     different URLs — capabilities, server type, and version are
 *     identical. (Same simplification applies to the existing
 *     URL-change flow now that the model is "same server, different
 *     address".)
 *
 *   - `pingUrl(url, timeoutMs)` — one-shot reachability against an
 *     arbitrary URL using current credentials. Used as a preflight
 *     before auto-failover ("is secondary actually up?") and as the
 *     recovery poller's heartbeat ("has primary come back yet?").
 *
 *   - `handleActiveServerDown()` — hook for connectivityService at the
 *     2-fail threshold. Decides whether to attempt failover.
 *
 * Plus lifecycle for the recovery poller (start/stop). When on secondary
 * in automatic mode, we ping primary every 60s; three consecutive
 * successes plus a 30s min-dwell since the last switch trigger a
 * switch back. Asymmetric thresholds (2-fail-down vs 3-success-up) +
 * min-dwell = hysteresis to prevent flapping.
 *
 * Phase 6 of the plan wires this into connectivityService. Phase 7
 * adds the banner UI driven by `failoverStatusStore`.
 */

import { authStore, type ServerSlot } from '../store/authStore';
import { failoverStatusStore, type SwitchCause } from '../store/failoverStatusStore';
import { setConnectivityRestoredHook, setServerDownHook } from './connectivityService';
import { retryRemoteImagesForServerSwitch } from './imageCacheService';
import { rebuildQueueForServerSwitch } from './playerService';
import { buildPingApi, clearApiCache, ensureCoverArtAuth } from './subsonicService';
import { withTimeout } from '../utils/withTimeout';

const PING_TIMEOUT_MS = 5_000;
const RECOVERY_POLL_INTERVAL_MS = 60_000;
const RECOVERY_SUCCESS_THRESHOLD = 3;
const MIN_DWELL_MS = 30_000;

let primarySuccessStreak = 0;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let lastSwitchAt = 0;
let switchInFlight = false;
/** Latest switch intent that arrived while a switch was in flight (replayed
 *  on completion so the newest failover decision isn't dropped). */
let pendingSwitch: { target: ServerSlot; cause: SwitchCause } | null = null;

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Atomically swap the active server slot.
 *
 * No-op when:
 *   - target slot has no URL configured
 *   - already on the target slot
 *   - another switch is in flight (re-entrancy guard)
 */
export async function switchToServer(
  target: ServerSlot,
  cause: SwitchCause,
): Promise<void> {
  if (switchInFlight) {
    // A switch is already running. Record the latest intent (newest wins) so it
    // isn't silently dropped — the in-flight switch replays it on completion.
    pendingSwitch = { target, cause };
    return;
  }
  const auth = authStore.getState();
  if (auth.activeServer === target) return;
  const targetUrl =
    target === 'primary' ? auth.primaryServerUrl : auth.secondaryServerUrl;
  if (!targetUrl) return;

  switchInFlight = true;
  try {
    // 1. Auth swap — every future getStreamUrl / getCoverArtUrl reads
    //    the new URL. setActiveServer is the single source of truth for
    //    the activeServer + serverUrl invariant.
    auth.setActiveServer(target);

    // 2. Drop the cached SubsonicAPI instance (keyed by URL). Capabilities
    //    are NOT cleared — same server, same caps.
    clearApiCache();

    // 2b. Re-establish the cover-art auth token against the new server — step 2
    //     nulled it, and both the queue rebuild and the image retry below need a
    //     valid token to produce working getStreamUrl / getCoverArtUrl results.
    await ensureCoverArtAuth();

    // 3. Rebuild the RNTP queue against the new base. Brief audio pause.
    await rebuildQueueForServerSwitch();

    // 3b. Tell the image layer to retry: a switch doesn't flip offlineMode or
    //     isServerReachable, so mounted CachedImages that failed against the old
    //     server won't re-attempt on their own. Clears remote-failed markers and
    //     re-notifies them so covers reload without needing a list-row recycle.
    retryRemoteImagesForServerSwitch();

    // 4. Record the switch for the UI banner.
    failoverStatusStore.getState().recordSwitch(target, cause);
    lastSwitchAt = Date.now();

    // 5. Reset recovery state — we're now on the target slot.
    primarySuccessStreak = 0;
    if (target === 'secondary' && auth.serverSwitchMode === 'automatic') {
      startRecoveryPoll();
    } else {
      stopRecoveryPoll();
    }
  } catch (e) {
    // Best-effort orchestration: the active-slot swap (step 1) has already
    // taken effect, so a failure in any later step (re-auth, queue rebuild,
    // image retry, status record) must NOT reject and crash the caller — the
    // 60s recovery poller, a manual switch tap, or auto-failover. Log and
    // continue; the user can retry, and the next poll re-evaluates.
    console.warn(
      '[failover] switchToServer step failed:',
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    switchInFlight = false;
    // Replay the newest intent that arrived mid-switch, if it still differs from
    // where we landed.
    const next = pendingSwitch;
    pendingSwitch = null;
    if (next && authStore.getState().activeServer !== next.target) {
      void switchToServer(next.target, next.cause);
    }
  }
}

/**
 * One-shot reachability check against an arbitrary URL using the
 * current auth credentials. Returns `true` on a successful ping
 * (Subsonic response `status === 'ok'`), `false` on timeout / network
 * error / auth failure / non-ok response.
 *
 * Does NOT touch the cached API client — the cache is keyed by the
 * ACTIVE URL and would thrash if we used it cross-URL.
 */
export async function pingUrl(
  url: string,
  timeoutMs: number = PING_TIMEOUT_MS,
): Promise<boolean> {
  const api = buildPingApi(url);
  if (!api) return false;
  try {
    const response = await withTimeout(() => api.ping(), timeoutMs);
    if (response === 'timeout') return false;
    return response.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Called by connectivityService when active-URL pings hit the 2-fail
 * threshold. Attempts auto-failover when:
 *   - serverSwitchMode === 'automatic'
 *   - secondary URL is configured
 *   - currently on primary (the unreachable one)
 *   - secondary itself responds to a preflight ping
 *
 * Manual mode is intentionally hands-off — the user has to tap the
 * Switch button themselves. We don't second-guess that choice.
 */
export async function handleActiveServerDown(): Promise<void> {
  const auth = authStore.getState();
  if (auth.serverSwitchMode !== 'automatic') return;
  if (auth.activeServer !== 'primary') return;
  if (!auth.secondaryServerUrl) return;
  if (Date.now() - lastSwitchAt < MIN_DWELL_MS) return;

  const secondaryUp = await pingUrl(auth.secondaryServerUrl);
  if (!secondaryUp) return;

  await switchToServer('secondary', 'auto');
}

/* ------------------------------------------------------------------ */
/*  Recovery poller (active on secondary + auto mode)                   */
/* ------------------------------------------------------------------ */

/**
 * Start the background poll that checks for primary coming back. Idempotent
 * — calling while already polling is a no-op. Stops automatically when
 * the switch-back happens or when the user flips mode to manual.
 */
export function startRecoveryPoll(): void {
  if (recoveryTimer != null) return;
  primarySuccessStreak = 0;
  scheduleRecoveryPoll();
}

export function stopRecoveryPoll(): void {
  if (recoveryTimer != null) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  primarySuccessStreak = 0;
}

/**
 * Subscribe to authStore for the recovery-poller lifecycle. Idempotent;
 * calling more than once is a no-op (the previous subscription stays).
 *
 * Should-poll truth table:
 *   - activeServer === 'secondary' AND mode === 'automatic' AND primary URL exists
 *     → poll
 *   - anything else → stop
 *
 * Driven by store mutations (mode toggle in Settings → Connectivity,
 * switchToServer outcomes, primary URL changes via login) so the
 * poller's state always reflects the latest auth state without an
 * explicit lifecycle call from every consumer.
 */
let authUnsubscribe: (() => void) | null = null;
let didCheckInitialState = false;

export function initFailover(): void {
  if (authUnsubscribe != null) return;

  const evaluate = () => {
    const auth = authStore.getState();
    const shouldPoll =
      auth.activeServer === 'secondary' &&
      auth.serverSwitchMode === 'automatic' &&
      auth.primaryServerUrl != null;
    if (shouldPoll) {
      startRecoveryPoll();
    } else {
      stopRecoveryPoll();
    }
  };

  authUnsubscribe = authStore.subscribe(evaluate);

  // Register hooks with connectivityService so it can notify us at the
  // 2-fail threshold (failover trigger) and on connectivity-restored
  // events (eager primary probe). Inverting this dependency keeps
  // connectivityService free of any RNTP-touching imports — tests that
  // transitively reach connectivityService no longer need to mock the
  // native player module.
  setServerDownHook(handleActiveServerDown);
  setConnectivityRestoredHook(probePrimaryNow);

  // Resume the poller on cold start when the persisted auth state already
  // wants it (user was on secondary + auto mode at last app close — the
  // boot reset in onRehydrateStorage forces back to primary for auto
  // mode, so in practice this kicks in for the rarer manual-mode-then-
  // toggled-back-to-auto-via-rehydration case).
  if (!didCheckInitialState) {
    didCheckInitialState = true;
    evaluate();
  }
}

/**
 * Eagerly probe primary on user-facing wake-ups (AppState→active,
 * connectivity restored) without waiting for the next 60s tick. Safe
 * to call even when not on secondary — it bails on the mode/slot check.
 */
export async function probePrimaryNow(): Promise<void> {
  const auth = authStore.getState();
  if (auth.activeServer !== 'secondary') return;
  if (auth.serverSwitchMode !== 'automatic') return;
  if (!auth.primaryServerUrl) return;
  await runRecoveryCheck();
}

/* ------------------------------------------------------------------ */
/*  Test seam — reset all module state between test cases.             */
/* ------------------------------------------------------------------ */

export function _resetForTest(): void {
  stopRecoveryPoll();
  lastSwitchAt = 0;
  switchInFlight = false;
  if (authUnsubscribe != null) {
    authUnsubscribe();
    authUnsubscribe = null;
  }
  didCheckInitialState = false;
  setServerDownHook(null);
  setConnectivityRestoredHook(null);
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

function scheduleRecoveryPoll(): void {
  if (recoveryTimer != null) clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    runRecoveryCheck().finally(() => {
      // Re-schedule only if we're still in the recovery state. If
      // runRecoveryCheck triggered a switch back to primary, that
      // already called stopRecoveryPoll.
      const auth = authStore.getState();
      if (
        auth.activeServer === 'secondary' &&
        auth.serverSwitchMode === 'automatic' &&
        auth.primaryServerUrl
      ) {
        scheduleRecoveryPoll();
      }
    });
  }, RECOVERY_POLL_INTERVAL_MS);
}

async function runRecoveryCheck(): Promise<void> {
  const auth = authStore.getState();
  if (!auth.primaryServerUrl) return;
  const ok = await pingUrl(auth.primaryServerUrl);
  if (!ok) {
    primarySuccessStreak = 0;
    return;
  }
  primarySuccessStreak += 1;
  if (primarySuccessStreak < RECOVERY_SUCCESS_THRESHOLD) return;
  if (Date.now() - lastSwitchAt < MIN_DWELL_MS) return;
  await switchToServer('primary', 'auto');
}

