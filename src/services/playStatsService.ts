/**
 * Eager local-play-stats updater.
 *
 * When a scrobble fires (song played to completion, exclusions passed), bump the
 * local play count + last-played date for the song and its album so the UI reflects
 * the play without waiting for a server round-trip. A later refresh overwrites these
 * with the server response, so reconciliation is automatic.
 *
 * Single public entry point: `applyLocalPlay(song)`.
 */

import { bumpAlbumPlayStats } from '../db/repository/albums';
import { bumpSongPlayStats } from '../db/repository/songs';
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

/** Subscribe the player's ephemeral-state updater to play-stat events. */
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

  // Every list that renders play stats reads the normalized rows, so these scalar
  // bumps are the whole update path: a targeted +1 UPDATE on the song and its album,
  // no child-table churn. Best-effort; no-op if the row isn't synced yet.
  const db = getDb();
  if (db) {
    void bumpSongPlayStats(db, songId, now).catch(() => { /* best-effort */ });
    if (albumId) void bumpAlbumPlayStats(db, albumId, now).catch(() => { /* best-effort */ });
  }

  // Ephemeral player state — the currently-displayed track copy.
  playerPlayStatListener?.(songId, now);
}
