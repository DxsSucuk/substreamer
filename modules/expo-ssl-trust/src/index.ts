export {
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
  refreshProxyInfo,
  __setProxyInfoForTests,
} from './ExpoSslTrust';

export type {
  CertificateInfo,
  TrustedCert,
  TrustStoreInstallStatus,
  ProxyInfo,
  ProxyUpstream,
} from './ExpoSslTrust';
