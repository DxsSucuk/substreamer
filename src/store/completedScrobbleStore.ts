import { create } from 'zustand';

import {
  backfillScrobbleColumnsAsync,
  insertScrobble,
  mergeScrobbles,
  replaceAllScrobbles,
} from './persistence/scrobbleTable';
import {
  computeScrobbleAnalytics,
  loadRecentScrobbles,
} from './persistence/scrobbleAggregates';

import { type Child } from '../services/subsonicService';

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
  /** Bounded, NEWEST-FIRST recent slice — for the history browser + any recent
   *  display. NOT the full history: analytics come from SQL aggregates, never a
   *  full in-memory array. */
  recentScrobbles: CompletedScrobble[];
  /** All-time stats + aggregates, computed by SQL GROUP BY (bounded by unique
   *  entities). Refreshed on add / hydrate / replace / merge. */
  stats: ListeningStats;
  aggregates: AnalyticsAggregates;
  /** True after the on-start hydration from SQLite has populated the store. */
  hasHydrated: boolean;

  addCompleted: (scrobble: CompletedScrobble) => void;
  /** Recompute all-time stats + aggregates + the recent slice from SQL. */
  refreshFromDb: () => Promise<void>;
  /**
   * Replace the entire scrobble set in the SQLite table (backup restore),
   * then refresh derived stats/aggregates from SQL.
   */
  replaceAll: (scrobbles: CompletedScrobble[]) => Promise<void>;
  /**
   * Merge the given scrobbles into the existing set (INSERT OR IGNORE per row).
   * Used by merge-mode backup restore so a backup from another device unifies
   * with locally-accumulated scrobbles. Refreshes from SQL after. Returns
   * `{ added, skipped }`.
   */
  mergeAll: (scrobbles: CompletedScrobble[]) => Promise<{ added: number; skipped: number }>;
  /** Called once at app start: backfill the structured columns for legacy rows,
   *  then compute analytics from SQL (no full-history load into memory). */
  hydrateFromDbAsync: () => Promise<void>;
}

/** How many recent scrobbles to keep in memory (history browser + home). */
const RECENT_CAP = 200;

export const completedScrobbleStore = create<CompletedScrobbleState>()((set, get) => ({
  recentScrobbles: [],
  stats: { ...EMPTY_STATS },
  aggregates: { ...EMPTY_AGGREGATES, hourBuckets: new Array(24).fill(0) },
  hasHydrated: false,

  addCompleted: (scrobble) => {
    if (!scrobble.id || !scrobble.song?.id || !scrobble.song.title) return;
    const state = get();
    if (state.recentScrobbles.some((s) => s.id === scrobble.id)) return;
    // Optimistic: surface in the recent slice immediately (newest-first, capped).
    set({ recentScrobbles: [scrobble, ...state.recentScrobbles].slice(0, RECENT_CAP) });
    // Persist (INSERT OR IGNORE dedupes on disk), then recompute analytics from
    // SQL. The aggregates are bounded by unique entities, so the recompute is
    // cheap + drift-free (no incremental-bump double-count risk).
    void (async () => {
      await insertScrobble(scrobble);
      await get().refreshFromDb();
    })();
  },

  refreshFromDb: async () => {
    const [{ stats, aggregates }, recent] = await Promise.all([
      computeScrobbleAnalytics(0),
      loadRecentScrobbles(RECENT_CAP),
    ]);
    set({ stats, aggregates, recentScrobbles: recent });
  },

  replaceAll: async (scrobbles) => {
    const seen = new Set<string>();
    const valid: CompletedScrobble[] = [];
    for (const s of scrobbles) {
      if (!s?.id || !s.song?.id || !s.song.title || seen.has(s.id)) continue;
      seen.add(s.id);
      valid.push(s);
    }
    await replaceAllScrobbles(valid);
    await get().refreshFromDb();
  },

  mergeAll: async (scrobbles) => {
    const result = await mergeScrobbles(scrobbles);
    await get().refreshFromDb();
    return result;
  },

  hydrateFromDbAsync: async () => {
    // Backfill the structured columns for any legacy (pre-columns) rows, then
    // compute analytics from SQL — no full-history array load into memory.
    await backfillScrobbleColumnsAsync();
    await get().refreshFromDb();
    set({ hasHydrated: true });
  },
}));
