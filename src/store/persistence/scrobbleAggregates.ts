/**
 * SQL analytics over `scrobble_events` — the OOM fix. Instead of loading the
 * whole scrobble history into a JS array and iterating it, the counts come from
 * GROUP BY queries over the structured columns (see scrobbleColumns.ts). Results
 * are bounded by UNIQUE entities (artists/albums/songs/genres/hours/days), never
 * by total plays, so memory stays flat as history grows.
 *
 * Produces the exact `ListeningStats` / `AnalyticsAggregates` shapes the store
 * published before, so the analytics consumers (My Listening, Tuned In) are
 * unchanged apart from where the numbers come from. Pass `sinceMs` to scope to a
 * period (7d/30d/90d); `0` = all time.
 */
import { getDb } from './db';
import { type Child } from '../../services/subsonicService';
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
        db.getAllAsync<{ song_id: string; c: number; song_json: string }>(
          `SELECT song_id, COUNT(*) AS c, MAX(song_json) AS song_json FROM scrobble_events ${whereOf(
            'song_id IS NOT NULL',
          )} GROUP BY song_id`,
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
    for (const r of songRows) {
      let song: Child | null = null;
      try {
        song = JSON.parse(r.song_json) as Child;
      } catch {
        song = null;
      }
      if (song && song.id) songCounts[r.song_id] = { song, count: r.c };
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
    const rows = await db.getAllAsync<{ id: string; song_json: string; time: number }>(
      'SELECT id, song_json, time FROM scrobble_events ORDER BY time DESC LIMIT ?;',
      [limit],
    );
    const out: CompletedScrobble[] = [];
    for (const row of rows) {
      let song: unknown;
      try {
        song = JSON.parse(row.song_json);
      } catch {
        continue;
      }
      if (song && typeof song === 'object' && (song as { id?: unknown }).id) {
        out.push({ id: row.id, song: song as CompletedScrobble['song'], time: row.time });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Scrobbles since `sinceMs` (newest first) — a BOUNDED recent slice for Tuned
 *  In's time-window mixes (Heavy Rotation 7d, time-of-day), so it never loads the
 *  whole history. Parses `song_json` per row; bounded by the window's play count. */
export async function loadScrobblesSince(sinceMs: number): Promise<CompletedScrobble[]> {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = await db.getAllAsync<{ id: string; song_json: string; time: number }>(
      'SELECT id, song_json, time FROM scrobble_events WHERE time >= ? ORDER BY time DESC;',
      [sinceMs],
    );
    const out: CompletedScrobble[] = [];
    for (const row of rows) {
      let song: unknown;
      try {
        song = JSON.parse(row.song_json);
      } catch {
        continue;
      }
      if (song && typeof song === 'object' && (song as { id?: unknown }).id) {
        out.push({ id: row.id, song: song as CompletedScrobble['song'], time: row.time });
      }
    }
    return out;
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
