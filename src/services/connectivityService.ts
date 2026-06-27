import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { AppState, type NativeEventSubscription } from 'react-native';

import { getCertificateInfo, isSSLError } from '../../modules/expo-ssl-trust/src';
import { authStore } from '../store/authStore';
import { certPromptStore } from '../store/certPromptStore';
import { connectivityStore } from '../store/connectivityStore';
import { sslCertStore } from '../store/sslCertStore';
import { fireAndForget } from '../utils/fireAndForget';
import { getApiUnchecked } from './subsonicService';

/**
 * Higher-level services (failoverService) register hooks here at boot so
 * connectivityService can notify them at the appropriate event without
 * importing them directly. Direct imports were creating a transitive
 * chain — connectivityService → failoverService → playerService → RNTP
 * — that broke every unrelated test which touched imageCacheService.
 */
type ConnectivityHook = () => unknown;
let onServerDownHook: ConnectivityHook | null = null;

export function setServerDownHook(hook: ConnectivityHook | null): void {
  onServerDownHook = hook;
}

function invokeHook(hook: ConnectivityHook | null, tag: string): void {
  if (!hook) return;
  try {
    const result = hook();
    if (result instanceof Promise) fireAndForget(result, tag);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[connectivityService:${tag}]`, e instanceof Error ? e.message : String(e));
  }
}

const PING_INTERVAL_REACHABLE_MS = 10_000;
const PING_INTERVAL_UNREACHABLE_MS = 5_000;
const PING_TIMEOUT_MS = 5_000;
const RECONNECTED_DISPLAY_MS = 2_500;

/**
 * Require N consecutive failed pings before marking the server unreachable.
 * A single timeout — common when the server is under load from concurrent
 * cover-art / library-sync requests, or on a flaky mobile connection —
 * shouldn't flip the banner. With THRESHOLD=2 and 5s timeout + 5s
 * faster-poll-on-failure cadence, a real outage surfaces the banner in
 * ~15s, while transient single-ping failures are silently absorbed.
 */
const FAILURE_THRESHOLD = 2;

let unsubscribeNetInfo: (() => void) | null = null;
let appStateSubscription: NativeEventSubscription | null = null;
let pingTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectedTimer: ReturnType<typeof setTimeout> | null = null;
let initialCheck = true;
let pingInFlight = false;
let consecutiveFailures = 0;

// First-ping signal: lets background tasks (e.g. image-cache repair) gate
// destructive decisions on a confirmed server-reachability result rather
// than the optimistic `isServerReachable=true` default.
let firstPingCompleted = false;
let firstPingResolvers: Array<() => void> = [];

function resolveFirstPing(): void {
  if (firstPingCompleted) return;
  firstPingCompleted = true;
  const pending = firstPingResolvers;
  firstPingResolvers = [];
  for (const fn of pending) fn();
}

function drainFirstPingWaiters(): void {
  // Used when monitoring stops (e.g. user toggles into offline mode) so
  // pending awaiters unblock and can re-check store state to bail out
  // rather than hanging forever.
  const pending = firstPingResolvers;
  firstPingResolvers = [];
  for (const fn of pending) fn();
}

/**
 * Resolves when the first connectivity ping of the current monitoring
 * session has produced a result (success or error). Resolves immediately
 * if monitoring isn't active or if the first ping has already completed.
 *
 * Used by background tasks that want to act on confirmed server state,
 * not the optimistic default. Callers should re-check `connectivityStore`
 * and `offlineModeStore` after this resolves to decide whether to proceed.
 */
export function awaitFirstPing(): Promise<void> {
  if (firstPingCompleted) return Promise.resolve();
  if (!unsubscribeNetInfo) return Promise.resolve();
  return new Promise((resolve) => firstPingResolvers.push(resolve));
}

function clearPingTimer(): void {
  if (pingTimer != null) {
    clearTimeout(pingTimer);
    pingTimer = null;
  }
}

function clearReconnectedTimer(): void {
  if (reconnectedTimer != null) {
    clearTimeout(reconnectedTimer);
    reconnectedTimer = null;
  }
}

function schedulePing(): void {
  clearPingTimer();
  const { isServerReachable } = connectivityStore.getState();
  // Speed up polling as soon as we see ANY failure (not only after we've
  // flipped to unreachable). Catches transient blips faster so the
  // FAILURE_THRESHOLD debounce doesn't slow real outage detection.
  const fastPath = !isServerReachable || consecutiveFailures > 0;
  const interval = fastPath
    ? PING_INTERVAL_UNREACHABLE_MS
    : PING_INTERVAL_REACHABLE_MS;
  pingTimer = setTimeout(() => {
    pingServer();
  }, interval);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Ping timeout')), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function pingServer(): Promise<void> {
  if (pingInFlight) return;

  const api = getApiUnchecked();
  if (!api) {
    // No API yet (not logged in / no credentials). Unblock any awaitFirstPing
    // waiters so they re-check store state and bail rather than hanging forever,
    // then retry.
    resolveFirstPing();
    schedulePing();
    return;
  }

  pingInFlight = true;
  try {
    const response = await withTimeout(api.ping(), PING_TIMEOUT_MS);
    handleServerResult(response.status === 'ok');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isSSLError(message)) {
      handleSslError();
    } else {
      handleServerResult(false);
    }
  } finally {
    pingInFlight = false;
  }
}

function handleServerResult(reachable: boolean): void {
  const store = connectivityStore.getState();
  const wasReachable = store.isServerReachable;

  if (reachable) {
    consecutiveFailures = 0;
    store.setServerReachable(true);
    store.setInternetReachable(true);
    // The active server is back — drop any failover prompt (offer / both-down)
    // so it doesn't linger after recovery.
    store.clearFailoverPrompt();

    if (!wasReachable && !initialCheck) {
      // Genuine recovery from a previously-shown unreachable state.
      clearReconnectedTimer();
      store.setBannerState('reconnected');
      reconnectedTimer = setTimeout(() => {
        connectivityStore.getState().setBannerState('hidden');
      }, RECONNECTED_DISPLAY_MS);
    }
  } else {
    consecutiveFailures += 1;
    // Debounce: a single failed ping doesn't flip state or surface the
    // banner. Wait for FAILURE_THRESHOLD consecutive failures.
    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      store.setServerReachable(false);
      clearReconnectedTimer();
      store.setBannerState('unreachable');
      // Trigger auto-failover via the registered hook (failoverService).
      // Gated internally by mode + slot + secondary configured + min-dwell.
      // Manual-mode users see the unreachable banner as today; auto-mode
      // users get a transparent switch to secondary on the next event loop tick.
      invokeHook(onServerDownHook, 'failover');
    }
  }

  initialCheck = false;
  resolveFirstPing();
  schedulePing();
}

function handleSslError(): void {
  const store = connectivityStore.getState();
  // SSL errors are authoritative — surface immediately, don't debounce
  // through the FAILURE_THRESHOLD ladder.
  consecutiveFailures = FAILURE_THRESHOLD;
  store.setServerReachable(false);
  store.setBannerState('ssl-error');
  initialCheck = false;
  resolveFirstPing();
  schedulePing();
}

/**
 * Fetch the server's current certificate and show the cert prompt.
 * Called when the user taps the "Certificate changed" banner.
 */
export async function handleSslCertPrompt(): Promise<void> {
  const { serverUrl } = authStore.getState();
  if (!serverUrl) return;

  let hostname: string;
  try {
    hostname = new URL(serverUrl).hostname;
  } catch {
    return;
  }

  try {
    const certInfo = await getCertificateInfo(serverUrl);
    const isRotation = hostname in sslCertStore.getState().trustedCerts;
    certPromptStore.getState().show(certInfo, hostname, isRotation);
  } catch {
    /* Server unreachable — banner stays, user can retry */
  }
}

function handleNetInfoChange(state: NetInfoState): void {
  const reachable = state.isInternetReachable ?? true;
  connectivityStore.getState().setInternetReachable(reachable);

  // NetInfo change is a hint — trigger an immediate ping for fast response.
  // The ping result is the ground truth for server reachability.
  if (!pingInFlight) {
    clearPingTimer();
    pingServer();
  }
}

export function startMonitoring(): void {
  if (unsubscribeNetInfo) return;

  initialCheck = true;
  pingInFlight = false;
  firstPingCompleted = false;
  consecutiveFailures = 0;

  unsubscribeNetInfo = NetInfo.addEventListener(handleNetInfoChange);

  appStateSubscription = AppState.addEventListener('change', (next) => {
    if (next === 'active') {
      clearPingTimer();
      pingServer();
    }
  });
}

export function stopMonitoring(): void {
  if (unsubscribeNetInfo) {
    unsubscribeNetInfo();
    unsubscribeNetInfo = null;
  }
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
  clearPingTimer();
  clearReconnectedTimer();

  const store = connectivityStore.getState();
  store.setInternetReachable(true);
  store.setServerReachable(true);
  store.setBannerState('hidden');
  initialCheck = true;
  pingInFlight = false;
  consecutiveFailures = 0;
  // Drain any pending awaitFirstPing waiters so they can re-check state
  // and bail rather than hanging until the next monitoring session.
  drainFirstPingWaiters();
  firstPingCompleted = false;
}
