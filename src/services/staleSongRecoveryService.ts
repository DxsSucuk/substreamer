/**
 * Stale-song-ID recovery (#146).
 *
 * Subsonic servers can change a song's internal ID under our feet —
 * the most common triggers are a Navidrome rescan, a database
 * migration, a file replacement (mp3 → flac), or an octo-fiesta-style
 * proxy "permanentising" a previously-virtual external track into a
 * proper library entry. Substreamer treats `cached_songs` /
 * `song_index` / `album_details` as authoritative once populated, so
 * the dead IDs linger and every subsequent stream call 404s.
 *
 * This service runs when playback fails. It:
 *
 *  1. Snapshots the cached album's song list (so we know the OLD ids).
 *  2. Calls `albumDetailStore.fetchAlbum(albumId)` to refresh the
 *     server's current view — this overwrites `album_details` AND
 *     `song_index` for the whole album in one shot (see
 *     `detailTables.upsertSongsForAlbum`, which DELETEs every old row
 *     for the album before inserting fresh ones).
 *  3. Diffs OLD vs FRESH song lists to build a per-album `{oldId →
 *     freshChild}` swap map. The premise: if one ID went stale, others
 *     in the same album probably did too (same rescan, same file move).
 *  4. For each swap that targets a DOWNLOADED song:
 *     - renames the file on disk (`renameCachedSongFile`)
 *     - rewrites the `cached_songs` row + `cached_item_songs` edges
 *       via `remapCachedSongId`.
 *  5. Returns the fresh `Child` for the currently-failing song plus
 *     the full swap map, so the caller (playerService) can update its
 *     in-memory queue + the native RNTP track.
 *
 * If the album refresh comes back with the SAME ID for the failing
 * song, the recovery exits with `null` — there's nothing to swap and
 * the original PlaybackError was a transient blip the normal retry
 * path can handle.
 */
import { albumDetailStore } from '../store/albumDetailStore';
import { remapCachedSongId } from '../store/persistence/musicCacheTables';
import {
  getAlbum as _getAlbumUnused,
  search3,
  type Child,
} from './subsonicService';
import { renameCachedSongFile } from './musicCacheService';

// _getAlbumUnused kept in the import list so future maintainers don't
// re-add it — we deliberately route through `albumDetailStore.fetchAlbum`
// instead so album_details and song_index get the persistence update
// for free.
void _getAlbumUnused;

/**
 * Tolerance for the duration-tiebreaker when multiple songs in the
 * parent share the same title+artist (rare but happens with remixes
 * and "live vs studio" pairs). 2 seconds is loose enough to absorb
 * server-side trim/silence-detection drift; tighter would risk failing
 * the match for legitimate dupes.
 */
const DURATION_TOLERANCE_SECONDS = 2;

export interface StaleIdRecoveryResult {
  /** The fresh Child for the song that was failing — caller should swap
   *  it into the player queue at the current track's index. */
  current: Child;
  /** Album-wide map of OLD song-id → FRESH Child. Every song in the
   *  album whose id changed is in here, including `current`. Caller
   *  should walk its in-memory queue and swap any song whose id is a
   *  key in this map. Empty/absent songs (no change) aren't included. */
  swaps: Map<string, Child>;
}

/**
 * Match `needle` against `haystack` using progressively-looser keys.
 * Returns the best match or null.
 *
 * Order matters: stronger keys first so we don't accidentally pick a
 * different recording when an MBID would have nailed it.
 */
export function findMatchingSong(
  needle: Child,
  haystack: readonly Child[] | undefined,
): Child | null {
  if (!haystack || haystack.length === 0) return null;

  // 1. MusicBrainz ID match — strongest signal when both ends have it.
  if (needle.musicBrainzId) {
    const m = haystack.find(
      (s) => s.musicBrainzId && s.musicBrainzId === needle.musicBrainzId,
    );
    if (m) return m;
  }

  // 2. title + artist + duration (within tolerance) — the common path
  //    for tracks without MBID. Handles "Song Title — Studio" vs
  //    "Song Title — Live" by picking the one with matching length.
  const titleArtistMatches = haystack.filter(
    (s) =>
      (s.title ?? '') === (needle.title ?? '')
      && (s.artist ?? '') === (needle.artist ?? ''),
  );
  if (titleArtistMatches.length === 1) return titleArtistMatches[0];
  if (titleArtistMatches.length > 1 && needle.duration && needle.duration > 0) {
    const byDuration = titleArtistMatches.find((s) =>
      s.duration !== undefined
      && Math.abs(s.duration - needle.duration!) <= DURATION_TOLERANCE_SECONDS,
    );
    if (byDuration) return byDuration;
  }

  // 3. title-only with track-number tiebreaker — last resort for tracks
  //    whose artist string changed (e.g. featuring credits stripped).
  const titleOnly = haystack.filter((s) => (s.title ?? '') === (needle.title ?? ''));
  if (titleOnly.length === 1) return titleOnly[0];
  if (titleOnly.length > 1 && needle.track !== undefined) {
    const byTrack = titleOnly.find((s) => s.track === needle.track);
    if (byTrack) return byTrack;
  }

  return null;
}

/**
 * Build a {oldId → freshChild} map for every song in `oldSongs` that
 * has a different id in `freshSongs`. Songs with no match drop out
 * silently (presumably removed from the album server-side).
 */
function buildAlbumSwapMap(
  oldSongs: readonly Child[],
  freshSongs: readonly Child[],
): Map<string, Child> {
  const swaps = new Map<string, Child>();
  for (const old of oldSongs) {
    if (!old.id) continue;
    const match = findMatchingSong(old, freshSongs);
    if (match && match.id !== old.id) {
      swaps.set(old.id, match);
    }
  }
  return swaps;
}

/**
 * For each swap whose old id maps to a downloaded song, rename the
 * file on disk AND repoint the SQL row. Failures here are logged but
 * not fatal — the in-memory swap still happens so the user gets their
 * music playing; a follow-up retry / library sync can clean up the
 * persistence gap.
 *
 * Returns the count of swaps that were persisted (i.e. that had a
 * matching downloaded file).
 */
function persistAlbumSwaps(
  albumId: string,
  swaps: ReadonlyMap<string, Child>,
): number {
  let persisted = 0;
  const now = Date.now();
  for (const [oldId, fresh] of swaps) {
    const suffix = (fresh.suffix ?? '').toLowerCase();
    if (!suffix) continue;
    // Try to rename first. If it returns 'missing' the song wasn't
    // downloaded and there's nothing to persist for this entry.
    const renameResult = renameCachedSongFile(albumId, oldId, fresh.id, suffix);
    if (renameResult === 'missing') continue;
    if (renameResult === 'failed') {
      console.warn(
        '[StaleIdRecovery] file rename failed for', oldId, '→', fresh.id,
        '— SQL swap skipped to avoid orphaning the row',
      );
      continue;
    }
    // Rename succeeded — now update SQL to match.
    const ok = remapCachedSongId(oldId, {
      id: fresh.id,
      title: fresh.title,
      artist: fresh.artist ?? undefined,
      album: fresh.album ?? undefined,
      albumId,
      coverArt: fresh.coverArt ?? undefined,
      // bytes/duration unchanged (same file on disk) — pull from fresh
      // metadata where available, otherwise leave defaulted.
      bytes: fresh.size ?? 0,
      duration: fresh.duration ?? 0,
      suffix,
      bitRate: fresh.bitRate ?? undefined,
      bitDepth: fresh.bitDepth ?? undefined,
      samplingRate: fresh.samplingRate ?? undefined,
      formatCapturedAt: now,
      downloadedAt: now,
      rawJson: JSON.stringify(fresh),
    });
    if (ok) persisted++;
  }
  return persisted;
}

/**
 * Refresh the parent album and recover from a stale song id. Returns
 * null when there is nothing to swap (no match found, OR the server
 * still has the song under the cached id — i.e. the failure was
 * transient, not stale-id).
 *
 * Side effects (when a real swap is detected):
 *   - `album_details` overwritten with fresh JSON (via fetchAlbum)
 *   - `song_index` cleared + reinserted for the album (via fetchAlbum)
 *   - downloaded songs in the album get their files renamed and
 *     `cached_songs` rows rekeyed.
 *
 * The caller is responsible for the IN-MEMORY swap: updating
 * `playerStore.queue` / `currentTrack` and the native RNTP queue.
 */
export async function recoverStaleSongId(
  stale: Child,
): Promise<StaleIdRecoveryResult | null> {
  // --- Phase 1: refresh via parent album -----------------------------
  if (stale.albumId) {
    // Snapshot the OLD song list BEFORE fetchAlbum overwrites it. If
    // the album isn't cached yet, fall through to search3.
    const cachedBefore = albumDetailStore.getState().albums[stale.albumId];
    const oldSongs = cachedBefore?.album?.song ?? [];

    try {
      const fresh = await albumDetailStore.getState().fetchAlbum(stale.albumId);
      if (fresh?.song && fresh.song.length > 0) {
        const currentMatch = findMatchingSong(stale, fresh.song);
        if (currentMatch) {
          // Identity check — if the failing song still has the cached
          // id, recovery is moot. Bail so callers fall through to the
          // normal retry path (transient network blip, not stale id).
          if (currentMatch.id === stale.id) return null;

          // Build the album-wide swap map from the diff. Always
          // ensure the currently-failing song is in the map so the
          // caller has something to swap even when the album wasn't
          // previously cached (oldSongs is empty).
          const swaps = oldSongs.length > 0
            ? buildAlbumSwapMap(oldSongs, fresh.song)
            : new Map<string, Child>();
          if (!swaps.has(stale.id)) swaps.set(stale.id, currentMatch);

          // Persist to disk + SQL for downloaded songs. In-memory queue
          // updates are the caller's responsibility.
          persistAlbumSwaps(stale.albumId, swaps);

          return { current: currentMatch, swaps };
        }
      }
    } catch {
      /* fall through to search3 */
    }
  }

  // --- Phase 2: search3 fallback ------------------------------------
  // Used when the album path is unavailable (no albumId, album fetch
  // failed, or no match in the refreshed album). Single-track recovery,
  // no album-wide swap.
  if (stale.title) {
    const q = [stale.artist, stale.title].filter(Boolean).join(' ').trim();
    if (q.length > 0) {
      try {
        const results = await search3(q);
        const match = findMatchingSong(stale, results.songs);
        if (match && match.id !== stale.id) {
          return {
            current: match,
            swaps: new Map([[stale.id, match]]),
          };
        }
      } catch {
        /* give up */
      }
    }
  }

  return null;
}
