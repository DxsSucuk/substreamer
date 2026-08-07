/**
 * Derives the structured, indexable columns stored alongside a scrobble's
 * `song_json` blob so analytics can run as SQL GROUP BY aggregates instead of
 * loading + iterating the whole history in JS.
 *
 * `hour` (0-23) and `day_key` (YYYY-MM-DD) are computed in the DEVICE's local
 * timezone at write time — SQLite can't derive local-calendar buckets from an
 * epoch-ms column without the offset — so they're stored, not computed in SQL.
 * `artist`/`album` fall back to 'Unknown' to match the in-memory aggregate keys.
 */
import { type Child } from '../../services/subsonicService';
import { dateKey } from '../../utils/dateKey';
import { getPrimaryGenre } from '../../utils/genreHelpers';

export interface ScrobbleColumns {
  song_id: string;
  artist: string;
  artist_id: string | null;
  album: string;
  album_id: string | null;
  cover_art: string | null;
  genre: string | null;
  year: number | null;
  duration: number | null;
  hour: number;
  day_key: string;
}

export function deriveScrobbleColumns(song: Child, time: number): ScrobbleColumns {
  return {
    song_id: song.id,
    artist: song.artist ?? 'Unknown',
    artist_id: song.artistId ?? null,
    album: song.album ?? 'Unknown',
    album_id: song.albumId ?? null,
    cover_art: song.coverArt ?? null,
    genre: getPrimaryGenre(song),
    year: song.year ?? null,
    duration: song.duration ?? null,
    hour: new Date(time).getHours(),
    day_key: dateKey(time),
  };
}

/** Column names in insert order — shared by the INSERT statements + backfill. */
export const SCROBBLE_COLUMN_NAMES: readonly (keyof ScrobbleColumns)[] = [
  'song_id',
  'artist',
  'artist_id',
  'album',
  'album_id',
  'cover_art',
  'genre',
  'year',
  'duration',
  'hour',
  'day_key',
];

/** The derived column values in `SCROBBLE_COLUMN_NAMES` order, for parameter binding. */
export function scrobbleColumnValues(cols: ScrobbleColumns): (string | number | null)[] {
  return SCROBBLE_COLUMN_NAMES.map((k) => cols[k]);
}
