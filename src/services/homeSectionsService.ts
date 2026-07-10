/**
 * Home album-list composition — the single source of truth for WHICH album
 * lists appear on the Home surface, in what order, and how they're filtered.
 * Shared by the Home screen (`src/screens/home.tsx`) and the CarPlay / Android
 * Auto browse tree (`headlessMediaService`) so both agree exactly, especially offline.
 *
 * Rules (mirrors the historical inline `home.tsx` logic):
 * - Online, unfiltered: Recently Added / Recently Played / Frequently Played /
 *   Random, in that order.
 * - `downloadedOnly`: prepend a **Downloaded Albums** list (every downloaded
 *   album) and filter each list to downloaded albums.
 * - `favoritesOnly`: filter each list to starred albums.
 * - `offlineMode`: drop **Random** (it's never meaningful offline).
 *
 * This selector only ORDERS + FILTERS the lists; it does NOT drop empty lists —
 * consumers decide empty-handling (the Home screen shows a placeholder for
 * Downloaded Albums but hides other empty lists when filtered; the car omits
 * empty rows).
 */
import type { AlbumID3 } from './subsonicService';
import { type AlbumListType } from '../store/albumListsStore';
import { albumPassesDownloadedFilter } from '../store/persistence/cachedItemHelpers';

/** Album-section identity: one of the curated lists, or the downloaded-albums list. */
export type HomeAlbumSectionType = AlbumListType | 'downloadedAlbums';

export interface HomeAlbumSection {
  type: HomeAlbumSectionType;
  /** i18n key for the section title (equals `type` for the curated lists). */
  titleKey: string;
  albums: AlbumID3[];
}

/** `musicCacheStore.cachedItems` shape — borrowed from the filter predicate. */
type CachedItems = Parameters<typeof albumPassesDownloadedFilter>[1];

export interface ComposeHomeInput {
  recentlyAdded: AlbumID3[];
  recentlyPlayed: AlbumID3[];
  frequentlyPlayed: AlbumID3[];
  randomSelection: AlbumID3[];
  /** Full library album list — source for the Downloaded Albums list. */
  allLibraryAlbums: AlbumID3[];
  offlineMode: boolean;
  downloadedOnly: boolean;
  favoritesOnly: boolean;
  /** Starred albums — used when `favoritesOnly`. */
  starredAlbums: AlbumID3[];
  cachedItems: CachedItems;
  includePartial: boolean;
}

/** Curated-list order (Random last; dropped offline). */
export const HOME_SECTION_ORDER: AlbumListType[] = [
  'recentlyAdded',
  'recentlyPlayed',
  'frequentlyPlayed',
  'randomSelection',
];

export function composeHomeAlbumSections(input: ComposeHomeInput): HomeAlbumSection[] {
  const {
    recentlyAdded,
    recentlyPlayed,
    frequentlyPlayed,
    randomSelection,
    allLibraryAlbums,
    offlineMode,
    downloadedOnly,
    favoritesOnly,
    starredAlbums,
    cachedItems,
    includePartial,
  } = input;

  const lists: Record<AlbumListType, AlbumID3[]> = {
    recentlyAdded,
    recentlyPlayed,
    frequentlyPlayed,
    randomSelection,
  };

  const hasFilters = downloadedOnly || favoritesOnly;
  const starredIds = favoritesOnly ? new Set(starredAlbums.map((a) => a.id)) : null;

  const filterList = (albums: AlbumID3[]): AlbumID3[] => {
    if (!hasFilters) return albums;
    return albums.filter((album) => {
      if (downloadedOnly && !albumPassesDownloadedFilter(album, cachedItems, includePartial)) {
        return false;
      }
      if (starredIds && !starredIds.has(album.id)) return false;
      return true;
    });
  };

  const sections: HomeAlbumSection[] = [];

  if (downloadedOnly) {
    sections.push({
      type: 'downloadedAlbums',
      titleKey: 'downloadedAlbums',
      albums: allLibraryAlbums.filter((a) =>
        albumPassesDownloadedFilter(a, cachedItems, includePartial),
      ),
    });
  }

  for (const key of HOME_SECTION_ORDER) {
    if (offlineMode && key === 'randomSelection') continue;
    sections.push({ type: key, titleKey: key, albums: filterList(lists[key]) });
  }

  return sections;
}
