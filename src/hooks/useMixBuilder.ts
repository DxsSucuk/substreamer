/**
 * Stateful business logic for the "Build a Mix" feature, shared by both the
 * phone bottom-sheet builder and the embedded tablet panel so the two stay
 * presentation-only. Owns genre/decade selection, the genre search, and the
 * play action; the pure era/mix helpers live in `tunedInService`.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { connectivityStore } from '../store/connectivityStore';
import { genreStore } from '../store/genreStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { offlineModeStore } from '../store/offlineModeStore';
import { playTrack } from '../services/playerService';
import {
  decadeRangesForLabels,
  fetchCustomMix,
  fetchMixSongs,
} from '../services/tunedInService';
import { selectionAsync } from '../utils/haptics';

/** Max genres a mix can combine. */
export const MAX_SELECTED_GENRES = 3;

export interface MixBuilder {
  selectedGenres: string[];
  selectedDecades: string[];
  loading: boolean;
  /** User-facing message when a mix resolves empty or fails; null otherwise. */
  error: string | null;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  /** History genres + genres added via search, deduped. */
  displayGenres: string[];
  /** Server genres matching the current search query (excludes already-shown). */
  searchResults: string[];
  toggleGenre: (genre: string) => void;
  selectSearchResult: (genre: string) => void;
  toggleDecade: (label: string) => void;
  /** Resolve the selection to songs and start playback. */
  play: () => Promise<void>;
}

export function useMixBuilder(availableGenres: string[]): MixBuilder {
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [selectedDecades, setSelectedDecades] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [addedGenres, setAddedGenres] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();

  const serverGenres = genreStore((s) => s.genres);

  const displayGenres = useMemo(() => {
    const availableSet = new Set(availableGenres.map((g) => g.toLowerCase()));
    const extra = addedGenres.filter((g) => !availableSet.has(g.toLowerCase()));
    return [...extra, ...availableGenres];
  }, [availableGenres, addedGenres]);

  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query.length === 0) return [];
    const displaySet = new Set(displayGenres.map((g) => g.toLowerCase()));
    return serverGenres
      .filter((g) => {
        const name = g.value.toLowerCase();
        return name.includes(query) && !displaySet.has(name);
      })
      .slice(0, 8)
      .map((g) => g.value);
  }, [searchQuery, serverGenres, displayGenres]);

  const toggleGenre = useCallback((genre: string) => {
    setError(null);
    setSelectedGenres((prev) => {
      if (prev.includes(genre)) return prev.filter((g) => g !== genre);
      if (prev.length >= MAX_SELECTED_GENRES) return prev;
      return [...prev, genre];
    });
  }, []);

  const selectSearchResult = useCallback((genre: string) => {
    selectionAsync();
    setError(null);
    setAddedGenres((prev) => [genre, ...prev.filter((g) => g !== genre)]);
    setSelectedGenres((prev) => {
      if (prev.includes(genre)) return prev;
      if (prev.length >= MAX_SELECTED_GENRES) return prev;
      return [genre, ...prev];
    });
    setSearchQuery('');
  }, []);

  const toggleDecade = useCallback((label: string) => {
    selectionAsync();
    setError(null);
    setSelectedDecades((prev) =>
      prev.includes(label) ? prev.filter((d) => d !== label) : [...prev, label],
    );
  }, []);

  const play = useCallback(async () => {
    if (loading) return;
    selectionAsync();
    setError(null);
    setLoading(true);
    try {
      const online =
        !offlineModeStore.getState().offlineMode &&
        connectivityStore.getState().isServerReachable;
      const ll = layoutPreferencesStore.getState().listLength;
      const decadeRanges = decadeRangesForLabels(selectedDecades);

      let songs;
      if (selectedGenres.length === 0 && decadeRanges.length === 0) {
        // Nothing picked — fully random "Mix It Up".
        songs = await fetchMixSongs(
          online ? { type: 'random', size: ll } : { type: 'offline' },
          ll,
        );
      } else {
        // Genre-only, era-only, or both (incl. multiple non-contiguous decades).
        songs = await fetchCustomMix(selectedGenres, decadeRanges, online, ll);
      }
      if (songs.length > 0) {
        await playTrack(songs[0], songs);
      } else {
        // Never fail silently — the resolved mix was empty.
        setError(t('noSongsFound'));
      }
    } catch {
      setError(t('failedToLoad'));
    } finally {
      setLoading(false);
    }
  }, [loading, selectedGenres, selectedDecades, t]);

  return {
    selectedGenres,
    selectedDecades,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    displayGenres,
    searchResults,
    toggleGenre,
    selectSearchResult,
    toggleDecade,
    play,
  };
}
