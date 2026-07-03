import type { AudioRoute } from 'react-native-queue-player';

import {
  castButtonLabel,
  localRouteDisplayName,
  rowSubtitle,
  startCastingA11yLabel,
  stopCastingA11yLabel,
} from '../copy';
import { iconForAudioRoute, iconForCastProtocol, iconForRoute } from '../iconForRoute';
import type { RouteInfo } from '../types';
import { useRoutePickerStore } from '../useRoutePickerStore';

/** Minimal valid RouteInfo builder for icon/subtitle assertions. */
function makeRoute(overrides: Partial<RouteInfo> = {}): RouteInfo {
  return {
    id: 'chromecast:abc',
    protocol: 'chromecast',
    protocolVersion: '',
    name: 'Living Room',
    modelName: '',
    iconHint: 'speaker',
    capabilities: {
      supportsRemoteVolume: true,
      streamingModel: 'pushPcm',
      requiresPairing: false,
    },
    isActive: false,
    isConnecting: false,
    ...overrides,
  };
}

function audioRoute(overrides: Partial<AudioRoute> = {}): AudioRoute {
  return { kind: 'speaker', name: '', ...overrides } as AudioRoute;
}

describe('iconForRoute', () => {
  it('maps the local route to a phone glyph', () => {
    expect(iconForRoute(makeRoute({ protocol: 'local' }))).toBe('cellphone');
  });

  it('maps AirPlay to the audio-cast glyph', () => {
    expect(iconForRoute(makeRoute({ protocol: 'airplay' }))).toBe('cast-audio');
  });

  it('reflects the active state for Chromecast', () => {
    expect(iconForRoute(makeRoute({ protocol: 'chromecast', isActive: false }))).toBe('cast');
    expect(iconForRoute(makeRoute({ protocol: 'chromecast', isActive: true }))).toBe(
      'cast-connected',
    );
  });

  it('falls back to the device iconHint for other protocols', () => {
    expect(iconForRoute(makeRoute({ protocol: 'dlna', iconHint: 'tv' }))).toBe('television');
    expect(iconForRoute(makeRoute({ protocol: 'dlna', iconHint: 'speaker' }))).toBe('speaker');
    expect(iconForRoute(makeRoute({ protocol: 'sonos', iconHint: 'unknown' }))).toBe('cast');
  });
});

describe('iconForCastProtocol', () => {
  it('maps each cast protocol to its badge glyph', () => {
    expect(iconForCastProtocol('chromecast')).toBe('cast-connected');
    expect(iconForCastProtocol('airplay')).toBe('cast-audio');
    expect(iconForCastProtocol('local')).toBe('cast');
  });
});

describe('iconForAudioRoute', () => {
  it('groups the Bluetooth kinds under one glyph', () => {
    expect(iconForAudioRoute(audioRoute({ kind: 'bluetoothA2DP' }))).toBe('bluetooth');
    expect(iconForAudioRoute(audioRoute({ kind: 'bluetoothLE' }))).toBe('bluetooth');
    expect(iconForAudioRoute(audioRoute({ kind: 'bluetoothHFP' }))).toBe('bluetooth');
  });

  it('maps wired / usb / hdmi / car / cast kinds', () => {
    expect(iconForAudioRoute(audioRoute({ kind: 'wired' }))).toBe('headphones');
    expect(iconForAudioRoute(audioRoute({ kind: 'usb' }))).toBe('usb');
    expect(iconForAudioRoute(audioRoute({ kind: 'hdmi' }))).toBe('television');
    expect(iconForAudioRoute(audioRoute({ kind: 'carPlay' }))).toBe('car');
    expect(iconForAudioRoute(audioRoute({ kind: 'androidAuto' }))).toBe('car');
    expect(iconForAudioRoute(audioRoute({ kind: 'airplay' }))).toBe('cast-audio');
    expect(iconForAudioRoute(audioRoute({ kind: 'chromecast' }))).toBe('cast-connected');
    expect(iconForAudioRoute(audioRoute({ kind: 'receiver' }))).toBe('speaker');
  });

  it('defaults the built-in speaker / unknown route to the phone glyph', () => {
    expect(iconForAudioRoute(audioRoute({ kind: 'speaker' }))).toBe('cellphone');
    expect(iconForAudioRoute(audioRoute({ kind: 'unknown' }))).toBe('cellphone');
  });
});

describe('castButtonLabel', () => {
  it('prefers the active cast session name', () => {
    expect(castButtonLabel(audioRoute({ kind: 'speaker' }), 'Kitchen Speaker')).toBe(
      'Kitchen Speaker',
    );
  });

  it('uses a named non-speaker audio route when not casting', () => {
    expect(castButtonLabel(audioRoute({ kind: 'bluetoothA2DP', name: 'AirPods' }), null)).toBe(
      'AirPods',
    );
  });

  it('falls back to the local device for the built-in speaker', () => {
    expect(castButtonLabel(audioRoute({ kind: 'speaker', name: '' }), null)).toBe(
      localRouteDisplayName(),
    );
    expect(castButtonLabel(audioRoute({ kind: 'unknown', name: 'x' }), null)).toBe(
      localRouteDisplayName(),
    );
  });
});

describe('rowSubtitle', () => {
  it('describes the local route', () => {
    expect(rowSubtitle(makeRoute({ protocol: 'local' }))).toBe('Currently listening here');
  });

  it('joins protocol + model for a receiver', () => {
    expect(rowSubtitle(makeRoute({ protocol: 'chromecast', modelName: 'Nest Audio' }))).toBe(
      'Chromecast • Nest Audio',
    );
  });

  it('appends a connect-failure note when a receiver errored', () => {
    expect(rowSubtitle(makeRoute({ protocol: 'chromecast', lastError: 'cast_connect_failed' }))).toBe(
      "Chromecast • Couldn't connect",
    );
  });
});

describe('a11y labels', () => {
  it('distinguishes stop vs start listening', () => {
    expect(stopCastingA11yLabel('Den TV')).toBe('Stop listening on Den TV');
    expect(startCastingA11yLabel('Den TV')).toBe('Listen on Den TV');
  });
});

describe('useRoutePickerStore', () => {
  afterEach(() => {
    useRoutePickerStore.getState().close();
  });

  it('starts closed and toggles open/close', () => {
    expect(useRoutePickerStore.getState().isOpen).toBe(false);
    useRoutePickerStore.getState().open();
    expect(useRoutePickerStore.getState().isOpen).toBe(true);
    useRoutePickerStore.getState().close();
    expect(useRoutePickerStore.getState().isOpen).toBe(false);
  });
});
