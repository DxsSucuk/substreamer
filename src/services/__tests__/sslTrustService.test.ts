// Native module mock (expo-ssl-trust). The native store is the single source
// of truth; the service reads/writes it and mirrors into sslCertStore.
const mockInitTrustStore = jest.fn();
const mockNativeTrustCertificate = jest.fn();
const mockNativeRemoveTrustedCertificate = jest.fn();
const mockNativeClearAll = jest.fn();
const mockNativeGetTrustedCertificates = jest.fn();
const mockRefreshProxyUpstreams = jest.fn();
const mockRefreshProxyInfo = jest.fn();

jest.mock('../../../modules/expo-ssl-trust/src', () => ({
  initTrustStore: mockInitTrustStore,
  trustCertificate: mockNativeTrustCertificate,
  removeTrustedCertificate: mockNativeRemoveTrustedCertificate,
  clearAllTrustedCertificates: mockNativeClearAll,
  getTrustedCertificates: mockNativeGetTrustedCertificates,
  refreshProxyUpstreams: mockRefreshProxyUpstreams,
  refreshProxyInfo: mockRefreshProxyInfo,
}));

// sslCertStore is a non-persisted mirror. The mock setter updates the local
// snapshot so the service's "any certs?" check reads what was just mirrored.
let mockTrustedCerts: Record<string, { sha256: string; acceptedAt: number; validTo?: string }> = {};
const mockSetTrustedCerts = jest.fn((certs) => {
  mockTrustedCerts = certs;
});

jest.mock('../../store/sslCertStore', () => ({
  sslCertStore: {
    getState: jest.fn(() => ({
      trustedCerts: mockTrustedCerts,
      setTrustedCerts: mockSetTrustedCerts,
    })),
  },
}));

jest.mock('../../store/authStore', () => ({
  authStore: {
    getState: jest.fn(() => ({
      serverUrl: null,
      primaryServerUrl: null,
      secondaryServerUrl: null,
    })),
  },
}));

beforeEach(() => {
  mockInitTrustStore.mockReset().mockResolvedValue({ installed: true, error: null });
  mockNativeTrustCertificate.mockReset().mockResolvedValue(undefined);
  mockNativeRemoveTrustedCertificate.mockReset().mockResolvedValue(undefined);
  mockNativeClearAll.mockReset().mockResolvedValue(undefined);
  mockNativeGetTrustedCertificates.mockReset().mockResolvedValue([]);
  mockRefreshProxyUpstreams.mockReset().mockResolvedValue(null);
  mockRefreshProxyInfo.mockReset().mockResolvedValue(undefined);
  mockSetTrustedCerts.mockClear();
  mockTrustedCerts = {};
});

function loadFreshService() {
  jest.resetModules();
  return require('../sslTrustService') as typeof import('../sslTrustService');
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('initSslTrustStore', () => {
  it('mirrors the native store and does NOT install when there are no certs', async () => {
    mockNativeGetTrustedCertificates.mockResolvedValue([]);
    const { initSslTrustStore } = loadFreshService();
    initSslTrustStore();
    await flush();

    expect(mockNativeGetTrustedCertificates).toHaveBeenCalled();
    expect(mockSetTrustedCerts).toHaveBeenCalledWith({});
    expect(mockInitTrustStore).not.toHaveBeenCalled();
  });

  it('mirrors native certs and installs the trust manager when certs exist', async () => {
    mockNativeGetTrustedCertificates.mockResolvedValue([
      { hostname: 'example.com', sha256Fingerprint: 'AA:BB', acceptedAt: 1000, validTo: null },
    ]);

    const { initSslTrustStore } = loadFreshService();
    initSslTrustStore();
    await flush();

    expect(mockSetTrustedCerts).toHaveBeenCalledWith({
      'example.com': { sha256: 'AA:BB', acceptedAt: 1000 },
    });
    expect(mockInitTrustStore).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on repeated calls', async () => {
    mockNativeGetTrustedCertificates.mockResolvedValue([
      { hostname: 'example.com', sha256Fingerprint: 'AA:BB', acceptedAt: 1000 },
    ]);
    const { initSslTrustStore } = loadFreshService();
    initSslTrustStore();
    initSslTrustStore();
    initSslTrustStore();
    await flush();

    expect(mockInitTrustStore).toHaveBeenCalledTimes(1);
  });
});

describe('ensureNativeTrustStoreInstalled', () => {
  it('returns true when native install succeeds', async () => {
    const { ensureNativeTrustStoreInstalled } = loadFreshService();
    const ok = await ensureNativeTrustStoreInstalled();
    expect(ok).toBe(true);
  });

  it('returns false and records failure when install fails', async () => {
    mockInitTrustStore.mockResolvedValueOnce({ installed: false, error: 'broken' });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { ensureNativeTrustStoreInstalled } = loadFreshService();
    const ok = await ensureNativeTrustStoreInstalled();

    expect(ok).toBe(false);
    warnSpy.mockRestore();
  });

  it('caches success — second call does not re-invoke native', async () => {
    const { ensureNativeTrustStoreInstalled } = loadFreshService();
    await ensureNativeTrustStoreInstalled();
    await ensureNativeTrustStoreInstalled();
    expect(mockInitTrustStore).toHaveBeenCalledTimes(1);
  });

  it('allows retry after a failed install', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockInitTrustStore
      .mockResolvedValueOnce({ installed: false, error: 'fail' })
      .mockResolvedValueOnce({ installed: true, error: null });

    const { ensureNativeTrustStoreInstalled } = loadFreshService();
    expect(await ensureNativeTrustStoreInstalled()).toBe(false);
    expect(await ensureNativeTrustStoreInstalled()).toBe(true);
    expect(mockInitTrustStore).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});

describe('trustCertificateForHost', () => {
  it('installs, writes the native store, and refreshes the mirror', async () => {
    mockNativeGetTrustedCertificates.mockResolvedValue([
      { hostname: 'music.example.com', sha256Fingerprint: 'FF:EE:DD', acceptedAt: 5 },
    ]);
    const { trustCertificateForHost } = loadFreshService();

    await trustCertificateForHost('music.example.com', 'FF:EE:DD');

    expect(mockInitTrustStore).toHaveBeenCalledTimes(1);
    expect(mockNativeTrustCertificate).toHaveBeenCalledWith('music.example.com', 'FF:EE:DD', undefined);
    // Mirror refreshed from native after the write.
    expect(mockNativeGetTrustedCertificates).toHaveBeenCalled();
    expect(mockSetTrustedCerts).toHaveBeenCalledWith({
      'music.example.com': { sha256: 'FF:EE:DD', acceptedAt: 5 },
    });
  });

  it('passes validTo through to native', async () => {
    const { trustCertificateForHost } = loadFreshService();
    await trustCertificateForHost('music.example.com', 'FF:EE:DD', '2027-01-01T00:00:00Z');
    expect(mockNativeTrustCertificate).toHaveBeenCalledWith(
      'music.example.com',
      'FF:EE:DD',
      '2027-01-01T00:00:00Z',
    );
  });

  it('swallows native trust failure and still refreshes', async () => {
    mockNativeTrustCertificate.mockRejectedValueOnce(new Error('jni go boom'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { trustCertificateForHost } = loadFreshService();
    await expect(trustCertificateForHost('music.example.com', 'FF:EE:DD')).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to trust cert'),
      expect.any(Error),
    );
    expect(mockNativeGetTrustedCertificates).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('removeTrustForHost', () => {
  it('removes from the native store and refreshes the mirror', async () => {
    const { removeTrustForHost } = loadFreshService();
    await removeTrustForHost('old.example.com');

    expect(mockNativeRemoveTrustedCertificate).toHaveBeenCalledWith('old.example.com');
    expect(mockNativeGetTrustedCertificates).toHaveBeenCalled();
    expect(mockSetTrustedCerts).toHaveBeenCalled();
  });

  it('swallows native remove failure', async () => {
    mockNativeRemoveTrustedCertificate.mockRejectedValueOnce(new Error('boom'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { removeTrustForHost } = loadFreshService();
    await expect(removeTrustForHost('old.example.com')).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to remove cert'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});

describe('clearAllNativeTrust', () => {
  it('clears the native store, stops the proxy, and empties the mirror', async () => {
    const { clearAllNativeTrust } = loadFreshService();
    await clearAllNativeTrust();

    expect(mockNativeClearAll).toHaveBeenCalledTimes(1);
    expect(mockRefreshProxyUpstreams).toHaveBeenCalledWith([]);
    expect(mockNativeGetTrustedCertificates).toHaveBeenCalled();
    expect(mockSetTrustedCerts).toHaveBeenCalledWith({});
  });

  it('never rejects even if native clear throws', async () => {
    mockNativeClearAll.mockRejectedValueOnce(new Error('nope'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { clearAllNativeTrust } = loadFreshService();
    await expect(clearAllNativeTrust()).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });
});

describe('__resetForTests', () => {
  it('clears initialized + nativeInstalled state for retest', async () => {
    const svc = loadFreshService();
    await svc.ensureNativeTrustStoreInstalled();
    expect(mockInitTrustStore).toHaveBeenCalledTimes(1);

    svc.__resetForTests();

    await svc.ensureNativeTrustStoreInstalled();
    expect(mockInitTrustStore).toHaveBeenCalledTimes(2);
  });
});
