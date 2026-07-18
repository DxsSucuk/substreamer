/**
 * Genre normalization utilities.
 *
 * The `subsonic-api` library types `genres` as `string[]`, but OpenSubsonic
 * servers actually return `Array<{name: string}>`. This module defensively
 * handles both shapes so the rest of the codebase can work with clean strings.
 */

interface HasGenreFields {
  genre?: string;
  genres?: unknown[];
}

function normalizeGenreElement(element: unknown): string | null {
  if (typeof element === 'string') {
    const trimmed = element.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (element != null && typeof element === 'object' && 'name' in element) {
    const name = (element as { name: unknown }).name;
    if (typeof name === 'string') {
      const trimmed = name.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

/**
 * Extract all genre names from an item, deduplicated.
 *
 * Prefers the `genres` array (normalizing both `{name}` objects and plain
 * strings defensively). Falls back to the singular `genre` string if `genres`
 * is absent or empty. Never splits the `genre` string.
 */
export function getGenreNames(item: HasGenreFields | null | undefined): string[] {
  if (!item) return [];

  if (item.genres && Array.isArray(item.genres) && item.genres.length > 0) {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const element of item.genres) {
      const name = normalizeGenreElement(element);
      if (name && !seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    }
    if (result.length > 0) return result;
  }

  if (item.genre && typeof item.genre === 'string') {
    const trimmed = item.genre.trim();
    if (trimmed.length > 0) return [trimmed];
  }

  return [];
}

/**
 * Get the primary (first) genre name, or null if none.
 */
export function getPrimaryGenre(item: HasGenreFields | null | undefined): string | null {
  const names = getGenreNames(item);
  return names.length > 0 ? names[0] : null;
}

/**
 * Split a compound genre string into its component genres for a genre query.
 * Servers that store split single-value genres (e.g. Navidrome splits on
 * `; / ,`) can't match a joined tag like "Folk, World, & Country", so we split
 * on those delimiters and strip a leading "& "/"and " conjunction from each
 * part → ['Folk', 'World', 'Country']. Single-value names with no delimiter
 * ("R&B", "Rock & Roll", "Drum & Bass") are left intact. Trimmed + deduped.
 */
export function splitGenreValue(genre: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of genre.split(/[,;/]/)) {
    const part = raw.trim().replace(/^\s*(?:&|and)\s+/i, '').trim();
    if (part.length > 0 && !seen.has(part)) {
      seen.add(part);
      result.push(part);
    }
  }
  return result;
}
