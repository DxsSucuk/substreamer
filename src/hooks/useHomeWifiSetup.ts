import NetInfo from '@react-native-community/netinfo';
import { useCallback, useState } from 'react';

import { getCurrentSSIDWithRetry } from '../services/autoOfflineService';

/**
 * Owns the home-WiFi SSID detection state for the offline-mode setup UI.
 *
 * `refreshSSID` re-reads the current network in one place (the block was
 * previously copy-pasted across the mount effect, mode-select, grant-
 * permission and retry handlers):
 *   - off WiFi → clear the SSID and flag `notOnWifi`;
 *   - on WiFi → fetch the SSID and flag `ssidReadFailed` when a
 *     permission-granted read still comes back empty.
 *
 * Pass `granted=false` (e.g. when permission isn't confirmed) to suppress the
 * read-failed flag; callers that have just confirmed/forced permission use the
 * default `true`.
 */
export function useHomeWifiSetup() {
  const [currentSSID, setCurrentSSID] = useState<string | null>(null);
  const [ssidReadFailed, setSsidReadFailed] = useState(false);
  const [notOnWifi, setNotOnWifi] = useState(false);

  const refreshSSID = useCallback(async (granted = true) => {
    const state = await NetInfo.refresh();
    if (state.type !== 'wifi') {
      setCurrentSSID(null);
      setSsidReadFailed(false);
      setNotOnWifi(true);
      return;
    }
    setNotOnWifi(false);
    const ssid = await getCurrentSSIDWithRetry();
    setCurrentSSID(ssid);
    setSsidReadFailed(granted && ssid == null);
  }, []);

  return { currentSSID, ssidReadFailed, notOnWifi, refreshSSID };
}
