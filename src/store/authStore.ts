import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { kvStorage } from './persistence';

export type ServerSlot = 'primary' | 'secondary';
export type ServerSwitchMode = 'manual' | 'automatic';

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
  /** 'manual' (default) requires user action to switch; 'automatic' enables
   *  the failoverService to auto-switch on primary unreachability. */
  serverSwitchMode: ServerSwitchMode;

  setSession: (
    serverUrl: string,
    username: string,
    password: string,
    apiVersion: string,
    legacyAuth?: boolean,
  ) => void;
  clearSession: () => void;
  setRehydrated: (value: boolean) => void;

  /** Atomically swap `serverUrl` to point at the requested slot. No-op if
   *  the slot has no URL configured or already active. */
  setActiveServer: (target: ServerSlot) => void;
  /** Set or clear the secondary URL. Clearing while active='secondary'
   *  is the caller's responsibility (failoverService handles that flow). */
  setSecondaryServerUrl: (url: string | null) => void;
  setServerSwitchMode: (mode: ServerSwitchMode) => void;
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
      serverSwitchMode: 'manual',

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

      clearSession: () =>
        set({
          serverUrl: null,
          username: null,
          password: null,
          apiVersion: null,
          legacyAuth: false,
          isLoggedIn: false,
          // Wipe failover state on logout too — a fresh login will repopulate.
          primaryServerUrl: null,
          secondaryServerUrl: null,
          activeServer: 'primary',
          serverSwitchMode: 'manual',
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

      setServerSwitchMode: (mode) => set({ serverSwitchMode: mode }),
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
        serverSwitchMode: state.serverSwitchMode,
      }),
      onRehydrateStorage: () => (rehydrated) => {
        // Auto-mode boot reset: always start on primary. Without this, a
        // session that ended on secondary (via auto-failover) would
        // persist activeServer='secondary' and the next launch would
        // continue talking to secondary even if primary is now reachable.
        // The recovery poller would correct it eventually, but resetting
        // here saves the first minute on secondary when primary is fine.
        // Manual-mode users keep their explicit choice across launches.
        if (!rehydrated) return;
        if (
          rehydrated.serverSwitchMode === 'automatic' &&
          rehydrated.activeServer !== 'primary' &&
          rehydrated.primaryServerUrl
        ) {
          rehydrated.activeServer = 'primary';
          rehydrated.serverUrl = rehydrated.primaryServerUrl;
        }
      },
    },
  ),
);
