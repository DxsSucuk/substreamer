import { useEffect, useMemo, useState } from 'react';

import { type Child } from '../services/subsonicService';
import { type AnalyticsAggregates } from '../store/completedScrobbleStore';
import { computeScrobbleAnalytics } from '../store/persistence/scrobbleAggregates';
import { dateKey, offsetDateKey } from '../utils/dateKey';

// Re-exported for the consumers that import `dateKey` from this module.
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

const EMPTY_PERIOD_DEPENDENT = {
  totalPlays: 0,
  totalListeningSeconds: 0,
  uniqueArtists: 0,
  uniqueAlbums: 0,
  dailyActivity: [] as DailyActivity[],
  hourlyDistribution: new Array<number>(24).fill(0),
  topSongs: [] as TopSong[],
  topArtists: [] as TopArtist[],
  topAlbums: [] as TopAlbum[],
  genreBreakdown: [] as GenreSlice[],
  peakHour: 0,
  averagePlaysPerDay: 0,
};

/**
 * Load period-scoped analytics aggregates from SQL. `period` picks the `time >=`
 * cutoff; the query runs GROUP BY over the scrobble columns (never a full-array
 * load). `refresh()` re-runs it (pull-to-refresh). Returns `undefined` until the
 * first query resolves.
 */
export function usePeriodAggregates(period: TimePeriod): {
  aggregates: AnalyticsAggregates | undefined;
  refresh: () => void;
} {
  const [aggregates, setAggregates] = useState<AnalyticsAggregates | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const days = PERIOD_DAYS[period];
    const cutoff = days ? Date.now() - days * 86_400_000 : 0;
    void computeScrobbleAnalytics(cutoff).then((r) => {
      if (alive) setAggregates(r.aggregates);
    });
    return () => {
      alive = false;
    };
  }, [period, tick]);
  return { aggregates, refresh: () => setTick((t) => t + 1) };
}

/**
 * Derive the My Listening view-model from SQL aggregates. `periodAggregates` is
 * scoped to the selected period (drives tops/charts); `allTimeAggregates` drives
 * the period-INDEPENDENT heatmap + streaks (which always span all history).
 */
export function usePlaybackAnalytics(
  period: TimePeriod,
  periodAggregates: AnalyticsAggregates | undefined,
  allTimeAggregates: AnalyticsAggregates | undefined,
  pendingScrobbles?: Pick<ScrobbleRecord, 'time'>[],
): PlaybackAnalytics {
  // Stable per-calendar-day key so the streak recomputes across midnight.
  const todayKey = dateKey(Date.now());

  // Period-independent: heatmap + streaks from ALL-TIME day counts.
  const periodIndependent = useMemo(() => {
    const dayCounts = allTimeAggregates?.dayCounts ?? {};
    const heatmapDays = HEATMAP_WEEKS * 7;
    const heatmapData: DailyActivity[] = [];
    const today = new Date();
    const todayDay = today.getDay();
    const gridEnd = new Date(today);
    gridEnd.setDate(gridEnd.getDate() + (6 - todayDay));
    gridEnd.setHours(0, 0, 0, 0);
    const gridStart = new Date(gridEnd);
    gridStart.setDate(gridStart.getDate() - heatmapDays + 1);
    for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) {
      const dk = dateKey(d.getTime());
      heatmapData.push({ date: dk, count: dayCounts[dk] ?? 0 });
    }

    const dayKeys = new Set(Object.keys(dayCounts));
    for (const s of pendingScrobbles ?? []) dayKeys.add(dateKey(s.time));
    const streaks = computeStreaks(Array.from(dayKeys));

    return { heatmapData, ...streaks };
  }, [allTimeAggregates, pendingScrobbles, todayKey]);

  // Period-dependent: tops + charts from the period-scoped aggregates.
  const periodDependent = useMemo(() => {
    const agg = periodAggregates;
    if (!agg) return EMPTY_PERIOD_DEPENDENT;

    let totalListeningSeconds = 0;
    for (const entry of Object.values(agg.songCounts)) {
      totalListeningSeconds += (entry.song.duration ?? 0) * entry.count;
    }

    const topSongs = Object.values(agg.songCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topArtists = Object.entries(agg.artistCounts)
      .map(([artist, val]) => ({ artist, count: val.count, artistId: val.artistId }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topAlbums = Object.entries(agg.albumCounts)
      .map(([key, val]) => ({
        album: key.split('::')[0],
        artist: val.artist,
        coverArt: val.coverArt,
        count: val.count,
        albumId: val.albumId,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const genreBreakdown = buildGenreBreakdown(agg.genreCounts);

    const totalPlays = Object.values(agg.dayCounts).reduce((sum, c) => sum + c, 0);
    const uniqueDays = Object.keys(agg.dayCounts).length;

    // Walk back day-by-day (calendar arithmetic — DST-safe).
    const activityDays = PERIOD_DAYS[period] ?? 90;
    const dailyActivity: DailyActivity[] = [];
    for (let i = activityDays - 1; i >= 0; i--) {
      const dk = offsetDateKey(todayKey, -i);
      dailyActivity.push({ date: dk, count: agg.dayCounts[dk] ?? 0 });
    }

    return {
      totalPlays,
      totalListeningSeconds,
      uniqueArtists: Object.keys(agg.artistCounts).length,
      uniqueAlbums: Object.keys(agg.albumCounts).length,
      dailyActivity,
      hourlyDistribution: agg.hourBuckets,
      topSongs,
      topArtists,
      topAlbums,
      genreBreakdown,
      peakHour: computePeakHour(agg.hourBuckets),
      averagePlaysPerDay: uniqueDays > 0 ? Math.round((totalPlays / uniqueDays) * 10) / 10 : 0,
    };
  }, [periodAggregates, period, todayKey]);

  return useMemo(
    () => ({
      ...periodDependent,
      heatmapData: periodIndependent.heatmapData,
      longestStreak: periodIndependent.longest,
      currentStreak: periodIndependent.current,
    }),
    [periodDependent, periodIndependent],
  );
}
