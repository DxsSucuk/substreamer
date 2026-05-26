import {
  ensureCoverArtAuth,
  search3,
  type AlbumID3,
  type ArtistID3,
  type Child,
} from './subsonicService';
import { albumLibraryStore } from '../store/albumLibraryStore';
import { musicCacheStore, getSongEnvelope } from '../store/musicCacheStore';
import { playlistLibraryStore } from '../store/playlistLibraryStore';
import { getGenreNames } from '../utils/genreHelpers';

export interface SearchResults {
  albums: AlbumID3[];
  artists: ArtistID3[];
  songs: Child[];
}

export async function performOnlineSearch(query: string): Promise<SearchResults> {
  await ensureCoverArtAuth();
  return search3(query);
}

/**
 * Construct a minimal Child from a cached_songs row + its parent cached_item.
 *
 * Hot fields only — sufficient for `SongRow` display and `playTrack`. Cover
 * art is resolved downstream via `song.albumId ?? song.id` (entity-ID model);
 * we do not populate `coverArt` because no consumer reads it.
 */
function childFromCachedSong(
  track: { id: string; title: string; artist?: string; albumId: string; duration: number },
  parentItemName?: string,
): Child {
  return {
    id: track.id,
    albumId: track.albumId,
    title: track.title,
    artist: track.artist,
    album: parentItemName,
    duration: track.duration,
    isDir: false,
  };
}

export function performOfflineSearch(query: string): SearchResults {
  const q = query.toLowerCase();
  const { cachedItems, cachedSongs } = musicCacheStore.getState();
  const cachedIds = new Set(Object.keys(cachedItems));

  const albums = albumLibraryStore
    .getState()
    .albums.filter(
      (a) =>
        cachedIds.has(a.id) &&
        (a.name.toLowerCase().includes(q) ||
          (a.artist?.toLowerCase().includes(q) ?? false))
    );

  const playlists = playlistLibraryStore
    .getState()
    .playlists.filter(
      (p) => cachedIds.has(p.id) && p.name.toLowerCase().includes(q)
    );

  const playlistAlbums: AlbumID3[] = playlists.map((p) => ({
    id: p.id,
    name: p.name,
    artist: p.owner,
    coverArt: p.coverArt,
    songCount: p.songCount,
    duration: p.duration,
    created: p.created,
  }));

  const songs: Child[] = [];
  const seen = new Set<string>();
  for (const item of Object.values(cachedItems)) {
    for (const songId of item.songIds) {
      if (seen.has(songId)) continue;
      const track = cachedSongs[songId];
      if (!track) continue;
      if (
        track.title.toLowerCase().includes(q) ||
        (track.artist?.toLowerCase().includes(q) ?? false)
      ) {
        seen.add(songId);
        songs.push(childFromCachedSong(track, item.name));
      }
    }
  }

  return {
    albums: [...albums, ...playlistAlbums],
    artists: [],
    songs,
  };
}

/**
 * Every downloaded song, optionally filtered by genre.
 *
 * Iterates `cachedItems` (downloaded items including the `__starred__`
 * aggregate) → `songIds` → `cachedSongs`. Dedup by song id so a track
 * that lives under multiple cached items appears once.
 *
 * Genre filtering reads each song's full envelope via `getSongEnvelope()`
 * (lazy JSON parse with WeakMap memoisation) since the `cached_songs` hot
 * columns don't carry genre. For text-only paths (no genre filter) we
 * never touch the envelope, so the call is essentially free.
 */
function collectOfflineSongs(genreFilter?: string): Child[] {
  const g = genreFilter?.toLowerCase();
  const { cachedItems, cachedSongs } = musicCacheStore.getState();

  const out: Child[] = [];
  const seen = new Set<string>();

  for (const item of Object.values(cachedItems)) {
    for (const songId of item.songIds) {
      if (seen.has(songId)) continue;
      const track = cachedSongs[songId];
      if (!track) continue;
      if (g) {
        const envelope = getSongEnvelope(songId);
        const names = envelope ? getGenreNames(envelope) : [];
        if (!names.some((name) => name.toLowerCase() === g)) continue;
      }
      seen.add(songId);
      out.push(childFromCachedSong(track, item.name));
    }
  }

  return out;
}

export function getOfflineSongsByGenre(genre: string): Child[] {
  return collectOfflineSongs(genre);
}

export function getOfflineSongsAll(): Child[] {
  return collectOfflineSongs();
}
