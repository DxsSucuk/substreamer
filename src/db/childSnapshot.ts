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

import type { BatchCommand, InternalDb } from '@/db/client';

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
 *  envelope; both store as epoch ms. Exported for the other snapshot tables whose
 *  payload carries the same two shapes. */
export function toEpoch(v: Date | string | number | null | undefined): number | undefined {
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

/* ------------------------------------------------------------------ */
/*  The full-snapshot tables: columns, INSERT, SELECT                   */
/* ------------------------------------------------------------------ */

/**
 * `ChildSnapshotRow` key → its column, for the tables that store the WHOLE `Child`
 * (`queue_snapshot_songs`, `download_queue_songs`). Typed as a TOTAL record, so a
 * field added to the mapping fails to compile until every such table stores it.
 *
 * `cached_songs` is not one of them — it renames five of these (see the file
 * docblock) and drives its own projection from `PROMOTED_SONG_COLUMNS`.
 */
export const CHILD_SNAPSHOT_COLUMNS = {
  id: 'song_id',
  title: 'title',
  artist: 'artist',
  album: 'album',
  coverArt: 'cover_art',
  duration: 'duration',
  albumId: 'album_id',
  suffix: 'suffix',
  bitRate: 'bit_rate',
  bitDepth: 'bit_depth',
  samplingRate: 'sampling_rate',
  artistId: 'artist_id',
  displayArtist: 'display_artist',
  displayAlbumArtist: 'display_album_artist',
  displayComposer: 'display_composer',
  track: 'track',
  discNumber: 'disc_number',
  year: 'year',
  genre: 'genre',
  size: 'size',
  contentType: 'content_type',
  transcodedContentType: 'transcoded_content_type',
  transcodedSuffix: 'transcoded_suffix',
  channelCount: 'channel_count',
  path: 'path',
  userRating: 'user_rating',
  averageRating: 'average_rating',
  playCount: 'play_count',
  created: 'created',
  starred: 'starred',
  played: 'played',
  type: 'type',
  bpm: 'bpm',
  comment: 'comment',
  sortName: 'sort_name',
  musicBrainzId: 'music_brainz_id',
  explicitStatus: 'explicit_status',
  bookmarkPosition: 'bookmark_position',
  isVideo: 'is_video',
  isDir: 'is_dir',
  parent: 'parent',
  originalWidth: 'original_width',
  originalHeight: 'original_height',
  rgTrackGain: 'rg_track_gain',
  rgAlbumGain: 'rg_album_gain',
  rgTrackPeak: 'rg_track_peak',
  rgAlbumPeak: 'rg_album_peak',
  rgBaseGain: 'rg_base_gain',
  rgFallbackGain: 'rg_fallback_gain',
} as const satisfies Record<keyof ChildSnapshotRow, string>;

type SnapshotKey = keyof typeof CHILD_SNAPSHOT_COLUMNS;

const SNAPSHOT_KEYS = Object.keys(CHILD_SNAPSHOT_COLUMNS) as SnapshotKey[];

/** Stored 0/1 by SQLite; `Child` declares them boolean. */
const BOOL_KEYS: ReadonlySet<SnapshotKey> = new Set<SnapshotKey>(['isVideo', 'isDir']);

/** Aliased to the `ChildSnapshotRow` keys, so a selected row IS the shape
 *  {@link childSnapshotRowFromRaw} takes and there is no second name mapping to drift. */
export const CHILD_SNAPSHOT_SELECT = SNAPSHOT_KEYS.map((k) =>
  CHILD_SNAPSHOT_COLUMNS[k] === k ? k : `${CHILD_SNAPSHOT_COLUMNS[k]} AS ${k}`,
).join(', ');

/** The shared `Child` mapping plus the identity/core fields it deliberately omits. */
export function childSnapshotRow(child: Child): ChildSnapshotRow {
  return {
    id: child.id,
    title: child.title,
    artist: child.artist,
    album: child.album,
    coverArt: child.coverArt,
    duration: child.duration,
    ...childSnapshotFields(child),
  };
}

/**
 * The INSERT for one full-snapshot song row. `key` names the owning columns → values
 * in column order (`{snapshot_id, pos}`, `{queue_id, pos}`); the `Child` columns follow.
 */
export function childSnapshotInsertCommand(spec: {
  table: string;
  key: Readonly<Record<string, string | number>>;
  child: Child;
}): BatchCommand {
  const keyCols = Object.keys(spec.key);
  const row: Record<string, unknown> = { ...childSnapshotRow(spec.child) };
  const columns = [...keyCols, ...SNAPSHOT_KEYS.map((k) => CHILD_SNAPSHOT_COLUMNS[k])];
  return [
    `INSERT INTO ${spec.table} (${columns.join(', ')}) ` +
      `VALUES (${new Array(columns.length).fill('?').join(', ')});`,
    [
      ...Object.values(spec.key),
      ...SNAPSHOT_KEYS.map((k) => {
        const v = row[k];
        if (v === undefined || v === null) return null;
        if (BOOL_KEYS.has(k)) return v ? 1 : 0;
        return v as string | number;
      }),
    ],
  ];
}

/** Inverse of {@link childSnapshotInsertCommand}: a row selected through
 *  {@link CHILD_SNAPSHOT_SELECT} back into the shape `childFromSnapshotRow` consumes,
 *  NULL columns left absent. */
export function childSnapshotRowFromRaw(raw: Record<string, unknown>): ChildSnapshotRow {
  const out: Record<string, unknown> = {};
  for (const k of SNAPSHOT_KEYS) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    out[k] = BOOL_KEYS.has(k) ? v === 1 || v === true : v;
  }
  return { ...out, id: String(raw.id ?? ''), title: String(raw.title ?? '') } as ChildSnapshotRow;
}

/* ------------------------------------------------------------------ */
/*  Reading the five array tables back                                  */
/* ------------------------------------------------------------------ */

const ARRAY_TABLES = [
  { field: 'genres', suffix: 'genres', cols: 'name' },
  { field: 'artists', suffix: 'artists', cols: 'artist_id, artist_name' },
  { field: 'albumArtists', suffix: 'album_artists', cols: 'artist_id, artist_name' },
  {
    field: 'contributors',
    suffix: 'contributors',
    cols: 'role, sub_role, artist_id, artist_name',
  },
  { field: 'moods', suffix: 'moods', cols: 'mood' },
] as const;

/**
 * Which array rows to read and how to identify the song each belongs to.
 * `keyColumns` are the columns naming that song — the owner key plus its position
 * (`snapshot_id, song_pos` / `queue_id, song_pos`).
 */
export interface ChildSnapshotArrayScope {
  tablePrefix: string;
  keyColumns: readonly string[];
  /** Restricts the owners, e.g. `queue_id = ?`. */
  where: string;
  params?: ReadonlyArray<string | number | null>;
}

/** The grouped arrays' key for one song: its {@link ChildSnapshotArrayScope.keyColumns}
 *  values, NUL-joined. Callers build the same key from what they hold. */
export const childSnapshotArrayKey = (values: ReadonlyArray<string | number>): string =>
  values.map(String).join('\u0000');

const arraySql = (scope: ChildSnapshotArrayScope, suffix: string, cols: string): string => {
  const keys = scope.keyColumns.join(', ');
  return (
    `SELECT ${keys}, ${cols} FROM ${scope.tablePrefix}_${suffix} ` +
    `WHERE ${scope.where} ORDER BY ${keys}, pos;`
  );
};

/** Mutable twin of `ChildSnapshotArrays`, built by pushing the grouped rows. */
interface MutableArrays {
  genres?: string[];
  artists?: { artistId: string | null; artistName: string | null }[];
  albumArtists?: { artistId: string | null; artistName: string | null }[];
  contributors?: {
    role: string;
    subRole: string | null;
    artistId: string | null;
    artistName: string | null;
  }[];
  moods?: string[];
}

type RawArrayRow = Record<string, unknown>;

/** One SELECT per array table (never one per song — that would be 5×N round trips),
 *  bucketed by the song each row belongs to. */
function groupArrayRows(
  scope: ChildSnapshotArrayScope,
  results: readonly RawArrayRow[][],
): Map<string, ChildSnapshotArrays> {
  const out = new Map<string, MutableArrays>();
  const bucket = (r: RawArrayRow): MutableArrays => {
    const key = childSnapshotArrayKey(
      scope.keyColumns.map((c) => r[c] as string | number),
    );
    let fields = out.get(key);
    if (fields === undefined) {
      fields = {};
      out.set(key, fields);
    }
    return fields;
  };
  const credit = (r: RawArrayRow): { artistId: string | null; artistName: string | null } => ({
    artistId: (r.artist_id ?? null) as string | null,
    artistName: (r.artist_name ?? null) as string | null,
  });
  ARRAY_TABLES.forEach((table, i) => {
    for (const r of results[i] ?? []) {
      const fields = bucket(r);
      if (table.field === 'genres') (fields.genres ??= []).push(r.name as string);
      else if (table.field === 'artists') (fields.artists ??= []).push(credit(r));
      else if (table.field === 'albumArtists') (fields.albumArtists ??= []).push(credit(r));
      else if (table.field === 'moods') (fields.moods ??= []).push(r.mood as string);
      else {
        (fields.contributors ??= []).push({
          role: r.role as string,
          subRole: (r.sub_role ?? null) as string | null,
          ...credit(r),
        });
      }
    }
  });
  return out;
}

/** The five array tables' rows for the scoped songs, grouped by
 *  {@link childSnapshotArrayKey}. */
export function readChildSnapshotArraysSync(
  db: InternalDb,
  scope: ChildSnapshotArrayScope,
): Map<string, ChildSnapshotArrays> {
  return groupArrayRows(
    scope,
    ARRAY_TABLES.map((t) =>
      db.getAllSync<RawArrayRow>(arraySql(scope, t.suffix, t.cols), scope.params ?? []),
    ),
  );
}

/** Async twin of {@link readChildSnapshotArraysSync} — the five queries in parallel. */
export async function readChildSnapshotArraysAsync(
  db: InternalDb,
  scope: ChildSnapshotArrayScope,
): Promise<Map<string, ChildSnapshotArrays>> {
  const results = await Promise.all(
    ARRAY_TABLES.map((t) =>
      db.getAllAsync<RawArrayRow>(arraySql(scope, t.suffix, t.cols), scope.params ?? []),
    ),
  );
  return groupArrayRows(scope, results);
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
