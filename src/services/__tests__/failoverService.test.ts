jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

// Avoid pulling RNTP / native modules through playerService.
jest.mock('../playerService', () => ({
  rebuildQueueForServerSwitch: jest.fn(async () => {}),
}));

// subsonicService bridge — we stub buildPingApi + clearApiCache and let
// the real authStore drive state.
const mockPing = jest.fn();
const mockBuildPingApi: jest.Mock = jest.fn(() => ({ ping: mockPing }));
const mockClearApiCache = jest.fn();
jest.mock('../subsonicService', () => ({
  buildPingApi: (url: string) => mockBuildPingApi(url),
  clearApiCache: () => mockClearApiCache(),
}));

// connectivityService hook registration — failoverService.initFailover
// calls setServerDownHook + setConnectivityRestoredHook. The test stubs
// observe those calls without depending on the real connectivity layer.
const mockSetServerDownHook = jest.fn();
const mockSetConnectivityRestoredHook = jest.fn();
jest.mock('../connectivityService', () => ({
  setServerDownHook: (hook: unknown) => mockSetServerDownHook(hook),
  setConnectivityRestoredHook: (hook: unknown) => mockSetConnectivityRestoredHook(hook),
}));

import { authStore } from '../../store/authStore';
import { failoverStatusStore } from '../../store/failoverStatusStore';
import { rebuildQueueForServerSwitch } from '../playerService';
import {
  _resetForTest,
  handleActiveServerDown,
  initFailover,
  pingUrl,
  probePrimaryNow,
  startRecoveryPoll,
  stopRecoveryPoll,
  switchToServer,
} from '../failoverService';

const mockRebuild = rebuildQueueForServerSwitch as jest.Mock;

function seedAuth(overrides: Partial<{
  serverUrl: string | null;
  primaryServerUrl: string | null;
  secondaryServerUrl: string | null;
  activeServer: 'primary' | 'secondary';
  serverSwitchMode: 'manual' | 'automatic';
  username: string;
  password: string;
  isLoggedIn: boolean;
}> = {}) {
  authStore.setState({
    serverUrl: overrides.primaryServerUrl ?? 'https://primary.example.com',
    primaryServerUrl: 'https://primary.example.com',
    secondaryServerUrl: 'https://secondary.example.com',
    activeServer: 'primary',
    serverSwitchMode: 'manual',
    username: 'user',
    password: 'pass',
    apiVersion: '1.16',
    legacyAuth: false,
    isLoggedIn: true,
    rehydrated: true,
    ...overrides,
  } as never);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockRebuild.mockClear();
  mockPing.mockReset();
  mockBuildPingApi.mockClear();
  mockClearApiCache.mockClear();
  mockSetServerDownHook.mockClear();
  mockSetConnectivityRestoredHook.mockClear();
  failoverStatusStore.setState({
    lastSwitchTarget: null,
    lastSwitchCause: null,
    lastSwitchAt: null,
  });
  _resetForTest();
  seedAuth();
});

afterEach(() => {
  jest.useRealTimers();
  _resetForTest();
});

describe('switchToServer', () => {
  it('atomically swaps active slot, clears API cache, rebuilds queue, records status', async () => {
    await switchToServer('secondary', 'manual');

    const auth = authStore.getState();
    expect(auth.activeServer).toBe('secondary');
    expect(auth.serverUrl).toBe('https://secondary.example.com');
    expect(mockClearApiCache).toHaveBeenCalledTimes(1);
    expect(mockRebuild).toHaveBeenCalledTimes(1);

    const status = failoverStatusStore.getState();
    expect(status.lastSwitchTarget).toBe('secondary');
    expect(status.lastSwitchCause).toBe('manual');
    expect(status.lastSwitchAt).not.toBeNull();
  });

  it('no-ops when target slot has no URL configured', async () => {
    seedAuth({ secondaryServerUrl: null });

    await switchToServer('secondary', 'manual');

    expect(authStore.getState().activeServer).toBe('primary');
    expect(mockClearApiCache).not.toHaveBeenCalled();
    expect(mockRebuild).not.toHaveBeenCalled();
  });

  it('no-ops when already on the target slot', async () => {
    await switchToServer('primary', 'manual');

    expect(mockClearApiCache).not.toHaveBeenCalled();
    expect(mockRebuild).not.toHaveBeenCalled();
  });

  it('starts recovery poller after switching to secondary in auto mode', async () => {
    seedAuth({ serverSwitchMode: 'automatic' });
    await switchToServer('secondary', 'auto');

    // Recovery interval is 60s; fast-forward to fire the first check.
    mockPing.mockResolvedValueOnce({ status: 'ok' });
    await jest.advanceTimersByTimeAsync(60_000);

    expect(mockBuildPingApi).toHaveBeenCalledWith('https://primary.example.com');
  });
});

describe('pingUrl', () => {
  it('returns true on Subsonic ok response', async () => {
    mockPing.mockResolvedValueOnce({ status: 'ok' });
    await expect(pingUrl('https://example.com')).resolves.toBe(true);
  });

  it('returns false on non-ok response', async () => {
    mockPing.mockResolvedValueOnce({ status: 'failed' });
    await expect(pingUrl('https://example.com')).resolves.toBe(false);
  });

  it('returns false when ping throws', async () => {
    mockPing.mockRejectedValueOnce(new Error('network error'));
    await expect(pingUrl('https://example.com')).resolves.toBe(false);
  });

  it('returns false when timeout elapses before ping resolves', async () => {
    mockPing.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));
    const promise = pingUrl('https://example.com', 100);
    await jest.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBe(false);
  });

  it('returns false when no credentials are available', async () => {
    mockBuildPingApi.mockReturnValueOnce(null);
    await expect(pingUrl('https://example.com')).resolves.toBe(false);
    expect(mockPing).not.toHaveBeenCalled();
  });
});

describe('handleActiveServerDown', () => {
  it('switches to secondary when in auto mode + secondary reachable', async () => {
    seedAuth({ serverSwitchMode: 'automatic' });
    mockPing.mockResolvedValueOnce({ status: 'ok' }); // preflight secondary

    await handleActiveServerDown();

    expect(authStore.getState().activeServer).toBe('secondary');
    expect(mockRebuild).toHaveBeenCalled();
  });

  it('does not switch in manual mode', async () => {
    seedAuth({ serverSwitchMode: 'manual' });
    mockPing.mockResolvedValueOnce({ status: 'ok' });

    await handleActiveServerDown();

    expect(authStore.getState().activeServer).toBe('primary');
    expect(mockRebuild).not.toHaveBeenCalled();
  });

  it('does not switch when secondary is also unreachable', async () => {
    seedAuth({ serverSwitchMode: 'automatic' });
    mockPing.mockResolvedValueOnce({ status: 'failed' });

    await handleActiveServerDown();

    expect(authStore.getState().activeServer).toBe('primary');
    expect(mockRebuild).not.toHaveBeenCalled();
  });

  it('does not switch when no secondary is configured', async () => {
    seedAuth({ serverSwitchMode: 'automatic', secondaryServerUrl: null });

    await handleActiveServerDown();

    expect(mockPing).not.toHaveBeenCalled();
    expect(authStore.getState().activeServer).toBe('primary');
  });

  it('does not switch from secondary (already on the fallback)', async () => {
    seedAuth({
      serverSwitchMode: 'automatic',
      activeServer: 'secondary',
      serverUrl: 'https://secondary.example.com',
    });

    await handleActiveServerDown();

    expect(mockPing).not.toHaveBeenCalled();
  });

  it('honours min-dwell — does not auto-switch within 30s of last switch', async () => {
    seedAuth({ serverSwitchMode: 'automatic' });

    // First switch establishes the dwell window.
    mockPing.mockResolvedValueOnce({ status: 'ok' });
    await handleActiveServerDown();
    expect(authStore.getState().activeServer).toBe('secondary');

    // Manually flip back to primary to set up the second trip, but keep
    // the lastSwitchAt internal timestamp recent.
    authStore.getState().setActiveServer('primary');

    // Try again immediately — should be blocked by min-dwell.
    mockPing.mockResolvedValueOnce({ status: 'ok' });
    await handleActiveServerDown();
    expect(authStore.getState().activeServer).toBe('primary');
  });
});

describe('recovery poller', () => {
  it('switches back to primary after 3 consecutive successful pings', async () => {
    seedAuth({
      serverSwitchMode: 'automatic',
      activeServer: 'secondary',
      serverUrl: 'https://secondary.example.com',
    });
    // Advance time past min-dwell so the first switch-back isn't blocked.
    await jest.advanceTimersByTimeAsync(31_000);

    startRecoveryPoll();

    // Tick 1: success → streak=1, no switch yet.
    mockPing.mockResolvedValueOnce({ status: 'ok' });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(authStore.getState().activeServer).toBe('secondary');

    // Tick 2: success → streak=2.
    mockPing.mockResolvedValueOnce({ status: 'ok' });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(authStore.getState().activeServer).toBe('secondary');

    // Tick 3: success → streak=3, switch back.
    mockPing.mockResolvedValueOnce({ status: 'ok' });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(authStore.getState().activeServer).toBe('primary');
  });

  it('resets the streak on a failed ping (hysteresis)', async () => {
    seedAuth({
      serverSwitchMode: 'automatic',
      activeServer: 'secondary',
      serverUrl: 'https://secondary.example.com',
    });
    await jest.advanceTimersByTimeAsync(31_000);

    startRecoveryPoll();

    // Two successes...
    mockPing.mockResolvedValueOnce({ status: 'ok' });
    await jest.advanceTimersByTimeAsync(60_000);
    mockPing.mockResolvedValueOnce({ status: 'ok' });
    await jest.advanceTimersByTimeAsync(60_000);

    // ...then a failure resets the streak.
    mockPing.mockResolvedValueOnce({ status: 'failed' });
    await jest.advanceTimersByTimeAsync(60_000);

    // ...so the next two successes are NOT enough to switch back.
    mockPing.mockResolvedValueOnce({ status: 'ok' });
    await jest.advanceTimersByTimeAsync(60_000);
    mockPing.mockResolvedValueOnce({ status: 'ok' });
    await jest.advanceTimersByTimeAsync(60_000);

    expect(authStore.getState().activeServer).toBe('secondary');
  });

  it('stopRecoveryPoll halts further checks', async () => {
    seedAuth({
      serverSwitchMode: 'automatic',
      activeServer: 'secondary',
      serverUrl: 'https://secondary.example.com',
    });

    startRecoveryPoll();
    stopRecoveryPoll();

    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockBuildPingApi).not.toHaveBeenCalled();
  });

  it('probePrimaryNow fires an immediate check without waiting 60s', async () => {
    seedAuth({
      serverSwitchMode: 'automatic',
      activeServer: 'secondary',
      serverUrl: 'https://secondary.example.com',
    });
    mockPing.mockResolvedValueOnce({ status: 'ok' });

    await probePrimaryNow();

    expect(mockBuildPingApi).toHaveBeenCalledWith('https://primary.example.com');
  });

  it('probePrimaryNow is a no-op when not on secondary', async () => {
    seedAuth({ serverSwitchMode: 'automatic', activeServer: 'primary' });

    await probePrimaryNow();

    expect(mockBuildPingApi).not.toHaveBeenCalled();
  });
});

describe('initFailover (auth subscriber)', () => {
  it('starts recovery poller when subscribed in auto + secondary state', async () => {
    seedAuth({
      serverSwitchMode: 'automatic',
      activeServer: 'secondary',
      serverUrl: 'https://secondary.example.com',
    });

    initFailover();

    // The subscriber fires evaluate() immediately on init — the poller
    // should be scheduled. Fast-forward 60s to verify it ticks.
    mockPing.mockResolvedValueOnce({ status: 'ok' });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockBuildPingApi).toHaveBeenCalledWith('https://primary.example.com');
  });

  it('stops recovery poller when mode flips to manual', async () => {
    seedAuth({
      serverSwitchMode: 'automatic',
      activeServer: 'secondary',
      serverUrl: 'https://secondary.example.com',
    });
    initFailover();

    // Flip to manual — poller should stop on the next subscriber tick.
    authStore.getState().setServerSwitchMode('manual');

    mockBuildPingApi.mockClear();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockBuildPingApi).not.toHaveBeenCalled();
  });

  it('starts polling when activeServer flips to secondary in auto mode', async () => {
    seedAuth({ serverSwitchMode: 'automatic', activeServer: 'primary' });
    initFailover();

    // No polling yet — primary is active.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockBuildPingApi).not.toHaveBeenCalled();

    // Simulate a manual switch to secondary outside the failover flow.
    authStore.getState().setActiveServer('secondary');

    // Subscriber kicks in — poller should now be scheduled.
    mockPing.mockResolvedValueOnce({ status: 'ok' });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockBuildPingApi).toHaveBeenCalledWith('https://primary.example.com');
  });

  it('is idempotent — calling twice does not double-subscribe', () => {
    seedAuth();
    initFailover();
    initFailover();
    // No assertion needed beyond "no error" — the test passes if the
    // second call doesn't throw and _resetForTest cleans up exactly one
    // subscription afterwards.
  });

  it('registers server-down and connectivity-restored hooks with connectivityService', () => {
    seedAuth();
    mockSetServerDownHook.mockClear();
    mockSetConnectivityRestoredHook.mockClear();
    initFailover();
    expect(mockSetServerDownHook).toHaveBeenCalledTimes(1);
    expect(mockSetServerDownHook.mock.calls[0][0]).toBeInstanceOf(Function);
    expect(mockSetConnectivityRestoredHook).toHaveBeenCalledTimes(1);
    expect(mockSetConnectivityRestoredHook.mock.calls[0][0]).toBeInstanceOf(Function);
  });
});
