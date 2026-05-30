import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { CachedImage } from './CachedImage';
import { useTheme } from '../hooks/useTheme';
import { playTrack } from '../services/playerService';
import {
  type AlbumID3,
  type ArtistID3,
  type Child,
} from '../services/subsonicService';
import { searchStore } from '../store/searchStore';

import { absoluteFill } from '../utils/styles';
const COVER_SIZE = 150;
const TOTAL_BUDGET = 9;
/** Space reserved below the card so it doesn't sit flush against the
 *  bottom of the screen / safe-area edge. */
const BOTTOM_BREATHING = 16;
/** Floor for the card so it stays usable on tiny screens or when the
 *  keyboard fills most of the viewport. */
const MIN_CARD_HEIGHT = 240;
/** Distance from the header to the top of the card (matches styles.card.marginTop). */
const CARD_TOP_MARGIN = 4;
/** Fraction of the available vertical space the card occupies. Keeps the
 *  dropdown from dominating the viewport on tall screens; the see-more
 *  footer is pinned below the scrolling area so it's always reachable. */
const CARD_HEIGHT_RATIO = 0.75;

/* ------------------------------------------------------------------ */
/*  Result redistribution logic                                       */
/* ------------------------------------------------------------------ */

function getSlotCounts(
  artistCount: number,
  albumCount: number,
  songCount: number
): { artists: number; albums: number; songs: number } {
  const categories = [
    { key: 'artists' as const, count: artistCount },
    { key: 'albums' as const, count: albumCount },
    { key: 'songs' as const, count: songCount },
  ];

  const nonEmpty = categories.filter((c) => c.count > 0);
  if (nonEmpty.length === 0) return { artists: 0, albums: 0, songs: 0 };

  // Distribute total budget among non-empty categories
  const perCategory = Math.floor(TOTAL_BUDGET / nonEmpty.length);
  let remainder = TOTAL_BUDGET - perCategory * nonEmpty.length;

  const slots: Record<string, number> = { artists: 0, albums: 0, songs: 0 };
  for (const cat of nonEmpty) {
    slots[cat.key] = Math.min(cat.count, perCategory + (remainder > 0 ? 1 : 0));
    if (remainder > 0) remainder--;
  }

  return slots as { artists: number; albums: number; songs: number };
}

/* ------------------------------------------------------------------ */
/*  Loading row — used in both the no-prior-results centered branch   */
/*  and the existing-results top-strip branch so the visual is the    */
/*  same in either case.                                              */
/* ------------------------------------------------------------------ */

function LoadingRow({
  colors,
  label,
}: {
  colors: ReturnType<typeof useTheme>['colors'];
  label: string;
}) {
  return (
    <View style={styles.loadingRow}>
      <ActivityIndicator size="small" color={colors.primary} />
      <Text style={[styles.loadingRowText, { color: colors.textSecondary }]}>
        {label}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Compact result rows                                               */
/* ------------------------------------------------------------------ */

function CompactArtistRow({
  artist,
  colors,
  albumCountLabel,
  onPress,
}: {
  artist: ArtistID3;
  colors: ReturnType<typeof useTheme>['colors'];
  albumCountLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.compactRow, pressed && styles.pressed]}
    >
      <CachedImage coverArtId={artist.id} size={COVER_SIZE} style={styles.compactCoverCircle} resizeMode="cover" />
      <View style={styles.compactText}>
        <Text style={[styles.compactPrimary, { color: colors.textPrimary }]} numberOfLines={1}>
          {artist.name}
        </Text>
        <Text style={[styles.compactSecondary, { color: colors.textSecondary }]} numberOfLines={1}>
          {albumCountLabel}
        </Text>
      </View>
    </Pressable>
  );
}

function CompactAlbumRow({
  album,
  colors,
  unknownArtistLabel,
  onPress,
}: {
  album: AlbumID3;
  colors: ReturnType<typeof useTheme>['colors'];
  unknownArtistLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.compactRow, pressed && styles.pressed]}
    >
      <CachedImage coverArtId={album.id} size={COVER_SIZE} style={styles.compactCover} resizeMode="cover" />
      <View style={styles.compactText}>
        <Text style={[styles.compactPrimary, { color: colors.textPrimary }]} numberOfLines={1}>
          {album.name}
        </Text>
        <Text style={[styles.compactSecondary, { color: colors.textSecondary }]} numberOfLines={1}>
          {album.artist ?? unknownArtistLabel}
        </Text>
      </View>
    </Pressable>
  );
}

function CompactSongRow({
  song,
  colors,
  unknownArtistLabel,
  onPress,
}: {
  song: Child;
  colors: ReturnType<typeof useTheme>['colors'];
  unknownArtistLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.compactRow, pressed && styles.pressed]}
    >
      <CachedImage coverArtId={song.albumId ?? song.id} size={COVER_SIZE} style={styles.compactCover} resizeMode="cover" />
      <View style={styles.compactText}>
        <Text style={[styles.compactPrimary, { color: colors.textPrimary }]} numberOfLines={1}>
          {song.title}
        </Text>
        <Text style={[styles.compactSecondary, { color: colors.textSecondary }]} numberOfLines={1}>
          {song.artist ?? unknownArtistLabel}
        </Text>
      </View>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/*  SearchResultsOverlay                                              */
/* ------------------------------------------------------------------ */

export function SearchResultsOverlay() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const isOverlayVisible = searchStore((s) => s.isOverlayVisible);
  const results = searchStore((s) => s.results);
  const loading = searchStore((s) => s.loading);
  const query = searchStore((s) => s.query);
  const headerHeight = searchStore((s) => s.headerHeight);
  const hideOverlay = searchStore((s) => s.hideOverlay);

  // Track the on-screen keyboard so the card can shrink to stay
  // above it. When the keyboard is up the bottom safe-area inset is
  // typically subsumed by the keyboard's frame, so we take the max of
  // both rather than adding them.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Card max-height: 75% of the space between the header bottom and the
  // top of whichever is higher (keyboard / bottom safe-area inset). The
  // see-more button is rendered as a pinned footer below the scrolling
  // list, so capping at 75% keeps the dropdown from dominating the
  // viewport while still showing enough rows above the always-visible
  // see-more action. Floor at MIN_CARD_HEIGHT so small phones (landscape
  // with keyboard up) still get a usable dropdown; clamp to the actual
  // available space so the card never overflows the viewport on a
  // genuinely tiny screen.
  const maxCardHeight = useMemo(() => {
    const bottomReserved = Math.max(keyboardHeight, insets.bottom);
    const available = windowHeight - headerHeight - bottomReserved - BOTTOM_BREATHING - CARD_TOP_MARGIN;
    const target = Math.floor(available * CARD_HEIGHT_RATIO);
    return Math.min(available, Math.max(MIN_CARD_HEIGHT, target));
  }, [windowHeight, headerHeight, insets.bottom, keyboardHeight]);

  const slots = useMemo(
    () =>
      getSlotCounts(
        results.artists.length,
        results.albums.length,
        results.songs.length
      ),
    [results.artists.length, results.albums.length, results.songs.length]
  );

  const hasResults =
    results.artists.length > 0 ||
    results.albums.length > 0 ||
    results.songs.length > 0;

  const handleBackdropPress = useCallback(() => {
    hideOverlay();
    Keyboard.dismiss();
  }, [hideOverlay]);

  const handleSeeMore = useCallback(() => {
    hideOverlay();
    Keyboard.dismiss();
    router.push('/(tabs)/search');
  }, [hideOverlay, router]);

  const navigateToArtist = useCallback(
    (id: string) => {
      hideOverlay();
      Keyboard.dismiss();
      router.push(`/artist/${id}`);
    },
    [hideOverlay, router]
  );

  const navigateToAlbum = useCallback(
    (id: string) => {
      hideOverlay();
      Keyboard.dismiss();
      router.push(`/album/${id}`);
    },
    [hideOverlay, router]
  );

  const handlePlaySong = useCallback(
    (song: Child) => {
      hideOverlay();
      Keyboard.dismiss();
      playTrack(song, [song]);
    },
    [hideOverlay]
  );

  if (!isOverlayVisible || !query.trim()) return null;

  return (
    <View style={[styles.overlay, { top: headerHeight }]}>
      {/* Backdrop */}
      <Pressable style={styles.backdrop} onPress={handleBackdropPress} />

      {/* Results card */}
      <View style={[styles.card, { backgroundColor: colors.card, maxHeight: maxCardHeight }]}>
        {loading && !hasResults ? (
          // First search with no prior results: same loading row,
          // centered vertically in the card body.
          <View style={styles.loadingContainer}>
            <LoadingRow colors={colors} label={t('searching')} />
          </View>
        ) : !hasResults && query.trim() ? (
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {t('noResultsFound')}
            </Text>
          </View>
        ) : (
          <>
          {/* New search in flight while previous results stay visible
              underneath. Same LoadingRow as the no-prior-results case
              so the visual is consistent — just placed as a top strip
              with a hairline divider below it. Empty queries don't
              reach this branch (early return on !query.trim()). */}
          {loading && (
            <View style={[styles.loadingStrip, { borderBottomColor: colors.border }]}>
              <LoadingRow colors={colors} label={t('searching')} />
            </View>
          )}
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            // "always" not "handled": the latter is documented to fire
            // Pressable onPress on the first tap when the keyboard is up,
            // but a known RN/Android quirk swallows the first tap in
            // nested-Pressable-inside-ScrollView setups like this one,
            // so the row taps were no-oping and the overlay never closed.
            // Every tap handler in this overlay already calls
            // Keyboard.dismiss() explicitly, so we don't need implicit
            // auto-dismiss.
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
          >
            {/* Artists */}
            {slots.artists > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.label }]}>
                  {t('artists')}
                </Text>
                {results.artists.slice(0, slots.artists).map((artist) => (
                  <CompactArtistRow
                    key={artist.id}
                    artist={artist}
                    colors={colors}
                    albumCountLabel={t('albumCount', { count: artist.albumCount ?? 0 })}
                    onPress={() => navigateToArtist(artist.id)}
                  />
                ))}
              </View>
            )}

            {/* Albums */}
            {slots.albums > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.label }]}>
                  {t('albums')}
                </Text>
                {results.albums.slice(0, slots.albums).map((album) => (
                  <CompactAlbumRow
                    key={album.id}
                    album={album}
                    colors={colors}
                    unknownArtistLabel={t('unknownArtist')}
                    onPress={() => navigateToAlbum(album.id)}
                  />
                ))}
              </View>
            )}

            {/* Songs */}
            {slots.songs > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.label }]}>
                  {t('songs')}
                </Text>
                {results.songs.slice(0, slots.songs).map((song, index) => (
                  <CompactSongRow
                    key={`${song.id}-${index}`}
                    song={song}
                    colors={colors}
                    unknownArtistLabel={t('unknownArtist')}
                    onPress={() => handlePlaySong(song)}
                  />
                ))}
              </View>
            )}

          </ScrollView>
          {/* See-more footer: always pinned at the bottom of the card so
              the user can reach it without scrolling, even when the
              results list overflows the 75% card height above. */}
          <Pressable
            onPress={handleSeeMore}
            style={({ pressed }) => [
              styles.seeMoreButton,
              { borderTopColor: colors.border },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.seeMoreText, { color: colors.primary }]}>
              {t('seeMoreResults')}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={colors.primary} />
          </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                            */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
    elevation: 100,
  },
  backdrop: {
    ...absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  card: {
    marginHorizontal: 12,
    marginTop: CARD_TOP_MARGIN,
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  scroll: {
    // Lets the ScrollView shrink to make room for the pinned see-more
    // footer when the card hits its maxHeight, while still sizing to
    // content when there are only a few results.
    flexShrink: 1,
  },
  scrollContent: {
    paddingVertical: 8,
  },
  loadingContainer: {
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingStrip: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadingRowText: {
    fontSize: 13,
  },
  emptyContainer: {
    padding: 24,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
  },
  section: {
    paddingHorizontal: 12,
    marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
    marginTop: 8,
    marginLeft: 4,
  },
  compactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: 8,
  },
  pressed: {
    opacity: 0.7,
  },
  compactCover: {
    width: 40,
    height: 40,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  compactCoverCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  compactText: {
    flex: 1,
    marginLeft: 10,
  },
  compactPrimary: {
    fontSize: 14,
    fontWeight: '500',
  },
  compactSecondary: {
    fontSize: 12,
    marginTop: 1,
  },
  seeMoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    // Hairline divider so the pinned footer reads as a separate region
    // from the scrolling list above it.
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  seeMoreText: {
    fontSize: 14,
    fontWeight: '600',
    marginRight: 4,
  },
});
