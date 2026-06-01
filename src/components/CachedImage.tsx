/**
 * Cover-art image with three render states:
 *
 *   LOCAL       — a cached file exists on disk → render it.
 *   REMOTE      — no cached file, online, the service hasn't flagged this
 *                 id's server URL as failed → render the server URL AND
 *                 ask the service to cache it in parallel. When the cache
 *                 download lands, the cache-update subscription forces a
 *                 re-render and we switch to LOCAL.
 *   PLACEHOLDER — anything else (offline + no cache, remote-failed, no
 *                 coverArtId, both URI sources errored on this mount).
 *                 The branded WaveformLogo placeholder is ALWAYS in the
 *                 tree underneath; the Image layer just covers it once
 *                 it paints. We never render a blank square.
 *
 * Decode errors flow back to the service:
 *   - A cached file that fails to decode → `reportBadCache(id, size)` →
 *     service deletes the variant + re-enqueues a download. On this
 *     mount we set a `localErroredRef` so we don't immediately try the
 *     same broken URI again; next render falls through to REMOTE.
 *   - A remote URL that fails → `reportBadRemote(id)` → service adds id
 *     to `failedRemoteIds` and notifies subscribers. Every CachedImage
 *     instance for the id stays on PLACEHOLDER until a fresh file lands.
 *
 * The service owns: download queue, dedup, timed retry, persistent
 * recovery (offline → online, AppState 'active'). The component only
 * renders and reports — no retry tower, no debounce, no scheduling.
 */

import { memo, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  Image as RNImage,
  type ImageProps,
  type ImageStyle,
  type LayoutChangeEvent,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import WaveformLogo from './WaveformLogo';
import {
  buildRemoteImageUrl,
  ensureCached,
  getCachedImageUri,
  isRemoteFailed,
  reportBadCache,
  reportBadRemote,
  subscribeImageCacheUpdate,
} from '../services/imageCacheService';
import { logImageCache } from '../services/imageCacheLogger';
import { STARRED_COVER_ART_ID } from '../services/musicCacheService';
import { VARIOUS_ARTISTS_COVER_ART_ID } from '../services/subsonicService';
import { offlineModeStore } from '../store/offlineModeStore';

import { absoluteFill } from '../utils/styles';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Duration of the placeholder-to-image crossfade for remote URLs. */
const FADE_DURATION_MS = 300;
/** Min size for the placeholder logo (dp). */
const MIN_LOGO_SIZE = 16;
/** Max size for the placeholder logo (dp). */
const MAX_LOGO_SIZE = 80;
/** Logo size as a fraction of the image's smaller dimension. */
const LOGO_SCALE = 0.4;
/** Default colour for the placeholder waveform bars. */
const PLACEHOLDER_COLOR = 'rgba(150,150,150,0.25)';

/** Resolved URI for the bundled starred-songs cover art. */
const STARRED_COVER_URI = RNImage.resolveAssetSource(
  require('../assets/starred-cover.jpg'),
).uri;

/** Resolved URI for the bundled Various Artists cover art. */
const VARIOUS_ARTISTS_COVER_URI = RNImage.resolveAssetSource(
  require('../assets/various-artists-cover.jpg'),
).uri;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface CachedImageProps extends Omit<ImageProps, 'source'> {
  /** Subsonic cover art ID (e.g. `album.coverArt`). */
  coverArtId: string | undefined;
  /** Requested image size tier (50 | 150 | 300 | 600). */
  size: number;
  /** Optional fallback URI when coverArtId is missing or URL construction fails. */
  fallbackUri?: string;
  /** Optional colour for the placeholder waveform bars. */
  placeholderColor?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function computeLogoSize(w: number | undefined, h: number | undefined): number {
  const smaller = Math.min(w ?? 56, h ?? 56);
  return Math.min(MAX_LOGO_SIZE, Math.max(MIN_LOGO_SIZE, smaller * LOGO_SCALE));
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const CachedImage = memo(function CachedImage({
  coverArtId: rawCoverArtId,
  size,
  fallbackUri: rawFallbackUri,
  style,
  placeholderColor,
  ...imageProps
}: CachedImageProps) {
  // Sentinel cover ids resolve to bundled assets — the cache service
  // never sees them. Map the id to `undefined` so the rest of the
  // component never tries to cache or report on them.
  const isSentinel =
    rawCoverArtId === STARRED_COVER_ART_ID ||
    rawCoverArtId === VARIOUS_ARTISTS_COVER_ART_ID;
  const coverArtId = isSentinel ? undefined : rawCoverArtId;
  const fallbackUri = isSentinel
    ? rawCoverArtId === STARRED_COVER_ART_ID
      ? STARRED_COVER_URI
      : VARIOUS_ARTISTS_COVER_URI
    : rawFallbackUri;

  // Re-render token. Bumped by the cache-update subscription on either
  // a fresh on-disk variant OR a flip of failedRemoteIds for this id —
  // both signals flow through the same channel.
  const [, force] = useReducer((x: number) => x + 1, 0);

  // Per-mount flag: "I already tried the local URI and it failed."
  // Clears when the cache-update fires (the service re-downloaded the
  // file) or when the id/size changes (fresh attempt). The id/size
  // reset happens during render via a previous-id compare so the
  // render that introduced the new id picks LOCAL straight away — a
  // useEffect-based reset would fire post-render and leave the first
  // paint on the wrong branch.
  const localErroredRef = useRef(false);
  const currentIdRef = useRef(coverArtId);
  const currentSizeRef = useRef(size);
  if (currentIdRef.current !== coverArtId || currentSizeRef.current !== size) {
    currentIdRef.current = coverArtId;
    currentSizeRef.current = size;
    localErroredRef.current = false;
  }

  // Sync lookups on every render. The opt-in `sourceFallback` exposes
  // the 600px source for smaller-size requests when the resized variant
  // isn't on disk — handles servers that fail to resize but serve the
  // source, and the brief gap before the local resize pipeline finishes.
  const cachedUri = coverArtId
    ? getCachedImageUri(coverArtId, size, { sourceFallback: true })
    : null;
  const remoteFailed = coverArtId ? isRemoteFailed(coverArtId) : false;
  const offline = offlineModeStore((s) => s.offlineMode);

  // Pick what to render: LOCAL > REMOTE > PLACEHOLDER.
  let renderUri: string | undefined;
  let isRemote = false;
  if (cachedUri && !localErroredRef.current) {
    renderUri = cachedUri;
  } else if (coverArtId && !offline && !remoteFailed) {
    const url = buildRemoteImageUrl(coverArtId, size);
    if (url) {
      renderUri = url;
      isRemote = true;
    }
  }
  if (!renderUri && fallbackUri) renderUri = fallbackUri;

  // Ask the service to cache this id. Idempotent (service-side dedup
  // collapses bursts of concurrent calls for the same id).
  useEffect(() => {
    if (!coverArtId || cachedUri) return;
    ensureCached(coverArtId);
  }, [coverArtId, cachedUri]);

  // Subscribe — fires on file landed OR remote-failed flag flipped.
  useEffect(() => {
    if (!coverArtId) return;
    return subscribeImageCacheUpdate(coverArtId, () => {
      localErroredRef.current = false;
      force();
    });
  }, [coverArtId]);

  // Error handler — three branches, no retry tower.
  const onError = useCallback(() => {
    if (!coverArtId) return;
    const hadCached = cachedUri != null && !localErroredRef.current;
    if (hadCached) {
      localErroredRef.current = true;
      reportBadCache(coverArtId, size);
    } else if (isRemote) {
      reportBadRemote(coverArtId);
    }
    force();
  }, [coverArtId, size, cachedUri, isRemote]);

  // Layout measurement for placeholder logo sizing.
  const [layoutSize, setLayoutSize] = useState<{ w: number; h: number } | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setLayoutSize((prev) => {
      if (prev && Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1) return prev;
      return { w: width, h: height };
    });
  }, []);

  // Fade-in for remote URLs only. Local files and bundled fallbacks
  // render at full opacity instantly — they're trusted sources.
  const fadeAnim = useSharedValue(isRemote ? 0 : 1);
  useEffect(() => {
    cancelAnimation(fadeAnim);
    fadeAnim.value = isRemote ? 0 : 1;
  }, [isRemote, fadeAnim]);
  const onLoad = useCallback(() => {
    if (isRemote) {
      fadeAnim.value = withTiming(1, { duration: FADE_DURATION_MS });
    }
  }, [isRemote, fadeAnim]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fadeAnim.value }));

  // One log line per state transition. Kept minimal so user logs are
  // scannable; the service has its own logs for downloads/retries.
  useEffect(() => {
    if (!coverArtId) {
      // No usable id AND no bundled fallback → a genuine missing-id
      // placeholder: the parent handed us an entity with no id. This is the
      // otherwise-silent stuck case (every other branch is gated on a truthy
      // id), so log it to make recurrence diagnosable. Sentinels render a
      // bundled fallbackUri and are intentionally skipped.
      if (!fallbackUri) {
        logImageCache(`CachedImage placeholder id-missing size=${size}`);
      }
      return;
    }
    const where = cachedUri && !localErroredRef.current
      ? 'local'
      : isRemote
        ? 'remote'
        : 'placeholder';
    logImageCache(
      `CachedImage state id=${coverArtId} size=${size} ${where} remoteFailed=${remoteFailed}`,
    );
  }, [coverArtId, size, cachedUri, isRemote, remoteFailed, fallbackUri]);

  const flatStyle = StyleSheet.flatten(style) as (ImageStyle & ViewStyle) | undefined;
  const logoSize = computeLogoSize(
    layoutSize?.w ?? (typeof flatStyle?.width === 'number' ? flatStyle.width : undefined),
    layoutSize?.h ?? (typeof flatStyle?.height === 'number' ? flatStyle.height : undefined),
  );

  return (
    <View style={[style as ViewStyle, styles.container]} onLayout={onLayout}>
      <View style={styles.placeholder} pointerEvents="none">
        <WaveformLogo
          size={logoSize}
          color={placeholderColor ?? PLACEHOLDER_COLOR}
        />
      </View>
      {renderUri && (
        <Animated.Image
          {...imageProps}
          source={{ uri: renderUri }}
          style={[StyleSheet.absoluteFill, fadeStyle]}
          onLoad={onLoad}
          onError={onError}
          // We do our own crossfade via fadeStyle. Disabling Fresco's
          // built-in fade shrinks the window in which a recycled view
          // can deliver a decode-success callback to a released
          // CloseableReference (the IllegalStateException trigger in
          // PipelineDraweeController on Android).
          fadeDuration={0}
        />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  placeholder: {
    ...absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
