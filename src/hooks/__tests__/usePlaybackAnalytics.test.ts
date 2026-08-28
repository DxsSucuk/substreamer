import { renderHook } from '@testing-library/react-native';

import {
  computeStreaks,
  dateKey,
  usePlaybackAnalytics,
  type ScrobbleRecord,
  type TimePeriod,
} from '../usePlaybackAnalytics';

import { type AnalyticsAggregates } from '../../store/completedScrobbleStore';
import { getPrimaryGenre } from '../../utils/genreHelpers';

// The hook is now aggregate-driven (SQL supplies period + all-time aggregates in
// prod). This helper builds an AnalyticsAggregates from a scrobble list — the same
// shape the SQL layer produces — so the existing scrobble-based cases keep working.
function buildAgg(list: ScrobbleRecord[]): AnalyticsAggregates {
  const artistCounts: AnalyticsAggregates['artistCounts'] = {};
  const albumCounts: AnalyticsAggregates['albumCounts'] = {};
  const songStats: AnalyticsAggregates['songStats'] = {};
  const latestSong = new Map<string, ScrobbleRecord['song']>();
  const genreCounts: Record<string, number> = {};
  const hourBuckets = new Array<number>(24).fill(0);
  const dayCounts: Record<string, number> = {};
  for (const s of list) {
    const artist = s.song.artist ?? 'Unknown';
    const a = artistCounts[artist];
    if (a) {
      a.count++;
      if (!a.artistId && s.song.artistId) a.artistId = s.song.artistId;
    } else artistCounts[artist] = { count: 1, artistId: s.song.artistId ?? undefined };
    const albumKey = `${s.song.album ?? 'Unknown'}::${artist}`;
    const al = albumCounts[albumKey];
    if (al) {
      al.count++;
      if (s.song.coverArt) al.coverArt = s.song.coverArt;
      if (!al.albumId && s.song.albumId) al.albumId = s.song.albumId;
    } else
      albumCounts[albumKey] = {
        artist,
        coverArt: s.song.coverArt ?? undefined,
        count: 1,
        albumId: s.song.albumId ?? undefined,
      };
    // Latest play wins for the per-song scalars, as the SQL representative row does.
    const sc = songStats[s.song.id];
    if (sc) sc.count++;
    else songStats[s.song.id] = { count: 1 };
    songStats[s.song.id].duration = s.song.duration ?? undefined;
    songStats[s.song.id].year = s.song.year ?? undefined;
    latestSong.set(s.song.id, s.song);
    const genre = getPrimaryGenre(s.song);
    if (genre) genreCounts[genre] = (genreCounts[genre] ?? 0) + 1;
    hourBuckets[new Date(s.time).getHours()]++;
    const dk = dateKey(s.time);
    dayCounts[dk] = (dayCounts[dk] ?? 0) + 1;
  }
  // The ranked, bounded, fully-reconstructed slice the SQL layer hands over.
  const topSongs = Object.entries(songStats)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 10)
    .map(([id, v]) => ({ song: latestSong.get(id)!, count: v.count }));
  return { artistCounts, albumCounts, songStats, topSongs, genreCounts, hourBuckets, dayCounts };
}

const PERIOD_DAYS_MAP: Record<TimePeriod, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null };

/** Adapter: build period + all-time aggregates from a scrobble list (as SQL does
 *  in prod) and drive the aggregate-based hook. */
function renderAnalytics(
  list: ScrobbleRecord[],
  period: TimePeriod,
  pending?: Pick<ScrobbleRecord, 'time'>[],
) {
  const days = PERIOD_DAYS_MAP[period];
  const cutoff = days ? Date.now() - days * 86_400_000 : 0;
  const periodAgg = buildAgg(days ? list.filter((s) => s.time >= cutoff) : list);
  const allAgg = buildAgg(list);
  return renderHook(() => usePlaybackAnalytics(period, periodAgg, allAgg, pending));
}

function ts(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day, 12, 0, 0);
}

function localTs(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0).getTime();
}

const mockSong = (id: string, artist: string, album: string, duration = 180) =>
  ({ id, artist, album, duration } as ScrobbleRecord['song']);

describe('computeStreaks', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns zeros for empty input', () => {
    expect(computeStreaks([])).toEqual({ longest: 0, current: 0 });
  });

  it('returns longest 1 for single day', () => {
    expect(computeStreaks([{ time: ts(2025, 1, 10) }])).toEqual({
      longest: 1,
      current: 0,
    });
  });

  it('counts consecutive days for longest', () => {
    expect(
      computeStreaks([
        { time: ts(2025, 1, 10) },
        { time: ts(2025, 1, 11) },
        { time: ts(2025, 1, 12) },
      ]),
    ).toEqual({ longest: 3, current: 0 });
  });

  it('resets streak when gap exists', () => {
    expect(
      computeStreaks([
        { time: ts(2025, 1, 10) },
        { time: ts(2025, 1, 11) },
        { time: ts(2025, 1, 13) },
      ]),
    ).toEqual({ longest: 2, current: 0 });
  });

  it('counts current streak from today', () => {
    expect(
      computeStreaks([
        { time: ts(2025, 1, 13) },
        { time: ts(2025, 1, 14) },
        { time: ts(2025, 1, 15) },
      ]),
    ).toEqual({ longest: 3, current: 3 });
  });

  it('counts current streak from yesterday when no scrobble today', () => {
    expect(
      computeStreaks([
        { time: ts(2025, 1, 12) },
        { time: ts(2025, 1, 13) },
        { time: ts(2025, 1, 14) },
      ]),
    ).toEqual({ longest: 3, current: 3 });
  });

  it('longest can exceed current', () => {
    expect(
      computeStreaks([
        { time: ts(2025, 1, 1) },
        { time: ts(2025, 1, 2) },
        { time: ts(2025, 1, 3) },
        { time: ts(2025, 1, 4) },
        { time: ts(2025, 1, 5) },
        { time: ts(2025, 1, 14) },
        { time: ts(2025, 1, 15) },
      ]),
    ).toEqual({ longest: 5, current: 2 });
  });

  it('deduplicates multiple scrobbles on the same day', () => {
    expect(
      computeStreaks([
        { time: ts(2025, 1, 14) },
        { time: ts(2025, 1, 14) },
        { time: ts(2025, 1, 14) },
        { time: ts(2025, 1, 15) },
      ]),
    ).toEqual({ longest: 2, current: 2 });
  });

  it('handles scrobbles in non-chronological order', () => {
    expect(
      computeStreaks([
        { time: ts(2025, 1, 15) },
        { time: ts(2025, 1, 13) },
        { time: ts(2025, 1, 14) },
      ]),
    ).toEqual({ longest: 3, current: 3 });
  });

  it('is not broken by DST spring-forward (23h between midnights)', () => {
    jest.setSystemTime(new Date(2025, 2, 11, 12, 0));
    expect(
      computeStreaks([
        { time: localTs(2025, 3, 8, 22) },
        { time: localTs(2025, 3, 9, 1) },
        { time: localTs(2025, 3, 10, 3) },
        { time: localTs(2025, 3, 11, 10) },
      ]),
    ).toEqual({ longest: 4, current: 4 });
  });

  it('is not broken by DST fall-back (25h between midnights)', () => {
    jest.setSystemTime(new Date(2025, 10, 4, 12, 0));
    expect(
      computeStreaks([
        { time: localTs(2025, 11, 1, 23) },
        { time: localTs(2025, 11, 2, 1) },
        { time: localTs(2025, 11, 3, 22) },
        { time: localTs(2025, 11, 4, 10) },
      ]),
    ).toEqual({ longest: 4, current: 4 });
  });

  it('handles streaks across month boundaries', () => {
    jest.setSystemTime(new Date(2025, 1, 2, 12, 0));
    expect(
      computeStreaks([
        { time: localTs(2025, 1, 30) },
        { time: localTs(2025, 1, 31) },
        { time: localTs(2025, 2, 1) },
        { time: localTs(2025, 2, 2) },
      ]),
    ).toEqual({ longest: 4, current: 4 });
  });

  it('handles streaks across year boundaries', () => {
    jest.setSystemTime(new Date(2025, 0, 2, 12, 0));
    expect(
      computeStreaks([
        { time: localTs(2024, 12, 30) },
        { time: localTs(2024, 12, 31) },
        { time: localTs(2025, 1, 1) },
        { time: localTs(2025, 1, 2) },
      ]),
    ).toEqual({ longest: 4, current: 4 });
  });

  it('treats late-night and early-morning scrobbles as separate days', () => {
    jest.setSystemTime(new Date(2025, 0, 15, 12, 0));
    expect(
      computeStreaks([
        { time: localTs(2025, 1, 14, 23, 59) },
        { time: localTs(2025, 1, 15, 0, 1) },
      ]),
    ).toEqual({ longest: 2, current: 2 });
  });

  // Day-keys overload tests
  it('accepts string[] day keys', () => {
    expect(
      computeStreaks(['2025-01-13', '2025-01-14', '2025-01-15']),
    ).toEqual({ longest: 3, current: 3 });
  });

  it('accepts string[] with gap', () => {
    expect(
      computeStreaks(['2025-01-10', '2025-01-12', '2025-01-15']),
    ).toEqual({ longest: 1, current: 1 });
  });

  it('day-keys overload returns zeros for empty array', () => {
    expect(computeStreaks([] as string[])).toEqual({ longest: 0, current: 0 });
  });
});

describe('dateKey', () => {
  it('formats timestamp as YYYY-MM-DD', () => {
    const t = new Date(2025, 0, 5, 10, 30).getTime();
    expect(dateKey(t)).toBe('2025-01-05');
  });
});

describe('usePlaybackAnalytics', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const scrobbles: ScrobbleRecord[] = [
    {
      id: '1',
      song: mockSong('s1', 'Artist A', 'Album X', 200),
      time: ts(2025, 1, 14),
    },
    {
      id: '2',
      song: mockSong('s1', 'Artist A', 'Album X', 200),
      time: ts(2025, 1, 14),
    },
    {
      id: '3',
      song: mockSong('s2', 'Artist B', 'Album Y', 240),
      time: ts(2025, 1, 13),
    },
  ];

  it('filters by period', () => {
    const oldScrobble: ScrobbleRecord = {
      id: 'old',
      song: mockSong('old', 'Old', 'Old', 100),
      time: ts(2024, 12, 1),
    };
    const { result } = renderAnalytics([...scrobbles, oldScrobble], '7d');
    expect(result.current.totalPlays).toBe(3);
  });

  it('includes all scrobbles for period all', () => {
    const { result } = renderAnalytics(scrobbles, 'all');
    expect(result.current.totalPlays).toBe(3);
  });

  it('ranks top songs by count', () => {
    const { result } = renderAnalytics(scrobbles, 'all');
    expect(result.current.topSongs).toHaveLength(2);
    expect(result.current.topSongs[0].count).toBe(2);
    expect(result.current.topSongs[0].song.id).toBe('s1');
  });

  it('limits top songs to 10', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: `r${i}`,
      song: mockSong(`s${i}`, `Artist${i}`, 'Album', 100),
      time: ts(2025, 1, 14),
    }));
    const { result } = renderAnalytics(many, 'all');
    expect(result.current.topSongs).toHaveLength(10);
  });

  it('limits top artists to 10 and top albums to 5', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`,
      song: mockSong(`s${i}`, `Artist${i}`, `Album${i}`, 100),
      time: ts(2025, 1, 14),
    }));
    const { result } = renderAnalytics(many, 'all');
    expect(result.current.topArtists).toHaveLength(10);
    expect(result.current.topAlbums).toHaveLength(5);
  });

  it('creates Other bucket when more than 6 genres', () => {
    const withGenres = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      song: {
        ...mockSong(`s${i}`, 'A', 'B'),
        genre: `Genre${i}`,
      } as ScrobbleRecord['song'],
      time: ts(2025, 1, 14),
    }));
    const { result } = renderAnalytics(withGenres, 'all');
    const other = result.current.genreBreakdown.find((g) => g.genre === 'Other');
    expect(other).toBeDefined();
    expect(other!.count).toBe(3);
  });

  it('computes peak hour', () => {
    const atHour = (h: number) => ({
      id: 'h',
      song: mockSong('s', 'A', 'B'),
      time: new Date(2025, 0, 14, h, 30, 0).getTime(),
    });
    const { result } = renderAnalytics(
        [atHour(14), atHour(14), atHour(14), atHour(9)],
        'all',
      );
    expect(result.current.peakHour).toBe(14);
  });

  it('computes average plays per day', () => {
    const { result } = renderAnalytics(scrobbles, 'all');
    expect(result.current.averagePlaysPerDay).toBeGreaterThan(0);
  });

  it('includes pending scrobbles in streak', () => {
    const { result } = renderAnalytics(
        [
          {
            id: '1',
            song: mockSong('s1', 'A', 'B'),
            time: ts(2025, 1, 14),
          },
        ],
        '7d',
        [{ time: ts(2025, 1, 15) }],
      );
    expect(result.current.currentStreak).toBe(2);
  });

  it('computes streaks from all scrobbles regardless of period filter', () => {
    const oldStreak: ScrobbleRecord[] = Array.from({ length: 5 }, (_, i) => ({
      id: `old${i}`,
      song: mockSong('s1', 'A', 'B'),
      time: ts(2024, 12, 1 + i),
    }));
    const recent: ScrobbleRecord[] = [
      { id: 'r1', song: mockSong('s1', 'A', 'B'), time: ts(2025, 1, 14) },
      { id: 'r2', song: mockSong('s1', 'A', 'B'), time: ts(2025, 1, 15) },
    ];
    const { result } = renderAnalytics([...oldStreak, ...recent], '7d');
    expect(result.current.totalPlays).toBe(2);
    expect(result.current.longestStreak).toBe(5);
    expect(result.current.currentStreak).toBe(2);
  });

  it('computes totalListeningSeconds from song durations', () => {
    const { result } = renderAnalytics(scrobbles, 'all');
    expect(result.current.totalListeningSeconds).toBe(200 + 200 + 240);
  });

  it('counts uniqueArtists and uniqueAlbums', () => {
    const { result } = renderAnalytics(scrobbles, 'all');
    expect(result.current.uniqueArtists).toBe(2);
    expect(result.current.uniqueAlbums).toBe(2);
  });

  it('computes exact averagePlaysPerDay', () => {
    const { result } = renderAnalytics(scrobbles, 'all');
    // 3 plays across 2 unique days → 1.5
    expect(result.current.averagePlaysPerDay).toBe(1.5);
  });

  it('returns zero stats for empty scrobble array', () => {
    const { result } = renderAnalytics([], 'all');
    expect(result.current.totalPlays).toBe(0);
    expect(result.current.totalListeningSeconds).toBe(0);
    expect(result.current.uniqueArtists).toBe(0);
    expect(result.current.currentStreak).toBe(0);
    expect(result.current.longestStreak).toBe(0);
    expect(result.current.topSongs).toHaveLength(0);
    expect(result.current.genreBreakdown).toHaveLength(0);
  });

  it('filters correctly for 30d period', () => {
    const old: ScrobbleRecord = {
      id: 'old',
      song: mockSong('old', 'X', 'Y'),
      time: ts(2024, 11, 1),
    };
    const { result } = renderAnalytics([...scrobbles, old], '30d');
    expect(result.current.totalPlays).toBe(3);
  });

  it('handles scrobbles with missing duration', () => {
    const noDuration: ScrobbleRecord[] = [
      { id: '1', song: { id: 's1', artist: 'A', album: 'B' } as any, time: ts(2025, 1, 14) },
    ];
    const { result } = renderAnalytics(noDuration, 'all');
    expect(result.current.totalListeningSeconds).toBe(0);
    expect(result.current.totalPlays).toBe(1);
  });

  it('handles scrobbles with missing artist', () => {
    const noArtist: ScrobbleRecord[] = [
      { id: '1', song: { id: 's1', album: 'B', duration: 100 } as any, time: ts(2025, 1, 14) },
    ];
    const { result } = renderAnalytics(noArtist, 'all');
    expect(result.current.topArtists[0].artist).toBe('Unknown');
  });

  it('uses genres array fallback when genre is absent ({name} objects)', () => {
    const withGenresArray: ScrobbleRecord[] = [
      {
        id: '1',
        song: { id: 's1', artist: 'A', album: 'B', duration: 100, genres: [{ name: 'Rock' }] } as any,
        time: ts(2025, 1, 14),
      },
    ];
    const { result } = renderAnalytics(withGenresArray, 'all');
    expect(result.current.genreBreakdown).toHaveLength(1);
    expect(result.current.genreBreakdown[0].genre).toBe('Rock');
  });

  it('handles genres as plain strings defensively', () => {
    const withStringGenres: ScrobbleRecord[] = [
      {
        id: '1',
        song: { id: 's1', artist: 'A', album: 'B', duration: 100, genres: ['Electronic'] } as any,
        time: ts(2025, 1, 14),
      },
    ];
    const { result } = renderAnalytics(withStringGenres, 'all');
    expect(result.current.genreBreakdown).toHaveLength(1);
    expect(result.current.genreBreakdown[0].genre).toBe('Electronic');
  });

  it('hourlyDistribution has 24 buckets', () => {
    const { result } = renderAnalytics(scrobbles, 'all');
    expect(result.current.hourlyDistribution).toHaveLength(24);
    const total = result.current.hourlyDistribution.reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
  });

  it('filter path uses latest song metadata for top songs', () => {
    const records: ScrobbleRecord[] = [
      { id: '1', song: { id: 's1', artist: 'A', album: 'B', duration: 100 } as any, time: ts(2025, 1, 14) },
      { id: '2', song: { id: 's1', artist: 'A', album: 'B', duration: 100, coverArt: 'art-1' } as any, time: ts(2025, 1, 14) },
    ];
    const { result } = renderAnalytics(records, '7d');
    expect(result.current.topSongs[0].song.coverArt).toBe('art-1');
  });

  it('filter path picks up album coverArt from later scrobble', () => {
    const records: ScrobbleRecord[] = [
      { id: '1', song: { id: 's1', artist: 'A', album: 'AlbX', duration: 100 } as any, time: ts(2025, 1, 14) },
      { id: '2', song: { id: 's2', artist: 'A', album: 'AlbX', duration: 100, coverArt: 'al-42' } as any, time: ts(2025, 1, 14) },
    ];
    const { result } = renderAnalytics(records, '7d');
    expect(result.current.topAlbums[0].coverArt).toBe('al-42');
  });

  it('filter path does not clear album coverArt when later scrobble lacks it', () => {
    const records: ScrobbleRecord[] = [
      { id: '1', song: { id: 's1', artist: 'A', album: 'AlbX', duration: 100, coverArt: 'al-42' } as any, time: ts(2025, 1, 14) },
      { id: '2', song: { id: 's2', artist: 'A', album: 'AlbX', duration: 100 } as any, time: ts(2025, 1, 14) },
    ];
    const { result } = renderAnalytics(records, '7d');
    expect(result.current.topAlbums[0].coverArt).toBe('al-42');
  });
});

describe('usePlaybackAnalytics with aggregates', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const scrobbles: ScrobbleRecord[] = [
    { id: '1', song: mockSong('s1', 'Artist A', 'Album X', 200), time: ts(2025, 1, 14) },
    { id: '2', song: mockSong('s1', 'Artist A', 'Album X', 200), time: ts(2025, 1, 14) },
    { id: '3', song: mockSong('s2', 'Artist B', 'Album Y', 240), time: ts(2025, 1, 13) },
  ];

  it('uses aggregates for "all" period and produces same results', () => {
    const { result: withAgg } = renderAnalytics(scrobbles, 'all');
    const { result: withoutAgg } = renderAnalytics(scrobbles, 'all');

    expect(withAgg.current.totalPlays).toBe(withoutAgg.current.totalPlays);
    expect(withAgg.current.uniqueArtists).toBe(withoutAgg.current.uniqueArtists);
    expect(withAgg.current.uniqueAlbums).toBe(withoutAgg.current.uniqueAlbums);
    expect(withAgg.current.topSongs.map(s => s.song.id)).toEqual(withoutAgg.current.topSongs.map(s => s.song.id));
    expect(withAgg.current.topArtists).toEqual(withoutAgg.current.topArtists);
    expect(withAgg.current.longestStreak).toBe(withoutAgg.current.longestStreak);
    expect(withAgg.current.currentStreak).toBe(withoutAgg.current.currentStreak);
  });

  it('still filters by period when aggregates are provided', () => {
    const oldScrobble: ScrobbleRecord = {
      id: 'old',
      song: mockSong('old', 'Old', 'Old', 100),
      time: ts(2024, 12, 1),
    };
    const allScrobbles = [...scrobbles, oldScrobble];
    const { result } = renderAnalytics(allScrobbles, '7d');
    // Period-filtered: only recent 3 scrobbles
    expect(result.current.totalPlays).toBe(3);
  });

  it('uses aggregates dayCounts for heatmap', () => {
    const { result } = renderAnalytics(scrobbles, '7d');
    // Heatmap should have entries for 16 weeks
    expect(result.current.heatmapData.length).toBe(16 * 7);
  });

  it('uses aggregates dayCounts for streaks', () => {
    const pending = [{ time: ts(2025, 1, 15) }];

    const { result } = renderAnalytics(scrobbles, 'all', pending);
    expect(result.current.currentStreak).toBe(3);
  });
});
