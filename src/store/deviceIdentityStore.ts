import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import i18n from '../i18n/i18n';
import { kvStorage } from './persistence';

/**
 * Device identity for backup tagging + cross-device matching.
 *
 * Three independent fields, each serving a distinct purpose:
 *   - `deviceId`     — UUID generated once on first launch. Canonical match
 *                      key. Survives any user-side rename. Never changes.
 *   - `deviceName`   — `Device.deviceName` from `expo-device`. On Android
 *                      this is the user-customisable OS name (e.g.
 *                      "Greg's Pixel"). On iOS 16+ it's the generic
 *                      "iPhone" / "iPad" — Apple restricted access to the
 *                      user-set name without MDM entitlements. Captured as
 *                      a stable secondary signal; refreshed on each launch.
 *   - `deviceLabel`  — Human-readable display string. Auto-default is
 *                      "Your {model}" via i18n (e.g. "Your iPhone 16",
 *                      "Your Pixel 8 Pro"). User can override in Settings;
 *                      `deviceLabelUserSet` then prevents auto-overwrite
 *                      on subsequent launches.
 */
interface DeviceIdentityState {
  deviceId: string;
  deviceName: string | null;
  deviceLabel: string;
  /** True once the user has explicitly edited the label. Gates auto-overwrite. */
  deviceLabelUserSet: boolean;
  /** User edits the label. Flips deviceLabelUserSet so launches preserve the edit. */
  setDeviceLabel: (label: string) => void;
  /** Re-read Device.deviceName so OS-side renames propagate. */
  refreshDeviceName: () => void;
  /** Re-derive the auto-default label from current Device.modelName. No-op
   *  if the user has explicitly set a label. Used by the migration on
   *  first launch and any time we want to refresh the default. */
  ensureDefaultLabel: () => void;
}

function deriveDefaultLabel(): string {
  const model = Device.modelName;
  if (model) return i18n.t('deviceLabelDefault', { model });
  return i18n.t('deviceLabelDefaultFallback');
}

export const deviceIdentityStore = create<DeviceIdentityState>()(
  persist(
    (set, get) => ({
      deviceId: Crypto.randomUUID(),
      deviceName: Device.deviceName ?? null,
      deviceLabel: deriveDefaultLabel(),
      deviceLabelUserSet: false,

      setDeviceLabel: (label) => {
        const trimmed = label.trim();
        if (!trimmed) return;
        set({ deviceLabel: trimmed, deviceLabelUserSet: true });
      },

      refreshDeviceName: () => {
        const next = Device.deviceName ?? null;
        if (next !== get().deviceName) set({ deviceName: next });
      },

      ensureDefaultLabel: () => {
        if (get().deviceLabelUserSet) return;
        const next = deriveDefaultLabel();
        if (next !== get().deviceLabel) set({ deviceLabel: next });
      },
    }),
    {
      name: 'substreamer-device-identity',
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({
        deviceId: state.deviceId,
        deviceName: state.deviceName,
        deviceLabel: state.deviceLabel,
        deviceLabelUserSet: state.deviceLabelUserSet,
      }),
    },
  ),
);

/**
 * Short form of `deviceId` used in backup filename stems
 * (`backup-{ts}-{deviceShortId}`) so two devices that happen to write a
 * backup in the same second on a shared cloud folder don't collide.
 */
export function getDeviceShortId(): string {
  return deviceIdentityStore.getState().deviceId.replace(/-/g, '').slice(0, 8);
}
