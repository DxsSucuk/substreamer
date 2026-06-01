/**
 * Stateless helpers for playerService. None of these touch the module's
 * own state machine (the 15 module-scope `let`s in playerService.ts);
 * they only read from external stores and services. Extracted so the
 * main service can stay focused on its event-handler state machine.
 */

import { RepeatMode, State, type Track } from 'react-native-track-player';

import i18n from '../i18n/i18n';
import { type EffectiveFormat } from '../types/audio';
import { musicCacheStore } from '../store/musicCacheStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { playbackSettingsStore, type RepeatModeSetting } from '../store/playbackSettingsStore';
import { type PlaybackStatus } from '../store/playerStore';
import { resolveEffectiveFormat } from '../utils/effectiveFormat';
import { coverArtIdForSong } from '../utils/coverArtId';
import { getCachedImageUri } from './imageCacheService';
import { getLocalTrackUri } from './musicCacheService';
import { getCoverArtUrl, getStreamUrl, type Child } from './subsonicService';

/** Map our RepeatModeSetting to RNTP's RepeatMode enum. */
export function mapRepeatMode(mode: RepeatModeSetting): RepeatMode {
  switch (mode) {
    case 'all':
      return RepeatMode.Queue;
    case 'one':
      return RepeatMode.Track;
    default:
      return RepeatMode.Off;
  }
}

/** Map RNTP State enum to our simplified PlaybackStatus. */
export function mapState(state: State): PlaybackStatus {
  switch (state) {
    case State.Playing:
      return 'playing';
    case State.Paused:
      return 'paused';
    case State.Buffering:
      return 'buffering';
    case State.Loading:
      return 'loading';
    case State.Stopped:
    case State.Ended:
      return 'stopped';
    default:
      return 'idle';
  }
}

const EXT_TO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
};

function mimeFromUri(uri: string): string | undefined {
  const ext = uri.split('.').pop()?.toLowerCase();
  return ext ? EXT_TO_MIME[ext] : undefined;
}

/**
 * Build an EffectiveFormat stamp for a track being added to the queue.
 * If the track has a downloaded copy with a persisted format, use that;
 * otherwise resolve from the current streaming settings.
 */
export function stampQueueFormat(child: Child): EffectiveFormat {
  const downloadedSong = musicCacheStore.getState().cachedSongs[child.id];
  if (downloadedSong) {
    return {
      suffix: downloadedSong.suffix.toLowerCase(),
      bitRate: downloadedSong.bitRate,
      bitDepth: downloadedSong.bitDepth,
      samplingRate: downloadedSong.samplingRate,
      capturedAt: downloadedSong.formatCapturedAt,
    };
  }

  const { streamFormat, maxBitRate } = playbackSettingsStore.getState();
  return resolveEffectiveFormat({
    sourceSuffix: child.suffix,
    sourceBitRate: child.bitRate,
    sourceBitDepth: child.bitDepth,
    sourceSamplingRate: child.samplingRate,
    formatSetting: streamFormat,
    bitRateSetting: maxBitRate,
  });
}

/**
 * Convert a Child (Subsonic song) to an RNTP Track object.
 *
 * Returns `null` when the track can't be played right now:
 * - Offline mode + no local cached file → RNTP must not receive a
 *   server stream URL (AVPlayer would latch onto it and stall
 *   indefinitely waiting for data from an unreachable server).
 * - No local URI AND stream-URL construction failed (e.g. auth not
 *   yet initialised). An empty-string URL in RNTP produces the same
 *   stall, so filter it out here rather than push it downstream.
 *
 * Callers must filter nulls out of the resulting array and treat an
 * all-null queue as "nothing playable" (toast + clearQueue).
 */
export function childToTrack(child: Child): Track | null {
  const localUri = getLocalTrackUri(child.id);
  const offline = offlineModeStore.getState().offlineMode;
  if (!localUri && offline) return null;

  const url = localUri ?? getStreamUrl(child.id);
  if (!url) return null;

  // Cover-art lookup keys off the parent album's ID (see
  // src/utils/coverArtId.ts) so every track in an album shares one
  // cached file — fixes the mini player / lock-screen placeholder
  // problem caused by Navidrome-style per-track coverArt variants.
  // `child.id` is always present, so the result is a defined string.
  const coverArtId = coverArtIdForSong(child) ?? child.id;
  const cachedArt = getCachedImageUri(coverArtId, 600);
  const contentType = localUri ? mimeFromUri(localUri) : undefined;
  // In offline mode drop any server-only artwork so RNTP's lock-screen
  // artwork fetch can't hit the network either. (`getCoverArtUrl` also
  // returns null under offline mode now; this is belt-and-braces.)
  const artwork = cachedArt
    ?? (offline ? undefined : getCoverArtUrl(coverArtId, 600) ?? undefined);

  return {
    id: child.id,
    url,
    title: child.title,
    artist: child.artist ?? i18n.t('unknownArtist'),
    album: child.album ?? undefined,
    artwork,
    duration: child.duration ?? 0,
    userAgent: 'substreamer8',
    ...(contentType ? { contentType } : {}),
  };
}

/**
 * Build (RNTP tracks, filtered child queue) from a Child queue, dropping
 * entries that aren't currently playable. Preserves source order so
 * callers can translate desired indices onto the filtered queue by
 * looking up the original Child.
 */
export function buildPlayableQueue(queue: readonly Child[]): {
  rnTracks: Track[];
  filteredQueue: Child[];
} {
  const rnTracks: Track[] = [];
  const filteredQueue: Child[] = [];
  for (const child of queue) {
    const track = childToTrack(child);
    if (track) {
      rnTracks.push(track);
      filteredQueue.push(child);
    }
  }
  return { rnTracks, filteredQueue };
}
