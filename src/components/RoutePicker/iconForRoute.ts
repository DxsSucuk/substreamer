import type { ComponentProps } from 'react';
import { Platform } from 'react-native';
import type MaterialCommunityIcons from '@react-native-vector-icons/material-design-icons/static';
import type { AudioRoute, CastProtocol } from 'react-native-queue-player';
import type { RouteInfo } from './types';

/** Material Design Icons glyph name, compile-time-checked against the typing. */
export type RouteIconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

/** Glyph for a discovered cast receiver row (protocol-first, like Apple/Google). */
export function iconForRoute(route: RouteInfo): RouteIconName {
  if (route.protocol === 'local') {
    return 'cellphone';
  }
  if (route.protocol === 'airplay') return 'cast-audio';
  if (route.protocol === 'chromecast') {
    return route.isActive ? 'cast-connected' : 'cast';
  }
  if (route.iconHint === 'tv') return 'television';
  if (route.iconHint === 'speaker') return 'speaker';
  return 'cast';
}

/** Glyph for the active cast session badge in the player-screen CastButton. */
export function iconForCastProtocol(castProtocol: CastProtocol): RouteIconName {
  switch (castProtocol) {
    case 'chromecast':
      return 'cast-connected';
    case 'airplay':
      return 'cast-audio';
    case 'local':
    default:
      return 'cast';
  }
}

/** Glyph for the SYSTEM audio route — what the CastButton shows with no cast session. */
export function iconForAudioRoute(route: AudioRoute): RouteIconName {
  switch (route.kind) {
    case 'bluetoothA2DP':
    case 'bluetoothLE':
    case 'bluetoothHFP':
      return 'bluetooth';
    case 'wired':
      return 'headphones';
    case 'usb':
      return 'usb';
    case 'hdmi':
      return 'television';
    case 'carPlay':
    case 'androidAuto':
      return 'car';
    case 'airplay':
      return 'cast-audio';
    case 'chromecast':
      return 'cast-connected';
    case 'receiver':
      return 'speaker';
    case 'speaker':
    case 'unknown':
    default:
      return 'cellphone';
  }
}
