import { useMemo } from 'react';

import { type Child } from '../services/subsonicService';
import { type AnalyticsAggregates } from '../store/completedScrobbleStore';
import { dateKey, offsetDateKey } from '../utils/dateKey';
import { getPrimaryGenre } from '../utils/genreHelpers';

// Re-export so consumers that imported from this file historically keep
// working without touching every call site.
export { dateKey } from '../utils/dateKey';

export type TimePeriod = '7d' | '30d' | '90d' | 'all';

export interface ScrobbleRecord {
  id: string;
  song: Child;
  time: number;
}

interface DailyActivity {
  date: string;
  count: number;
}

interface TopSong {
  song: Child;
  count: number;
}

interface TopArtist {
  artist: string;
  count: number;
  /** Subsonic artistId when known; absent for old aggregate rows or scrobbles without artistId. */
  artistId?: string;
}

interface TopAlbum {
  album: string;
  artist: string;
  coverArt?: string;
  count: number;
  /** Subsonic albumId when known; absent for old aggregate rows or scrobbles without albumId. */
  albumId?: string;
}

interface GenreSlice {
  genre: string;
  count: number;
  percentage: number;
}

interface PlaybackAnalytics {
  totalPlays: number;
  totalListeningSeconds: number;
  uniqueArtists: number;
  uniqueAlbums: number;
  longestStreak: number;
  currentStreak: number;
  dailyActivity: DailyActivity[];
  hourlyDistribution: number[];
  topSongs: TopSong[];
  topArtists: TopArtist[];
  topAlbums: TopAlbum[];
  genreBreakdown: GenreSlice[];
  heatmapData: DailyActivity[];
  peakHour: number;
  averagePlaysPerDay: number;
}

const PERIOD_DAYS: Record<TimePeriod, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
};

const HEATMAP_WEEKS = 16;

export function computeStreaks(input: Pick<ScrobbleRecord, 'time'>[] | string[]): {
  longest: number;
  current: number;
} {
  if (input.length === 0) return { longest: 0, current: 0 };

  let daySet: Set<string>;
  if (typeof input[0] === 'string') {
    daySet = new Set(input as string[]);
  } else {
    daySet = new Set<string>();
    for (const s of input as Pick<ScrobbleRecord, 'time'>[]) {
      daySet.add(dateKey(s.time));
    }
  }

  const sortedDays = Array.from(daySet).sort();

  let longest = 1;
  let streak = 1;

  for (let i = 1; i < sortedDays.length; i++) {
    if (sortedDays[i] === offsetDateKey(sortedDays[i - 1], 1)) {
      streak++;
    } else {
      streak = 1;
    }
    if (streak > longest) longest = streak;
  }

  let current = 0;
  let checkKey = dateKey(Date.now());
  while (daySet.has(checkKey)) {
    current++;
    checkKey = offsetDateKey(checkKey, -1);
  }
  if (current === 0) {
    checkKey = offsetDateKey(dateKey(Date.now()), -1);
    while (daySet.has(checkKey)) {
      current++;
      checkKey = offsetDateKey(checkKey, -1);
    }
  }

  return { longest, current };
}

function buildGenreBreakdown(genreCounts: Map<string, number> | Record<string, number>): GenreSlice[] {
  const entries = genreCounts instanceof Map
    ? Array.from(genreCounts.entries())
    : Object.entries(genreCounts);

  const sortedGenres = entries
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count);

  const totalWithGenre = sortedGenres.reduce((sum, g) => sum + g.count, 0);

  if (sortedGenres.length <= 6) {
    return sortedGenres.map((g) => ({
      ...g,
      percentage: totalWithGenre > 0 ? (g.count / totalWithGenre) * 100 : 0,
    }));
  }

  const top = sortedGenres.slice(0, 5);
  const otherCount = sortedGenres.slice(5).reduce((sum, g) => sum + g.count, 0);
  return [
    ...top.map((g) => ({
      ...g,
      percentage: totalWithGenre > 0 ? (g.count / totalWithGenre) * 100 : 0,
    })),
    {
      genre: 'Other',
      count: otherCount,
      percentage: totalWithGenre > 0 ? (otherCount / totalWithGenre) * 100 : 0,
    },
  ];
}

function computePeakHour(hourBuckets: number[]): number {
  let peakHour = 0;
  let peakCount = 0;
  for (let h = 0; h < 24; h++) {
    if (hourBuckets[h] > peakCount) {
      peakCount = hourBuckets[h];
      peakHour = h;
    }
  }
  return peakHour;
}

export function usePlaybackAnalytics(
  scrobbles: ScrobbleRecord[],
  period: TimePeriod,
  pendingScrobbles?: Pick<ScrobbleRecord, 'time'>[],
  aggregates?: AnalyticsAggregates,
): PlaybackAnalytics {
  // Stable per-calendar-day key. Drives recomputation across midnight
  // so the streak doesn't show yesterday's "current streak" until the
  // user navigates away and back. Cheap — dateKey(Date.now()) is a
  // handful of integer ops per render, and the equality check upstream
  // means the memo only re-runs on actual day rollover.
  const todayKey = dateKey(Date.now());

  // Period-independent: heatmap + streaks (always use all data)
  const periodIndependent = useMemo(() => {
    // Heatmap
    const heatmapDays = HEATMAP_WEEKS * 7;
    const heatmapData: DailyActivity[] = [];
    const today = new Date();
    const todayDay = today.getDay();
    const gridEnd = new Date(today);
    gridEnd.setDate(gridEnd.getDate() + (6 - todayDay));
    gridEnd.setHours(0, 0, 0, 0);
    const gridStart = new Date(gridEnd);
    gridStart.setDate(gridStart.getDate() - heatmapDays + 1);

    if (aggregates?.dayCounts && Object.keys(aggregates.dayCounts).length > 0) {
      // Use pre-computed day counts — O(112) iterations
      for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) {
        const dk = dateKey(d.getTime());
        heatmapData.push({ date: dk, count: aggregates.dayCounts[dk] ?? 0 });
      }
    } else {
      // Fallback: iterate all scrobbles
      const allDayCounts = new Map<string, number>();
      for (const s of scrobbles) {
        const dk = dateKey(s.time);
        allDayCounts.set(dk, (allDayCounts.get(dk) ?? 0) + 1);
      }
      for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) {
        const dk = dateKey(d.getTime());
        heatmapData.push({ date: dk, count: allDayCounts.get(dk) ?? 0 });
      }
    }

    // Streaks
    const allPending = pendingScrobbles ?? [];
    let streaks: { longest: number; current: number };
    if (aggregates?.dayCounts && Object.keys(aggregates.dayCounts).length > 0) {
      const dayKeys = new Set(Object.keys(aggregates.dayCounts));
      for (const s of allPending) dayKeys.add(dateKey(s.time));
      streaks = computeStreaks(Array.from(dayKeys));
    } else {
      streaks = computeStreaks([...scrobbles, ...allPending]);
    }

    return { heatmapData, ...streaks };
  }, [aggregates, scrobbles, pendingScrobbles, todayKey]);

  // Period-dependent: stats, tops, charts
  const periodDependent = useMemo(() => {
    const periodDays = PERIOD_DAYS[period];

    // "all" period with aggregates: use pre-computed data
    if (!periodDays && aggregates?.dayCounts && Object.keys(aggregates.dayCounts).length > 0) {
      let totalListeningSeconds = 0;
      for (const entry of Object.values(aggregates.songCounts)) {
        totalListeningSeconds += (entry.song.duration ?? 0) * entry.count;
      }

      const topSongs = Object.values(aggregates.songCounts)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const topArtists = Object.entries(aggregates.artistCounts)
        .map(([artist, val]) => ({ artist, count: val.count, artistId: val.artistId }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const topAlbums = Object.entries(aggregates.albumCounts)
        .map(([key, val]) => ({
          album: key.split('::')[0],
          artist: val.artist,
          coverArt: val.coverArt,
          count: val.count,
          albumId: val.albumId,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      const genreBreakdown = buildGenreBreakdown(aggregates.genreCounts);

      const totalPlays = Object.values(aggregates.dayCounts).reduce((sum, c) => sum + c, 0);
      const uniqueDays = Object.keys(aggregates.dayCounts).length;

      const dailyActivity: DailyActivity[] = [];
      const activityDays = 90;
      // Walk back day-by-day using calendar component arithmetic so a DST
      // transition can't skip or duplicate a date. Fixed 86_400_000 ms
      // steps would silently drop the transition day (the local day is
      // 23 or 25 hours, not 24).
      const todayKey = dateKey(Date.now());
      for (let i = activityDays - 1; i >= 0; i--) {
        const dk = offsetDateKey(todayKey, -i);
        dailyActivity.push({ date: dk, count: aggregates.dayCounts[dk] ?? 0 });
      }

      return {
        totalPlays,
        totalListeningSeconds,
        uniqueArtists: Object.keys(aggregates.artistCounts).length,
        uniqueAlbums: Object.keys(aggregates.albumCounts).length,
        dailyActivity,
        hourlyDistribution: aggregates.hourBuckets,
        topSongs,
        topArtists,
        topAlbums,
        genreBreakdown,
        peakHour: computePeakHour(aggregates.hourBuckets),
        averagePlaysPerDay: uniqueDays > 0 ? Math.round((totalPlays / uniqueDays) * 10) / 10 : 0,
      };
    }

    // Filter-based path: period-specific or no aggregates
    const cutoff = periodDays
      ? Date.now() - periodDays * 86_400_000
      : 0;

    const filtered = periodDays
      ? scrobbles.filter((s) => s.time >= cutoff)
      : scrobbles;

    const totalPlays = filtered.length;

    let totalListeningSeconds = 0;
    const artistCounts = new Map<string, { count: number; artistId?: string }>();
    const albumCounts = new Map<string, { artist: string; coverArt?: string; count: number; albumId?: string }>();
    const songCounts = new Map<string, { song: Child; count: number }>();
    const genreCounts = new Map<string, number>();
    const hourBuckets = new Array<number>(24).fill(0);
    const dayCounts = new Map<string, number>();

    for (const s of filtered) {
      if (s.song.duration) {
        totalListeningSeconds += s.song.duration;
      }

      const artist = s.song.artist ?? 'Unknown';
      const existingArtist = artistCounts.get(artist);
      if (existingArtist) {
        existingArtist.count++;
        if (!existingArtist.artistId && s.song.artistId) {
          existingArtist.artistId = s.song.artistId;
        }
      } else {
        artistCounts.set(artist, { count: 1, artistId: s.song.artistId ?? undefined });
      }

      const albumKey = `${s.song.album ?? 'Unknown'}::${artist}`;
      const existing = albumCounts.get(albumKey);
      if (existing) {
        existing.count++;
        if (s.song.coverArt) existing.coverArt = s.song.coverArt;
        if (!existing.albumId && s.song.albumId) existing.albumId = s.song.albumId;
      } else {
        albumCounts.set(albumKey, {
          artist,
          coverArt: s.song.coverArt ?? undefined,
          count: 1,
          albumId: s.song.albumId ?? undefined,
        });
      }

      const songEntry = songCounts.get(s.song.id);
      if (songEntry) {
        songEntry.count++;
        songEntry.song = s.song;
      } else {
        songCounts.set(s.song.id, { song: s.song, count: 1 });
      }

      const genre = getPrimaryGenre(s.song);
      if (genre) {
        genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
      }

      const hour = new Date(s.time).getHours();
      hourBuckets[hour]++;

      const dk = dateKey(s.time);
      dayCounts.set(dk, (dayCounts.get(dk) ?? 0) + 1);
    }

    const topSongs = Array.from(songCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topArtists = Array.from(artistCounts.entries())
      .map(([artist, val]) => ({ artist, count: val.count, artistId: val.artistId }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topAlbums = Array.from(albumCounts.entries())
      .map(([key, val]) => ({
        album: key.split('::')[0],
        artist: val.artist,
        coverArt: val.coverArt,
        count: val.count,
        albumId: val.albumId,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const genreBreakdown = buildGenreBreakdown(genreCounts);

    const activityDays = periodDays ?? 90;
    const dailyActivity: DailyActivity[] = [];
    // Walk back day-by-day using calendar component arithmetic so a DST
    // transition can't skip or duplicate a date.
    const todayKey = dateKey(Date.now());
    for (let i = activityDays - 1; i >= 0; i--) {
      const dk = offsetDateKey(todayKey, -i);
      dailyActivity.push({ date: dk, count: dayCounts.get(dk) ?? 0 });
    }

    const uniqueDays = dayCounts.size;
    const averagePlaysPerDay =
      uniqueDays > 0 ? Math.round((totalPlays / uniqueDays) * 10) / 10 : 0;

    return {
      totalPlays,
      totalListeningSeconds,
      uniqueArtists: artistCounts.size,
      uniqueAlbums: albumCounts.size,
      dailyActivity,
      hourlyDistribution: hourBuckets,
      topSongs,
      topArtists,
      topAlbums,
      genreBreakdown,
      peakHour: computePeakHour(hourBuckets),
      averagePlaysPerDay,
    };
  }, [scrobbles, period, aggregates, todayKey]);

  return useMemo(() => ({
    ...periodDependent,
    heatmapData: periodIndependent.heatmapData,
    longestStreak: periodIndependent.longest,
    currentStreak: periodIndependent.current,
  }), [periodDependent, periodIndependent]);
}
