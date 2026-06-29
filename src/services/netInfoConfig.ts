import NetInfo from '@react-native-community/netinfo';

import { autoOfflineStore } from '../store/autoOfflineStore';
import { errMessage } from '../utils/errorMessage';

/**
 * The WiFi SSID is read only by the home-WiFi auto-offline listener
 * (autoOfflineService). Resolving it on every NetInfo state update calls iOS's
 * location-gated SSID API (NEHotspotNetwork / CNCopyCurrentNetworkInfo) —
 * expensive, WiFi-only, and a documented memory/CPU sink when location isn't
 * granted. So enable it only while that feature is actually active.
 */
function needsWiFiSSID(): boolean {
  const { enabled, mode } = autoOfflineStore.getState();
  return enabled && mode === 'home-wifi';
}

/**
 * (Re)apply the NetInfo configuration. `NetInfo.configure` REPLACES the whole
 * config — it does not merge — so every option must be set on each call.
 */
export function configureNetInfo(): void {
  try {
    NetInfo.configure({
      shouldFetchWiFiSSID: needsWiFiSSID(),
      // Disable NetInfo's own internet-reachability probe entirely (periodic
      // HTTP to a generate_204 endpoint — a known battery drain, netinfo#178).
      // We don't consume `isInternetReachable`: the OS-level `isConnected` flag
      // tells us whether there's a network, and our own server ping
      // (connectivityService) is the ground truth for whether the server is
      // reachable. So the probe is pure waste — turn it off.
      reachabilityShouldRun: () => false,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[netInfoConfig] configure failed:', errMessage(e));
  }
}

/**
 * Apply the initial config and keep `shouldFetchWiFiSSID` in sync with the
 * auto-offline setting for the app's lifetime. Call once at boot, before any
 * NetInfo listener registers. The subscription also catches the persisted
 * setting hydrating in after launch.
 */
export function initNetInfoConfig(): void {
  configureNetInfo();
  autoOfflineStore.subscribe((s, p) => {
    if (s.enabled !== p.enabled || s.mode !== p.mode) configureNetInfo();
  });
}
