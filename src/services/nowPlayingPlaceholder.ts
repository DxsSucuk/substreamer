import { File, Paths } from 'expo-file-system';

import { NOWPLAYING_PLACEHOLDER_JPEG_BASE64 } from './nowPlayingPlaceholderData';

const FILE_NAME = 'nowplaying-placeholder.jpg';

/**
 * Write the bundled gray-waveform placeholder to a local file and return its
 * `file://` URI, for RNQP's `placeholderArtworkUri` (which needs an on-disk
 * `file://`, not a Metro/drawable asset URL). Idempotent + synchronous; returns
 * undefined on failure so RNQP falls back to its built-in placeholder.
 */
export function ensureNowPlayingPlaceholderUri(): string | undefined {
  try {
    const file = new File(Paths.document, FILE_NAME);
    if (!file.exists) file.write(NOWPLAYING_PLACEHOLDER_JPEG_BASE64, { encoding: 'base64' });
    return file.uri;
  } catch {
    return undefined;
  }
}
