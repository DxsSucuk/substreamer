import { Platform } from 'react-native';

import ExpoSslTrustModule from '../ExpoSslTrustModule';
import {
  getCertificateInfo,
  trustCertificate,
  removeTrustedCertificate,
  getTrustedCertificates,
  isCertificateTrusted,
  initTrustStore,
  getInstallStatus,
  isSSLError,
  resolveServerBase,
  refreshProxyUpstreams,
  __setProxyInfoForTests,
} from '../ExpoSslTrust';

import type {
  CertificateInfo,
  TrustedCert,
  TrustStoreInstallStatus,
} from '../ExpoSslTrust';

jest.mock('../ExpoSslTrustModule');

const mockModule = jest.mocked(ExpoSslTrustModule);

beforeEach(() => {
  jest.clearAllMocks();
});

// -- Native-delegating functions --

describe('initTrustStore', () => {
  it('delegates to native and returns install status', async () => {
    const status: TrustStoreInstallStatus = { installed: true, error: null };
    mockModule.initTrustStore.mockResolvedValue(status);

    const result = await initTrustStore();

    expect(mockModule.initTrustStore).toHaveBeenCalledTimes(1);
    expect(result).toEqual(status);
  });

  it('returns failure status when native install failed', async () => {
    const status: TrustStoreInstallStatus = {
      installed: false,
      error: 'JSSE provider broken',
    };
    mockModule.initTrustStore.mockResolvedValue(status);

    const result = await initTrustStore();
    expect(result).toEqual(status);
  });

  it('propagates native errors', async () => {
    mockModule.initTrustStore.mockRejectedValue(new Error('Init failed'));

    await expect(initTrustStore()).rejects.toThrow('Init failed');
  });
});

describe('getInstallStatus', () => {
  it('returns the current install status from native', async () => {
    const status: TrustStoreInstallStatus = { installed: true, error: null };
    mockModule.getInstallStatus.mockResolvedValue(status);

    const result = await getInstallStatus();

    expect(mockModule.getInstallStatus).toHaveBeenCalledTimes(1);
    expect(result).toEqual(status);
  });

  it('reflects an unhealthy state', async () => {
    const status: TrustStoreInstallStatus = {
      installed: false,
      error: 'broken',
    };
    mockModule.getInstallStatus.mockResolvedValue(status);

    const result = await getInstallStatus();
    expect(result.installed).toBe(false);
    expect(result.error).toBe('broken');
  });
});

describe('getCertificateInfo', () => {
  const mockCert: CertificateInfo = {
    subject: 'CN=navidrome.local',
    issuer: 'CN=navidrome.local',
    sha256Fingerprint: 'AA:BB:CC:DD',
    validFrom: '2025-01-01T00:00:00Z',
    validTo: '2026-01-01T00:00:00Z',
    serialNumber: 'DEADBEEF',
    isSelfSigned: true,
  };

  it('passes URL to native and returns CertificateInfo', async () => {
    mockModule.getCertificateInfo.mockResolvedValue(mockCert);

    const result = await getCertificateInfo('https://navidrome.local:4533');

    expect(mockModule.getCertificateInfo).toHaveBeenCalledWith('https://navidrome.local:4533');
    expect(result).toEqual(mockCert);
  });

  it('propagates native errors', async () => {
    mockModule.getCertificateInfo.mockRejectedValue(new Error('Connection refused'));

    await expect(getCertificateInfo('https://unreachable')).rejects.toThrow('Connection refused');
  });
});

describe('trustCertificate', () => {
  it('passes hostname and fingerprint to native', async () => {
    mockModule.trustCertificate.mockResolvedValue(undefined);

    await trustCertificate('navidrome.local', 'AA:BB:CC');

    expect(mockModule.trustCertificate).toHaveBeenCalledWith('navidrome.local', 'AA:BB:CC');
  });
});

describe('removeTrustedCertificate', () => {
  it('passes hostname to native', async () => {
    mockModule.removeTrustedCertificate.mockResolvedValue(undefined);

    await removeTrustedCertificate('navidrome.local');

    expect(mockModule.removeTrustedCertificate).toHaveBeenCalledWith('navidrome.local');
  });
});

describe('getTrustedCertificates', () => {
  it('returns array of TrustedCert', async () => {
    const certs: TrustedCert[] = [
      { hostname: 'a.local', sha256Fingerprint: 'AA', acceptedAt: 1000 },
      { hostname: 'b.local', sha256Fingerprint: 'BB', acceptedAt: 2000 },
    ];
    mockModule.getTrustedCertificates.mockResolvedValue(certs);

    const result = await getTrustedCertificates();

    expect(result).toEqual(certs);
    expect(result).toHaveLength(2);
  });

  it('returns empty array when no certs are trusted', async () => {
    mockModule.getTrustedCertificates.mockResolvedValue([]);

    const result = await getTrustedCertificates();

    expect(result).toEqual([]);
  });
});

describe('isCertificateTrusted', () => {
  it('returns true when certificate is trusted', async () => {
    mockModule.isCertificateTrusted.mockResolvedValue(true);

    const result = await isCertificateTrusted('navidrome.local');

    expect(mockModule.isCertificateTrusted).toHaveBeenCalledWith('navidrome.local');
    expect(result).toBe(true);
  });

  it('returns false when certificate is not trusted', async () => {
    mockModule.isCertificateTrusted.mockResolvedValue(false);

    const result = await isCertificateTrusted('unknown.host');

    expect(result).toBe(false);
  });
});

// -- Local reverse proxy: resolveServerBase / refreshProxyUpstreams --

describe('resolveServerBase', () => {
  const isIOS = Platform.OS === 'ios';

  afterEach(() => __setProxyInfoForTests(null));

  it('returns the input unchanged when no proxy info is cached', () => {
    __setProxyInfoForTests(null);
    expect(resolveServerBase('https://music.example.com')).toBe('https://music.example.com');
  });

  it('rewrites a registered host to the loopback proxy (iOS) / identity (Android)', () => {
    __setProxyInfoForTests({
      port: 50555,
      upstreams: [{ baseUrl: 'https://music.example.com', token: 'tok123' }],
    });
    const result = resolveServerBase('https://music.example.com');
    expect(result).toBe(isIOS ? 'http://127.0.0.1:50555/tok123' : 'https://music.example.com');
  });

  it('returns identity for an unregistered host even while the proxy runs', () => {
    __setProxyInfoForTests({
      port: 50555,
      upstreams: [{ baseUrl: 'https://music.example.com', token: 'tok123' }],
    });
    expect(resolveServerBase('https://other.example.com')).toBe('https://other.example.com');
  });

  it('matches by scheme+host+port regardless of case (iOS)', () => {
    __setProxyInfoForTests({
      port: 1,
      upstreams: [{ baseUrl: 'https://Music.Example.com:4533', token: 't' }],
    });
    const out = resolveServerBase('https://music.example.com:4533');
    expect(out).toBe(isIOS ? 'http://127.0.0.1:1/t' : 'https://music.example.com:4533');
  });

  it('does NOT match a different port (a plain-HTTP secondary stays direct)', () => {
    __setProxyInfoForTests({
      port: 1,
      upstreams: [{ baseUrl: 'https://music.example.com:443', token: 't' }],
    });
    // Same host, different scheme/port → not the registered self-signed upstream.
    expect(resolveServerBase('http://music.example.com:8080')).toBe('http://music.example.com:8080');
  });
});

describe('refreshProxyUpstreams', () => {
  it('is a no-op on Android; delegates to native on iOS', async () => {
    mockModule.syncProxyUpstreams.mockResolvedValue(null);
    await refreshProxyUpstreams(['https://music.example.com']);
    if (Platform.OS === 'ios') {
      expect(mockModule.syncProxyUpstreams).toHaveBeenCalledWith(['https://music.example.com']);
    } else {
      expect(mockModule.syncProxyUpstreams).not.toHaveBeenCalled();
    }
  });
});

// -- Pure JS: isSSLError --

describe('isSSLError', () => {
  describe('Android SSL patterns', () => {
    it.each([
      'javax.net.ssl.SSLHandshakeException: chain validation failed',
      'SSLHandshakeException: Handshake failed',
      'CertPathValidatorException: Trust anchor not found',
      'PKIX path building failed',
      'Trust anchor for certification path not found',
      'SSL handshake aborted',
    ])('matches "%s"', (msg) => {
      expect(isSSLError(msg)).toBe(true);
    });
  });

  describe('iOS SSL patterns', () => {
    it.each([
      'NSURLErrorServerCertificateUntrusted',
      'NSURLErrorServerCertificateHasUnknownRoot',
      'NSURLErrorServerCertificateNotYetValid',
      'NSURLErrorServerCertificateHasBadDate',
      'kCFStreamErrorDomainSSL',
      'The certificate for this server is invalid',
      'certificate is not trusted',
      'A server with the specified hostname could not be found',
    ])('matches "%s"', (msg) => {
      expect(isSSLError(msg)).toBe(true);
    });
  });

  describe('generic SSL patterns', () => {
    it.each([
      'SSL connection error',
      'Invalid certificate received',
      'CERTIFICATE_VERIFY_FAILED',
      'CERT_FINGERPRINT_MISMATCH: fingerprint changed',
    ])('matches "%s"', (msg) => {
      expect(isSSLError(msg)).toBe(true);
    });
  });

  describe('case-insensitive matching', () => {
    it('matches lowercase versions of patterns', () => {
      expect(isSSLError('sslhandshakeexception: failed')).toBe(true);
    });

    it('matches uppercase versions of patterns', () => {
      expect(isSSLError('JAVAX.NET.SSL.SSLEXCEPTION')).toBe(true);
    });

    it('matches mixed-case versions', () => {
      expect(isSSLError('Certificate Is Not Trusted')).toBe(true);
    });
  });

  describe('non-SSL errors', () => {
    it.each([
      'Connection timed out',
      'HTTP 404 Not Found',
      'JSON parse error',
      'Network is unreachable',
      'ECONNREFUSED',
      '',
    ])('does not match "%s"', (msg) => {
      expect(isSSLError(msg)).toBe(false);
    });
  });
});
