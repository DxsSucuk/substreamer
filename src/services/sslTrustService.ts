import { AppState } from 'react-native';

import {
  initTrustStore,
  trustCertificate as nativeTrustCertificate,
  removeTrustedCertificate as nativeRemoveTrustedCertificate,
  refreshProxyUpstreams,
  refreshProxyInfo,
} from '../../modules/expo-ssl-trust/src';
import { authStore } from '../store/authStore';
import { sslCertStore } from '../store/sslCertStore';
import { fireAndForget } from '../utils/fireAndForget';

/**
 * Reconcile the iOS local reverse proxy with the app's configured server URLs.
 * The native side proxies only the ones whose host has a trusted self-signed
 * cert; everything else connects directly. No-op on Android.
 */
async function syncProxyUpstreams(): Promise<void> {
  const { serverUrl, primaryServerUrl, secondaryServerUrl } = authStore.getState();
  const urls = [serverUrl, primaryServerUrl, secondaryServerUrl].filter(
    (u): u is string => !!u,
  );
  await refreshProxyUpstreams([...new Set(urls)]);
}

let initialized = false;
let nativeInstalled = false;
let nativeInstallInflight: Promise<boolean> | null = null;

/**
 * Initialise the SSL trust store from JS. Called at module scope from
 * `_layout.tsx`, before any network requests are made.
 *
 * **Lazy install**: We deliberately skip the native install when the user
 * has no trusted certificates persisted. Installing the custom TrustManager
 * is what triggers the JSSE crash on stripped Android OEM ROMs (MIUI/HyperOS,
 * FunTouchOS), so users on broken ROMs who never need pinning never pay
 * for it. The install runs lazily on first call to `trustCertificateForHost`.
 *
 * For users who already have certs persisted, install runs immediately so
 * those connections work from app start.
 */
export function initSslTrustStore(): void {
  if (initialized) return;
  initialized = true;

  // The local proxy's listener can drop while the app is suspended (no audio
  // playing); refresh the cached port when we return to the foreground so the
  // next request hits the live port. No-op on Android / when no proxy runs.
  AppState.addEventListener('change', (state) => {
    if (state === 'active') fireAndForget(refreshProxyInfo(), 'sslTrust.refreshProxyInfo');
  });

  const { trustedCerts } = sslCertStore.getState();
  if (Object.keys(trustedCerts).length === 0) {
    // No persisted certs → no need to touch native JSSE wiring at all.
    return;
  }

  // Persisted certs present — install eagerly, sync them, and prime the proxy
  // so the first request after a cold start (iOS self-signed) is routed.
  fireAndForget(
    ensureNativeTrustStoreInstalled().then((ok) => {
      if (ok) {
        fireAndForget(syncToNative(), 'sslTrust.syncToNative');
        fireAndForget(syncProxyUpstreams(), 'sslTrust.syncProxyUpstreams');
      }
    }),
    'sslTrust.ensureInstalled',
  );
}

/**
 * Idempotently install the native trust store. On stripped OEM ROMs the
 * install can fail; the failure is recorded on `sslCertStore.installFailed`
 * so the UI can surface a banner. Returns true on success.
 */
export async function ensureNativeTrustStoreInstalled(): Promise<boolean> {
  if (nativeInstalled) return true;
  if (nativeInstallInflight) return nativeInstallInflight;

  nativeInstallInflight = (async () => {
    try {
      const status = await initTrustStore();
      if (status.installed) {
        nativeInstalled = true;
        sslCertStore.getState().clearInstallFailed();
        return true;
      }
      const message =
        status.error ??
        'SSL trust store could not be installed on this device.';
      sslCertStore.getState().setInstallFailed(message);
      console.warn('[sslTrustService] native trust store install failed:', message);
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sslCertStore.getState().setInstallFailed(message);
      console.warn('[sslTrustService] native trust store install threw:', err);
      return false;
    } finally {
      nativeInstallInflight = null;
    }
  })();

  return nativeInstallInflight;
}

/**
 * Sync all trusted certificates from the Zustand store to the native module.
 */
async function syncToNative(): Promise<void> {
  const { trustedCerts } = sslCertStore.getState();
  for (const [hostname, entry] of Object.entries(trustedCerts)) {
    try {
      await nativeTrustCertificate(hostname, entry.sha256);
    } catch (err) {
      console.warn(`[sslTrustService] Failed to sync cert for ${hostname}:`, err);
    }
  }
}

/**
 * Trust a certificate for a hostname, persisting in both Zustand and native
 * stores. Triggers a native install on first call (for users who launched
 * with no persisted certs).
 */
export async function trustCertificateForHost(
  hostname: string,
  sha256Fingerprint: string,
  validTo?: string,
): Promise<void> {
  // Ensure the native trust manager is wired before we hand it a cert.
  // If install fails, persist anyway — the JS-side store still drives
  // the certificate prompt UI even when native pinning is unavailable.
  await ensureNativeTrustStoreInstalled();

  // Persist in Zustand store (SQLite)
  sslCertStore.getState().trustCertificate(hostname, sha256Fingerprint, validTo);

  // Sync to native store. Swallow per-cert failures: install may have
  // failed entirely, in which case the call is a no-op against the stub.
  try {
    await nativeTrustCertificate(hostname, sha256Fingerprint);
  } catch (err) {
    console.warn(`[sslTrustService] Failed to push cert for ${hostname}:`, err);
  }

  // (iOS) register/refresh the local proxy now this host is trusted so the
  // login retry + subsequent requests are routed through it.
  fireAndForget(syncProxyUpstreams(), 'sslTrust.syncProxyUpstreams');
}

/**
 * Remove trust for a hostname from both Zustand and native stores.
 */
export async function removeTrustForHost(hostname: string): Promise<void> {
  sslCertStore.getState().removeTrustedCertificate(hostname);
  try {
    await nativeRemoveTrustedCertificate(hostname);
  } catch (err) {
    console.warn(`[sslTrustService] Failed to remove cert for ${hostname}:`, err);
  }
  // (iOS) drop this host from the proxy so we no longer route through it.
  fireAndForget(syncProxyUpstreams(), 'sslTrust.syncProxyUpstreams');
}

/**
 * Reset module-private state — for tests only. Has no effect outside Jest.
 */
export function __resetForTests(): void {
  initialized = false;
  nativeInstalled = false;
  nativeInstallInflight = null;
}
