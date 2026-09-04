import { PermissionsAndroid, Platform } from 'react-native';
import type { Permission } from 'react-native';

/**
 * Android 17 (API 37) gates access to the local network behind the runtime
 * `ACCESS_LOCAL_NETWORK` permission for apps targeting SDK 37+. The permission
 * is only defined from API 37 — requesting it on an older OS fails closed
 * without a dialog, so those devices always answer "granted" here.
 *
 * This app targets SDK 36, where the permission is granted implicitly with
 * INTERNET and must not be requested — so this helper never raises the system
 * prompt today (the check already reports granted). It is the hook a future
 * targetSdk bump needs: on enforcing devices the check fails and the standard
 * prompt runs before the first connection attempt, and a refusal maps to a
 * clear error instead of a silent timeout.
 */
export const ANDROID_LOCAL_NETWORK_PERMISSION = 'android.permission.ACCESS_LOCAL_NETWORK';

const ENFORCING_API_LEVEL = 37;

export async function ensureAndroidLocalNetworkPermission(): Promise<
  'granted' | 'denied'
> {
  if (Platform.OS !== 'android') return 'granted';
  if (Number(Platform.Version) < ENFORCING_API_LEVEL) return 'granted';
  try {
    // RN 0.86's Permission union predates this constant — assert it for the
    // native platform call.
    const permission = ANDROID_LOCAL_NETWORK_PERMISSION as Permission;
    if (await PermissionsAndroid.check(permission)) {
      return 'granted';
    }
    const result = await PermissionsAndroid.request(permission);
    return result === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
  } catch {
    // Permission state undeterminable — don't block the connection attempt; a
    // genuine OS-level block surfaces as the normal network error.
    return 'granted';
  }
}
