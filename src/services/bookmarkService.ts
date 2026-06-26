import * as Crypto from 'expo-crypto';

import { playTrack, seekTo } from './playerService';
import { flushPosition } from './queuePersistenceService';
import { type Child } from './subsonicService';
import { resolveSongCoverArt } from '../hooks/useSongCoverArt';
import { bookmarksStore, type PlayQueueBookmark } from '../store/bookmarksStore';
import { playerStore } from '../store/playerStore';
import { getDateTimeFormat } from '../utils/intl';

/* ------------------------------------------------------------------ */
/*  Auto-naming                                                        */
/* ------------------------------------------------------------------ */

/**
 * Time-of-day buckets used to build friendly auto-names like
 * "Tuesday Early Morning". Each entry's i18n key resolves to the bucket label;
 * `startHour` is the inclusive local-hour at which the bucket begins. Buckets
 * are evaluated in order and wrap past midnight (lateNight covers 22:00–04:59).
 */
const TOD_BUCKETS: { key: string; startHour: number; endHour: number }[] = [
  { key: 'tod_earlyMorning', startHour: 5, endHour: 7 },
  { key: 'tod_midMorning', startHour: 8, endHour: 10 },
  { key: 'tod_midday', startHour: 11, endHour: 12 },
  { key: 'tod_earlyAfternoon', startHour: 13, endHour: 14 },
  { key: 'tod_afternoon', startHour: 15, endHour: 16 },
  { key: 'tod_earlyEvening', startHour: 17, endHour: 18 },
  { key: 'tod_evening', startHour: 19, endHour: 21 },
  { key: 'tod_lateNight', startHour: 22, endHour: 4 },
];

/** Resolve the time-of-day bucket i18n key for a local hour (0–23). */
export function bucketKeyForHour(hour: number): string {
  for (const b of TOD_BUCKETS) {
    if (b.startHour <= b.endHour) {
      if (hour >= b.startHour && hour <= b.endHour) return b.key;
    } else {
      // Wraps past midnight (e.g. 22..4).
      if (hour >= b.startHour || hour <= b.endHour) return b.key;
    }
  }
  return 'tod_lateNight';
}

/**
 * Build a friendly auto-name like "Tuesday Early Morning". Appends " (2)",
 * " (3)", … when an identical name already exists in the same weekday+bucket
 * window. `t` resolves the bucket label; weekday is locale-formatted.
 */
export function buildAutoName(
  t: (key: string) => string,
  locale: string | undefined,
  existingNames: string[],
  date: Date = new Date(),
): string {
  const weekday = getDateTimeFormat(locale, { weekday: 'long' }).format(date);
  const bucket = t(bucketKeyForHour(date.getHours()));
  const base = `${weekday} ${bucket}`;
  if (!existingNames.includes(base)) return base;
  let n = 2;
  while (existingNames.includes(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

/* ------------------------------------------------------------------ */
/*  Capture / restore                                                  */
/* ------------------------------------------------------------------ */

/** Raw player snapshot, captured the instant the user asks to bookmark. */
export interface BookmarkSnapshot {
  queue: Child[];
  currentIndex: number;
  positionSec: number;
}

/**
 * Capture the live player state (queue + current track index + position) right
 * now. Returns null when nothing is playing (empty queue). Capturing is split
 * from naming so a bookmark always reflects the moment the user tapped the
 * button — not whenever they finish typing a name in the prompt.
 */
export function capturePlayerSnapshot(): BookmarkSnapshot | null {
  const { queue, currentTrackIndex, position, currentTrack } = playerStore.getState();
  if (queue.length === 0) return null;

  // Flush the latest position so it's coherent with what we snapshot here.
  if (currentTrack?.id) flushPosition(position, currentTrack.id, currentTrack.duration);

  return { queue, currentIndex: currentTrackIndex ?? 0, positionSec: position };
}

/** Persist a previously captured snapshot as a named bookmark; returns it. */
export function commitBookmark(snapshot: BookmarkSnapshot, name: string): PlayQueueBookmark {
  const bookmark: PlayQueueBookmark = {
    id: Crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    queue: snapshot.queue,
    currentIndex: snapshot.currentIndex,
    positionSec: snapshot.positionSec,
  };
  bookmarksStore.getState().addBookmark(bookmark);
  return bookmark;
}

/**
 * Convenience for the auto-name path: capture the live player state and save it
 * immediately under `name`. Returns null when nothing is playing.
 */
export function createBookmarkFromPlayer(name: string): PlayQueueBookmark | null {
  const snapshot = capturePlayerSnapshot();
  if (!snapshot) return null;
  return commitBookmark(snapshot, name);
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

/**
 * Restore a bookmark: replace the queue, jump to the saved track, resume, and
 * seek to the saved position. `playTrack` filters out unplayable/offline
 * tracks, so we only seek when the saved track actually survived into the live
 * queue — otherwise playback started on a different track, or the queue was
 * cleared because nothing was playable, and seeking then would land wrong.
 */
export async function restoreBookmark(bookmark: PlayQueueBookmark): Promise<void> {
  if (bookmark.queue.length === 0) return;
  const idx = clampIndex(bookmark.currentIndex, bookmark.queue.length);
  const track = bookmark.queue[idx];
  await playTrack(track, bookmark.queue);
  if (bookmark.positionSec <= 0) return;
  const liveQueue = playerStore.getState().queue;
  if (liveQueue.length > 0 && liveQueue.some((c) => c.id === track.id)) {
    await seekTo(bookmark.positionSec);
  }
}

/* ------------------------------------------------------------------ */
/*  Derived display helpers (whole-queue math)                         */
/* ------------------------------------------------------------------ */

/** The current track for a bookmark (index-clamped), or undefined. */
export function bookmarkCurrentTrack(bookmark: PlayQueueBookmark): Child | undefined {
  if (bookmark.queue.length === 0) return undefined;
  return bookmark.queue[clampIndex(bookmark.currentIndex, bookmark.queue.length)];
}

/** Cover-art value for a bookmark — its current track's resolved cover (#202). */
export function bookmarkCoverArtId(bookmark: PlayQueueBookmark): string | undefined {
  const track = bookmarkCurrentTrack(bookmark);
  if (!track) return undefined;
  return resolveSongCoverArt(track);
}

/** 1-based queue position, e.g. { index: 25, total: 40 } → "25/40". */
export function bookmarkQueuePosition(
  bookmark: PlayQueueBookmark,
): { index: number; total: number } {
  const total = bookmark.queue.length;
  return { index: clampIndex(bookmark.currentIndex, total) + 1, total };
}

/**
 * Whole-queue time math:
 *   elapsed   = Σ durations[0..current-1] + position
 *   total     = Σ durations[0..end]
 *   remaining = total − elapsed
 * Durations come from `Child.duration` (seconds); missing values count as 0.
 */
export function bookmarkTimes(
  bookmark: PlayQueueBookmark,
): { elapsedSec: number; remainingSec: number; totalSec: number } {
  const { queue } = bookmark;
  const idx = clampIndex(bookmark.currentIndex, queue.length);
  let beforeSec = 0;
  let totalSec = 0;
  for (let i = 0; i < queue.length; i++) {
    const dur = queue[i]?.duration ?? 0;
    totalSec += dur;
    if (i < idx) beforeSec += dur;
  }
  const elapsedSec = beforeSec + Math.max(0, bookmark.positionSec);
  const remainingSec = Math.max(0, totalSec - elapsedSec);
  return { elapsedSec, remainingSec, totalSec };
}
