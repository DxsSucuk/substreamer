// The store is now SQL-backed: it delegates persistence to `scrobbleTable` and
// derives stats/aggregates from `scrobbleAggregates` (SQL GROUP BY) rather than
// iterating an in-memory array. These tests fake both with a single in-memory
// list (`mockDb`) so the store's CONTRACT is exercised deterministically:
//   - addCompleted persists + optimistically surfaces in the recent slice, then
//     refreshes stats/aggregates from SQL (async);
//   - validation rejects bad input without touching SQL;
//   - replaceAll / mergeAll / hydrate write/read SQL then refresh derived state.
// The aggregate MATH itself is covered by scrobbleAggregates.test.
import { type Child } from '../../services/subsonicService';
import { dateKey } from '../../utils/dateKey';
import { getPrimaryGenre } from '../../utils/genreHelpers';

interface Row {
  id: string;
  song: Child;
  time: number;
}
// eslint-disable-next-line prefer-const
let mockDb: Row[] = [];

// Build the analytics shapes from the fake table — the same output the real SQL
// layer produces, so aggregate assertions below stay meaningful.
function mockBuildAnalytics() {
  const artistCounts: Record<string, { count: number; artistId?: string }> = {};
  const albumCounts: Record<string, { artist: string; coverArt?: string; count: number; albumId?: string }> = {};
  const songCounts: Record<string, { song: Child; count: number }> = {};
  const genreCounts: Record<string, number> = {};
  const hourBuckets = new Array<number>(24).fill(0);
  const dayCounts: Record<string, number> = {};
  const uniqueArtists: Record<string, true> = {};
  let totalListeningSeconds = 0;
  for (const s of mockDb) {
    const artist = s.song.artist ?? 'Unknown';
    uniqueArtists[artist] = true;
    totalListeningSeconds += s.song.duration ?? 0;
    (artistCounts[artist] ??= { count: 0, artistId: s.song.artistId ?? undefined }).count++;
    const albumKey = `${s.song.album ?? 'Unknown'}::${artist}`;
    const al = (albumCounts[albumKey] ??= { artist, coverArt: undefined, count: 0, albumId: undefined });
    al.count++;
    if (s.song.coverArt) al.coverArt = s.song.coverArt;
    if (!al.albumId && s.song.albumId) al.albumId = s.song.albumId;
    (songCounts[s.song.id] ??= { song: s.song, count: 0 }).count++;
    songCounts[s.song.id].song = s.song;
    const genre = getPrimaryGenre(s.song);
    if (genre) genreCounts[genre] = (genreCounts[genre] ?? 0) + 1;
    hourBuckets[new Date(s.time).getHours()]++;
    const dk = dateKey(s.time);
    dayCounts[dk] = (dayCounts[dk] ?? 0) + 1;
  }
  return {
    stats: { totalPlays: mockDb.length, totalListeningSeconds, uniqueArtists },
    aggregates: { artistCounts, albumCounts, songCounts, genreCounts, hourBuckets, dayCounts },
  };
}

const mockInsert = jest.fn(async (s: Row) => {
  if (!mockDb.some((x) => x.id === s.id)) mockDb.push(s);
});
const mockReplaceAll = jest.fn(async (arr: Row[]) => {
  mockDb = [...arr];
});
const mockMerge = jest.fn(async (arr: Row[]) => {
  const seen = new Set(mockDb.map((s) => s.id));
  let added = 0;
  for (const s of arr) {
    if (s?.id && !seen.has(s.id)) {
      seen.add(s.id);
      mockDb.push(s);
      added += 1;
    }
  }
  return { added, skipped: arr.length - added };
});

jest.mock('../persistence/scrobbleTable', () => ({
  insertScrobble: (s: Row) => mockInsert(s),
  replaceAllScrobbles: (arr: Row[]) => mockReplaceAll(arr),
  mergeScrobbles: (arr: Row[]) => mockMerge(arr),
  clearScrobbles: jest.fn(async () => {
    mockDb = [];
  }),
  hydrateScrobblesAsync: jest.fn(async () => mockDb),
  backfillScrobbleColumnsAsync: jest.fn(async () => {}),
}));
jest.mock('../persistence/scrobbleAggregates', () => ({
  computeScrobbleAnalytics: jest.fn(async () => mockBuildAnalytics()),
  loadRecentScrobbles: jest.fn(async (n: number) => [...mockDb].reverse().slice(0, n)),
}));

import { completedScrobbleStore, type CompletedScrobble } from '../completedScrobbleStore';

/** Let the fire-and-forget insert + SQL refresh settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function validScrobble(overrides?: Partial<CompletedScrobble>): CompletedScrobble {
  return {
    id: 'scrobble-1',
    song: { id: 's1', title: 'Song', artist: 'Artist', duration: 180 },
    time: Date.now(),
    ...overrides,
  } as CompletedScrobble;
}

beforeEach(() => {
  mockDb = [];
  mockInsert.mockClear();
  mockReplaceAll.mockClear();
  mockMerge.mockClear();
  completedScrobbleStore.setState({
    recentScrobbles: [],
    stats: { totalPlays: 0, totalListeningSeconds: 0, uniqueArtists: {} },
    aggregates: {
      artistCounts: {},
      albumCounts: {},
      songCounts: {},
      genreCounts: {},
      hourBuckets: new Array(24).fill(0),
      dayCounts: {},
    },
    hasHydrated: false,
  });
});

describe('addCompleted', () => {
  it('persists to SQL, surfaces in recent slice, and refreshes stats/aggregates', async () => {
    const s = validScrobble();
    completedScrobbleStore.getState().addCompleted(s);
    // Optimistic recent slice updates synchronously.
    expect(completedScrobbleStore.getState().recentScrobbles).toHaveLength(1);
    await flush();
    const state = completedScrobbleStore.getState();
    expect(mockInsert).toHaveBeenCalledWith(s);
    expect(state.stats.totalPlays).toBe(1);
    expect(state.stats.totalListeningSeconds).toBe(180);
    expect(state.stats.uniqueArtists).toEqual({ Artist: true });
    expect(state.aggregates.artistCounts.Artist.count).toBe(1);
  });

  it.each([
    ['missing id', validScrobble({ id: '' })],
    ['missing song.id', validScrobble({ song: { id: '', title: 'X', artist: 'A' } as any })],
    ['missing song.title', validScrobble({ song: { id: 's1', title: '', artist: 'A' } as any })],
    ['null song', { id: 'x', song: null as any, time: Date.now() } as CompletedScrobble],
  ])('rejects %s without touching SQL', async (_label, bad) => {
    completedScrobbleStore.getState().addCompleted(bad);
    await flush();
    expect(completedScrobbleStore.getState().recentScrobbles).toHaveLength(0);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('dedupes by id in the recent slice and does not double-insert', async () => {
    const s = validScrobble();
    completedScrobbleStore.getState().addCompleted(s);
    completedScrobbleStore.getState().addCompleted(s);
    await flush();
    expect(completedScrobbleStore.getState().recentScrobbles).toHaveLength(1);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('accumulates stats + aggregates across many adds', async () => {
    for (let i = 0; i < 10; i++) {
      completedScrobbleStore.getState().addCompleted(
        validScrobble({
          id: `s-${i}`,
          song: { id: `song-${i}`, title: `T${i}`, artist: `A${i % 3}`, duration: 100 } as any,
        }),
      );
    }
    await flush();
    const { stats } = completedScrobbleStore.getState();
    expect(stats.totalPlays).toBe(10);
    expect(stats.totalListeningSeconds).toBe(1000);
    expect(Object.keys(stats.uniqueArtists)).toHaveLength(3);
  });

  it('derives genre / hour / day aggregates from SQL', async () => {
    completedScrobbleStore.getState().addCompleted(
      validScrobble({
        id: '1',
        song: { id: 's1', title: 'A', artist: 'Art', genre: 'Rock', duration: 100 } as any,
        time: new Date(2025, 0, 15, 14).getTime(),
      }),
    );
    await flush();
    const { aggregates } = completedScrobbleStore.getState();
    expect(aggregates.genreCounts.Rock).toBe(1);
    expect(aggregates.hourBuckets[14]).toBe(1);
    expect(aggregates.dayCounts['2025-01-15']).toBe(1);
  });
});

describe('replaceAll', () => {
  it('writes SQL (deduped + validated) then refreshes derived state', async () => {
    const dirty = [
      validScrobble({ id: 'ok', song: { id: 's1', title: 'A', artist: 'Art', duration: 100 } as any }),
      validScrobble({ id: 'ok', song: { id: 's1', title: 'A', artist: 'Art', duration: 100 } as any }), // dup
      validScrobble({ id: '', song: { id: 's2', title: 'B' } as any }), // invalid
    ];
    await completedScrobbleStore.getState().replaceAll(dirty);
    expect(mockReplaceAll).toHaveBeenCalledTimes(1);
    expect(mockReplaceAll.mock.calls[0][0]).toHaveLength(1);
    const state = completedScrobbleStore.getState();
    expect(state.stats.totalPlays).toBe(1);
    expect(state.recentScrobbles).toHaveLength(1);
  });

  it('empty array resets derived state', async () => {
    await completedScrobbleStore.getState().replaceAll([
      validScrobble({ id: '1', song: { id: 's1', title: 'A', artist: 'Art', duration: 100 } as any }),
    ]);
    await completedScrobbleStore.getState().replaceAll([]);
    const state = completedScrobbleStore.getState();
    expect(state.stats.totalPlays).toBe(0);
    expect(state.aggregates.artistCounts).toEqual({});
  });
});

describe('mergeAll', () => {
  it('delegates to mergeScrobbles and refreshes from SQL, returning counts', async () => {
    await completedScrobbleStore.getState().replaceAll([
      validScrobble({ id: 'local', song: { id: 's1', title: 'A', artist: 'Art', duration: 100 } as any }),
    ]);
    const result = await completedScrobbleStore.getState().mergeAll([
      validScrobble({ id: 'local', song: { id: 's1', title: 'A', artist: 'Art', duration: 100 } as any }), // dup
      validScrobble({ id: 'remote', song: { id: 's2', title: 'B', artist: 'Art', duration: 100 } as any }),
    ]);
    expect(result).toEqual({ added: 1, skipped: 1 });
    expect(completedScrobbleStore.getState().stats.totalPlays).toBe(2);
  });
});

describe('hydrateFromDbAsync', () => {
  it('backfills columns, refreshes from SQL, and flips hasHydrated', async () => {
    mockDb = [
      validScrobble({ id: 'a', song: { id: 's1', title: 'A', artist: 'Art', duration: 100 } as any, time: new Date(2025, 0, 15, 10).getTime() }),
      validScrobble({ id: 'b', song: { id: 's2', title: 'B', artist: 'Art', duration: 200 } as any, time: new Date(2025, 0, 15, 14).getTime() }),
    ];
    await completedScrobbleStore.getState().hydrateFromDbAsync();
    const state = completedScrobbleStore.getState();
    expect(state.hasHydrated).toBe(true);
    expect(state.stats.totalPlays).toBe(2);
    expect(state.stats.totalListeningSeconds).toBe(300);
    expect(state.aggregates.artistCounts.Art.count).toBe(2);
    expect(state.recentScrobbles).toHaveLength(2);
  });

  it('hydrates empty when SQL has no rows', async () => {
    mockDb = [];
    await completedScrobbleStore.getState().hydrateFromDbAsync();
    const state = completedScrobbleStore.getState();
    expect(state.hasHydrated).toBe(true);
    expect(state.stats.totalPlays).toBe(0);
    expect(state.recentScrobbles).toEqual([]);
  });
});
