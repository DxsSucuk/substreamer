/**
 * Resolve the cover-art VALUE for a Subsonic entity.
 *
 * Per the OpenSubsonic spec, `getCoverArt?id=` takes the entity's `coverArt`
 * token (the opaque value from its metadata), NOT the entity id. We use that
 * `coverArt` value as both the image-cache key and the fetch id everywhere —
 * never the entity id (#202). Servers where `coverArt !== id` (airsonic-advanced,
 * Gonic) return a placeholder/error for an entity id; the `coverArt` token works
 * on all servers.
 *
 * These helpers are PURE (no store access) — the album-coverArt lookup used by
 * song "album mode" is injected. The store-backed resolvers + reactive hook live
 * in `src/hooks/useSongCoverArt.ts`.
 *
 * Returns `undefined` when the entity has no usable `coverArt`; `CachedImage`
 * and `getCoverArtUrl` are null-safe for that.
 */

import { type SongCoverArtMode } from '../store/layoutPreferencesStore';
import { type AlbumID3, type ArtistID3, type Child, type Playlist } from '../services/subsonicService';

export function coverArtForAlbum(album: { coverArt?: string | null }): string | undefined {
  return album.coverArt ?? undefined;
}

export function coverArtForArtist(artist: { coverArt?: string | null }): string | undefined {
  return artist.coverArt ?? undefined;
}

export function coverArtForPlaylist(playlist: { coverArt?: string | null }): string | undefined {
  return playlist.coverArt ?? undefined;
}

/**
 * Cover-art value for a song.
 * - `album` mode (default): the PARENT album's `coverArt` so every track in an
 *   album shares one cover. Resolved via `lookupAlbumCoverArt(albumId)`; falls
 *   back to the song's own `coverArt` when the album isn't in the local library
 *   (a song surfaced via search/playlist whose new album hasn't synced yet, or
 *   the pre-first-sync window).
 * - `perTrack` mode: the song's own `coverArt`.
 * Always a `coverArt` value, never an entity id.
 */
export function coverArtForSong(
  song: { coverArt?: string | null; albumId?: string | null },
  mode: SongCoverArtMode,
  lookupAlbumCoverArt: (albumId: string | null | undefined) => string | undefined,
): string | undefined {
  if (mode === 'perTrack') return song.coverArt ?? undefined;
  return lookupAlbumCoverArt(song.albumId) ?? song.coverArt ?? undefined;
}

/**
 * Polymorphic dispatch over the four entity shapes. `Child` (song) is detected
 * by the presence of an `albumId` key and routed through the song-mode logic;
 * everything else uses its `coverArt`.
 */
export function coverArtForEntity(
  entity: AlbumID3 | ArtistID3 | Playlist | Child,
  mode: SongCoverArtMode,
  lookupAlbumCoverArt: (albumId: string | null | undefined) => string | undefined,
): string | undefined {
  if ('albumId' in entity) {
    return coverArtForSong(entity, mode, lookupAlbumCoverArt);
  }
  return (entity as { coverArt?: string | null }).coverArt ?? undefined;
}
