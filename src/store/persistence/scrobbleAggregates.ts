/**
 * SQL analytics over `scrobble_events`. Counts come from GROUP BY queries over the
 * structured columns (see scrobbleColumns.ts) rather than a JS pass over the whole
 * history: results are bounded by UNIQUE entities (artists/albums/songs/genres/
 * hours/days), never by total plays, so memory stays flat as history grows and a
 * long history cannot OOM.
 *
 * Per-song results carry counts and two scalars, not a `Child`. Only the ranked
 * `topSongs` are reconstructed whole — those are the ones rendered, played and opened
 * in the details modal, and assembling a full `Child` (five child-table reads each)
 * for every song ever played is what made My Listening janky on a large history.
 *
 * Produces the `ListeningStats` / `AnalyticsAggregates` shapes the analytics
 * consumers (My Listening, Tuned In) read. Pass `sinceMs` to scope to a period
 * (7d/30d/90d); `0` = all time.
 */
import { getDb, type InternalDb } from './db';
import {
  rowToScrobble,
  SCROBBLE_SELECT,
  scrobblesWithArrays,
  type ScrobbleSnapshotRow,
} from './scrobbleSnapshot';
import {
  type AnalyticsAggregates,
  type CompletedScrobble,
  type ListeningStats,
} from '../completedScrobbleStore';

export interface ScrobbleAnalytics {
  stats: ListeningStats;
  aggregates: AnalyticsAggregates;
}

/** How many songs `topSongs` reconstructs whole. My Listening's "most played songs"
 *  card is the only consumer and renders all of them. */
const TOP_SONG_COUNT = 10;

const emptyResult = (): ScrobbleAnalytics => ({
  stats: { totalPlays: 0, totalListeningSeconds: 0, uniqueArtists: {} },
  aggregates: {
    artistCounts: {},
    albumCounts: {},
    songStats: {},
    topSongs: [],
    genreCounts: {},
    hourBuckets: new Array<number>(24).fill(0),
    dayCounts: {},
  },
});

/** One row per unique song: its play count, the two fields the whole-history
 *  consumers read, and the id of the play those came from. */
interface SongStatRow {
  scrobbleId: string;
  songId: string;
  duration: number | null;
  year: number | null;
  c: number;
}

/**
 * The most-played songs, each rebuilt as a complete `Child`. My Listening plays these
 * rows and opens them in the track-details modal, so a projection will not do — but
 * only the ranked few need one. One PK lookup for their representative plays plus the
 * shared child-table fetch, whatever the history size.
 */
async function topSongsFromStats(
  db: InternalDb,
  rows: readonly SongStatRow[],
): Promise<AnalyticsAggregates['topSongs']> {
  const top = [...rows].sort((a, b) => b.c - a.c).slice(0, TOP_SONG_COUNT);
  if (top.length === 0) return [];
  const full = await db.getAllAsync<ScrobbleSnapshotRow>(
    `SELECT ${SCROBBLE_SELECT} FROM scrobble_events WHERE id IN (SELECT value FROM json_each(?));`,
    [JSON.stringify(top.map((r) => r.scrobbleId))],
  );
  const songs = new Map(
    (await scrobblesWithArrays(db, 'scrobble', full)).map((s) => [s.id, s.song]),
  );
  // Re-ordered to the ranking: the id list binds unordered.
  return top.flatMap((r) => {
    const song = songs.get(r.scrobbleId);
    return song === undefined ? [] : [{ song, count: r.c }];
  });
}

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
        // One row per song: the play count, the two fields every-song consumers read,
        // and the id of the MOST RECENT play — the representative whose snapshot the
        // top entries are rebuilt from. A `GROUP BY` with `MAX(col)` takes each scalar
        // from an arbitrary row of the group, so the child rows keyed by that row's
        // scrobble id would belong to a different play — one play's genres against
        // another play's metadata in the details modal.
        //
        // The representative is picked over every play, then dropped if it is a row no
        // reader accepts (missing `song_id`/`title`) — the order the reconstruction
        // itself applies.
        db.getAllAsync<SongStatRow>(
          `SELECT scrobbleId, songId, duration, year, c FROM (
             SELECT scrobble_events.id AS scrobbleId, song_id AS songId, duration, year, title,
                    COUNT(*) OVER (PARTITION BY song_id) AS c,
                    ROW_NUMBER() OVER (
                      PARTITION BY song_id ORDER BY time DESC, scrobble_events.id DESC
                    ) AS rn
               FROM scrobble_events ${whereOf('song_id IS NOT NULL')}
           ) WHERE rn = 1 AND songId <> '' AND title IS NOT NULL AND title <> ''`,
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

    const songStats: AnalyticsAggregates['songStats'] = {};
    for (const r of songRows) {
      songStats[r.songId] = {
        count: r.c,
        duration: r.duration ?? undefined,
        year: r.year ?? undefined,
      };
    }
    const topSongs = await topSongsFromStats(db, songRows);

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
      aggregates: {
        artistCounts,
        albumCounts,
        songStats,
        topSongs,
        genreCounts,
        hourBuckets,
        dayCounts,
      },
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
    return await scrobblesWithArrays(db, 'scrobble', rows);
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
