import { calendarDaysBetween } from './dateKey';

/**
 * Common leading articles/prefixes stripped when computing artist initials.
 * Covers English, Spanish, French, German, Italian, and Portuguese articles.
 */
const ARTIST_PREFIX_RE = /^(the|a|an|el|la|las|los|le|les|der|die|das|il|lo|gli|os|as)\s+/i;

/**
 * Derive 2-character initials for an artist name.
 *
 * - Strips common leading articles ("The", "A", "El", "Le", etc.)
 * - Multi-word name → first letter of each of the first two words
 * - Single-word name → first two letters
 */
export function getArtistInitials(name: string): string {
  const stripped = name.replace(ARTIST_PREFIX_RE, '');
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length === 0) return name.substring(0, 2).toUpperCase();
  if (words.length === 1) return words[0].substring(0, 2).toUpperCase();
  return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
}

/**
 * Return a promise that resolves after `ms` milliseconds.
 * Used to ensure pull-to-refresh animations have a minimum visible duration.
 */
export function minDelay(ms = 2000): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format a timestamp as a human-readable relative time string.
 * Requires i18next `t` function for localised output.
 *
 * "Yesterday" / "N days ago" use CALENDAR days (in local time), not elapsed
 * 24-hour buckets: `Math.floor(hours / 24) === 1` would call a play "47 hours
 * ago" yesterday, disagreeing with the calendar-based streak / heatmap views.
 * If the streak says yesterday was empty, the recent-play row must not claim
 * to be "yesterday".
 */
export function timeAgo(ts: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const now = Date.now();
  const diff = now - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return t('justNow');
  if (mins < 60) return t('minutesAgo', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('hoursAgo', { count: hours });

  // Calendar-aware days bucket. Walk back at most a week from today to
  // find which calendar bucket the timestamp falls in.
  const cd = calendarDaysBetween(ts, now, 8);
  if (cd === 1) return t('yesterday');
  if (cd >= 2 && cd <= 6) return t('daysAgo', { count: cd });
  // cd === 0 here means same calendar day but >= 24 hours elapsed — a
  // clock or timezone shift edge case. Fall back to the hours bucket.
  if (cd === 0) return t('hoursAgo', { count: hours });

  // Beyond a week — preserve original elapsed-time rendering.
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return t('weeksAgo', { count: weeks });
  const months = Math.floor(days / 30);
  if (months < 12) return t('monthsAgo', { count: months });
  const years = Math.floor(days / 365);
  return t('yearsAgo', { count: years });
}
