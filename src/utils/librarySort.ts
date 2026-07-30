/**
 * Pure, store-independent list sorts for the bounded filtered library views
 * (favorites / downloaded). Article- + accent-folded keys via a Schwartzian
 * transform (keys computed once per item). Callers pass the live articles/sort
 * preference so this stays free of store imports (and survives the removal of
 * the legacy library stores).
 */
import type { AlbumID3, ArtistID3, Playlist } from 'subsonic-api';

import { baseCollator } from './intl';
import { getSortKey } from './sortHelpers';

export type AlbumSortOrder = 'title' | 'artist';

/** Sort albums by the user's preference (title OR artist) — mirrors the library
 *  list's A-Z so the alphabet scroller aligns. */
export function sortAlbumsByPreference(
  albums: readonly AlbumID3[],
  sortOrder: AlbumSortOrder,
  articles?: readonly string[],
): AlbumID3[] {
  const decorated = albums.map((a): [string, AlbumID3] => [
    sortOrder === 'title'
      ? getSortKey(a.name ?? '', a.sortName, articles)
      : getSortKey(a.artist ?? '', undefined, articles),
    a,
  ]);
  decorated.sort(([ka], [kb]) => baseCollator.compare(ka, kb));
  return decorated.map(([, a]) => a);
}

/** Sort artists A-Z by (sort) name. */
export function sortArtistsByName(
  artists: readonly ArtistID3[],
  articles?: readonly string[],
): ArtistID3[] {
  const decorated = artists.map((a): [string, ArtistID3] => [
    getSortKey(a.name ?? '', a.sortName, articles),
    a,
  ]);
  decorated.sort(([ka], [kb]) => baseCollator.compare(ka, kb));
  return decorated.map(([, a]) => a);
}

/** Sort playlists A-Z by name (playlists have no server sortName). */
export function sortPlaylistsByName(
  playlists: readonly Playlist[],
  articles?: readonly string[],
): Playlist[] {
  const decorated = playlists.map((p): [string, Playlist] => [
    getSortKey(p.name ?? '', undefined, articles),
    p,
  ]);
  decorated.sort(([ka], [kb]) => baseCollator.compare(ka, kb));
  return decorated.map(([, p]) => p);
}
