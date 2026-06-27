/**
 * Shared formatting utilities used across the app.
 */

/**
 * Format a duration in seconds to a compact human-readable string. Auto-scales
 * to the largest meaningful unit so the value always fits within a bounded
 * column width:
 *
 *   < 1h   → "Xm"           (e.g. "5m", "59m")
 *   < 24h  → "Xh Ym"        (e.g. "1h 30m", "23h 59m")
 *   ≥ 24h  → "Xd Yh"        (e.g. "1d 0h", "4d 11h", "33d 8h")
 *
 * Matches the listening-time format on the home screen "My Listening" card.
 * Max output length is 7 characters ("23h 59m"), which `RowMetaLine` relies
 * on to size the duration slot.
 */
export function formatCompactDuration(seconds: number): string {
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const mins = totalMinutes - totalHours * 60;
    return `${totalHours}h ${mins}m`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours - days * 24;
  return `${days}d ${hours}h`;
}

/**
 * Format a duration in seconds as m:ss for individual track display.
 * Examples: "3:42", "0:30", "12:05".
 */
export function formatTrackDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Common HTML named entities for biography text decoding. */
const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
};

/**
 * Sanitize biography text from HTML sources (Subsonic, MusicBrainz, etc.).
 * Decodes HTML entities (e.g. &amp; → &), preserves paragraph boundaries as
 * blank lines, strips tags, and normalizes whitespace.
 */
export function sanitizeBiographyText(html: string): string {
  // 1. Replace block boundaries with paragraph breaks before stripping tags
  let text = html
    .replace(/<\/p>\s*/gi, '\n\n')
    .replace(/<br\s*\/?>\s*/gi, '\n\n')
    .replace(/<\/div>\s*/gi, '\n\n');

  // 2. Strip remaining HTML tags
  text = text.replace(/<[^>]*>/g, '');

  // 3. Decode HTML entities (named first, then numeric)
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    text = text.replace(new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), char);
  }
  text = text.replace(/&#(\d+);/g, (_, code) => {
    const charCode = parseInt(code, 10);
    return charCode >= 32 || charCode === 9 ? String.fromCharCode(charCode) : ' ';
  });
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, code) => {
    const charCode = parseInt(code, 16);
    return charCode >= 32 || charCode === 9 ? String.fromCharCode(charCode) : ' ';
  });

  // 4. Normalize whitespace: replace single newlines (formatting artifacts from
  // the source) with spaces, preserve paragraph breaks, collapse 3+ newlines
  text = text.replace(/(?<!\n)\n(?!\n)/g, ' ');
  text = text.trim().replace(/\n{3,}/g, '\n\n');
  return text.replace(/  +/g, ' ');
}

/**
 * Format a byte count into a compact human-readable string.
 * Examples: "0 B", "4.2 KB", "128 MB", "1 GB".
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/**
 * Format a speed in bytes per second into a compact human-readable string.
 * Examples: "0 B/s", "856 KB/s", "12.5 MB/s".
 */
export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.min(Math.floor(Math.log(bytesPerSecond) / Math.log(1024)), units.length - 1);
  const value = bytesPerSecond / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}
