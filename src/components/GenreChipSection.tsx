import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useRouter } from 'expo-router';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { type ThemeColors } from '../constants/theme';
import { getOfflineSongsByGenre, getOfflineSongsAll } from '../services/searchService';
import { getRandomSongs, type Child } from '../services/subsonicService';
import { playTrack } from '../services/playerService';
import { shuffleArray } from '../utils/arrayHelpers';
import { connectivityStore } from '../store/connectivityStore';
import { genreStore } from '../store/genreStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { selectionAsync } from '../utils/haptics';
import { VIZ_PALETTE } from '../constants/vizColors';

const MAX_GENRE_CHIPS = 8;


/** Deterministic color for a genre name (stable across re-renders/sessions). */
function genreColor(genre: string): string {
  let hash = 0;
  for (let i = 0; i < genre.length; i++) {
    hash = (hash * 31 + genre.charCodeAt(i)) | 0;
  }
  return VIZ_PALETTE[Math.abs(hash) % VIZ_PALETTE.length];
}

/** Fisher-Yates shuffle (in-place, returns same array). */
function isOnline(): boolean {
  const { offlineMode } = offlineModeStore.getState();
  if (offlineMode) return false;
  const { isServerReachable } = connectivityStore.getState();
  return isServerReachable;
}

async function playGenre(genre: string): Promise<boolean> {
  const { listLength } = layoutPreferencesStore.getState();
  let songs: Child[] | null;

  if (isOnline()) {
    songs = await getRandomSongs(listLength, genre);
  } else {
    songs = getOfflineSongsByGenre(genre);
    if (songs) songs = shuffleArray(songs).slice(0, listLength);
  }

  if (!songs || songs.length === 0) return false;

  await playTrack(songs[0], songs);
  return true;
}

interface GenreChipProps {
  genre: string;
  colors: ThemeColors;
}

const GenreChip = memo(function GenreChip({ genre, colors }: GenreChipProps) {
  const [loading, setLoading] = useState(false);
  const color = useMemo(() => genreColor(genre), [genre]);

  // No useEffect-driven entrance animation — see the explanatory comment
  // in `MixItUpChip` below. Starting opacity at 0 and fading in via
  // useEffect leaves the chip invisible whenever the effect misses
  // (double-mount, strict-mode quirks, worklet timing). The chip simply
  // appears at full opacity; the stagger isn't worth a real bug where
  // chips disappear and require an app kill+restart to recover.
  const scale = useSharedValue(1);
  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.96, { damping: 15, stiffness: 150 });
  }, [scale]);
  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, { damping: 15, stiffness: 150 });
  }, [scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = useCallback(async () => {
    if (loading) return;
    selectionAsync();
    setLoading(true);
    try {
      await playGenre(genre);
    } finally {
      setLoading(false);
    }
  }, [genre, loading]);

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={[
          styles.chip,
          {
            backgroundColor: color + '1A',
            borderColor: color + '4D',
          },
        ]}
      >
        {loading && (
          <ActivityIndicator size={12} color={color} />
        )}
        <Text
          style={[styles.chipText, { color: colors.textPrimary }]}
          numberOfLines={1}
        >
          {genre}
        </Text>
        <Ionicons name="play" size={12} color={color} />
      </Pressable>
    </Animated.View>
  );
});

const MixItUpChip = memo(function MixItUpChip({ colors }: { colors: ThemeColors }) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const color = colors.primary;

  // Always-visible primary chip: no useEffect-driven entrance animation like the
  // genre chips have. Starting opacity at 0 and fading in via `useEffect +
  // withTiming` leaves the chip permanently invisible whenever the effect doesn't
  // fire as expected (double-mount, strict-mode quirks, worklet timing).
  const scale = useSharedValue(1);
  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.96, { damping: 15, stiffness: 150 });
  }, [scale]);
  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, { damping: 15, stiffness: 150 });
  }, [scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = useCallback(async () => {
    if (loading) return;
    selectionAsync();
    setLoading(true);
    try {
      const { listLength } = layoutPreferencesStore.getState();
      let songs: Child[] | null;
      if (isOnline()) {
        songs = await getRandomSongs(listLength);
      } else {
        songs = getOfflineSongsAll();
        if (songs) songs = shuffleArray(songs).slice(0, listLength);
      }
      if (songs && songs.length > 0) {
        await playTrack(songs[0], songs);
      }
    } finally {
      setLoading(false);
    }
  }, [loading]);

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={[
          styles.chip,
          {
            backgroundColor: color + '1A',
            borderColor: color + '4D',
          },
        ]}
      >
        {loading ? (
          <ActivityIndicator size={12} color={color} />
        ) : (
          <Ionicons name="shuffle" size={14} color={color} />
        )}
        <Text
          style={[styles.chipText, { color: colors.textPrimary }]}
          numberOfLines={1}
        >
          {t('mixItUp')}
        </Text>
        <Ionicons name="play" size={12} color={color} />
      </Pressable>
    </Animated.View>
  );
});

interface GenreChipSectionProps {
  genreCounts: Record<string, number>;
  colors: ThemeColors;
}

export const GenreChipSection = memo(function GenreChipSection({
  genreCounts,
  colors,
}: GenreChipSectionProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const serverGenres = genreStore((s) => s.genres);
  const offlineMode = offlineModeStore((s) => s.offlineMode);
  const isServerReachable = connectivityStore((s) => s.isServerReachable);
  const online = !offlineMode && isServerReachable;

  const genres = useMemo(() => {
    // Start with listening history genres sorted by play count
    const historyGenres = Object.entries(genreCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([genre]) => genre);

    if (historyGenres.length >= MAX_GENRE_CHIPS) {
      return historyGenres.slice(0, MAX_GENRE_CHIPS);
    }

    // Backfill from server genres (sorted by songCount desc)
    const existing = new Set(historyGenres.map((g) => g.toLowerCase()));
    const result = [...historyGenres];

    if (serverGenres.length > 0) {
      const sorted = [...serverGenres].sort(
        (a, b) => (b.songCount ?? 0) - (a.songCount ?? 0)
      );
      for (const g of sorted) {
        if (result.length >= MAX_GENRE_CHIPS) break;
        if (!existing.has(g.value.toLowerCase())) {
          existing.add(g.value.toLowerCase());
          result.push(g.value);
        }
      }
    }

    return result;
  }, [genreCounts, serverGenres]);

  const handleTunedInPress = useCallback(() => {
    router.push('/tuned-in');
  }, [router]);

  if (genres.length === 0) return null;

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        {online ? (
          <Pressable
            onPress={handleTunedInPress}
            style={({ pressed }) => [{ flex: 1 }, pressed && styles.headerPressed]}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('openTunedIn')}
          >
            <Text style={[styles.title, { color: colors.textPrimary }]}>
              {t('tunedIn')}
            </Text>
          </Pressable>
        ) : (
          <Text style={[styles.title, { color: colors.textPrimary, flex: 1 }]}>
            {t('tunedIn')}
          </Text>
        )}
        {online && (
          <Pressable
            onPress={handleTunedInPress}
            style={({ pressed }) => [styles.chevronButton, pressed && styles.headerPressed]}
            hitSlop={8}
          >
            <Ionicons name="chevron-forward" size={24} color={colors.textSecondary} />
          </Pressable>
        )}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
      >
        <MixItUpChip colors={colors} />
        {genres.map((genre) => (
          <GenreChip
            key={genre}
            genre={genre}
            colors={colors}
          />
        ))}
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  section: {
    marginBottom: 24,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  headerPressed: {
    opacity: 0.6,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
  },
  chevronButton: {
    padding: 4,
  },
  chipRow: {
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 42,
    paddingHorizontal: 14,
    borderRadius: 21,
    borderWidth: 1,
    gap: 8,
    maxWidth: 200,
  },
  chipText: {
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
  },
});
