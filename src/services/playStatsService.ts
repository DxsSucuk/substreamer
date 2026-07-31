/**
 * Eager local-play-stats updater.
 *
 * When a scrobble fires (song played to completion, exclusions passed), we
 * mutate the local copies of the song and its album everywhere they live so
 * the UI reflects the new play count + last-played date without waiting for
 * a server round-trip. Pull-to-refresh on any of these stores replaces the
 * local blob with the server response, so reconciliation is automatic: if
 * the server is ahead, the local values are overwritten; if the server is
 * still catching up, the local eager values carry until the next refresh.
 *
 * This module has a single public entry point, `applyLocalPlay(song)`, that
 * fans out to every store that may hold a copy of the row. Stores no-op
 * when the row isn't present — there is nothing to update, hence nothing to
 * go stale.
 */

import { bumpAlbumPlayStats } from '../db/repository/albums';
import { bumpSongPlayStats } from '../db/repository/songs';
import { favoritesStore } from '../store/favoritesStore';
import { getDb } from '../store/persistence/db';
import { type Child } from './subsonicService';

/**
 * Listener signature for player-local play-stat updates. `playerService`
 * registers one of these at module load so `applyLocalPlay` can push the
 * ephemeral currentTrack / currentChildQueue bumps without importing back
 * into playerService (which would create a cycle with scrobbleService).
 */
export type PlayerPlayStatListener = (songId: string, now: string) => void;

let playerPlayStatListener: PlayerPlayStatListener | null = null;

/**
 * Subscribe the player's ephemeral-state updater to play-stat events.
 * `playerService` calls this once at module load to wire `applyLocalPlay`
 * → `applyLocalPlayToPlayer` without the reverse import that would close
 * the playerService ↔ scrobbleService ↔ playStatsService cycle.
 */
export function registerPlayerPlayStatListener(
  listener: PlayerPlayStatListener | null,
): void {
  playerPlayStatListener = listener;
}

/**
 * Eagerly bump local play-count and last-played for a just-scrobbled song.
 * Safe to call repeatedly — each store's action is idempotent per input.
 * Called from `scrobbleService.addCompletedScrobble` after the exclusion
 * gate so excluded plays skip the update automatically.
 */
export function applyLocalPlay(song: Child): void {
  const now = new Date().toISOString();
  const songId = song.id;
  const albumId = song.albumId;

  // favoritesStore keeps its own in-memory copy of the starred rows and is NOT backed
  // by the normalized tables, so it still needs the optimistic patch. The four detail /
  // library stores that used to be patched here render from the repository now — the
  // scalar bumps below are their update path.
  favoritesStore.getState().applyLocalPlay(songId, albumId, now);

  // Normalized model — the source the detail screens / player will read. Targeted
  // scalar +1 UPDATE for the song + its album (no child-table churn) so play stats
  // stay current without a full resync. Best-effort; no-op if the row isn't synced yet.
  const db = getDb();
  if (db) {
    void bumpSongPlayStats(db, songId, now).catch(() => { /* best-effort */ });
    if (albumId) void bumpAlbumPlayStats(db, albumId, now).catch(() => { /* best-effort */ });
  }

  // Ephemeral player state — the currently-displayed track copy.
  playerPlayStatListener?.(songId, now);
}
