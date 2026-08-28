/**
 * The stored A–Z sort keys, derived in ONE place.
 *
 * Every table that holds a sortable copy of an entity writes its keys through these —
 * the library tables (`albums`/`songs`/`artists`/`playlists`), the `favorite_*`
 * remainder and the `cached_*` download rows. A per-table derivation is how a filtered
 * list ends up ordered differently from browse over the same data.
 *
 * `articles` is the effective ignored-article list (the server's, else `undefined` →
 * `getSortKey` falls back to `DEFAULT_IGNORED_ARTICLES`). Imports nothing but
 * `sortHelpers`, so this module can be read from the repository, the store persistence
 * layer and the migration alike.
 */
import { getSortKey } from '@/utils/sortHelpers';

/** The album fields the keys derive from — structural, so an `AlbumID3`, a
 *  `CachedAlbumMeta` and a raw DB row all satisfy it. */
export interface AlbumSortSource {
  name?: string | null;
  sortName?: string | null;
  artist?: string | null;
  displayArtist?: string | null;
}

/** A type alias, not an interface: the migration hands these straight to a
 *  `Record<string, string>` column map, and only aliases get an implicit index
 *  signature. */
export type SortKeyPair = {
  sort_title: string;
  sort_artist: string;
};

/**
 * Album keys. `sort_artist` follows `displayArtist ?? artist ?? name` — the artist-less
 * album lands under its own title's letter rather than at the top of the list.
 */
export const albumSortKeys = (a: AlbumSortSource, articles?: readonly string[]): SortKeyPair => ({
  sort_title: getSortKey(a.name ?? '', a.sortName, articles),
  sort_artist: getSortKey(a.displayArtist ?? a.artist ?? a.name ?? '', undefined, articles),
});

/** Song keys. `sort_artist` derives from the SAME `artist` field the row displays and
 *  the scroller reads — deliberately NOT the album fallback chain. */
export const songSortKeys = (
  c: { title?: string | null; sortName?: string | null; artist?: string | null },
  articles?: readonly string[],
): SortKeyPair => ({
  sort_title: getSortKey(c.title ?? '', c.sortName, articles),
  sort_artist: getSortKey(c.artist ?? c.title ?? '', undefined, articles),
});

export const artistSortTitle = (
  a: { name?: string | null; sortName?: string | null },
  articles?: readonly string[],
): string => getSortKey(a.name ?? '', a.sortName, articles);

/** Playlists have no server `sortName`. */
export const playlistSortTitle = (
  p: { name?: string | null },
  articles?: readonly string[],
): string => getSortKey(p.name ?? '', undefined, articles);
