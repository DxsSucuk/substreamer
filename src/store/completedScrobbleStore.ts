import { create } from 'zustand';

import {
  clearScrobbles,
  hydrateScrobbles,
  hydrateScrobblesAsync,
  insertScrobble,
  mergeScrobbles,
  replaceAllScrobbles,
} from './persistence/scrobbleTable';

import { type Child } from '../services/subsonicService';
import { dateKey } from '../utils/dateKey';
import { getPrimaryGenre } from '../utils/genreHelpers';

export interface CompletedScrobble {
  /** Unique identifier (carried over from the pending entry). */
  id: string;
  /** Full Subsonic songID3 object. */
  song: Child;
  /** Unix timestamp (ms) when playback completed. */
  time: number;
}

export interface ListeningStats {
  totalPlays: number;
  totalListeningSeconds: number;
  uniqueArtists: Record<string, true>;
}

export interface AnalyticsAggregates {
  artistCounts: Record<string, { count: number; artistId?: string }>;
  albumCounts: Record<string, { artist: string; coverArt?: string; count: number; albumId?: string }>;
  songCounts: Record<string, { song: Child; count: number }>;
  genreCounts: Record<string, number>;
  hourBuckets: number[];
  dayCounts: Record<string, number>;
}

const EMPTY_STATS: ListeningStats = {
  totalPlays: 0,
  totalListeningSeconds: 0,
  uniqueArtists: {},
};

const EMPTY_AGGREGATES: AnalyticsAggregates = {
  artistCounts: {},
  albumCounts: {},
  songCounts: {},
  genreCounts: {},
  hourBuckets: new Array(24).fill(0),
  dayCounts: {},
};

export interface CompletedScrobbleState {
  completedScrobbles: CompletedScrobble[];
  stats: ListeningStats;
  aggregates: AnalyticsAggregates;
  /** True after the on-start hydration from SQLite has populated the store. */
  hasHydrated: boolean;

  addCompleted: (scrobble: CompletedScrobble) => void;
  rebuildStats: () => void;
  rebuildAggregates: () => void;
  /**
   * Replace the entire scrobble set both in the SQLite table and in memory.
   * Used by backup restore. Rebuilds derived stats + aggregates from the
   * provided list.
   */
  replaceAll: (scrobbles: CompletedScrobble[]) => void;
  /**
   * Merge the given scrobbles into the existing set (INSERT OR IGNORE per
   * row). Used by merge-mode backup restore so a backup from another device
   * unifies with locally-accumulated scrobbles instead of replacing them.
   * Re-hydrates from SQL after the merge so derived stats reflect the
   * union. Returns `{ added, skipped }` where `added` is rows actually
   * inserted and `skipped` covers duplicates + invalid inputs.
   */
  mergeAll: (scrobbles: CompletedScrobble[]) => { added: number; skipped: number };
  /** Called once at app start to load persisted rows into memory — background
   * read + chunked JSON.parse. Aggregates/stats are still built synchronously
   * afterwards (single pass, needed before My Listening renders). */
  hydrateFromDbAsync: () => Promise<void>;
}

function buildStats(scrobbles: CompletedScrobble[]): ListeningStats {
  let totalListeningSeconds = 0;
  const uniqueArtists: Record<string, true> = {};
  for (const s of scrobbles) {
    if (s.song.duration) totalListeningSeconds += s.song.duration;
    if (s.song.artist) uniqueArtists[s.song.artist] = true;
  }
  return { totalPlays: scrobbles.length, totalListeningSeconds, uniqueArtists };
}

function buildAggregates(scrobbles: CompletedScrobble[]): AnalyticsAggregates {
  const artistCounts: Record<string, { count: number; artistId?: string }> = {};
  const albumCounts: Record<string, { artist: string; coverArt?: string; count: number; albumId?: string }> = {};
  const songCounts: Record<string, { song: Child; count: number }> = {};
  const genreCounts: Record<string, number> = {};
  const hourBuckets = new Array<number>(24).fill(0);
  const dayCounts: Record<string, number> = {};

  for (const s of scrobbles) {
    const artist = s.song.artist ?? 'Unknown';
    const existingArtist = artistCounts[artist];
    if (existingArtist) {
      existingArtist.count++;
      // Capture artistId opportunistically: rows from older app versions
      // may lack it; the first scrobble that carries one wins.
      if (!existingArtist.artistId && s.song.artistId) {
        existingArtist.artistId = s.song.artistId;
      }
    } else {
      artistCounts[artist] = { count: 1, artistId: s.song.artistId ?? undefined };
    }

    const albumKey = `${s.song.album ?? 'Unknown'}::${artist}`;
    const existingAlbum = albumCounts[albumKey];
    if (existingAlbum) {
      existingAlbum.count++;
      if (s.song.coverArt) existingAlbum.coverArt = s.song.coverArt;
      if (!existingAlbum.albumId && s.song.albumId) {
        existingAlbum.albumId = s.song.albumId;
      }
    } else {
      albumCounts[albumKey] = {
        artist,
        coverArt: s.song.coverArt ?? undefined,
        count: 1,
        albumId: s.song.albumId ?? undefined,
      };
    }

    const existingSong = songCounts[s.song.id];
    if (existingSong) {
      existingSong.count++;
      existingSong.song = s.song;
    } else {
      songCounts[s.song.id] = { song: s.song, count: 1 };
    }

    const genre = getPrimaryGenre(s.song);
    if (genre) {
      genreCounts[genre] = (genreCounts[genre] ?? 0) + 1;
    }

    hourBuckets[new Date(s.time).getHours()]++;

    const dk = dateKey(s.time);
    dayCounts[dk] = (dayCounts[dk] ?? 0) + 1;
  }

  return { artistCounts, albumCounts, songCounts, genreCounts, hourBuckets, dayCounts };
}

export const completedScrobbleStore = create<CompletedScrobbleState>()((set, get) => ({
  completedScrobbles: [],
  stats: { ...EMPTY_STATS },
  aggregates: { ...EMPTY_AGGREGATES, hourBuckets: new Array(24).fill(0) },
  hasHydrated: false,

  addCompleted: (scrobble) => {
    const state = get();
    if (
      !scrobble.id ||
      !scrobble.song?.id ||
      !scrobble.song.title ||
      state.completedScrobbles.some((s) => s.id === scrobble.id)
    ) {
      return;
    }

    // Persist first so the row is on disk before any subscriber acts on the
    // new in-memory state. insertScrobble is INSERT OR IGNORE so a collision
    // with a concurrently-added row can't throw.
    insertScrobble(scrobble);

    const artist = scrobble.song.artist;
    const newArtists =
      artist && !(artist in state.stats.uniqueArtists)
        ? { ...state.stats.uniqueArtists, [artist]: true as const }
        : state.stats.uniqueArtists;

    // Incremental aggregate updates
    const agg = state.aggregates;
    const artistName = artist ?? 'Unknown';
    const existingArtistEntry = agg.artistCounts[artistName];
    const newArtistCounts = {
      ...agg.artistCounts,
      [artistName]: existingArtistEntry
        ? {
            count: existingArtistEntry.count + 1,
            artistId: existingArtistEntry.artistId ?? scrobble.song.artistId ?? undefined,
          }
        : { count: 1, artistId: scrobble.song.artistId ?? undefined },
    };

    const albumKey = `${scrobble.song.album ?? 'Unknown'}::${artistName}`;
    const existingAlbum = agg.albumCounts[albumKey];
    const newAlbumCounts = {
      ...agg.albumCounts,
      [albumKey]: existingAlbum
        ? {
            ...existingAlbum,
            count: existingAlbum.count + 1,
            coverArt: scrobble.song.coverArt ?? existingAlbum.coverArt,
            albumId: existingAlbum.albumId ?? scrobble.song.albumId ?? undefined,
          }
        : {
            artist: artistName,
            coverArt: scrobble.song.coverArt ?? undefined,
            count: 1,
            albumId: scrobble.song.albumId ?? undefined,
          },
    };

    const existingSong = agg.songCounts[scrobble.song.id];
    const newSongCounts = {
      ...agg.songCounts,
      [scrobble.song.id]: { song: scrobble.song, count: (existingSong?.count ?? 0) + 1 },
    };

    const genre = getPrimaryGenre(scrobble.song);
    let newGenreCounts = agg.genreCounts;
    if (genre) {
      newGenreCounts = { ...agg.genreCounts, [genre]: (agg.genreCounts[genre] ?? 0) + 1 };
    }

    const newHourBuckets = [...agg.hourBuckets];
    newHourBuckets[new Date(scrobble.time).getHours()]++;

    const dk = dateKey(scrobble.time);
    const newDayCounts = { ...agg.dayCounts, [dk]: (agg.dayCounts[dk] ?? 0) + 1 };

    set({
      completedScrobbles: [...state.completedScrobbles, scrobble],
      stats: {
        totalPlays: state.stats.totalPlays + 1,
        totalListeningSeconds:
          state.stats.totalListeningSeconds + (scrobble.song.duration ?? 0),
        uniqueArtists: newArtists,
      },
      aggregates: {
        artistCounts: newArtistCounts,
        albumCounts: newAlbumCounts,
        songCounts: newSongCounts,
        genreCounts: newGenreCounts,
        hourBuckets: newHourBuckets,
        dayCounts: newDayCounts,
      },
    });
  },

  rebuildStats: () => {
    const { completedScrobbles } = get();
    set({ stats: buildStats(completedScrobbles) });
  },

  rebuildAggregates: () => {
    const { completedScrobbles } = get();
    set({ aggregates: buildAggregates(completedScrobbles) });
  },

  replaceAll: (scrobbles) => {
    // Dedupe + validate mirror what `hydrateScrobbles` / `insertScrobble`
    // already enforce, so the in-memory array matches what lands on disk.
    const seen = new Set<string>();
    const valid: CompletedScrobble[] = [];
    for (const s of scrobbles) {
      if (!s?.id || !s.song?.id || !s.song.title || seen.has(s.id)) continue;
      seen.add(s.id);
      valid.push(s);
    }
    replaceAllScrobbles(valid);
    set({
      completedScrobbles: valid,
      stats: buildStats(valid),
      aggregates: buildAggregates(valid),
    });
  },

  mergeAll: (scrobbles) => {
    const result = mergeScrobbles(scrobbles);
    // Re-hydrate from SQL so the in-memory array matches the unioned table
    // exactly. Cheaper than reconciling incrementally and avoids drift if
    // any rows were silently rejected by the table-level validation.
    const restored = hydrateScrobbles();
    set({
      completedScrobbles: restored,
      stats: buildStats(restored),
      aggregates: buildAggregates(restored),
    });
    return result;
  },

  hydrateFromDbAsync: async () => {
    // Idempotent re-read; the per-row table is the source of truth.
    const restored = await hydrateScrobblesAsync();
    set({
      completedScrobbles: restored,
      stats: buildStats(restored),
      aggregates: buildAggregates(restored),
      hasHydrated: true,
    });
  },
}));
