import { Platform } from 'react-native';

import ExpoSslTrustModule from './ExpoSslTrustModule';

export interface CertificateInfo {
  /** Certificate subject (e.g. "CN=navidrome.local") */
  subject: string;
  /** Certificate issuer (e.g. "CN=navidrome.local" for self-signed) */
  issuer: string;
  /** SHA-256 fingerprint of the certificate in hex (colon-separated) */
  sha256Fingerprint: string;
  /** Validity start date as ISO 8601 string */
  validFrom: string;
  /** Validity end date as ISO 8601 string */
  validTo: string;
  /** Certificate serial number in hex */
  serialNumber: string;
  /** Whether the certificate is self-signed (subject === issuer) */
  isSelfSigned: boolean;
}

export interface TrustedCert {
  /** The hostname this certificate is trusted for */
  hostname: string;
  /** SHA-256 fingerprint of the trusted certificate */
  sha256Fingerprint: string;
  /** Timestamp when the user accepted this certificate (epoch ms) */
  acceptedAt: number;
}

/**
 * Result of attempting to install the custom TrustManager. On stripped
 * Android OEM ROMs the JSSE provider can be broken — in that case
 * `installed` is false and `error` carries the failure message.
 */
export interface TrustStoreInstallStatus {
  /** True if the custom TrustManager is wired into HttpsURLConnection / OkHttp. */
  installed: boolean;
  /** Failure message if install did not succeed. */
  error: string | null;
}

/**
 * Connect to a server and retrieve its SSL certificate information.
 * This opens a raw TLS connection to extract the certificate without
 * going through the normal trust validation.
 */
export async function getCertificateInfo(url: string): Promise<CertificateInfo> {
  return ExpoSslTrustModule.getCertificateInfo(url);
}

/**
 * Add a certificate to the app's trusted certificate store.
 * After calling this, connections to the specified hostname whose
 * certificate matches the given fingerprint will be allowed.
 */
export async function trustCertificate(
  hostname: string,
  sha256Fingerprint: string
): Promise<void> {
  return ExpoSslTrustModule.trustCertificate(hostname, sha256Fingerprint);
}

/**
 * Remove a previously trusted certificate from the trust store.
 */
export async function removeTrustedCertificate(hostname: string): Promise<void> {
  return ExpoSslTrustModule.removeTrustedCertificate(hostname);
}

/**
 * Get all currently trusted certificates.
 */
export async function getTrustedCertificates(): Promise<TrustedCert[]> {
  return ExpoSslTrustModule.getTrustedCertificates();
}

/**
 * Check if a hostname has a trusted certificate in the store.
 */
export async function isCertificateTrusted(hostname: string): Promise<boolean> {
  return ExpoSslTrustModule.isCertificateTrusted(hostname);
}

/**
 * Initialize the native trust store. Should be called the first time the
 * app actually needs SSL pinning (i.e. before adding a custom certificate),
 * not unconditionally at startup — installing the custom TrustManager is
 * what triggers the JSSE crash on broken OEM ROMs, so we want to defer
 * that work until it's needed.
 *
 * Returns the install status. If `installed` is false, the JS layer should
 * surface a banner to the user and fall back to the system trust store.
 */
export async function initTrustStore(): Promise<TrustStoreInstallStatus> {
  return ExpoSslTrustModule.initTrustStore();
}

/**
 * Query the current install status of the native trust store without
 * triggering an install attempt. Returns `{ installed: false, error: null }`
 * before `initTrustStore()` has been called.
 */
export async function getInstallStatus(): Promise<TrustStoreInstallStatus> {
  return ExpoSslTrustModule.getInstallStatus();
}

/**
 * SSL error message patterns per platform. Use this to detect whether
 * a network error is an SSL certificate trust failure.
 */
const SSL_ERROR_PATTERNS = [
  // Android (OkHttp / javax.net.ssl)
  'javax.net.ssl',
  'SSLHandshakeException',
  'CertPathValidatorException',
  'PKIX path',
  'Trust anchor for certification path not found',
  'SSL handshake aborted',
  // iOS (NSURLSession / Security framework)
  'NSURLErrorServerCertificateUntrusted',
  'NSURLErrorServerCertificateHasUnknownRoot',
  'NSURLErrorServerCertificateNotYetValid',
  'NSURLErrorServerCertificateHasBadDate',
  'kCFStreamErrorDomainSSL',
  'The certificate for this server is invalid',
  'certificate is not trusted',
  'A server with the specified hostname could not be found',
  // Generic
  'SSL',
  'certificate',
  'CERTIFICATE_VERIFY_FAILED',
  // Certificate changed (from our native module)
  'CERT_FINGERPRINT_MISMATCH',
];

/**
 * Check if an error message indicates an SSL certificate trust failure.
 */
export function isSSLError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return SSL_ERROR_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/* ------------------------------------------------------------------ */
/*  iOS local reverse proxy                                            */
/* ------------------------------------------------------------------ */

/** One registered upstream: a real server base URL and its proxy token. */
export interface ProxyUpstream {
  baseUrl: string;
  token: string;
}

/** Live proxy state: the loopback port and the token↔baseUrl map. */
export interface ProxyInfo {
  port: number;
  upstreams: ProxyUpstream[];
}

// JS-side cache of the iOS proxy state. Read synchronously by
// `resolveServerBase`; refreshed at the mutation points (trust/untrust, boot,
// foreground). Always null on Android (no proxy — trust is handled at the
// HTTP-client layer).
let cachedProxyInfo: ProxyInfo | null = null;

/**
 * Normalize a base URL to `scheme://host[:port]` (lowercased, no path / trailing
 * slash) so registration and lookup match regardless of formatting. Mirrors the
 * native `SslTrustProxy.normalizeBase`.
 */
function normalizeBase(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/:?#]+)(?::(\d+))?/i.exec(url.trim());
  if (!m) return url.trim().toLowerCase().replace(/\/+$/, '');
  const port = m[3] ? `:${m[3]}` : '';
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}${port}`;
}

/**
 * Resolve a real server base URL to the URL the app should actually request.
 *
 * - iOS, host has a trusted self-signed cert + proxy running → returns the
 *   loopback proxy base `http://127.0.0.1:<port>/<token>` (append your
 *   `/rest/…?…` as normal).
 * - Android, a normal CA cert, or a not-yet-trusted host → returns `url`
 *   unchanged.
 *
 * Synchronous + cheap: it only reads the in-memory cache, so it's safe to call
 * from every URL builder on the request hot path. Apply it ONLY where a base URL
 * becomes a network request — never to identity/config/display (`serverUrl`,
 * settings UI, failover records), which must keep the real URL.
 */
export function resolveServerBase(url: string): string {
  if (Platform.OS !== 'ios' || !cachedProxyInfo) return url;
  const norm = normalizeBase(url);
  const match = cachedProxyInfo.upstreams.find((u) => normalizeBase(u.baseUrl) === norm);
  if (!match) return url;
  return `http://127.0.0.1:${cachedProxyInfo.port}/${match.token}`;
}

/**
 * Reconcile the proxy's upstreams with the app's configured server base URLs
 * (e.g. primary + secondary). The native side proxies only the ones whose host
 * has a trusted self-signed cert and starts/stops the listener accordingly.
 * No-op on Android. Call after trusting/untrusting a cert and at boot.
 */
export async function refreshProxyUpstreams(baseUrls: string[]): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    cachedProxyInfo = await ExpoSslTrustModule.syncProxyUpstreams(baseUrls);
  } catch (err) {
    console.warn('[expo-ssl-trust] syncProxyUpstreams failed:', err);
    cachedProxyInfo = null;
  }
}

/**
 * Refresh just the cached proxy info (the port can change when the listener is
 * restarted after a background suspend). Call on app foreground. No-op on
 * Android; preserves the last cache on transient failure.
 */
export async function refreshProxyInfo(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    cachedProxyInfo = await ExpoSslTrustModule.getProxyInfo();
  } catch {
    /* keep the last known info */
  }
}

/** Test seam — set the in-memory proxy cache directly. */
export function __setProxyInfoForTests(info: ProxyInfo | null): void {
  cachedProxyInfo = info;
}
