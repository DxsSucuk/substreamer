import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// Synchronous adapter: `isLoggedIn` gates the login redirect at boot — async
// hydration would flash the logged-out state then bounce.
import { kvStorageSync as kvStorage } from './persistence';

export type ServerSlot = 'primary' | 'secondary';

export interface AuthState {
  /** The ACTIVE server URL — what every existing consumer (subsonicService,
   *  imageCacheService, etc.) reads. Mirrors whichever slot `activeServer`
   *  points to. Never set directly; use `setActiveServer` to swap slots. */
  serverUrl: string | null;
  username: string | null;
  password: string | null;
  apiVersion: string | null;
  legacyAuth: boolean;
  isLoggedIn: boolean;
  rehydrated: boolean;

  /** Canonical primary URL — the address the user logged in with. */
  primaryServerUrl: string | null;
  /** Optional fallback URL for failover. `null` means failover is disabled. */
  secondaryServerUrl: string | null;
  /** Which slot `serverUrl` currently mirrors. */
  activeServer: ServerSlot;

  setSession: (
    serverUrl: string,
    username: string,
    password: string,
    apiVersion: string,
    legacyAuth?: boolean,
  ) => void;
  setRehydrated: (value: boolean) => void;

  /** Atomically swap `serverUrl` to point at the requested slot. No-op if
   *  the slot has no URL configured or already active. */
  setActiveServer: (target: ServerSlot) => void;
  /** Set or clear the secondary URL. Clearing while active='secondary'
   *  is the caller's responsibility (failoverService handles that flow). */
  setSecondaryServerUrl: (url: string | null) => void;
  /** Switch the auth scheme (token ↔ legacy plaintext) without disturbing the
   *  server slots. Callers must re-verify against the server first — see the
   *  Account settings toggle. The API + cover-art caches key on `legacyAuth`,
   *  so they rebuild on next use (pair with `clearApiCache()`). */
  setLegacyAuth: (legacyAuth: boolean) => void;
}

const PERSIST_KEY = 'substreamer-auth';

function resolveSlotUrl(
  target: ServerSlot,
  primary: string | null,
  secondary: string | null,
): string | null {
  return target === 'primary' ? primary : secondary;
}

export const authStore = create<AuthState>()(
  persist(
    (set) => ({
      serverUrl: null,
      username: null,
      password: null,
      apiVersion: null,
      legacyAuth: false,
      isLoggedIn: false,
      rehydrated: false,
      primaryServerUrl: null,
      secondaryServerUrl: null,
      activeServer: 'primary',

      setSession: (serverUrl, username, password, apiVersion, legacyAuth = false) =>
        set({
          // Login defines the primary. Active resets to primary so a
          // re-login after failover always starts on the new primary.
          serverUrl,
          primaryServerUrl: serverUrl,
          activeServer: 'primary',
          username,
          password,
          apiVersion,
          legacyAuth,
          isLoggedIn: true,
          rehydrated: true,
        }),

      setRehydrated: (value) => set({ rehydrated: value }),

      setActiveServer: (target) =>
        set((state) => {
          if (state.activeServer === target) return state;
          const nextUrl = resolveSlotUrl(target, state.primaryServerUrl, state.secondaryServerUrl);
          if (!nextUrl) return state;
          return { activeServer: target, serverUrl: nextUrl };
        }),

      setSecondaryServerUrl: (url) => set({ secondaryServerUrl: url }),

      setLegacyAuth: (legacyAuth) => set({ legacyAuth }),
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({
        serverUrl: state.serverUrl,
        username: state.username,
        password: state.password,
        apiVersion: state.apiVersion,
        legacyAuth: state.legacyAuth,
        isLoggedIn: state.isLoggedIn,
        primaryServerUrl: state.primaryServerUrl,
        secondaryServerUrl: state.secondaryServerUrl,
        activeServer: state.activeServer,
      }),
      // No boot reset: `activeServer` is restored verbatim. If the restored
      // server is unreachable, the connectivity banner offers a switch (detect-
      // and-confirm) — we never silently force a slot on launch.
    },
  ),
);
