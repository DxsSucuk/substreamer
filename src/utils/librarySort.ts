/**
 * The one JS list sort left: raw-title order for the bounded song filter views.
 *
 * Album, artist and playlist ordering lives in SQL, on the stored `sort_*` keys
 * (`db/sortKeys` → `ORDER BY`) — one comparator, one place, so a filtered list cannot
 * order differently from browse.
 */
import { defaultCollator } from './intl';

/** Title-order comparator for the bounded song filter views. `defaultCollator`, not
 *  `localeCompare` — Hermes on Android ARM64 clones a fresh ICU collator per call
 *  (#867), which is why the raw method is banned repo-wide. */
export const byTitle = (a: { title?: string }, b: { title?: string }): number =>
  defaultCollator.compare(a.title ?? '', b.title ?? '');
