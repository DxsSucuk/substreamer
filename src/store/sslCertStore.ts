import { create } from 'zustand';

export interface TrustedCertEntry {
  /** SHA-256 fingerprint of the trusted certificate (colon-separated hex) */
  sha256: string;
  /** Timestamp when the user accepted this certificate (epoch ms) */
  acceptedAt: number;
  /** Certificate validity end date as ISO 8601 string, if known */
  validTo?: string;
}

interface SslCertState {
  /**
   * Map of hostname -> trusted certificate entry.
   *
   * This is a NON-PERSISTED reactive MIRROR of the native trust store
   * (`expo-ssl-trust`), which is the single source of truth — it's what the iOS
   * URLProtocol swizzle / Android OkHttp actually enforce. Populated via
   * `setTrustedCerts` after every native op (trust / remove / clear) and at
   * boot, by `sslTrustService.refreshTrustedCertsFromNative()`. Do NOT mutate it
   * directly — go through the native store so the two can't drift.
   */
  trustedCerts: Record<string, TrustedCertEntry>;
  /** Replace the cache with the latest snapshot read from the native store. */
  setTrustedCerts: (certs: Record<string, TrustedCertEntry>) => void;
  /** Check if a hostname has a trusted certificate (reads the mirror). */
  isTrusted: (hostname: string) => boolean;
  /** Get the trusted fingerprint for a hostname, or null. */
  getTrustedFingerprint: (hostname: string) => string | null;
}

export const sslCertStore = create<SslCertState>()((set, get) => ({
  trustedCerts: {},

  setTrustedCerts: (certs) => set({ trustedCerts: certs }),

  isTrusted: (hostname) => hostname in get().trustedCerts,

  getTrustedFingerprint: (hostname) => get().trustedCerts[hostname]?.sha256 ?? null,
}));
