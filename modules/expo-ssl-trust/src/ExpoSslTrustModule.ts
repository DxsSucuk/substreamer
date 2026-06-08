import { requireNativeModule } from 'expo-modules-core';

import {
  type CertificateInfo,
  type ProxyInfo,
  type TrustedCert,
  type TrustStoreInstallStatus,
} from './ExpoSslTrust';

interface ExpoSslTrustNative {
  initTrustStore(): Promise<TrustStoreInstallStatus>;
  getInstallStatus(): Promise<TrustStoreInstallStatus>;
  getCertificateInfo(url: string): Promise<CertificateInfo>;
  trustCertificate(hostname: string, sha256Fingerprint: string): Promise<void>;
  removeTrustedCertificate(hostname: string): Promise<void>;
  getTrustedCertificates(): Promise<TrustedCert[]>;
  isCertificateTrusted(hostname: string): Promise<boolean>;
  /** iOS-only local reverse proxy. Android resolves these via stubs (no proxy). */
  syncProxyUpstreams(baseUrls: string[]): Promise<ProxyInfo | null>;
  getProxyInfo(): Promise<ProxyInfo | null>;
}

// Load the native module from JSI. If the native module is not available
// (e.g. during development before a native rebuild), provide a stub that
// logs warnings instead of crashing the app.
let module: ExpoSslTrustNative;

try {
  module = requireNativeModule<ExpoSslTrustNative>('ExpoSslTrust');
} catch {
  console.warn(
    '[expo-ssl-trust] Native module not found. ' +
      'Run `npx expo run:ios` or `npx expo run:android` to rebuild with the native module.'
  );

  // Provide a no-op stub so the JS side doesn't crash
  const stubStatus: TrustStoreInstallStatus = { installed: false, error: null };
  const noop = () => Promise.resolve(undefined as unknown as void);
  module = {
    initTrustStore: () => Promise.resolve(stubStatus),
    getInstallStatus: () => Promise.resolve(stubStatus),
    getCertificateInfo: () =>
      Promise.reject(new Error('expo-ssl-trust native module not available. Rebuild the app.')),
    trustCertificate: noop,
    removeTrustedCertificate: noop,
    getTrustedCertificates: () => Promise.resolve([]),
    isCertificateTrusted: () => Promise.resolve(false),
    syncProxyUpstreams: () => Promise.resolve(null),
    getProxyInfo: () => Promise.resolve(null),
  };
}

export default module;
