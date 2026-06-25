import Ionicons from "@react-native-vector-icons/ionicons/static";
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { memo, useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { CachedImage } from '@/components/CachedImage';
import { FavoriteButton } from '@/components/FavoriteButton';
import { PlayerProgressBar } from '@/components/PlayerProgressBar';
import WaveformLogo from '@/components/WaveformLogo';
import { type ThemeColors } from '@/constants/theme';
import { useCanSkip } from '@/hooks/useCanSkip';
import { useImagePalette } from '@/hooks/useImagePalette';
import { useSongCoverArt } from '@/hooks/useSongCoverArt';
import { useTheme } from '@/hooks/useTheme';
import { retryPlayback, seekTo, skipToNext, skipToPrevious, togglePlayPause } from '@/services/playerService';
import { playerStore } from '@/store/playerStore';
import { absoluteFill } from '@/utils/styles';

const COVER_SIZE = 76;
/** Matches the placeholder cover art background (rgb 150,150,150). */
const PLACEHOLDER_BG = '#969696';

/** Append alpha hex to a colour string (supports #RGB, #RRGGBB). */
const withAlpha = (hex: string, alpha: number) => {
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return `${hex}${a}`;
};

/**
 * Tablet-portrait mini player — the persistent now-playing footer on tablets
 * held in portrait. A taller floating card than the phone bar: a 3-column split
 * of cover art (left), centered title / artist·album·year over an inline
 * draggable seek bar (center), and favorite / play-pause / next controls
 * (right). Tapping the art or text opens the full /player screen.
 *
 * Phone (PlayerPhoneMini) and tablet landscape (split-view, no mini) are
 * unaffected. Branched in by BottomChrome via useIsTabletPortrait.
 */
export function PlayerTabletPortraitMini() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const currentTrack = playerStore((s) => s.currentTrack);
  const songCoverArtId = useSongCoverArt(currentTrack);
  const queueLoading = playerStore((s) => s.queueLoading);

  const router = useRouter();
  const openPlayer = useCallback(() => router.push('/player'), [router]);

  // The controls cluster is wider than the cover, which would shove the
  // centered text/progress off to the left. Measure the controls' width and
  // mirror it onto the cover side so the centre column is symmetric about the
  // card's centre (robust across tablet widths and themes).
  const [sideWidth, setSideWidth] = useState(0);
  const onControlsLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setSideWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
  }, []);

  // Colour extraction (theme-aware; secondary preferred for a calmer top hue).
  const { primary, secondary, gradientOpacity } = useImagePalette(songCoverArtId);
  const gradientAnimatedStyle = useAnimatedStyle(() => ({
    opacity: gradientOpacity.value,
  }));

  // The default track colour (colors.border) is only 6–8% opacity and gets
  // lost over the album-art gradient, so use a much stronger unplayed-track
  // colour for this surface only — textPrimary at 28% stays theme-aware
  // (light track in dark mode, dark track in light mode).
  const progressColors = useMemo(
    () => ({ ...colors, border: withAlpha(colors.textPrimary, 0.28) }),
    [colors],
  );

  if (!currentTrack) return null;

  const extractedTop = secondary ?? primary ?? colors.card;
  const topColor = queueLoading ? PLACEHOLDER_BG : extractedTop;
  const gradientColors: readonly [string, string, ...string[]] = [
    withAlpha(topColor, 0.65),
    withAlpha(colors.background, 0.65),
  ];

  return (
    <View style={[styles.card, { backgroundColor: colors.card }]}>
      {/* Album-art accent gradient over the solid card */}
      <Animated.View style={[absoluteFill, gradientAnimatedStyle]} pointerEvents="none">
        <LinearGradient
          colors={gradientColors}
          locations={[0, 1]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={absoluteFill}
        />
      </Animated.View>

      <View style={styles.band}>
        {/* Column 1 — cover art (tap to expand). Sized to match the controls
            column so the centre column stays centred on the card. */}
        <View style={[styles.sideLeft, sideWidth ? { width: sideWidth } : null]}>
          <Pressable
            onPress={openPlayer}
            style={({ pressed }) => [styles.coverWrap, pressed && styles.pressed]}
          >
            {queueLoading ? (
              <View style={[styles.cover, styles.coverPlaceholder, { backgroundColor: 'rgba(150,150,150,0.25)' }]}>
                <WaveformLogo size={24} color="rgba(150,150,150,1)" />
              </View>
            ) : (
              <CachedImage
                coverArtId={songCoverArtId}
                size={300}
                style={styles.cover}
                resizeMode="cover"
              />
            )}
          </Pressable>
          <FavoriteButton trackId={currentTrack.id} size={30} style={styles.coverFavorite} />
        </View>

        {/* Column 2 — centered title + artist + progress bar */}
        <View style={styles.center}>
          <Pressable
            onPress={openPlayer}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Text
              style={[
                styles.title,
                { color: queueLoading ? colors.textSecondary : colors.textPrimary },
              ]}
              numberOfLines={1}
            >
              {queueLoading ? t('loading') : currentTrack.title}
            </Text>
          </Pressable>

          {!queueLoading && (
            <Pressable
              onPress={openPlayer}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Text
                style={[styles.subtitle, { color: colors.textSecondary }]}
                numberOfLines={1}
              >
                {currentTrack.artist ?? t('unknownArtist')}
              </Text>
            </Pressable>
          )}

          <View style={styles.progressSection}>
            <View style={styles.progressInner}>
              <ProgressBar colors={progressColors} />
            </View>
          </View>
        </View>

        {/* Column 3 — transport controls */}
        <View style={styles.controls} onLayout={onControlsLayout}>
          <PrevButton colors={colors} />
          <PlayPauseButton colors={colors} />
          <NextButton colors={colors} />
        </View>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Progress bar — isolated so high-frequency position ticks don't     */
/*  re-render the whole card. Mirrors player-tablet-portrait.tsx.      */
/* ------------------------------------------------------------------ */

const ProgressBar = memo(function ProgressBar({ colors }: { colors: ThemeColors }) {
  const position = playerStore((s) => s.position);
  const duration = playerStore((s) => s.duration);
  const bufferedPosition = playerStore((s) => s.bufferedPosition);
  const playbackState = playerStore((s) => s.playbackState);
  const error = playerStore((s) => s.error);
  const retrying = playerStore((s) => s.retrying);
  const isBuffering = playbackState === 'buffering' || playbackState === 'loading';

  return (
    <PlayerProgressBar
      position={position}
      duration={duration}
      bufferedPosition={bufferedPosition}
      colors={colors}
      onSeek={seekTo}
      isBuffering={isBuffering}
      error={error}
      retrying={retrying}
      onRetry={retryPlayback}
    />
  );
});

/* ------------------------------------------------------------------ */
/*  Play / pause — filled circle, mirrors the tablet full player.      */
/* ------------------------------------------------------------------ */

const PlayPauseButton = memo(function PlayPauseButton({ colors }: { colors: ThemeColors }) {
  const playbackState = playerStore((s) => s.playbackState);
  const queueLoading = playerStore((s) => s.queueLoading);
  const error = playerStore((s) => s.error);
  const isPlaying = playbackState === 'playing' || playbackState === 'buffering';
  const isBuffering = playbackState === 'buffering' || playbackState === 'loading';

  return (
    <Pressable
      onPress={togglePlayPause}
      style={({ pressed }) => [
        styles.playPauseButton,
        { backgroundColor: colors.textPrimary },
        pressed && styles.pressed,
      ]}
    >
      {(isBuffering || queueLoading) ? (
        <ActivityIndicator size="small" color={colors.background} />
      ) : (
        <Ionicons
          name={isPlaying ? 'pause' : 'play'}
          size={26}
          color={error ? colors.red : colors.background}
          style={!isPlaying ? styles.playIcon : undefined}
        />
      )}
    </Pressable>
  );
});

/* ------------------------------------------------------------------ */
/*  Skip to previous.                                                  */
/* ------------------------------------------------------------------ */

const PrevButton = memo(function PrevButton({ colors }: { colors: ThemeColors }) {
  const { canSkipPrevious } = useCanSkip();
  return (
    <Pressable
      onPress={skipToPrevious}
      hitSlop={12}
      disabled={!canSkipPrevious}
      style={({ pressed }) => [styles.controlButton, pressed && canSkipPrevious && styles.pressed]}
    >
      <Ionicons
        name="play-back"
        size={30}
        color={canSkipPrevious ? colors.textPrimary : colors.textSecondary}
        style={!canSkipPrevious ? styles.disabled : undefined}
      />
    </Pressable>
  );
});

/* ------------------------------------------------------------------ */
/*  Skip to next.                                                      */
/* ------------------------------------------------------------------ */

const NextButton = memo(function NextButton({ colors }: { colors: ThemeColors }) {
  const { canSkipNext } = useCanSkip();
  const handlePress = useCallback(() => {
    if (canSkipNext) skipToNext();
  }, [canSkipNext]);

  return (
    <Pressable
      onPress={handlePress}
      hitSlop={12}
      disabled={!canSkipNext}
      style={({ pressed }) => [styles.controlButton, pressed && canSkipNext && styles.pressed]}
    >
      <Ionicons
        name="play-forward"
        size={30}
        color={canSkipNext ? colors.textPrimary : colors.textSecondary}
        style={!canSkipNext ? styles.disabled : undefined}
      />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.22,
    shadowRadius: 12,
    elevation: 8,
  },
  band: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  sideLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  coverFavorite: {
    marginLeft: 28,
    padding: 4,
  },
  coverWrap: {
    borderRadius: 10,
  },
  cover: {
    width: COVER_SIZE,
    height: COVER_SIZE,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  coverPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    flex: 1,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 20,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 17,
    marginTop: 2,
    textAlign: 'center',
  },
  progressSection: {
    width: '100%',
    marginTop: 6,
    alignItems: 'center',
  },
  progressInner: {
    width: '80%',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  controlButton: {
    padding: 4,
  },
  playPauseButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    marginLeft: 2,
  },
  pressed: {
    opacity: 0.6,
  },
  disabled: {
    opacity: 0.35,
  },
});
