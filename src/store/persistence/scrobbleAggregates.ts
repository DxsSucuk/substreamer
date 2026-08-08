/**
 * SQL analytics over `scrobble_events`. Counts come from GROUP BY queries over the
 * structured columns (see scrobbleColumns.ts) rather than a JS pass over the whole
 * history: results are bounded by UNIQUE entities (artists/albums/songs/genres/
 * hours/days), never by total plays, so memory stays flat as history grows and a
 * long history cannot OOM.
 *
 * Produces the `ListeningStats` / `AnalyticsAggregates` shapes the analytics
 * consumers (My Listening, Tuned In) read. Pass `sinceMs` to scope to a period
 * (7d/30d/90d); `0` = all time.
 */
import { getDb } from './db';
import {
  rowToScrobble,
  SCROBBLE_SELECT,
  scrobblesWithArrays,
  type ScrobbleSnapshotRow,
} from './scrobbleTable';
import {
  type AnalyticsAggregates,
  type CompletedScrobble,
  type ListeningStats,
} from '../completedScrobbleStore';

export interface ScrobbleAnalytics {
  stats: ListeningStats;
  aggregates: AnalyticsAggregates;
}

const emptyResult = (): ScrobbleAnalytics => ({
  stats: { totalPlays: 0, totalListeningSeconds: 0, uniqueArtists: {} },
  aggregates: {
    artistCounts: {},
    albumCounts: {},
    songCounts: {},
    genreCounts: {},
    hourBuckets: new Array<number>(24).fill(0),
    dayCounts: {},
  },
});

/**
 * Compute stats + aggregates for the window `time >= sinceMs` (0 = all time).
 * One GROUP BY per aggregate; each result set is bounded by unique entities.
 */
export async function computeScrobbleAnalytics(sinceMs = 0): Promise<ScrobbleAnalytics> {
  const db = getDb();
  if (db === null) return emptyResult();

  const timeCond = sinceMs > 0 ? 'time >= ?' : null;
  const p: number[] = sinceMs > 0 ? [sinceMs] : [];
  const whereOf = (extra?: string): string => {
    const parts = [timeCond, extra].filter(Boolean) as string[];
    return parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '';
  };

  try {
    const [artistRows, albumRows, songRows, genreRows, hourRows, dayRows, statRow] =
      await Promise.all([
        db.getAllAsync<{ artist: string; artist_id: string | null; c: number }>(
          `SELECT artist, MAX(artist_id) AS artist_id, COUNT(*) AS c FROM scrobble_events ${whereOf(
            'artist IS NOT NULL',
          )} GROUP BY artist`,
          p,
        ),
        db.getAllAsync<{
          album: string;
          artist: string;
          cover_art: string | null;
          album_id: string | null;
          c: number;
        }>(
          `SELECT album, artist, MAX(cover_art) AS cover_art, MAX(album_id) AS album_id, COUNT(*) AS c ` +
            `FROM scrobble_events ${whereOf('album IS NOT NULL')} GROUP BY album, artist`,
          p,
        ),
        // One row per song: the play count plus the MOST RECENT play's snapshot,
        // taken whole. A `GROUP BY` with `MAX(col)` takes each scalar from an
        // arbitrary row of the group, so the child rows keyed by that row's scrobble
        // id would belong to a different play — one play's genres against another
        // play's metadata in the details modal.
        db.getAllAsync<ScrobbleSnapshotRow & { c: number }>(
          `SELECT * FROM (
             SELECT ${SCROBBLE_SELECT},
                    COUNT(*) OVER (PARTITION BY song_id) AS c,
                    ROW_NUMBER() OVER (
                      PARTITION BY song_id ORDER BY time DESC, scrobble_events.id DESC
                    ) AS rn
               FROM scrobble_events ${whereOf('song_id IS NOT NULL')}
           ) WHERE rn = 1`,
          p,
        ),
        db.getAllAsync<{ genre: string; c: number }>(
          `SELECT genre, COUNT(*) AS c FROM scrobble_events ${whereOf('genre IS NOT NULL')} GROUP BY genre`,
          p,
        ),
        db.getAllAsync<{ hour: number; c: number }>(
          `SELECT hour, COUNT(*) AS c FROM scrobble_events ${whereOf('hour IS NOT NULL')} GROUP BY hour`,
          p,
        ),
        db.getAllAsync<{ day_key: string; c: number }>(
          `SELECT day_key, COUNT(*) AS c FROM scrobble_events ${whereOf('day_key IS NOT NULL')} GROUP BY day_key`,
          p,
        ),
        db.getFirstAsync<{ plays: number; secs: number }>(
          `SELECT COUNT(*) AS plays, COALESCE(SUM(duration), 0) AS secs FROM scrobble_events ${whereOf()}`,
          p,
        ),
      ]);

    const artistCounts: AnalyticsAggregates['artistCounts'] = {};
    const uniqueArtists: Record<string, true> = {};
    for (const r of artistRows) {
      artistCounts[r.artist] = { count: r.c, artistId: r.artist_id ?? undefined };
      uniqueArtists[r.artist] = true;
    }

    const albumCounts: AnalyticsAggregates['albumCounts'] = {};
    for (const r of albumRows) {
      albumCounts[`${r.album}::${r.artist}`] = {
        artist: r.artist,
        coverArt: r.cover_art ?? undefined,
        count: r.c,
        albumId: r.album_id ?? undefined,
      };
    }

    const songCounts: AnalyticsAggregates['songCounts'] = {};
    const playCounts = new Map(songRows.map((r) => [r.scrobbleId, r.c]));
    for (const s of await scrobblesWithArrays(db, songRows)) {
      songCounts[s.song.id] = { song: s.song, count: playCounts.get(s.id) ?? 0 };
    }

    const genreCounts: Record<string, number> = {};
    for (const r of genreRows) genreCounts[r.genre] = r.c;

    const hourBuckets = new Array<number>(24).fill(0);
    for (const r of hourRows) if (r.hour >= 0 && r.hour < 24) hourBuckets[r.hour] = r.c;

    const dayCounts: Record<string, number> = {};
    for (const r of dayRows) dayCounts[r.day_key] = r.c;

    return {
      stats: {
        totalPlays: statRow?.plays ?? 0,
        totalListeningSeconds: statRow?.secs ?? 0,
        uniqueArtists,
      },
      aggregates: { artistCounts, albumCounts, songCounts, genreCounts, hourBuckets, dayCounts },
    };
  } catch {
    return emptyResult();
  }
}

/** The most recent `limit` scrobbles (newest first) — for the home "recently
 *  played" strip + the streak seed, without loading the full history. */
export async function loadRecentScrobbles(limit: number): Promise<CompletedScrobble[]> {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = await db.getAllAsync<ScrobbleSnapshotRow>(
      `SELECT ${SCROBBLE_SELECT} FROM scrobble_events ORDER BY time DESC LIMIT ?;`,
      [limit],
    );
    return await scrobblesWithArrays(db, rows);
  } catch {
    return [];
  }
}

/**
 * Scrobbles since `sinceMs` (newest first) — a BOUNDED recent slice for Tuned In's
 * time-window mixes (Heavy Rotation 7d, time-of-day), so it never loads the whole
 * history. Bounded by the window's play count, not by a LIMIT.
 *
 * The one reader that does not require a `title`, and the one that skips the child
 * tables. Its consumer reads `genre`/`artist`/`artistId` (`tunedInService.generateMixes`),
 * and `tuned-in.tsx` calls this directly rather than through the store — so it bypasses
 * the boot ordering that awaits the column backfill. Requiring `title` would silently
 * narrow the mix window on the first launch after an upgrade while a large history is
 * still backfilling.
 *
 * A NULL title is therefore fine, but `''` is not: that is the backfill's stamp for a
 * row it can never decode, and it writes the SCROBBLE's id into `song_id` as the second
 * marker. Admitting it would put a fake, untitled song into Heavy Rotation, whose only
 * guard is a truthy `song.id`.
 */
export async function loadScrobblesSince(sinceMs: number): Promise<CompletedScrobble[]> {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = await db.getAllAsync<ScrobbleSnapshotRow>(
      `SELECT ${SCROBBLE_SELECT} FROM scrobble_events WHERE time >= ? ORDER BY time DESC;`,
      [sinceMs],
    );
    return rows.filter((r) => !!r.id && r.title !== '').map((r) => rowToScrobble(r));
  } catch {
    return [];
  }
}

/** Genre play-counts across the given clock hours (0-23) — Tuned In's
 *  time-of-day "Right Now" mix uses a window around the current hour. */
export async function genreCountsForHours(hours: readonly number[]): Promise<Record<string, number>> {
  const db = getDb();
  if (db === null || hours.length === 0) return {};
  try {
    const placeholders = hours.map(() => '?').join(', ');
    const rows = await db.getAllAsync<{ genre: string; c: number }>(
      `SELECT genre, COUNT(*) AS c FROM scrobble_events WHERE hour IN (${placeholders}) AND genre IS NOT NULL GROUP BY genre`,
      [...hours],
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.genre] = r.c;
    return out;
  } catch {
    return {};
  }
}
