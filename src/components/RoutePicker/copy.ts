import { Platform } from 'react-native';
import type { AudioRoute } from 'react-native-queue-player';
import type { RouteInfo } from './types';

/**
 * User-facing copy for the route picker, in one place so the picker, the button,
 * and screen-reader announcements speak with one voice. Follows the "Listening
 * on" convention for audio context.
 *
 * TODO(phase-2): route these through i18n once the picker ships in all locales.
 */

const localDeviceLabel = Platform.OS === 'ios' ? 'This iPhone' : 'This device';

/** Title for the sheet header. */
export const SHEET_TITLE = 'Listening on';

/** Subtitle line under the device name on each row. */
export function rowSubtitle(route: RouteInfo): string {
  if (route.protocol === 'local') return 'Currently listening here';
  const protoBits: string[] = [];
  if (route.protocol === 'airplay') {
    protoBits.push(`AirPlay${route.protocolVersion ? ' ' + route.protocolVersion : ''}`);
  } else if (route.protocol === 'chromecast') {
    protoBits.push('Chromecast');
  } else {
    protoBits.push(route.protocol);
  }
  if (route.modelName.length > 0) protoBits.push(route.modelName);
  if (route.lastError) protoBits.push(`Couldn't connect`);
  return protoBits.join(' • ');
}

/** Local-row subtitle while audio is routed to an OS-managed AirPlay/BT device. */
export const SYSTEM_ROUTE_ACTIVE_LOCAL_SUBTITLE =
  'Use the AirPlay & Bluetooth picker to switch back';

/** Local-row subtitle while a lib-managed cast route (Chromecast) is active. */
export const CAST_ACTIVE_LOCAL_SUBTITLE = 'Tap to switch back here';

/** Friendly name for the local device row. */
export function localRouteDisplayName(): string {
  return localDeviceLabel;
}

/** Text the player-screen CastButton displays — the active route's name. */
export function castButtonLabel(audioRoute: AudioRoute, activeCastName: string | null): string {
  if (activeCastName != null && activeCastName.length > 0) {
    return activeCastName;
  }
  if (
    audioRoute.name &&
    audioRoute.name.length > 0 &&
    audioRoute.kind !== 'speaker' &&
    audioRoute.kind !== 'unknown'
  ) {
    return audioRoute.name;
  }
  return localDeviceLabel;
}

/** A11y label for the active receiver row (disconnect target). */
export function stopCastingA11yLabel(name: string): string {
  return `Stop listening on ${name}`;
}

/** A11y label for an idle, tappable receiver row. */
export function startCastingA11yLabel(name: string): string {
  return `Listen on ${name}`;
}

/** Preposition the CastButton uses inline ("Listening on X"). */
export const CAST_BUTTON_PREPOSITION = 'Listening on';
