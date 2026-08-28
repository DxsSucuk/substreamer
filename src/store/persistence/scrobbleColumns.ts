/**
 * Derives the structured, indexable columns stored alongside a scrobble's
 * `song_json` blob so analytics can run as SQL GROUP BY aggregates instead of
 * loading + iterating the whole history in JS, and so a play stays readable
 * after the song leaves the library.
 *
 * The `Child` scalars come from the shared `childSnapshotFields` mapping — the
 * same one `cached_songs` uses — so a new Subsonic field lands in one place.
 * `hour` (0-23) and `day_key` (YYYY-MM-DD) are computed in the DEVICE's local
 * timezone at write time — SQLite can't derive local-calendar buckets from an
 * epoch-ms column without the offset — so they're stored, not computed in SQL.
 * `artist`/`album` fall back to 'Unknown' to match the in-memory aggregate keys.
 */
import { childSnapshotFields } from '../../db/childSnapshot';
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
  title: string | null;
  display_artist: string | null;
  display_composer: string | null;
  track: number | null;
  disc_number: number | null;
  suffix: string | null;
  bit_rate: number | null;
  size: number | null;
  content_type: string | null;
  bpm: number | null;
  path: string | null;
  parent: string | null;
  sort_name: string | null;
  music_brainz_id: string | null;
  explicit_status: string | null;
  user_rating: number | null;
  average_rating: number | null;
  play_count: number | null;
  /** Epoch ms — `Child.created` is a `Date`. */
  created: number | null;
  /** Epoch ms — `Child.starred` is a `Date`. */
  starred: number | null;
  played: string | null;
  rg_track_gain: number | null;
  rg_track_peak: number | null;
}

export function deriveScrobbleColumns(song: Child, time: number): ScrobbleColumns {
  const f = childSnapshotFields(song);
  return {
    song_id: song.id,
    artist: song.artist ?? 'Unknown',
    artist_id: f.artistId ?? null,
    album: song.album ?? 'Unknown',
    album_id: f.albumId ?? null,
    cover_art: song.coverArt ?? null,
    genre: getPrimaryGenre(song),
    year: f.year ?? null,
    duration: song.duration ?? null,
    hour: new Date(time).getHours(),
    day_key: dateKey(time),
    title: song.title ?? null,
    display_artist: f.displayArtist ?? null,
    display_composer: f.displayComposer ?? null,
    track: f.track ?? null,
    disc_number: f.discNumber ?? null,
    suffix: f.suffix ?? null,
    bit_rate: f.bitRate ?? null,
    size: f.size ?? null,
    content_type: f.contentType ?? null,
    bpm: f.bpm ?? null,
    path: f.path ?? null,
    parent: f.parent ?? null,
    sort_name: f.sortName ?? null,
    music_brainz_id: f.musicBrainzId ?? null,
    explicit_status: f.explicitStatus ?? null,
    user_rating: f.userRating ?? null,
    average_rating: f.averageRating ?? null,
    play_count: f.playCount ?? null,
    created: f.created ?? null,
    starred: f.starred ?? null,
    played: f.played ?? null,
    rg_track_gain: f.rgTrackGain ?? null,
    rg_track_peak: f.rgTrackPeak ?? null,
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
  'title',
  'display_artist',
  'display_composer',
  'track',
  'disc_number',
  'suffix',
  'bit_rate',
  'size',
  'content_type',
  'bpm',
  'path',
  'parent',
  'sort_name',
  'music_brainz_id',
  'explicit_status',
  'user_rating',
  'average_rating',
  'play_count',
  'created',
  'starred',
  'played',
  'rg_track_gain',
  'rg_track_peak',
];

/**
 * The same set minus `hour`/`day_key`, for `pending_scrobble_events`. Those two are
 * device-local calendar buckets derived from `time` when the play COMPLETES
 * (`completedScrobbleStore.addCompleted`), so a queued row has no use for them.
 * Filtered from the list above rather than written out again, so a new snapshot
 * column reaches both tables.
 */
export const PENDING_SCROBBLE_COLUMN_NAMES: readonly (keyof ScrobbleColumns)[] =
  SCROBBLE_COLUMN_NAMES.filter((c) => c !== 'hour' && c !== 'day_key');

/** The derived column values in the given order, for parameter binding. Defaults to
 *  the completed table's full set. */
export function scrobbleColumnValues(
  cols: ScrobbleColumns,
  names: readonly (keyof ScrobbleColumns)[] = SCROBBLE_COLUMN_NAMES,
): (string | number | null)[] {
  return names.map((k) => cols[k]);
}
