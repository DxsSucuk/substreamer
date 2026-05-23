/**
 * Shared player lyrics fetch coordination. Owns the store selectors, the
 * fetch-attempt guard ref, the gated effect, and the retry handler. The
 * phone (`player-view.tsx`) and tablet (`ExpandedPlayerView.tsx`) used to
 * implement this independently — see Phase 6 of
 * `plans/2026-05-22-audit-remediation-roadmap.md` for full rationale.
 *
 * No refresh handler: neither surface exposes one for lyrics, matching the
 * existing UX (refresh is album-info only).
 *
 * Timeout / error-reset semantics live inside `lyricsStore.fetchLyrics()`
 * (15s `withTimeout`), so this hook is a thin coordination layer.
 */

import { useCallback, useEffect, useRef } from 'react';

import { lyricsStore, type LyricsErrorKind } from '../store/lyricsStore';
import { type LyricsData } from '../services/subsonicService';

export interface PlayerLyricsResult {
  entry: LyricsData | undefined;
  loading: boolean;
  error: LyricsErrorKind | null;
  handleRetry: () => void;
}

export function usePlayerLyrics(
  trackId: string | null,
  artist: string | null | undefined,
  title: string | null | undefined,
): PlayerLyricsResult {
  const entry = lyricsStore((s) => (trackId ? s.entries[trackId] : undefined));
  const loading = lyricsStore((s) => (trackId ? (s.loading[trackId] ?? false) : false));
  const error = lyricsStore((s) => (trackId ? (s.errors[trackId] ?? null) : null));

  const fetchAttemptedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!trackId || entry || loading) return;
    if (fetchAttemptedRef.current === trackId) return;
    fetchAttemptedRef.current = trackId;
    lyricsStore.getState().fetchLyrics(
      trackId,
      artist ?? undefined,
      title ?? undefined,
    );
  }, [trackId, entry, loading, artist, title]);

  // Reset the per-track guard when the track changes.
  useEffect(() => {
    fetchAttemptedRef.current = null;
  }, [trackId]);

  const handleRetry = useCallback(() => {
    if (!trackId) return;
    fetchAttemptedRef.current = null;
    lyricsStore.getState().fetchLyrics(
      trackId,
      artist ?? undefined,
      title ?? undefined,
    );
  }, [trackId, artist, title]);

  return { entry, loading, error, handleRetry };
}
