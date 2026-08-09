import { create } from 'zustand';

import { clearAllLyrics, loadLyrics, saveLyrics } from './persistence/lyricsTable';

import { getLyricsForTrack, type LyricsData } from '../services/subsonicService';
import { withTimeout } from '../utils/withTimeout';

/** Hard budget for a single lyrics fetch (OpenSubsonic + classic fallback). */
const FETCH_TIMEOUT_MS = 15_000;

export type LyricsErrorKind = 'timeout' | 'error';

interface LyricsState {
  /** Session cache indexed by track ID. NOT persisted — the `lyrics` table is. */
  entries: Record<string, LyricsData>;
  /** Per-track loading flags. */
  loading: Record<string, boolean>;
  /** Per-track error flags. Set when the last fetch failed. */
  errors: Record<string, LyricsErrorKind>;
  /** Resolve lyrics for a track: memory, then the table, then the network. */
  fetchLyrics: (
    trackId: string,
    artist?: string,
    title?: string,
  ) => Promise<LyricsData | null>;
  /** Clear all cached lyrics, in memory and on disk. */
  clearLyrics: () => Promise<void>;
}

export const lyricsStore = create<LyricsState>()((set, get) => ({
  entries: {},
  loading: {},
  errors: {},

  fetchLyrics: async (trackId, artist, title) => {
    const cached = get().entries[trackId];
    if (cached) return cached;

    set({
      loading: { ...get().loading, [trackId]: true },
      errors: (() => {
        const { [trackId]: _, ...rest } = get().errors;
        return rest;
      })(),
    });

    const clearLoading = () => {
      const { [trackId]: _, ...rest } = get().loading;
      set({ loading: rest });
    };
    const setError = (kind: LyricsErrorKind) => {
      set({ errors: { ...get().errors, [trackId]: kind } });
    };
    const remember = (data: LyricsData) => {
      set({ entries: { ...get().entries, [trackId]: data } });
    };

    try {
      const stored = await loadLyrics(trackId);
      if (stored !== null) {
        remember(stored);
        return stored;
      }

      const result = await withTimeout(
        async () => getLyricsForTrack(trackId, artist, title),
        FETCH_TIMEOUT_MS,
      );

      if (result === 'timeout') {
        setError('timeout');
        return null;
      }

      if (result === null) {
        // Well-defined "no lyrics for this track" case. No entry, no error, no row.
        return null;
      }

      await saveLyrics(trackId, result);
      remember(result);
      return result;
    } catch {
      setError('error');
      return null;
    } finally {
      clearLoading();
    }
  },

  clearLyrics: async () => {
    set({ entries: {}, loading: {}, errors: {} });
    await clearAllLyrics();
  },
}));
