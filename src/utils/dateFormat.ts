/**
 * Locale-aware date/time formatting routed through the cached `intl.ts`
 * `Intl.DateTimeFormat` instances (so we don't construct a fresh ICU
 * formatter per call — see intl.ts for the Hermes perf rationale).
 *
 * Each returns `'—'` for null/undefined/invalid input.
 */
import i18next from 'i18next';

import { getDateTimeFormat } from './intl';

const PLACEHOLDER = '—';

function toValidDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Long date, e.g. "5 January 2026". */
export function formatLongDate(value: Date | string | number | null | undefined): string {
  const d = toValidDate(value);
  if (!d) return PLACEHOLDER;
  return getDateTimeFormat(i18next.language, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

/** Short date, e.g. "5 Jan 2026". */
export function formatShortDate(value: Date | string | number | null | undefined): string {
  const d = toValidDate(value);
  if (!d) return PLACEHOLDER;
  return getDateTimeFormat(i18next.language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

/** Short date + time, e.g. "5 Jan 2026, 14:30". */
export function formatShortDateTime(value: Date | string | number | null | undefined): string {
  const d = toValidDate(value);
  if (!d) return PLACEHOLDER;
  return getDateTimeFormat(i18next.language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}
