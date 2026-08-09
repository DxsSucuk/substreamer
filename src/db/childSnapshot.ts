/**
 * The ONE `Child` ⇄ typed-columns mapping, shared by every table that snapshots a
 * Subsonic track. `cached_songs` owned it first; it lives here so a second snapshot
 * table reuses it instead of carrying a copy that drifts the next time Subsonic adds
 * a field.
 *
 * A consumer supplies its own table prefix and key column; the field names, the five
 * positional child tables and the epoch-ms storage of `Child`'s `Date`s are shared.
 *
 * Every field here is `Child` data under its NATURAL name. `cached_songs` is the one
 * table where five of those names (`album_id`, `suffix`, `bit_rate`, `bit_depth`,
 * `sampling_rate`) are already taken by columns describing the downloaded FILE, which
 * `resolveSongFile` builds its path from — so that table renames them to its `src_*`
 * twins on the way in (see the `cachedSongs` docblock in `./schema.ts`). The collision
 * belongs to the table that has it, not to this mapping. The file facts themselves
 * (`bytes`, `format_captured_at`, `downloaded_at`) are not `Child` data and are absent.
 */
import type { ArtistID3, Child, Contributor, MediaType, ReplayGain } from 'subsonic-api';

import type { BatchCommand } from '@/db/client';

/** The `Child` scalars a snapshot table stores, keyed camelCase. `created`/`starred`
 *  are epoch ms: SQLite has no date type and `Child` declares them `Date`. */
export interface ChildSnapshotFields {
  /** The SERVER's album — `cached_songs` renames this to `src_album_id`. */
  albumId?: string;
  suffix?: string;
  bitRate?: number;
  bitDepth?: number;
  samplingRate?: number;
  artistId?: string;
  displayArtist?: string;
  displayAlbumArtist?: string;
  displayComposer?: string;
  track?: number;
  discNumber?: number;
  year?: number;
  genre?: string;
  size?: number;
  contentType?: string;
  transcodedContentType?: string;
  transcodedSuffix?: string;
  channelCount?: number;
  path?: string;
  userRating?: number;
  averageRating?: number;
  playCount?: number;
  /** Epoch ms. */
  created?: number;
  /** Epoch ms. */
  starred?: number;
  played?: string;
  type?: string;
  bpm?: number;
  comment?: string;
  sortName?: string;
  musicBrainzId?: string;
  explicitStatus?: string;
  bookmarkPosition?: number;
  isVideo?: boolean;
  isDir?: boolean;
  parent?: string;
  originalWidth?: number;
  originalHeight?: number;
  rgTrackGain?: number;
  rgAlbumGain?: number;
  rgTrackPeak?: number;
  rgAlbumPeak?: number;
  rgBaseGain?: number;
  rgFallbackGain?: number;
}

/** A stored snapshot row: the shared fields plus the identity/core columns each
 *  consumer holds under its own key (`cached_songs.song_id`, a scrobble's
 *  `song_id`), which is why they are not part of {@link childSnapshotFields}. */
export interface ChildSnapshotRow extends ChildSnapshotFields {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  coverArt?: string;
  duration?: number;
}

/** The five positional child tables, in `pos` order, as read back. */
export interface ChildSnapshotArrays {
  genres?: readonly string[];
  artists?: ReadonlyArray<{ artistId?: string | null; artistName?: string | null }>;
  albumArtists?: ReadonlyArray<{ artistId?: string | null; artistName?: string | null }>;
  contributors?: ReadonlyArray<{
    role: string;
    subRole?: string | null;
    artistId?: string | null;
    artistName?: string | null;
  }>;
  moods?: readonly string[];
}

/** Dates arrive as live `Date` from the API and as ISO strings out of a parsed
 *  envelope; both store as epoch ms. */
function toEpoch(v: Date | string | number | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** The child tables declare `name` / `mood` / `role` NOT NULL, and an array element
 *  can be null whatever the declared type says. Entries failing these guards are
 *  dropped rather than inserted, because one bad value aborts the whole batch. */
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const presentEntries = <T>(list: readonly T[] | undefined): T[] =>
  (list ?? []).filter((e) => e !== null && e !== undefined);

/** Subsonic `genres` is declared `string[]` but real OpenSubsonic servers return
 *  `{name}[]`. Accept either, and drop empties so a blank name never indexes. */
export function childGenreNames(child: Child): string[] {
  return ((child.genres ?? []) as unknown[])
    .map((g) => (typeof g === 'string' ? g : String((g as { name?: unknown } | null)?.name ?? '')))
    .filter((name) => name.length > 0);
}

/** The shared `Child` scalars for a real `Child`. */
export function childSnapshotFields(child: Child): ChildSnapshotFields {
  const rg = child.replayGain;
  return {
    albumId: child.albumId,
    suffix: child.suffix,
    bitRate: child.bitRate,
    bitDepth: child.bitDepth,
    samplingRate: child.samplingRate,
    artistId: child.artistId,
    displayArtist: child.displayArtist,
    displayAlbumArtist: child.displayAlbumArtist,
    displayComposer: child.displayComposer,
    track: child.track,
    discNumber: child.discNumber,
    year: child.year,
    genre: child.genre,
    size: child.size,
    contentType: child.contentType,
    transcodedContentType: child.transcodedContentType,
    transcodedSuffix: child.transcodedSuffix,
    channelCount: child.channelCount,
    path: child.path,
    userRating: child.userRating,
    averageRating: child.averageRating,
    playCount: child.playCount,
    created: toEpoch(child.created),
    starred: toEpoch(child.starred),
    played: child.played,
    type: child.type,
    bpm: child.bpm,
    comment: child.comment,
    sortName: child.sortName,
    musicBrainzId: child.musicBrainzId,
    explicitStatus: child.explicitStatus,
    bookmarkPosition: child.bookmarkPosition,
    isVideo: child.isVideo,
    isDir: child.isDir,
    parent: child.parent,
    originalWidth: child.originalWidth,
    originalHeight: child.originalHeight,
    rgTrackGain: rg?.trackGain,
    rgAlbumGain: rg?.albumGain,
    rgTrackPeak: rg?.trackPeak,
    rgAlbumPeak: rg?.albumPeak,
    rgBaseGain: rg?.baseGain,
    rgFallbackGain: rg?.fallbackGain,
  };
}

/**
 * Rebuild one row's five `Child` multi-valued mirrors from a real `Child`. Delete-
 * then-insert because the arrays are positional: a shrunk array must not leave stale
 * tail rows behind.
 *
 * `tablePrefix` names all five (`cached_song` → `cached_song_genres`,
 * `cached_song_artists`, `cached_song_album_artists`, `cached_song_contributors`,
 * `cached_song_moods`). `key` is the owning row's key columns → values, in column
 * order: one entry for the song-keyed and scrobble-keyed tables, two for the queue
 * snapshot's `(snapshot_id, song_pos)` rows.
 *
 * Entries a NOT NULL column would reject are skipped and `pos` numbers the
 * survivors, so a `moods: [null]` or a role-less contributor costs that entry
 * rather than the whole batch, and the stored array stays contiguous.
 */
export function childSnapshotArrayCommands(spec: {
  tablePrefix: string;
  key: Readonly<Record<string, string | number>>;
  child: Child;
}): BatchCommand[] {
  const { tablePrefix, key, child } = spec;
  const keyValues = Object.values(key);
  const where = Object.keys(key)
    .map((c) => `${c} = ?`)
    .join(' AND ');
  const keyCols = Object.keys(key).join(', ');
  const keyMarks = keyValues.map(() => '?').join(', ');
  const statements: BatchCommand[] = [
    'genres',
    'artists',
    'album_artists',
    'contributors',
    'moods',
  ].map((suffix) => [`DELETE FROM ${tablePrefix}_${suffix} WHERE ${where};`, keyValues]);
  childGenreNames(child).forEach((name, pos) => {
    statements.push([
      `INSERT INTO ${tablePrefix}_genres (${keyCols}, pos, name) VALUES (${keyMarks}, ?, ?);`,
      [...keyValues, pos, name],
    ]);
  });
  presentEntries(child.artists).forEach((a, pos) => {
    statements.push([
      `INSERT INTO ${tablePrefix}_artists (${keyCols}, pos, artist_id, artist_name) VALUES (${keyMarks}, ?, ?, ?);`,
      [...keyValues, pos, a.id ?? null, a.name ?? null],
    ]);
  });
  presentEntries(child.albumArtists).forEach((a, pos) => {
    statements.push([
      `INSERT INTO ${tablePrefix}_album_artists (${keyCols}, pos, artist_id, artist_name) VALUES (${keyMarks}, ?, ?, ?);`,
      [...keyValues, pos, a.id ?? null, a.name ?? null],
    ]);
  });
  presentEntries(child.contributors)
    .filter((c) => isNonEmptyString(c.role))
    .forEach((c, pos) => {
      statements.push([
        `INSERT INTO ${tablePrefix}_contributors
         (${keyCols}, pos, role, sub_role, artist_id, artist_name)
         VALUES (${keyMarks}, ?, ?, ?, ?, ?);`,
        [
          ...keyValues,
          pos,
          c.role,
          c.subRole ?? null,
          c.artist?.id ?? null,
          c.artist?.name ?? null,
        ],
      ]);
    });
  presentEntries(child.moods)
    .filter(isNonEmptyString)
    .forEach((mood, pos) => {
      statements.push([
        `INSERT INTO ${tablePrefix}_moods (${keyCols}, pos, mood) VALUES (${keyMarks}, ?, ?);`,
        [...keyValues, pos, mood],
      ]);
    });
  return statements;
}

/** `albumCount` is required by `ArtistID3` but is mutable current state of the
 *  artist, not a fact about this track, so the mirrors hold identity only and it
 *  reconstructs as 0. */
const artistFromRow = (r: {
  artistId?: string | null;
  artistName?: string | null;
}): ArtistID3 => ({ id: r.artistId ?? '', name: r.artistName ?? '', albumCount: 0 });

function contributorFromRow(r: {
  role: string;
  subRole?: string | null;
  artistId?: string | null;
  artistName?: string | null;
}): Contributor {
  const out: Contributor = { role: r.role };
  if (r.subRole !== null && r.subRole !== undefined) out.subRole = r.subRole;
  const hasArtist =
    (r.artistId !== null && r.artistId !== undefined) ||
    (r.artistName !== null && r.artistName !== undefined);
  if (hasArtist) out.artist = artistFromRow(r);
  return out;
}

function replayGainFromRow(row: ChildSnapshotFields): ReplayGain | undefined {
  const rg: ReplayGain = {};
  if (row.rgTrackGain !== null && row.rgTrackGain !== undefined) rg.trackGain = row.rgTrackGain;
  if (row.rgAlbumGain !== null && row.rgAlbumGain !== undefined) rg.albumGain = row.rgAlbumGain;
  if (row.rgTrackPeak !== null && row.rgTrackPeak !== undefined) rg.trackPeak = row.rgTrackPeak;
  if (row.rgAlbumPeak !== null && row.rgAlbumPeak !== undefined) rg.albumPeak = row.rgAlbumPeak;
  if (row.rgBaseGain !== null && row.rgBaseGain !== undefined) rg.baseGain = row.rgBaseGain;
  if (row.rgFallbackGain !== null && row.rgFallbackGain !== undefined) {
    rg.fallbackGain = row.rgFallbackGain;
  }
  return Object.keys(rg).length > 0 ? rg : undefined;
}

/**
 * The reverse direction: a stored row plus its five child arrays back into a real
 * `Child`. NULL columns stay absent rather than becoming `null`, so the result is
 * shaped like the server object the snapshot was taken from.
 */
export function childFromSnapshotRow(row: ChildSnapshotRow, arrays: ChildSnapshotArrays): Child {
  const child: Child = { id: row.id, title: row.title, isDir: row.isDir ?? false };
  const set = <K extends keyof Child>(key: K, value: Child[K] | null | undefined): void => {
    if (value !== null && value !== undefined) child[key] = value;
  };
  set('artist', row.artist);
  set('album', row.album);
  set('coverArt', row.coverArt);
  set('duration', row.duration);
  set('albumId', row.albumId);
  set('suffix', row.suffix);
  set('bitRate', row.bitRate);
  set('bitDepth', row.bitDepth);
  set('samplingRate', row.samplingRate);
  set('artistId', row.artistId);
  set('displayArtist', row.displayArtist);
  set('displayAlbumArtist', row.displayAlbumArtist);
  set('displayComposer', row.displayComposer);
  set('track', row.track);
  set('discNumber', row.discNumber);
  set('year', row.year);
  set('genre', row.genre);
  set('size', row.size);
  set('contentType', row.contentType);
  set('transcodedContentType', row.transcodedContentType);
  set('transcodedSuffix', row.transcodedSuffix);
  set('channelCount', row.channelCount);
  set('path', row.path);
  set('userRating', row.userRating);
  set('averageRating', row.averageRating);
  set('playCount', row.playCount);
  set('played', row.played);
  set('type', row.type as MediaType | undefined);
  set('bpm', row.bpm);
  set('comment', row.comment);
  set('sortName', row.sortName);
  set('musicBrainzId', row.musicBrainzId);
  set('explicitStatus', row.explicitStatus);
  set('bookmarkPosition', row.bookmarkPosition);
  set('isVideo', row.isVideo);
  set('parent', row.parent);
  set('originalWidth', row.originalWidth);
  set('originalHeight', row.originalHeight);
  // Epoch ms in the column, `Date` on `Child`.
  if (row.created !== null && row.created !== undefined) child.created = new Date(row.created);
  if (row.starred !== null && row.starred !== undefined) child.starred = new Date(row.starred);
  set('replayGain', replayGainFromRow(row));
  if (arrays.genres?.length) child.genres = [...arrays.genres];
  if (arrays.artists?.length) child.artists = arrays.artists.map(artistFromRow);
  if (arrays.albumArtists?.length) child.albumArtists = arrays.albumArtists.map(artistFromRow);
  if (arrays.contributors?.length) child.contributors = arrays.contributors.map(contributorFromRow);
  if (arrays.moods?.length) child.moods = [...arrays.moods];
  return child;
}
