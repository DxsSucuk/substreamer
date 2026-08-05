/**
 * Pure, store-independent list sorts for the bounded filtered library views
 * (favorites / downloaded). Article- + accent-folded keys via a Schwartzian
 * transform (keys computed once per item). Callers pass the live articles/sort
 * preference so this stays free of store imports (and survives the removal of
 * the legacy library stores).
 */
import type { ArtistID3, Playlist } from 'subsonic-api';

import { baseCollator, defaultCollator } from './intl';
import { getSortKey } from './sortHelpers';

/** Title-order comparator for the bounded song filter views. `defaultCollator`, not
 *  `localeCompare` — Hermes on Android ARM64 clones a fresh ICU collator per call
 *  (#867), which is why the raw method is banned repo-wide. */
export const byTitle = (a: { title?: string }, b: { title?: string }): number =>
  defaultCollator.compare(a.title ?? '', b.title ?? '');

export type AlbumSortOrder = 'title' | 'artist';

/** The album fields this sort reads — structural, not `AlbumID3`, so a narrow browse
 *  row sorts without being widened into a full entity first. */
export interface SortableAlbum {
  id: string;
  name?: string;
  artist?: string;
  sortName?: string;
}

/** Sort albums by the user's preference (title OR artist) — mirrors the library
 *  list's A-Z so the alphabet scroller aligns. */
export function sortAlbumsByPreference<T extends SortableAlbum>(
  albums: readonly T[],
  sortOrder: AlbumSortOrder,
  articles?: readonly string[],
): T[] {
  const decorated = albums.map((a): [string, T] => [
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
