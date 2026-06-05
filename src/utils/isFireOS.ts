import { Platform } from 'react-native';
import * as Device from 'expo-device';

/**
 * True on Amazon Fire tablets (Fire OS). Fire devices report
 * `Device.manufacturer === 'Amazon'`. `Device.manufacturer` is a synchronous
 * constant, so this is safe to read on hot paths (e.g. the play gate).
 *
 * Used to surface Fire-specific background-playback guidance — Fire OS's
 * "Smart Suspend" turns Wi-Fi off when idle and its battery management can
 * pause/stop background audio, neither of which applies on standard Android.
 */
export function isFireOS(): boolean {
  return Platform.OS === 'android' && Device.manufacturer === 'Amazon';
}
