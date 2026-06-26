import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { authStore } from './authStore';
import { kvStorage } from './persistence';

interface ShareSettingsState {
  shareBaseUrl: string | null;
  setShareBaseUrl: (url: string | null) => void;
}

export const shareSettingsStore = create<ShareSettingsState>()(
  persist(
    (set) => ({
      shareBaseUrl: null,
      setShareBaseUrl: (url) => set({ shareBaseUrl: url || null }),
    }),
    {
      name: 'substreamer-share-settings',
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({ shareBaseUrl: state.shareBaseUrl }),
    },
  ),
);

/**
 * The canonical server URL for share links: always the primary server (the
 * only URL configured at first login). Share links shouldn't follow a failover
 * switch to the secondary — if the user wants a different address they set the
 * alternate share base URL explicitly. Falls back to the active `serverUrl`
 * only for sessions predating the primary/secondary schema.
 */
function getPrimaryServerUrl(): string | null {
  const auth = authStore.getState();
  return auth.primaryServerUrl ?? auth.serverUrl;
}

/**
 * Returns the effective base URL for share links.
 * Uses the user-configured alternate URL if set, otherwise falls back
 * to the primary server URL.
 */
export function getEffectiveShareBaseUrl(): string | null {
  return shareSettingsStore.getState().shareBaseUrl ?? getPrimaryServerUrl();
}

/**
 * Normalises the origin (scheme + host + port) of a server-provided share URL.
 *
 * Solves two problems:
 *  - Some servers (e.g. Navidrome reached on a non-default port) return a share
 *    `url` with the port stripped from the host, producing an unusable link
 *    (#208). We restore the origin we actually connect to, which carries the
 *    correct port.
 *  - When the user has configured an alternate public share base URL, we swap
 *    the origin to that instead.
 *
 * Only URLs whose host matches the primary server are rewritten, so a share
 * link the server intentionally points at a different public host is left
 * alone. Path, query and hash are always preserved.
 */
export function rewriteShareUrl(originalUrl: string): string {
  const primaryUrl = getPrimaryServerUrl();
  if (!primaryUrl) return originalUrl;

  let parsed: URL;
  let server: URL;
  try {
    parsed = new URL(originalUrl);
    server = new URL(primaryUrl);
  } catch {
    return originalUrl;
  }

  // Only touch share URLs that point at our own server's host. A server that
  // hands back a deliberately different public host (e.g. Navidrome's
  // ShareURL) is left untouched.
  if (parsed.hostname !== server.hostname) return originalUrl;

  // Prefer the user's alternate base URL; otherwise normalise to the primary
  // server origin — which carries the correct port the server dropped.
  let base = server;
  const override = shareSettingsStore.getState().shareBaseUrl;
  if (override) {
    try {
      base = new URL(override);
    } catch {
      return originalUrl;
    }
  }

  parsed.protocol = base.protocol;
  parsed.host = base.host; // host includes the port
  return parsed.toString();
}
