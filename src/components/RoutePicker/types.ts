import type {
  CastDeviceKind,
  CastProtocol,
  CastReceiverCapabilities,
} from 'react-native-queue-player';

/**
 * Normalised picker row payload. Mirrors `CastReceiver` from RNQP plus a few
 * derived UI fields (`isActive`, `isConnecting`, `lastError`) that the picker
 * layer tracks.
 */
export interface RouteInfo {
  id: string;
  protocol: CastProtocol;
  protocolVersion: string;
  name: string;
  modelName: string;
  iconHint: CastDeviceKind;
  capabilities: CastReceiverCapabilities;
  /** True for the row currently delivering audio. */
  isActive: boolean;
  /** True while a `connect(receiverId)` is in flight. */
  isConnecting: boolean;
  /** Last connect error code surfaced to the user (resets on next attempt). */
  lastError?: string;
}

/** Discovery lifecycle state shown in the sheet header. */
export type DiscoveryState = 'idle' | 'scanning' | 'permission-denied' | 'error';

/** Theming tokens for the picker. Built from the app theme via useRoutePickerTheme. */
export interface RoutePickerTheme {
  background: string;
  surface: string;
  text: string;
  textSubtle: string;
  border: string;
  accent: string;
  activeIndicator: string;
  connectingIndicator: string;
  errorIndicator: string;
}
