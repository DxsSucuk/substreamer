/**
 * The one-time move of the pre-upgrade KV blobs into `queue_snapshots`: the user's
 * saved bookmarks, plus the live player queue and its position when those keys are
 * still present.
 *
 * A bookmark is NOT re-derivable — a saved queue has no server to refetch it from — so
 * the KV copy is only given up after the rows have been READ BACK and checked. A
 * verification failure THROWS, which leaves the migration counter where it was: the KV
 * blob is untouched, `bookmarksStore` keeps hydrating from it, and the next launch
 * retries. The live queue is deliberately not held to that (see
 * {@link migrateLiveQueue}).
 *
 * Idempotent: re-running upserts the same rows by id, and a blob already stripped has
 * nothing left to migrate.
 */
import {
  deleteSnapshot,
  listBookmarks,
  readSnapshotMeta,
  readSnapshotSongCounts,
  replaceSnapshotTracks,
  upsertSnapshot,
  writeBookmarkSnapshots,
  SNAPSHOT_LIVE_ID,
  type BookmarkSnapshotInput,
} from './queueSnapshotTable';
import { kvStorage } from './kvStorage';

import type { Child } from 'subsonic-api';

const BOOKMARKS_KEY = 'substreamer-bookmarks';
const QUEUE_KEY = 'substreamer-persisted-queue';
const POSITION_KEY = 'substreamer-persisted-position';

/** `bookmarksStore`'s persisted shape, as it was written before this migration. */
interface LegacyBookmark {
  id: string;
  name: string;
  createdAt: number;
  queue: Child[];
  currentIndex: number;
  positionSec: number;
}

/** Zustand's persist envelope around it. `state` keeps `autoName`/`sortOrder`, which
 *  have no table and stay in KV — only `bookmarks` is removed. */
interface BookmarksBlob {
  state?: Record<string, unknown> & { bookmarks?: Record<string, LegacyBookmark> };
  version?: number;
}

/** The live queue's own key, written by hand rather than through `persist`. */
interface LegacyQueue {
  queue?: unknown;
  currentTrackIndex?: unknown;
}

/**
 * The tracks the repository will actually store: it drops entries with no id, because
 * `song_id` is NOT NULL and `childToTrack` cannot play them. Verification has to count
 * the same set the writer wrote.
 */
const usableTracks = (queue: readonly Child[]): Child[] => queue.filter((c) => !!c?.id);

/** A hand-edited or truncated blob can hold anything; the UI iterates `queue`. */
const isMigratableBookmark = (value: unknown): value is LegacyBookmark => {
  const b = value as LegacyBookmark | null;
  return !!b && typeof b === 'object' && !!b.id && Array.isArray(b.queue);
};

const toSnapshotInput = (b: LegacyBookmark): BookmarkSnapshotInput => ({
  id: b.id,
  name: typeof b.name === 'string' ? b.name : null,
  createdAt: typeof b.createdAt === 'number' ? b.createdAt : Date.now(),
  currentIndex: typeof b.currentIndex === 'number' ? b.currentIndex : 0,
  positionSec: typeof b.positionSec === 'number' ? b.positionSec : 0,
  tracks: b.queue,
});

/**
 * Bookmarks: blob → rows, then read the rows back and only then drop the blob's copy.
 *
 * The write is a UNION (`replaceExisting: false`). A bookmark saved after the upgrade
 * but before this runs exists only as a row, and a replacing write would delete it —
 * the migration may add, never remove.
 *
 * @throws when a bookmark the blob holds is not readable back from the rows.
 */
async function migrateBookmarks(log: (message: string) => void): Promise<void> {
  const raw = await kvStorage.getItem(BOOKMARKS_KEY);
  if (!raw) {
    log('[m36] no bookmarks blob — nothing to migrate');
    return;
  }
  let blob: BookmarksBlob;
  try {
    blob = JSON.parse(raw) as BookmarksBlob;
  } catch {
    // Unparseable is unrecoverable, and throwing would retry it on every launch
    // forever. Left in place rather than deleted, in case it is salvageable by hand.
    log('[m36] bookmarks blob unparseable — left in place');
    return;
  }
  const stored = blob.state?.bookmarks;
  const legacy = stored && typeof stored === 'object' ? Object.values(stored) : [];
  const migratable = legacy.filter(isMigratableBookmark);
  if (migratable.length === 0) {
    log(`[m36] bookmarks blob holds none to migrate (${legacy.length} entries)`);
    return;
  }

  await writeBookmarkSnapshots(migratable.map(toSnapshotInput), { replaceExisting: false });

  // Read back. `writeBookmarkSnapshots` swallows its own failures, so "it returned"
  // proves nothing — the parent row AND its songs have to be there.
  const counts = await readSnapshotSongCounts();
  if (counts === null) {
    throw new Error('[m36] bookmark rows unreadable after the write');
  }
  const storedIds = new Set((await listBookmarks()).map((m) => m.id));
  const unstored = migratable.filter(
    (b) => !storedIds.has(b.id) || (counts.get(b.id) ?? 0) !== usableTracks(b.queue).length,
  );
  if (unstored.length > 0) {
    throw new Error(
      `[m36] ${unstored.length}/${migratable.length} bookmarks did not store; blob kept`,
    );
  }

  // Verified: the rows hold every bookmark, so the blob's copy can go. The rest of the
  // envelope (autoName, sortOrder, the persist version) is rewritten untouched.
  if (blob.state) delete blob.state.bookmarks;
  await kvStorage.setItem(BOOKMARKS_KEY, JSON.stringify(blob));
  log(`[m36] migrated ${migratable.length} bookmarks into rows; blob copy removed`);
}

/**
 * The live queue: blob → the single `live` row, position folded in.
 *
 * Two things make this the asymmetric half. Migration 30 already deletes both keys
 * unconditionally, so ABSENT keys are the normal case and not a failure. And a queue is
 * cheap to recreate, so a failure here logs and moves on rather than throwing — a
 * migration that could never pass would otherwise pin the counter below the latest id
 * for good, which stalls the blob→normalized ETL as well.
 */
async function migrateLiveQueue(log: (message: string) => void): Promise<void> {
  const [rawQueue, rawPosition] = await Promise.all([
    kvStorage.getItem(QUEUE_KEY),
    kvStorage.getItem(POSITION_KEY),
  ]);
  if (!rawQueue && !rawPosition) {
    log('[m36] no persisted-queue keys (migration 30 clears them) — nothing to migrate');
    return;
  }

  const dropKeys = async (): Promise<void> => {
    await kvStorage.removeItem(QUEUE_KEY);
    await kvStorage.removeItem(POSITION_KEY);
  };

  // A `live` row is the CURRENT queue; the key is pre-upgrade data that nothing has
  // written since. Restoring it over the row would put back a queue the user has
  // already moved on from.
  if ((await readSnapshotMeta(SNAPSHOT_LIVE_ID)) !== null) {
    await dropKeys();
    log('[m36] live queue row already exists — stale keys dropped, row untouched');
    return;
  }

  let parsed: LegacyQueue | null = null;
  try {
    parsed = rawQueue ? (JSON.parse(rawQueue) as LegacyQueue) : null;
  } catch {
    parsed = null;
  }
  const storedQueue = parsed?.queue;
  const original = Array.isArray(storedQueue) ? (storedQueue as Child[]) : [];
  const tracks = usableTracks(original);
  if (tracks.length === 0) {
    await dropKeys();
    log('[m36] persisted queue empty or unparseable — keys dropped');
    return;
  }

  // The stored index points into the ORIGINAL array, so map it through the filter
  // rather than reusing it directly.
  const stored = parsed?.currentTrackIndex;
  const currentIndex = Math.max(
    0,
    tracks.indexOf(original[typeof stored === 'number' ? stored : 0]),
  );

  // The position belonged to one specific track; on the row it is an offset into
  // whatever the cursor points at, so it only survives when those agree.
  let positionSec = 0;
  try {
    const position = rawPosition
      ? (JSON.parse(rawPosition) as { position?: unknown; trackId?: unknown })
      : null;
    if (
      typeof position?.position === 'number' &&
      position.trackId === tracks[currentIndex]?.id
    ) {
      positionSec = Math.max(0, position.position);
    }
  } catch {
    /* a broken position blob just resumes from the start of the track */
  }

  await upsertSnapshot({
    id: SNAPSHOT_LIVE_ID,
    kind: 'live',
    name: null,
    createdAt: Date.now(),
    currentIndex,
    positionSec,
  });
  await replaceSnapshotTracks(SNAPSHOT_LIVE_ID, tracks);

  const counts = await readSnapshotSongCounts();
  if ((counts?.get(SNAPSHOT_LIVE_ID) ?? 0) !== tracks.length) {
    // Drop the parent row this run created: left behind, a retry would read it as
    // "a live queue already exists" and discard the keys it is meant to migrate.
    await deleteSnapshot(SNAPSHOT_LIVE_ID);
    log('[m36] live queue did not store — keys kept for the next attempt');
    return;
  }
  await dropKeys();
  log(`[m36] migrated the live queue (${tracks.length} tracks, index ${currentIndex})`);
}

/** Bookmarks first: they are the half that cannot be recreated, and a failure there
 *  stops the queue half from running until the retry succeeds. */
export async function migrateQueueSnapshotsFromKv(
  log: (message: string) => void,
): Promise<void> {
  await migrateBookmarks(log);
  await migrateLiveQueue(log);
}
