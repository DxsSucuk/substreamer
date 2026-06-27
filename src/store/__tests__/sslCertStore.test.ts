import { sslCertStore } from '../sslCertStore';

beforeEach(() => {
  sslCertStore.setState({ trustedCerts: {} });
});

// sslCertStore is now a NON-PERSISTED mirror of the native trust store — the
// native plugin is the single source of truth. The store just holds the latest
// snapshot (set via setTrustedCerts) and exposes read helpers.
describe('sslCertStore (native mirror)', () => {
  it('setTrustedCerts replaces the cache', () => {
    sslCertStore.getState().setTrustedCerts({
      'example.com': { sha256: 'AA:BB:CC', acceptedAt: 100 },
    });
    expect(sslCertStore.getState().trustedCerts['example.com'].sha256).toBe('AA:BB:CC');
    expect(sslCertStore.getState().trustedCerts['example.com'].acceptedAt).toBe(100);
  });

  it('setTrustedCerts overwrites prior contents (full replace)', () => {
    sslCertStore.getState().setTrustedCerts({ 'a.com': { sha256: 'AA', acceptedAt: 1 } });
    sslCertStore.getState().setTrustedCerts({ 'b.com': { sha256: 'BB', acceptedAt: 2 } });
    expect(sslCertStore.getState().trustedCerts['a.com']).toBeUndefined();
    expect(sslCertStore.getState().trustedCerts['b.com']).toBeDefined();
  });

  it('preserves validTo', () => {
    sslCertStore.getState().setTrustedCerts({
      'example.com': { sha256: 'AA', acceptedAt: 1, validTo: '2027-01-01T00:00:00Z' },
    });
    expect(sslCertStore.getState().trustedCerts['example.com'].validTo).toBe(
      '2027-01-01T00:00:00Z',
    );
  });

  it('isTrusted reflects the mirror', () => {
    sslCertStore.getState().setTrustedCerts({ 'example.com': { sha256: 'AA', acceptedAt: 1 } });
    expect(sslCertStore.getState().isTrusted('example.com')).toBe(true);
    expect(sslCertStore.getState().isTrusted('unknown.com')).toBe(false);
  });

  it('getTrustedFingerprint reads the mirror', () => {
    sslCertStore.getState().setTrustedCerts({
      'example.com': { sha256: 'AA:BB:CC', acceptedAt: 1 },
    });
    expect(sslCertStore.getState().getTrustedFingerprint('example.com')).toBe('AA:BB:CC');
    expect(sslCertStore.getState().getTrustedFingerprint('unknown.com')).toBeNull();
  });
});
