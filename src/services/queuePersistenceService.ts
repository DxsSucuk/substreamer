// Queue blob: written through the ASYNC adapter, debounced (full-queue
// stringify + write coalesced across rapid skips, IO off the JS thread).
// Position blob: tiny + already throttled to 10s, so it stays on the sync
// adapter. Init reads are synchronous (one-shot at player start).
import { kvStorage, kvStorageSync } from '../store/persistence';
import { type Child } from './subsonicService';

const QUEUE_KEY = 'substreamer-persisted-queue';
const POSITION_KEY = 'substreamer-persisted-position';
export const PERSIST_INTERVAL_MS = 10_000;

/**
 * Debounce window for queue writes. The queue is serialized in full on every
 * track change/skip; without coalescing, rapid skips would stringify + write
 * the entire (potentially thousands-of-tracks) queue many times on the JS
 * thread. A short trailing debounce collapses a burst to one write, and the
 * write itself runs off-thread via the async adapter. The on-disk copy only
 * needs to be current for crash/relaunch restore, so a ~1.5s lag is fine —
 * `flushPersistedQueue()` forces it out on backgrounding.
 */
const QUEUE_DEBOUNCE_MS = 1500;

interface PersistedQueue {
  queue: Child[];
  currentTrackIndex: number;
}

interface PersistedPosition {
  position: number;
  trackId: string;
}

let lastPositionPersistTime = 0;

let queueTimer: ReturnType<typeof setTimeout> | null = null;
let pendingQueue: PersistedQueue | null = null;

function clearQueueTimer(): void {
  if (queueTimer !== null) {
    clearTimeout(queueTimer);
    queueTimer = null;
  }
}

function flushQueueWrite(): void {
  clearQueueTimer();
  if (pendingQueue === null) return;
  const data = pendingQueue;
  pendingQueue = null;
  // Stringify ONCE here (deferred from persistQueue), write off the JS thread.
  void kvStorage.setItem(QUEUE_KEY, JSON.stringify(data));
}

export function persistQueue(
  queue: Child[],
  currentTrackIndex: number,
): void {
  // Hold the latest snapshot in memory; (re)arm the debounce. Readers see it
  // immediately via getPersistedQueue (pending-first), so the delayed disk
  // write is transparent.
  pendingQueue = { queue, currentTrackIndex };
  clearQueueTimer();
  queueTimer = setTimeout(flushQueueWrite, QUEUE_DEBOUNCE_MS);
}

/** Force the pending queue snapshot to disk now (e.g. on app background). */
export function flushPersistedQueue(): void {
  flushQueueWrite();
}

/**
 * A persisted resume position must be a valid in-track offset. Clamp to
 * [0, duration] when the duration is known so we never store a position past
 * the end of the track (which would seek to an invalid spot on next launch).
 */
function clampPersistedPosition(position: number, duration?: number): number {
  const floored = Math.max(0, position);
  return duration != null && duration > 0 ? Math.min(floored, duration) : floored;
}

export function persistPositionIfDue(
  position: number,
  trackId: string,
  duration?: number,
): boolean {
  const now = Date.now();
  if (now - lastPositionPersistTime < PERSIST_INTERVAL_MS) return false;
  lastPositionPersistTime = now;
  kvStorageSync.setItem(
    POSITION_KEY,
    JSON.stringify({ position: clampPersistedPosition(position, duration), trackId } as PersistedPosition),
  );
  return true;
}

export function flushPosition(position: number, trackId: string, duration?: number): void {
  lastPositionPersistTime = Date.now();
  kvStorageSync.setItem(
    POSITION_KEY,
    JSON.stringify({ position: clampPersistedPosition(position, duration), trackId } as PersistedPosition),
  );
}

export function clearPersistedQueue(): void {
  // Cancel any pending queue write so it can't land after the removal.
  clearQueueTimer();
  pendingQueue = null;
  void kvStorage.removeItem(QUEUE_KEY);
  kvStorageSync.removeItem(POSITION_KEY);
  lastPositionPersistTime = 0;
}

export function getPersistedQueue(): PersistedQueue | null {
  // Prefer the in-memory pending snapshot (freshest); fall back to disk. At
  // player init no write has happened this session, so this reads disk.
  if (pendingQueue !== null) {
    return pendingQueue.queue.length === 0 ? null : pendingQueue;
  }
  const raw = kvStorageSync.getItem(QUEUE_KEY) as string | null;
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as PersistedQueue;
    if (!Array.isArray(data.queue) || data.queue.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

export function getPersistedPosition(): PersistedPosition | null {
  const raw = kvStorageSync.getItem(POSITION_KEY) as string | null;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedPosition;
  } catch {
    return null;
  }
}

export function resetPersistTimer(): void {
  lastPositionPersistTime = 0;
}
