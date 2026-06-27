import { useMemo } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';

import { BottomSheet } from './BottomSheet';
import { CachedImage } from './CachedImage';
import { useTheme } from '../hooks/useTheme';
import type { AlbumID3, AlbumWithSongsID3, Child } from '../services/subsonicService';
import { formatCompactDuration } from '../utils/formatters';
import { formatLongDate } from '../utils/dateFormat';
import { getGenreNames } from '../utils/genreHelpers';

export interface AlbumDetailsModalProps {
  album: AlbumID3 | AlbumWithSongsID3;
  visible: boolean;
  onClose: () => void;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function hasSongs(album: AlbumID3 | AlbumWithSongsID3): album is AlbumWithSongsID3 {
  return 'song' in album && Array.isArray((album as AlbumWithSongsID3).song);
}

function getMostCommonFormat(songs: Child[]): string | null {
  const counts = new Map<string, number>();
  for (const s of songs) {
    if (s.suffix) {
      const key = s.suffix.toUpperCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  let best = '';
  let max = 0;
  for (const [fmt, count] of counts) {
    if (count > max) {
      best = fmt;
      max = count;
    }
  }
  return best;
}

function getAverageBitrate(songs: Child[]): number | null {
  const rates = songs.filter((s) => s.bitRate != null).map((s) => s.bitRate!);
  if (rates.length === 0) return null;
  return Math.round(rates.reduce((a, b) => a + b, 0) / rates.length);
}

function getTotalSize(songs: Child[]): number | null {
  const sizes = songs.filter((s) => s.size != null).map((s) => s.size!);
  if (sizes.length === 0) return null;
  return sizes.reduce((a, b) => a + b, 0);
}

function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function getDiscCount(songs: Child[]): number {
  const discs = new Set<number>();
  for (const s of songs) {
    discs.add(s.discNumber ?? 1);
  }
  return discs.size;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export function AlbumDetailsModal({ album, visible, onClose }: AlbumDetailsModalProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  const rows = useMemo(() => {
    const result: { label: string; value: string; wide?: boolean }[] = [];

    const artist = album.artist ?? album.displayArtist;
    if (artist) result.push({ label: t('detailArtist'), value: artist });

    if (album.year != null && album.year > 0) {
      result.push({ label: t('detailYear'), value: String(album.year) });
    }

    const genreNames = getGenreNames(album);
    const genre = genreNames.length > 0 ? genreNames.join(', ') : null;
    if (genre) result.push({ label: t('detailGenre'), value: genre, wide: true });

    result.push({ label: t('detailTracks'), value: String(album.songCount) });

    const songs = hasSongs(album) ? album.song ?? [] : [];

    if (songs.length > 0) {
      const discCount = getDiscCount(songs);
      if (discCount > 1) {
        result.push({ label: t('detailDiscs'), value: String(discCount) });
      }
    }

    if (album.duration > 0) {
      result.push({ label: t('detailDuration'), value: formatCompactDuration(album.duration) });
    }

    if (album.playCount != null) {
      result.push({ label: t('detailPlayCount'), value: String(album.playCount) });
    }

    if (songs.length > 0) {
      const format = getMostCommonFormat(songs);
      if (format) result.push({ label: t('detailFormat'), value: format });

      const bitrate = getAverageBitrate(songs);
      if (bitrate != null) result.push({ label: t('detailBitrate'), value: `${bitrate} kbps` });

      const totalSize = getTotalSize(songs);
      if (totalSize != null) result.push({ label: t('detailTotalSize'), value: formatSize(totalSize) });
    }

    if (album.created) {
      result.push({ label: t('detailAdded'), value: formatLongDate(album.created) });
    }

    return result;
  }, [album, t]);

  return (
    <BottomSheet visible={visible} onClose={onClose} maxHeight="60%">
      <View style={styles.header}>
        {album.id && (
          <CachedImage coverArtId={album.coverArt} size={150} style={styles.coverArt} resizeMode="cover" />
        )}
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>
            {t('albumDetails')}
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={1}>
            {album.name}
          </Text>
        </View>
      </View>

      <ScrollView style={styles.scrollArea} bounces={false}>
        {rows.map((row) => (
          <View key={row.label} style={styles.row}>
            <Text style={[styles.label, { color: colors.textSecondary }]}>
              {row.label}
            </Text>
            <Text
              style={[styles.value, row.wide && styles.wideValue, { color: colors.textPrimary }]}
              numberOfLines={row.wide ? 4 : 2}
            >
              {row.value}
            </Text>
          </View>
        ))}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  coverArt: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: 'rgba(128,128,128,0.12)',
    marginRight: 12,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 14,
    fontWeight: '400',
  },
  scrollArea: {
    flexGrow: 0,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  label: {
    fontSize: 16,
    fontWeight: '500',
    flexShrink: 0,
    marginRight: 16,
  },
  value: {
    fontSize: 16,
    fontWeight: '400',
    textAlign: 'right',
    flexShrink: 1,
  },
  wideValue: {
    maxWidth: '55%',
  },
});
