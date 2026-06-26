jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

// Avoid pulling RNTP / native modules through playerService.
jest.mock('../playerService', () => ({
  rebuildQueueForServerSwitch: jest.fn(async () => {}),
}));

// subsonicService bridge — stub buildPingApi + clearApiCache + ensureCoverArtAuth
// and let the real authStore drive state.
const mockPing = jest.fn();
const mockBuildPingApi: jest.Mock = jest.fn(() => ({ ping: mockPing }));
const mockClearApiCache = jest.fn();
const mockEnsureCoverArtAuth = jest.fn(async () => {});
jest.mock('../subsonicService', () => ({
  buildPingApi: (url: string) => mockBuildPingApi(url),
  clearApiCache: () => mockClearApiCache(),
  ensureCoverArtAuth: () => mockEnsureCoverArtAuth(),
}));

// imageCacheService — switchToServer pokes the image layer to retry.
const mockRetryRemoteImages = jest.fn();
jest.mock('../imageCacheService', () => ({
  retryRemoteImagesForServerSwitch: () => mockRetryRemoteImages(),
}));

// connectivityService hook registration — initFailover registers the server-down
// hook. Stub it so the test doesn't depend on the real connectivity layer.
const mockSetServerDownHook = jest.fn();
jest.mock('../connectivityService', () => ({
  setServerDownHook: (hook: unknown) => mockSetServerDownHook(hook),
}));

import { authStore } from '../../store/authStore';
import { connectivityStore } from '../../store/connectivityStore';
import { rebuildQueueForServerSwitch } from '../playerService';
import {
  _resetForTest,
  evaluateServerDownPrompt,
  initFailover,
  pingUrl,
  switchToServer,
} from '../failoverService';

const mockRebuild = rebuildQueueForServerSwitch as jest.Mock;

function seedAuth(overrides: Partial<{
  serverUrl: string | null;
  primaryServerUrl: string | null;
  secondaryServerUrl: string | null;
  activeServer: 'primary' | 'secondary';
  username: string;
  password: string;
  isLoggedIn: boolean;
}> = {}) {
  authStore.setState({
    serverUrl: overrides.primaryServerUrl ?? 'https://primary.example.com',
    primaryServerUrl: 'https://primary.example.com',
    secondaryServerUrl: 'https://secondary.example.com',
    activeServer: 'primary',
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
  mockEnsureCoverArtAuth.mockClear();
  mockRetryRemoteImages.mockClear();
  mockSetServerDownHook.mockClear();
  connectivityStore.getState().clearFailoverPrompt();
  _resetForTest();
  seedAuth();
});

afterEach(() => {
  jest.useRealTimers();
  _resetForTest();
});

describe('switchToServer', () => {
  it('swaps active slot, clears API cache, re-auths, rebuilds queue, retries images, clears the offer', async () => {
    connectivityStore.getState().setFailoverPrompt('secondary');

    await switchToServer('secondary');

    const auth = authStore.getState();
    expect(auth.activeServer).toBe('secondary');
    expect(auth.serverUrl).toBe('https://secondary.example.com');
    expect(mockClearApiCache).toHaveBeenCalledTimes(1);
    expect(mockEnsureCoverArtAuth).toHaveBeenCalledTimes(1);
    expect(mockRebuild).toHaveBeenCalledTimes(1);
    expect(mockRetryRemoteImages).toHaveBeenCalledTimes(1);
    // The offer is satisfied — it's cleared.
    expect(connectivityStore.getState().failoverPrompt).toBeNull();
  });

  it('no-ops when target slot has no URL configured', async () => {
    seedAuth({ secondaryServerUrl: null });

    await switchToServer('secondary');

    expect(authStore.getState().activeServer).toBe('primary');
    expect(mockClearApiCache).not.toHaveBeenCalled();
    expect(mockRebuild).not.toHaveBeenCalled();
  });

  it('no-ops when already on the target slot (but clears any stale offer)', async () => {
    connectivityStore.getState().setFailoverPrompt('secondary');

    await switchToServer('primary');

    expect(mockClearApiCache).not.toHaveBeenCalled();
    expect(mockRebuild).not.toHaveBeenCalled();
    expect(connectivityStore.getState().failoverPrompt).toBeNull();
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

describe('evaluateServerDownPrompt (detect, never switch)', () => {
  it('offers the secondary when on primary and secondary is reachable', async () => {
    mockPing.mockResolvedValueOnce({ status: 'ok' }); // secondary preflight

    await evaluateServerDownPrompt();

    expect(mockBuildPingApi).toHaveBeenCalledWith('https://secondary.example.com');
    expect(connectivityStore.getState().failoverPrompt).toBe('secondary');
    // Detect-only — never switches on its own.
    expect(authStore.getState().activeServer).toBe('primary');
    expect(mockRebuild).not.toHaveBeenCalled();
  });

  it('offers the primary when on secondary and primary is reachable', async () => {
    seedAuth({ activeServer: 'secondary', serverUrl: 'https://secondary.example.com' });
    mockPing.mockResolvedValueOnce({ status: 'ok' });

    await evaluateServerDownPrompt();

    expect(mockBuildPingApi).toHaveBeenCalledWith('https://primary.example.com');
    expect(connectivityStore.getState().failoverPrompt).toBe('primary');
    expect(authStore.getState().activeServer).toBe('secondary');
  });

  it('sets both-down when the other server is also unreachable', async () => {
    mockPing.mockResolvedValueOnce({ status: 'failed' });

    await evaluateServerDownPrompt();

    expect(connectivityStore.getState().failoverPrompt).toBe('both-down');
  });

  it('clears the prompt when no other server is configured (single server)', async () => {
    seedAuth({ secondaryServerUrl: null });
    connectivityStore.getState().setFailoverPrompt('secondary'); // stale

    await evaluateServerDownPrompt();

    expect(mockPing).not.toHaveBeenCalled();
    expect(connectivityStore.getState().failoverPrompt).toBeNull();
  });
});

describe('initFailover', () => {
  it('registers the server-down hook with connectivityService', () => {
    mockSetServerDownHook.mockClear();
    initFailover();
    expect(mockSetServerDownHook).toHaveBeenCalledTimes(1);
    expect(mockSetServerDownHook.mock.calls[0][0]).toBeInstanceOf(Function);
  });
});
