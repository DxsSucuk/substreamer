/**
 * Album-info fetch coordination shared by the phone
 * (`player-phone-portrait.tsx`) and tablet (`PlayerTabletLandscape.tsx`)
 * players. Owns the store selectors, the fetch-attempt guard ref, the gated
 * effect, retry/refresh handlers, and refreshing state.
 *
 * Timeout / error-reset semantics live inside
 * `albumInfoStore.fetchAlbumInfo()` (15s `withTimeout`), so this hook is
 * a thin coordination layer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  albumInfoStore,
  type AlbumInfoEntry,
  type AlbumInfoErrorKind,
} from '../store/albumInfoStore';
import { minDelay } from '../utils/stringHelpers';

export interface UsePlayerAlbumInfoOptions {
  /**
   * Whether the consumer is currently displaying the album-info surface.
   * Phone passes nothing (component is conditionally mounted); tablet
   * passes `rightPanelMode === 'info'` so the fetch only fires when the
   * panel is actually visible.
   */
  enabled?: boolean;
}

export interface PlayerAlbumInfoResult {
  entry: AlbumInfoEntry | undefined;
  loading: boolean;
  error: AlbumInfoErrorKind | null;
  refreshing: boolean;
  handleRetry: () => void;
  handleRefresh: () => Promise<void>;
}

export function usePlayerAlbumInfo(
  albumId: string | null,
  artist: string | null | undefined,
  album: string | null | undefined,
  options: UsePlayerAlbumInfoOptions = {},
): PlayerAlbumInfoResult {
  const enabled = options.enabled ?? true;

  const entry = albumInfoStore((s) => (albumId ? s.entries[albumId] : undefined));
  const loading = albumInfoStore((s) => (albumId ? (s.loading[albumId] ?? false) : false));
  const error = albumInfoStore((s) => (albumId ? (s.errors[albumId] ?? null) : null));

  const fetchAttemptedRef = useRef<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    if (!albumId || entry || loading) return;
    if (fetchAttemptedRef.current === albumId) return;
    fetchAttemptedRef.current = albumId;
    // Cached info lives in `album_info` — read it first and only hit the network on a
    // genuine miss.
    void (async () => {
      const cached = await albumInfoStore.getState().hydrateAlbumInfo(albumId);
      if (cached) return;
      await albumInfoStore.getState().fetchAlbumInfo(
        albumId,
        artist ?? undefined,
        album ?? undefined,
      );
    })();
  }, [enabled, albumId, entry, loading, artist, album]);

  // Reset the per-album guard when the album changes.
  useEffect(() => {
    fetchAttemptedRef.current = null;
  }, [albumId]);

  const handleRetry = useCallback(() => {
    if (!albumId) return;
    fetchAttemptedRef.current = null;
    albumInfoStore.getState().fetchAlbumInfo(
      albumId,
      artist ?? undefined,
      album ?? undefined,
    );
  }, [albumId, artist, album]);

  const handleRefresh = useCallback(async () => {
    if (!albumId) return;
    setRefreshing(true);
    const delay = minDelay();
    // Drop the cached entry so the next fetch is a fresh hit. Functional updater so the
    // delete applies to the latest state — a read-then-write could clobber a concurrent
    // `entries` update.
    albumInfoStore.setState((state) => {
      const { [albumId]: _drop, ...rest } = state.entries;
      return { entries: rest };
    });
    fetchAttemptedRef.current = null;
    await albumInfoStore.getState().fetchAlbumInfo(
      albumId,
      artist ?? undefined,
      album ?? undefined,
    );
    await delay;
    setRefreshing(false);
  }, [albumId, artist, album]);

  return { entry, loading, error, refreshing, handleRetry, handleRefresh };
}
