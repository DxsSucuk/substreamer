import { useMemo } from 'react';

import { coverArtForEntity, coverArtForSong } from '../utils/coverArtId';
import { albumLibraryStore } from '../store/albumLibraryStore';
import { layoutPreferencesStore } from '../store/layoutPreferencesStore';
import { type AlbumID3, type ArtistID3, type Child, type Playlist } from '../services/subsonicService';

// Memoised `albumId -> coverArt` map over the full synced library. Rebuilt only
// when `albumLibraryStore.albums` changes reference (sync / upsert), so song
// "album mode" resolves the parent album's coverArt in O(1) without scanning the
// (up to ~100k) array on every render.
let _mapSource: AlbumID3[] | null = null;
let _map = new Map<string, string>();

/** Parent album's `coverArt` for an album id, from the synced library. */
export function albumCoverArtById(albumId: string | null | undefined): string | undefined {
  if (!albumId) return undefined;
  const albums = albumLibraryStore.getState().albums;
  if (albums !== _mapSource) {
    const next = new Map<string, string>();
    for (const a of albums) {
      if (a.id && a.coverArt) next.set(a.id, a.coverArt);
    }
    _map = next;
    _mapSource = albums;
  }
  return _map.get(albumId);
}

/**
 * Non-reactive song cover-art value (reads the current mode + library). For
 * services / headless callers — prefetch, RNTP lock-screen artwork.
 */
export function resolveSongCoverArt(song: {
  coverArt?: string | null;
  albumId?: string | null;
} | null | undefined): string | undefined {
  if (!song) return undefined;
  return coverArtForSong(song, layoutPreferencesStore.getState().songCoverArtMode, albumCoverArtById);
}

/** Non-reactive polymorphic resolver for prefetch over mixed entities. */
export function resolveEntityCoverArt(
  entity: AlbumID3 | ArtistID3 | Playlist | Child,
): string | undefined {
  return coverArtForEntity(entity, layoutPreferencesStore.getState().songCoverArtMode, albumCoverArtById);
}

/**
 * Reactive song cover-art value for render sites. Re-renders when the mode
 * toggles or the song changes; the album lookup is read non-reactively (the rare
 * unsynced-album fallback resolves on the next render after a sync).
 */
export function useSongCoverArt(song: {
  id?: string;
  coverArt?: string | null;
  albumId?: string | null;
} | null | undefined): string | undefined {
  const mode = layoutPreferencesStore((s) => s.songCoverArtMode);
  return useMemo(
    () => (song ? coverArtForSong(song, mode, albumCoverArtById) : undefined),
    [song?.id, song?.coverArt, song?.albumId, mode],
  );
}
