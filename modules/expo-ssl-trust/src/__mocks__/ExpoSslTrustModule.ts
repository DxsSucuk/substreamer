export default {
  initTrustStore: jest.fn().mockResolvedValue({ installed: true, error: null }),
  getInstallStatus: jest.fn().mockResolvedValue({ installed: true, error: null }),
  getCertificateInfo: jest.fn().mockResolvedValue({
    subject: 'CN=test.local',
    issuer: 'CN=test.local',
    sha256Fingerprint: 'AA:BB:CC',
    validFrom: '2025-01-01T00:00:00Z',
    validTo: '2026-01-01T00:00:00Z',
    serialNumber: '01',
    isSelfSigned: true,
  }),
  trustCertificate: jest.fn().mockResolvedValue(undefined),
  removeTrustedCertificate: jest.fn().mockResolvedValue(undefined),
  getTrustedCertificates: jest.fn().mockResolvedValue([]),
  isCertificateTrusted: jest.fn().mockResolvedValue(false),
  syncProxyUpstreams: jest.fn().mockResolvedValue(null),
  getProxyInfo: jest.fn().mockResolvedValue(null),
};
