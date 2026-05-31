import Ionicons from "@react-native-vector-icons/ionicons/static";
import { Stack, useNavigation, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector, Pressable as GHPressable } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BookmarkButton } from '../components/BookmarkButton';
import { CachedImage } from '../components/CachedImage';
import { FavoriteButton } from '../components/FavoriteButton';
import { EmptyState } from '../components/EmptyState';
import { MarqueeText } from '../components/MarqueeText';
import { MoreOptionsButton } from '../components/MoreOptionsButton';
import { PlaybackRateButton } from '../components/PlaybackRateButton';
import { PlayerProgressBar } from '../components/PlayerProgressBar';
import { RepeatButton } from '../components/RepeatButton';
import { ShuffleButton } from '../components/ShuffleButton';
import { ShuffleOverlay } from '../components/ShuffleOverlay';
import { SkipIntervalButton } from '../components/SkipIntervalButton';
import { SleepTimerButton } from '../components/SleepTimerButton';
import { SleepTimerCapsule } from '../components/SleepTimerCapsule';
import { UpNextPanel } from '../components/UpNextPanel';
import { type ThemeColors } from '../constants/theme';
import { useCanSkip } from '../hooks/useCanSkip';
import { useImagePalette } from '../hooks/useImagePalette';
import { usePlayerActions } from '../hooks/usePlayerActions';
import { useShuffleOverlay } from '../hooks/useShuffleOverlay';
import { useTheme } from '../hooks/useTheme';
import {
  clearQueue,
  retryPlayback,
  skipToNext,
  skipToPrevious,
  togglePlayPause,
} from '../services/playerService';
import { type Child } from '../services/subsonicService';
import { moreOptionsStore } from '../store/moreOptionsStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { playbackSettingsStore } from '../store/playbackSettingsStore';
import { playerStore } from '../store/playerStore';
import { mixHexColors } from '../utils/colors';
import { absoluteFill } from '../utils/styles';

const HERO_PADDING = 24;
const HERO_COVER_SIZE = 600;
const HEADER_BAR_HEIGHT = Platform.OS === 'ios' ? 44 : 56;
const STRIP_HEIGHT = 112;
const COLUMN_GAP = 24;
const LOW_PEEK_HEIGHT = 160; // collapsed sheet — handle + toggle only
const ART_MAX = 440;

/**
 * Tablet-portrait full-screen Now Playing. A large hero + controls up top with
 * an inline draggable "Up Next" panel (Queue/Info/Lyrics) below. As the panel
 * is dragged to full, the hero collapses into a compact control strip so
 * play/pause + scrubber stay reachable. Used by the /player route only on
 * tablets in portrait (see useIsTabletPortrait); phone + landscape are unchanged.
 */
export function TabletPortraitPlayer() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const router = useRouter();
  const { height: screenH, width: screenW } = useWindowDimensions();

  const currentTrack = playerStore((s) => s.currentTrack);
  const currentTrackIndex = playerStore((s) => s.currentTrackIndex);
  const queue = playerStore((s) => s.queue);
  const offlineMode = offlineModeStore((s) => s.offlineMode);

  const onClose = useCallback(() => router.back(), [router]);

  const onClearConfirmed = useCallback(() => {
    onClose();
    setTimeout(() => clearQueue(), 350);
  }, [onClose]);

  const {
    handleSeek,
    handleQueueItemPress,
    handleQueueItemLongPress,
    handleShareQueue,
    handleClearQueue,
  } = usePlayerActions({ source: 'player', onClearConfirmed });

  const {
    shuffling,
    handleShuffle,
    overlayStyle,
    spinStyle,
  } = useShuffleOverlay();

  // Auto-dismiss when the queue is externally cleared while this screen is open.
  const [wasPopulated, setWasPopulated] = useState(false);
  useEffect(() => {
    if (currentTrack) {
      setWasPopulated(true);
    } else if (wasPopulated) {
      onClose();
    }
  }, [currentTrack, wasPopulated, onClose]);

  const { primary, secondary, gradientOpacity } = useImagePalette(
    currentTrack ? (currentTrack.albumId ?? currentTrack.id) : undefined,
  );
  const gradientTopColor = secondary ?? primary ?? colors.background;
  const gradientColors: readonly [string, string, ...string[]] = [gradientTopColor, colors.background];
  const gradientLocations: readonly [number, number, ...number[]] = [0, 0.6];

  const gradientAnimatedStyle = useAnimatedStyle(() => ({
    opacity: gradientOpacity.value,
  }));

  /* ---- Header: dismiss + more options ---- */
  useEffect(() => {
    if (Platform.OS === 'ios') return;
    navigation.setOptions({
      headerLeft: () => (
        <GHPressable
          onPress={onClose}
          hitSlop={12}
          style={({ pressed }) => [{ opacity: 1 }, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-down" size={28} color={colors.textPrimary} />
        </GHPressable>
      ),
      headerRight: () =>
        currentTrack ? (
          <MoreOptionsButton
            onPress={() =>
              moreOptionsStore.getState().show({ type: 'song', item: currentTrack }, 'player')
            }
            color={colors.textPrimary}
          />
        ) : null,
    });
  }, [currentTrack, navigation, onClose, colors.textPrimary]);

  /* ---- Layout: a horizontal band (art left, controls right) centered in the
     space above the sheet. Three detents: low (pulled down) / default / full
     (band collapses into the strip). ---- */
  const headerSpace = insets.top + HEADER_BAR_HEIGHT;

  // Prominent square art on the left, capped so the right column keeps room for
  // the controls on narrower tablets.
  const artSize = Math.min(
    Math.round((screenW - 2 * HERO_PADDING - COLUMN_GAP) * 0.5),
    ART_MAX,
  );

  const fullHeight = Math.max(screenH - headerSpace - STRIP_HEIGHT, 320);
  const defaultHeight = Math.min(
    Math.max(Math.round(screenH * 0.44), LOW_PEEK_HEIGHT + 120),
    fullHeight - 80,
  );

  const panelHeight = useSharedValue(defaultHeight);
  const startHeight = useSharedValue(0);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          'worklet';
          startHeight.value = panelHeight.value;
        })
        .onUpdate((e) => {
          'worklet';
          const next = startHeight.value - e.translationY;
          panelHeight.value = Math.min(fullHeight, Math.max(LOW_PEEK_HEIGHT, next));
        })
        .onEnd((e) => {
          'worklet';
          const projected = panelHeight.value - e.velocityY * 0.08;
          const dLow = Math.abs(projected - LOW_PEEK_HEIGHT);
          const dDef = Math.abs(projected - defaultHeight);
          const dFull = Math.abs(projected - fullHeight);
          let target = LOW_PEEK_HEIGHT;
          if (dDef <= dLow && dDef <= dFull) target = defaultHeight;
          else if (dFull <= dLow && dFull <= dDef) target = fullHeight;
          panelHeight.value = withSpring(target, { damping: 28, stiffness: 220, mass: 0.9 });
        }),
    [defaultHeight, fullHeight, panelHeight, startHeight],
  );

  // Band fades out as the sheet expands to full; it also rides to stay
  // vertically centered in the (shrinking/growing) space above the sheet.
  const fullContentStyle = useAnimatedStyle(() => {
    const c = interpolate(panelHeight.value, [defaultHeight, fullHeight], [0, 1], Extrapolation.CLAMP);
    const centerY = (headerSpace - panelHeight.value) / 2;
    return {
      opacity: 1 - c,
      transform: [{ translateY: centerY - 16 * c }],
      pointerEvents: c < 0.5 ? ('auto' as const) : ('none' as const),
    };
  }, [defaultHeight, fullHeight, headerSpace]);

  const stripStyle = useAnimatedStyle(() => {
    const c = interpolate(panelHeight.value, [defaultHeight, fullHeight], [0, 1], Extrapolation.CLAMP);
    return {
      opacity: c,
      pointerEvents: c > 0.5 ? ('auto' as const) : ('none' as const),
    };
  }, [defaultHeight, fullHeight]);

  const queueColors = useMemo(
    () => ({ ...colors, primary: mixHexColors(colors.primary, colors.textPrimary, 0.45) }),
    [colors],
  );

  if (!currentTrack) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <EmptyState
          icon="musical-notes-outline"
          title={t('nothingPlaying')}
          subtitle={t('nothingPlayingSubtitle')}
        />
      </View>
    );
  }

  return (
    <>
      {Platform.OS === 'ios' && (
        <>
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button icon="chevron.down" onPress={onClose} />
          </Stack.Toolbar>
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button
              icon="ellipsis"
              onPress={() => moreOptionsStore.getState().show({ type: 'song', item: currentTrack }, 'player')}
            />
          </Stack.Toolbar>
        </>
      )}
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {/* Gradient background */}
        <View style={[absoluteFill, { backgroundColor: colors.background }]} />
        <Animated.View style={[absoluteFill, gradientAnimatedStyle]} pointerEvents="none">
          <LinearGradient colors={gradientColors} locations={gradientLocations} style={absoluteFill} />
        </Animated.View>

        {/* Top band: cover art (left) + info/progress/controls (right).
            Collapses into the compact strip as the panel expands. */}
        <Animated.View style={[styles.fullContent, fullContentStyle]}>
          <View style={styles.band}>
            <View style={[styles.heroImageWrap, { width: artSize, height: artSize }]}>
              <CachedImage
                coverArtId={currentTrack.albumId ?? currentTrack.id}
                size={HERO_COVER_SIZE}
                style={styles.heroImage}
                resizeMode="cover"
              />
              <View style={styles.sleepCapsuleOverlay} pointerEvents="box-none">
                <SleepTimerCapsule />
              </View>
            </View>

            <View style={styles.bandContent}>
              <View style={styles.trackInfoRow}>
                <View style={styles.trackInfoText}>
                  <MarqueeText style={[styles.trackTitle, { color: colors.textPrimary }]}>
                    {currentTrack.title}
                  </MarqueeText>
                  <Text style={[styles.trackArtist, { color: colors.textSecondary }]} numberOfLines={1}>
                    {currentTrack.artist ?? t('unknownArtist')}
                  </Text>
                </View>
                <FavoriteButton trackId={currentTrack.id} style={styles.favoriteButton} />
              </View>

              <View style={styles.progressSection}>
                <ProgressBar colors={colors} handleSeek={handleSeek} />
              </View>

              <PlaybackControls
                colors={colors}
                shuffling={shuffling}
                handleShuffle={handleShuffle}
                queueLength={queue.length}
              />
            </View>
          </View>
        </Animated.View>

        {/* Compact strip — fades in when the panel is full */}
        <Animated.View
          style={[styles.strip, { top: headerSpace, height: STRIP_HEIGHT }, stripStyle]}
        >
          <View style={styles.stripRow}>
            <CachedImage
              coverArtId={currentTrack.albumId ?? currentTrack.id}
              size={150}
              style={styles.stripArt}
              resizeMode="cover"
            />
            <View style={styles.stripInfo}>
              <MarqueeText style={[styles.stripTitle, { color: colors.textPrimary }]}>
                {currentTrack.title}
              </MarqueeText>
              <Text style={[styles.stripArtist, { color: colors.textSecondary }]} numberOfLines={1}>
                {currentTrack.artist ?? t('unknownArtist')}
              </Text>
            </View>
            <StripPlayButton colors={colors} />
          </View>
          <View style={styles.stripProgress}>
            <ProgressBar colors={colors} handleSeek={handleSeek} />
          </View>
        </Animated.View>

        {/* Up Next panel */}
        <UpNextPanel
          panelHeight={panelHeight}
          maxHeight={fullHeight}
          panGesture={panGesture}
          currentTrack={currentTrack}
          queue={queue}
          currentTrackIndex={currentTrackIndex}
          colors={colors}
          queueColors={queueColors}
          offlineMode={offlineMode}
          onQueueItemPress={handleQueueItemPress}
          onQueueItemLongPress={handleQueueItemLongPress}
          onShareQueue={handleShareQueue}
          onClearQueue={handleClearQueue}
        />

        {/* Shuffle overlay */}
        <ShuffleOverlay
          visible={shuffling}
          overlayStyle={overlayStyle}
          spinStyle={spinStyle}
          colors={colors}
        />
      </View>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Progress bar (subscribes to playback position)                     */
/* ------------------------------------------------------------------ */

const ProgressBar = memo(function ProgressBar({
  colors,
  handleSeek,
}: {
  colors: ThemeColors;
  handleSeek: (seconds: number) => void;
}) {
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
      onSeek={handleSeek}
      isBuffering={isBuffering}
      error={error}
      retrying={retrying}
      onRetry={retryPlayback}
    />
  );
});

/* ------------------------------------------------------------------ */
/*  Playback controls (two rows)                                       */
/* ------------------------------------------------------------------ */

const PlaybackControls = memo(function PlaybackControls({
  colors,
  shuffling,
  handleShuffle,
  queueLength,
}: {
  colors: ThemeColors;
  shuffling: boolean;
  handleShuffle: () => void;
  queueLength: number;
}) {
  const playbackState = playerStore((s) => s.playbackState);
  const showSkipInterval = playbackSettingsStore((s) => s.showSkipIntervalButtons);
  const showSleepTimer = playbackSettingsStore((s) => s.showSleepTimerButton);
  const { canSkipNext, canSkipPrevious } = useCanSkip();

  const isPlaying = playbackState === 'playing' || playbackState === 'buffering';
  const isBuffering = playbackState === 'buffering' || playbackState === 'loading';

  return (
    <>
      <View style={styles.controls}>
        <View style={styles.controlSideLeft}>
          <ShuffleButton
            onPress={handleShuffle}
            disabled={shuffling || queueLength < 2}
            size={28}
          />
        </View>

        <View style={styles.transportControls}>
          <Pressable
            onPress={skipToPrevious}
            hitSlop={12}
            disabled={!canSkipPrevious}
            style={({ pressed }) => [pressed && styles.pressed, !canSkipPrevious && styles.disabled]}
          >
            <Ionicons
              name="play-back"
              size={32}
              color={canSkipPrevious ? colors.textPrimary : colors.textSecondary}
            />
          </Pressable>

          <Pressable
            onPress={togglePlayPause}
            style={({ pressed }) => [
              styles.playPauseButton,
              { backgroundColor: colors.textPrimary },
              pressed && styles.playPausePressed,
            ]}
          >
            {isBuffering ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Ionicons
                name={isPlaying ? 'pause' : 'play'}
                size={34}
                color={colors.background}
                style={!isPlaying ? styles.playIcon : undefined}
              />
            )}
          </Pressable>

          <Pressable
            onPress={skipToNext}
            hitSlop={12}
            disabled={!canSkipNext}
            style={({ pressed }) => [pressed && styles.pressed, !canSkipNext && styles.disabled]}
          >
            <Ionicons
              name="play-forward"
              size={32}
              color={canSkipNext ? colors.textPrimary : colors.textSecondary}
            />
          </Pressable>
        </View>

        <View style={styles.controlSideRight}>
          <RepeatButton />
        </View>
      </View>

      <View style={styles.secondaryControls}>
        <View style={[styles.controlSideLeft, styles.secondaryLeftInset]}>
          {showSleepTimer && <SleepTimerButton />}
        </View>
        <View style={[styles.secondaryCenter, styles.secondaryCenterRow]}>
          {showSkipInterval && <SkipIntervalButton direction="backward" size={32} />}
          <View style={styles.secondaryRateSlot}>
            <PlaybackRateButton />
          </View>
          {showSkipInterval && <SkipIntervalButton direction="forward" size={32} />}
        </View>
        <View style={styles.controlSideRight}>
          <BookmarkButton style={styles.favoriteButton} />
        </View>
      </View>
    </>
  );
});

/* ------------------------------------------------------------------ */
/*  Compact-strip play/pause                                           */
/* ------------------------------------------------------------------ */

const StripPlayButton = memo(function StripPlayButton({ colors }: { colors: ThemeColors }) {
  const playbackState = playerStore((s) => s.playbackState);
  const isPlaying = playbackState === 'playing' || playbackState === 'buffering';
  const isBuffering = playbackState === 'buffering' || playbackState === 'loading';

  return (
    <Pressable
      onPress={togglePlayPause}
      hitSlop={8}
      style={({ pressed }) => [pressed && styles.pressed]}
    >
      {isBuffering ? (
        <ActivityIndicator size="small" color={colors.textPrimary} />
      ) : (
        <Ionicons
          name={isPlaying ? 'pause' : 'play'}
          size={30}
          color={colors.textPrimary}
        />
      )}
    </Pressable>
  );
});

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  fullContent: {
    ...absoluteFill,
    paddingHorizontal: HERO_PADDING,
    justifyContent: 'center',
  },
  band: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: COLUMN_GAP,
  },
  bandContent: {
    flex: 1,
    justifyContent: 'center',
  },
  heroImageWrap: {
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.06)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 18,
    elevation: 12,
  },
  heroImage: {
    width: '100%',
    height: '100%',
  },
  sleepCapsuleOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  trackInfoText: {
    flex: 1,
    minWidth: 0,
  },
  trackTitle: {
    fontSize: 24,
    fontWeight: '700',
  },
  trackArtist: {
    fontSize: 17,
    marginTop: 4,
  },
  favoriteButton: {
    paddingLeft: 12,
    paddingVertical: 4,
  },
  secondaryLeftInset: {
    paddingLeft: 4,
  },
  progressSection: {
    width: '100%',
    marginBottom: 8,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
  },
  controlSideLeft: {
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  controlSideRight: {
    flex: 1,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  transportControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    width: 248,
  },
  secondaryControls: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    marginTop: 20,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
  },
  secondaryCenter: {
    width: 248,
  },
  secondaryCenterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
  },
  secondaryRateSlot: {
    width: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playPauseButton: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playPausePressed: {
    opacity: 0.7,
  },
  playIcon: {
    marginLeft: 3,
  },
  strip: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: HERO_PADDING,
    justifyContent: 'center',
  },
  stripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stripArt: {
    width: 44,
    height: 44,
    borderRadius: 6,
  },
  stripInfo: {
    flex: 1,
    minWidth: 0,
  },
  stripTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  stripArtist: {
    fontSize: 13,
    marginTop: 2,
  },
  stripProgress: {
    marginTop: 8,
  },
  pressed: {
    opacity: 0.6,
  },
  disabled: {
    opacity: 0.4,
  },
});
