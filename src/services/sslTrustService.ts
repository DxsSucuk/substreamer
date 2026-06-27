import { onAppForeground } from '../utils/onAppForeground';

import {
  initTrustStore,
  trustCertificate as nativeTrustCertificate,
  removeTrustedCertificate as nativeRemoveTrustedCertificate,
  clearAllTrustedCertificates as nativeClearAllTrustedCertificates,
  getTrustedCertificates as nativeGetTrustedCertificates,
  refreshProxyUpstreams,
  refreshProxyInfo,
} from '../../modules/expo-ssl-trust/src';
import { authStore } from '../store/authStore';
import { sslCertStore, type TrustedCertEntry } from '../store/sslCertStore';
import { fireAndForget } from '../utils/fireAndForget';

/**
 * Re-read the NATIVE trust store (the single source of truth) and replace the
 * JS `sslCertStore` mirror with it. Call after every native trust op and at
 * boot so the UI + prompt logic always reflect exactly what's enforced.
 */
async function refreshTrustedCertsFromNative(): Promise<void> {
  try {
    const certs = await nativeGetTrustedCertificates();
    const map: Record<string, TrustedCertEntry> = {};
    for (const c of certs) {
      map[c.hostname] = {
        sha256: c.sha256Fingerprint,
        acceptedAt: c.acceptedAt,
        ...(c.validTo ? { validTo: c.validTo } : {}),
      };
    }
    sslCertStore.getState().setTrustedCerts(map);
  } catch (err) {
    console.warn('[sslTrustService] refresh trusted certs from native failed:', err);
  }
}

/**
 * Reconcile the iOS local reverse proxy with the app's configured server URLs.
 * The proxy is only for AVPlayer streaming (`getStreamUrl`) to a trusted
 * self-signed host — login/API/covers/downloads go through the NSURLSession
 * swizzle instead. Call AFTER login (authStore is set) and at boot. No-op on
 * Android / when no configured host is self-signed.
 */
export async function syncProxyUpstreams(): Promise<void> {
  // The mirror must reflect native trust before we decide which hosts to route
  // (boot can call this before the initial mirror refresh has landed).
  await refreshTrustedCertsFromNative();
  const trusted = sslCertStore.getState().trustedCerts;
  const { serverUrl, primaryServerUrl, secondaryServerUrl } = authStore.getState();
  // Register ONLY self-signed (pinned) hosts. A normal-CA server has no entry
  // in the trust store, so it's never routed through the proxy — it talks
  // direct HTTPS (and a CA secondary in a failover pair stays direct). This is
  // what keeps `resolveServerBase` an identity for non-self-signed hosts.
  const urls = [serverUrl, primaryServerUrl, secondaryServerUrl]
    .filter((u): u is string => !!u)
    .filter((u) => {
      try {
        return !!trusted[new URL(u).hostname];
      } catch {
        return false;
      }
    });
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
  onAppForeground(() => {
    fireAndForget(refreshProxyInfo(), 'sslTrust.refreshProxyInfo');
  });

  // Mirror the NATIVE store (source of truth) into the JS cache at boot. The
  // Android OkHttp trust manager is installed natively at Application.onCreate
  // (ExpoSslTrustPackage) — the only point early enough, before RN builds its
  // fixed HTTP client — so this JS path is purely a mirror + (for returning
  // users) a redundant ensure-installed. The streaming proxy is brought up
  // separately by the session-driven effect in _layout.
  fireAndForget(
    (async () => {
      await refreshTrustedCertsFromNative();
      if (Object.keys(sslCertStore.getState().trustedCerts).length > 0) {
        await ensureNativeTrustStoreInstalled();
      }
    })(),
    'sslTrust.init',
  );
}

/**
 * Idempotently install the native trust store. On stripped OEM ROMs the
 * install can fail (logged). Returns true on success.
 */
export async function ensureNativeTrustStoreInstalled(): Promise<boolean> {
  if (nativeInstalled) return true;
  if (nativeInstallInflight) return nativeInstallInflight;

  nativeInstallInflight = (async () => {
    try {
      const status = await initTrustStore();
      if (status.installed) {
        nativeInstalled = true;
        return true;
      }
      const message =
        status.error ??
        'SSL trust store could not be installed on this device.';
      console.warn('[sslTrustService] native trust store install failed:', message);
      return false;
    } catch (err) {
      console.warn('[sslTrustService] native trust store install threw:', err);
      return false;
    } finally {
      nativeInstallInflight = null;
    }
  })();

  return nativeInstallInflight;
}

/**
 * Trust a certificate for a hostname. Writes the NATIVE store (the single
 * source of truth) and refreshes the JS mirror from it. Triggers the native
 * install on first call (for users who launched with no certs).
 */
export async function trustCertificateForHost(
  hostname: string,
  sha256Fingerprint: string,
  validTo?: string,
): Promise<void> {
  // Ensure the native trust manager is wired before we hand it a cert.
  await ensureNativeTrustStoreInstalled();
  try {
    await nativeTrustCertificate(hostname, sha256Fingerprint, validTo);
  } catch (err) {
    console.warn(`[sslTrustService] Failed to trust cert for ${hostname}:`, err);
  }
  await refreshTrustedCertsFromNative();

  // If we're already in a session (e.g. an in-place re-trust from the
  // "Certificate changed" banner, not a fresh login), bring the streaming proxy
  // up now — the session-driven effect in _layout only fires on login/boot.
  // Gated on serverUrl so it doesn't fire mid-login (authStore not set yet),
  // which is where the _layout effect handles registration instead.
  if (authStore.getState().serverUrl) {
    fireAndForget(syncProxyUpstreams(), 'sslTrust.syncProxyUpstreams');
  }
}

/**
 * Remove trust for a hostname from the native store, refresh the mirror, and
 * reconcile the proxy (the host is no longer routed).
 */
export async function removeTrustForHost(hostname: string): Promise<void> {
  try {
    await nativeRemoveTrustedCertificate(hostname);
  } catch (err) {
    console.warn(`[sslTrustService] Failed to remove cert for ${hostname}:`, err);
  }
  await refreshTrustedCertsFromNative();
  // (iOS) drop this host from the proxy so we no longer route through it.
  fireAndForget(syncProxyUpstreams(), 'sslTrust.syncProxyUpstreams');
}

/**
 * Clear ALL trust on logout: wipe the native store (the single source of
 * truth), stop the proxy, and empty the JS mirror. Awaited by the logout
 * handler before navigating to login so a self-signed re-login re-prompts.
 * Never rejects (best-effort).
 */
export async function clearAllNativeTrust(): Promise<void> {
  try {
    await nativeClearAllTrustedCertificates();
  } catch (err) {
    console.warn('[sslTrustService] logout: clearAllTrustedCertificates failed:', err);
  }
  // Stop the iOS streaming proxy (no upstreams remain). No-op on Android.
  try {
    await refreshProxyUpstreams([]);
  } catch {
    /* best-effort */
  }
  // Empty the JS mirror to match native.
  await refreshTrustedCertsFromNative();
}

/**
 * Reset module-private state — for tests only. Has no effect outside Jest.
 */
export function __resetForTests(): void {
  initialized = false;
  nativeInstalled = false;
  nativeInstallInflight = null;
}
