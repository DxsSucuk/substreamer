/** Songs repository: bulk upsert (row + children), keyset A–Z list, count. */
import type { ArtistID3, Child, Contributor, MediaType, ReplayGain } from 'subsonic-api';

import type { InternalDb } from '../client';
import {
  songAlbumArtistRows,
  songArtistRows,
  songContributorRows,
  songGenreRows,
  songMoodRows,
  songRow,
} from './mappers';
import {
  bulkUpsert,
  colsOf,
  countRows,
  fetchChildren,
  keysetPage,
  keysetPageBefore,
  type Complete,
  type Cursor,
  type Page,
} from './core';

/** The `songs` columns every list read projects: the full row MINUS the internal
 *  search derivatives (`norm_*`/`dmeta_*` — accent-folded copies with no API
 *  counterpart that roughly double the per-row string payload). `sort_title`/
 *  `sort_artist` stay: the keyset cursor and the A–Z scroller read them. */
interface SongColumns {
  id: string;
  album_id: string | null;
  artist_id: string | null;
  title: string | null;
  album: string | null;
  artist: string | null;
  display_artist: string | null;
  display_album_artist: string | null;
  display_composer: string | null;
  track: number | null;
  disc_number: number | null;
  year: number | null;
  genre: string | null;
  cover_art: string | null;
  duration: number | null;
  size: number | null;
  content_type: string | null;
  suffix: string | null;
  transcoded_content_type: string | null;
  transcoded_suffix: string | null;
  bit_rate: number | null;
  bit_depth: number | null;
  sampling_rate: number | null;
  channel_count: number | null;
  path: string | null;
  user_rating: number | null;
  average_rating: number | null;
  play_count: number | null;
  created: number | null;
  starred: number | null;
  played: string | null;
  type: string | null;
  bpm: number | null;
  comment: string | null;
  sort_name: string | null;
  sort_title: string | null;
  sort_artist: string | null;
  music_brainz_id: string | null;
  explicit_status: string | null;
  bookmark_position: number | null;
  is_video: number | null;
  is_dir: number | null;
  parent: string | null;
  original_width: number | null;
  original_height: number | null;
  rg_track_gain: number | null;
  rg_album_gain: number | null;
  rg_track_peak: number | null;
  rg_album_peak: number | null;
  rg_base_gain: number | null;
  rg_fallback_gain: number | null;
}

/** A projected song row: its columns plus the multi-value children, hydrated one
 *  batched query per child table per page. Absent (not `[]`) when the song has none. */
export interface SongListRow extends SongColumns {
  genres?: string[];
  artists?: ArtistID3[];
  albumArtists?: ArtistID3[];
  contributors?: Contributor[];
  moods?: string[];
}

/** Typed against the row so a stale or misspelled column is a compile error, and both
 *  COLS strings derive from it so the SQL cannot drift from the row type — a field on
 *  the interface that no query selects reads back `undefined` at runtime. */
const SONG_LIST_FIELDS: readonly (keyof SongColumns)[] = [
  'id', 'album_id', 'artist_id', 'title', 'album', 'artist', 'display_artist',
  'display_album_artist', 'display_composer', 'track', 'disc_number', 'year', 'genre',
  'cover_art', 'duration', 'size', 'content_type', 'suffix', 'transcoded_content_type',
  'transcoded_suffix', 'bit_rate', 'bit_depth', 'sampling_rate', 'channel_count', 'path',
  'user_rating', 'average_rating', 'play_count', 'created', 'starred', 'played', 'type',
  'bpm', 'comment', 'sort_name', 'sort_title', 'sort_artist', 'music_brainz_id',
  'explicit_status', 'bookmark_position', 'is_video', 'is_dir', 'parent', 'original_width',
  'original_height', 'rg_track_gain', 'rg_album_gain', 'rg_track_peak', 'rg_album_peak',
  'rg_base_gain', 'rg_fallback_gain',
];

export const SONG_LIST_COLS = colsOf(SONG_LIST_FIELDS);

/** The same projection qualified to `s`, for queries that JOIN a table sharing column
 *  names with `songs` (`artist_top_songs.artist_id`, `playlist_songs.song_id`) — an
 *  unqualified list is ambiguous there. */
export const SONG_LIST_COLS_S = colsOf(SONG_LIST_FIELDS, 's');

export type SongSortOrder = 'title' | 'artist';

/** A `Child` built from a projected row: every field the `songs` table holds is
 *  present (possibly `undefined` — the server may not have sent it). Nested
 *  `ArtistID3`s inside `artists`/`albumArtists`/`contributors` are reference stubs
 *  (id + name), NOT complete artists. */
export type LibrarySong = Complete<
  Child,
  | 'album' | 'albumId' | 'artist' | 'artistId' | 'averageRating' | 'bitRate' | 'bitDepth'
  | 'samplingRate' | 'channelCount' | 'bookmarkPosition' | 'contentType' | 'coverArt'
  | 'created' | 'discNumber' | 'duration' | 'genre' | 'isVideo' | 'originalHeight'
  | 'originalWidth' | 'parent' | 'path' | 'playCount' | 'size' | 'starred' | 'suffix'
  | 'track' | 'transcodedContentType' | 'transcodedSuffix' | 'type' | 'userRating' | 'year'
  | 'played' | 'bpm' | 'comment' | 'sortName' | 'musicBrainzId' | 'genres' | 'artists'
  | 'displayArtist' | 'albumArtists' | 'displayAlbumArtist' | 'contributors'
  | 'displayComposer' | 'moods' | 'replayGain' | 'explicitStatus'
>;

/** Rebuild the nested ReplayGain from the flattened `rg_*` columns. A member the
 *  server never sent stays ABSENT rather than defaulting to 0 — the track details
 *  sheet prints any member it finds, and 0.0 dB is a legitimate gain — so a fabricated
 *  0 would read as real data and defeat any "do we have ReplayGain for this track?"
 *  check. Absent means absent. */
function replayGainOf(r: SongColumns): ReplayGain | undefined {
  const rg: ReplayGain = {};
  let any = false;
  if (r.rg_track_gain != null) { rg.trackGain = r.rg_track_gain; any = true; }
  if (r.rg_album_gain != null) { rg.albumGain = r.rg_album_gain; any = true; }
  if (r.rg_track_peak != null) { rg.trackPeak = r.rg_track_peak; any = true; }
  if (r.rg_album_peak != null) { rg.albumPeak = r.rg_album_peak; any = true; }
  if (r.rg_base_gain != null) { rg.baseGain = r.rg_base_gain; any = true; }
  if (r.rg_fallback_gain != null) { rg.fallbackGain = r.rg_fallback_gain; any = true; }
  return any ? rg : undefined;
}

/** Adapt a projected row to the `Child` every consumer downstream of a list read
 *  expects — playback, scrobbling, downloads, the player Info tab and the options sheet
 *  each read fields a leaner projection would drop silently. */
export function songListRowToChild(r: SongListRow): LibrarySong {
  return {
    id: r.id,
    title: r.title ?? '',
    album: r.album ?? undefined,
    albumId: r.album_id ?? undefined,
    artist: r.artist ?? undefined,
    // 'Go to artist' and 'More by this artist' in the options sheet gate on `artistId`;
    // drop it from the projection and both silently disappear.
    artistId: r.artist_id ?? undefined,
    displayArtist: r.display_artist ?? undefined,
    displayAlbumArtist: r.display_album_artist ?? undefined,
    displayComposer: r.display_composer ?? undefined,
    track: r.track ?? undefined,
    discNumber: r.disc_number ?? undefined,
    year: r.year ?? undefined,
    genre: r.genre ?? undefined,
    coverArt: r.cover_art ?? undefined,
    duration: r.duration ?? 0,
    size: r.size ?? undefined,
    contentType: r.content_type ?? undefined,
    suffix: r.suffix ?? undefined,
    transcodedContentType: r.transcoded_content_type ?? undefined,
    transcodedSuffix: r.transcoded_suffix ?? undefined,
    bitRate: r.bit_rate ?? undefined,
    bitDepth: r.bit_depth ?? undefined,
    samplingRate: r.sampling_rate ?? undefined,
    channelCount: r.channel_count ?? undefined,
    path: r.path ?? undefined,
    userRating: r.user_rating ?? undefined,
    averageRating: r.average_rating ?? undefined,
    playCount: r.play_count ?? undefined,
    created: r.created ? new Date(r.created) : undefined,
    starred: r.starred ? new Date(r.starred) : undefined,
    played: r.played ?? undefined,
    type: (r.type as MediaType | null) ?? undefined,
    bpm: r.bpm ?? undefined,
    comment: r.comment ?? undefined,
    // The alphabet scroller recomputes the sort key in JS; without `sortName` it
    // disagrees with the `sort_title` the list was actually ordered by.
    sortName: r.sort_name ?? undefined,
    musicBrainzId: r.music_brainz_id ?? undefined,
    explicitStatus: r.explicit_status ?? undefined,
    bookmarkPosition: r.bookmark_position ?? undefined,
    isVideo: r.is_video == null ? undefined : Boolean(r.is_video),
    isDir: Boolean(r.is_dir),
    parent: r.parent ?? undefined,
    originalWidth: r.original_width ?? undefined,
    originalHeight: r.original_height ?? undefined,
    replayGain: replayGainOf(r),
    genres: r.genres,
    artists: r.artists,
    albumArtists: r.albumArtists,
    contributors: r.contributors,
    moods: r.moods,
  };
}

/** Reference stub for a nested artist: the child tables hold id + name only, and
 *  `ArtistID3.albumCount` is required, so it is fabricated (as `getArtistInfoRow`
 *  already does for similar artists). Never treat one as a complete artist. */
const artistStub = (id: string | null, name: string | null): ArtistID3 => ({
  id: id ?? '',
  name: name ?? '',
  albumCount: 0,
});

/**
 * Attach the multi-value children to a page of song rows — one batched query per
 * child table, stitched in JS. Rows with no children keep the key absent rather than
 * holding an empty array (consumers treat the two identically).
 */
export async function hydrateSongRows(db: InternalDb, rows: SongListRow[]): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const [genres, artists, albumArtists, contributors, moods] = await Promise.all([
    fetchChildren<{ name: string }, string>(
      db, { table: 'song_genres', parentCol: 'song_id', columns: ['name'] }, ids, (c) => c.name,
    ),
    fetchChildren<{ artist_id: string | null; artist_name: string | null }, ArtistID3>(
      db,
      { table: 'song_artists', parentCol: 'song_id', columns: ['artist_id', 'artist_name'] },
      ids,
      (c) => artistStub(c.artist_id, c.artist_name),
    ),
    fetchChildren<{ artist_id: string | null; artist_name: string | null }, ArtistID3>(
      db,
      { table: 'song_album_artists', parentCol: 'song_id', columns: ['artist_id', 'artist_name'] },
      ids,
      (c) => artistStub(c.artist_id, c.artist_name),
    ),
    fetchChildren<
      { role: string; sub_role: string | null; artist_id: string | null; artist_name: string | null },
      Contributor
    >(
      db,
      {
        table: 'song_contributors',
        parentCol: 'song_id',
        columns: ['role', 'sub_role', 'artist_id', 'artist_name'],
      },
      ids,
      (c) => ({
        role: c.role,
        subRole: c.sub_role ?? undefined,
        artist:
          c.artist_id == null && c.artist_name == null
            ? undefined
            : artistStub(c.artist_id, c.artist_name),
      }),
    ),
    fetchChildren<{ mood: string }, string>(
      db, { table: 'song_moods', parentCol: 'song_id', columns: ['mood'] }, ids, (c) => c.mood,
    ),
  ]);
  for (const row of rows) {
    const g = genres.get(row.id);
    if (g) row.genres = g;
    const a = artists.get(row.id);
    if (a) row.artists = a;
    const aa = albumArtists.get(row.id);
    if (aa) row.albumArtists = aa;
    const c = contributors.get(row.id);
    if (c) row.contributors = c;
    const m = moods.get(row.id);
    if (m) row.moods = m;
  }
}

export function upsertSongs(
  db: InternalDb,
  songs: Child[],
  onProgress?: (done: number, total: number) => void,
  articles?: readonly string[],
): Promise<number> {
  return bulkUpsert(
    db,
    {
      table: 'songs',
      idOf: (c) => c.id,
      rowOf: (c) => songRow(c, articles),
      children: [
        { table: 'song_genres', parentCol: 'song_id', rows: songGenreRows },
        { table: 'song_artists', parentCol: 'song_id', rows: songArtistRows },
        { table: 'song_album_artists', parentCol: 'song_id', rows: songAlbumArtistRows },
        { table: 'song_contributors', parentCol: 'song_id', rows: songContributorRows },
        { table: 'song_moods', parentCol: 'song_id', rows: songMoodRows },
      ],
      onProgress,
    },
    songs,
  );
}

/** Sort by artist uses the compound key (sort_artist, sort_title, id); sort by
 *  title is the plain (sort_title, id) key. The A–Z scroller seeks on the primary
 *  column either way. Mirrors the album repository. */
function songSortCols(sortOrder?: SongSortOrder) {
  const byArtist = sortOrder === 'artist';
  return {
    sortCol: byArtist ? 'sort_artist' : 'sort_title',
    sortCol2: byArtist ? 'sort_title' : undefined,
    sortKeyOf: (r: SongListRow) => (byArtist ? r.sort_artist : r.sort_title) ?? '',
    sortKey2Of: byArtist ? (r: SongListRow) => r.sort_title ?? '' : undefined,
  };
}

/** Build the keyset cursor for a song row under the active sort order — used by the
 *  screen to seed a backward page from the first loaded row. */
export function songCursorOf(r: SongListRow, sortOrder?: SongSortOrder): Cursor {
  return sortOrder === 'artist'
    ? { sortKey: r.sort_artist ?? '', sortKey2: r.sort_title ?? '', id: r.id }
    : { sortKey: r.sort_title ?? '', id: r.id };
}

/** Full A–Z keyset browse of the song library. */
export async function listSongs(
  db: InternalDb,
  opts: {
    cursor?: Cursor | null;
    letter?: string | null;
    limit: number;
    sortOrder?: SongSortOrder;
  },
): Promise<Page<SongListRow>> {
  const page = await keysetPage<SongListRow>(db, {
    table: 'songs',
    columns: SONG_LIST_COLS,
    limit: opts.limit,
    cursor: opts.cursor,
    letter: opts.letter,
    ...songSortCols(opts.sortOrder),
  });
  await hydrateSongRows(db, page.rows);
  return page;
}

export async function listSongsBefore(
  db: InternalDb,
  opts: { before: Cursor; limit: number; sortOrder?: SongSortOrder },
): Promise<{ rows: SongListRow[]; prevCursor: Cursor | null }> {
  const page = await keysetPageBefore<SongListRow>(db, {
    table: 'songs',
    columns: SONG_LIST_COLS,
    limit: opts.limit,
    before: opts.before,
    ...songSortCols(opts.sortOrder),
  });
  await hydrateSongRows(db, page.rows);
  return page;
}

export const countSongs = (db: InternalDb): Promise<number> => countRows(db, 'songs');

/**
 * Drop this album's songs that the server no longer lists. Servers that derive song ids
 * from path+tags (Navidrome et al.) emit fresh ids after a re-tag, and since nothing
 * else deletes song rows the album's track list would otherwise show the old and new
 * sets forever (`getAlbumDetail` is `WHERE album_id = ?`).
 *
 * Scoped to ONE album and ONE authoritative `getAlbum` response, so it carries no
 * assumption about what a whole sync run saw. Downloaded tracks are exempt — their row
 * backs the offline track list even when the server has moved on. Run it AFTER the
 * upsert: deleting first would leave the album empty if the process died in between.
 *
 * `serverSongCount` is the album's own `songCount` from the SAME response. A track list
 * shorter than the album says it is means the response was truncated, not that the album
 * shrank — deleting the remainder off a truncated answer destroys real tracks, while
 * skipping it only postpones an update to the next fetch. Only a self-consistent response
 * is allowed to prune. Omit it when the caller has no count to check against.
 */
export const deleteAlbumSongsNotIn = (
  db: InternalDb,
  albumId: string,
  keepIds: string[],
  serverSongCount?: number,
): Promise<unknown> =>
  typeof serverSongCount === 'number' && keepIds.length < serverSongCount
    ? Promise.resolve()
    : db.runAsync(
        'DELETE FROM songs WHERE album_id = ? ' +
          'AND id NOT IN (SELECT value FROM json_each(?)) ' +
          'AND id NOT IN (SELECT song_id FROM cached_songs)',
        [albumId, JSON.stringify(keepIds)],
      );

/** Eager +1 play-count + last-played for a just-scrobbled song — a TARGETED scalar
 *  UPDATE (no child-table churn) so normalized play stats stay current for the detail
 *  screens / player. Relative increment mirrors the store bumps; a full resync
 *  overwrites with the server value. No-op if the song isn't in the table yet. */
export const bumpSongPlayStats = (db: InternalDb, id: string, played: string): Promise<unknown> =>
  db.runAsync(
    'UPDATE songs SET play_count = COALESCE(play_count, 0) + 1, played = ? WHERE id = ?',
    [played, id],
  );


/** Which of the given song ids are in the table — the id-only presence check, mirroring
 *  `albumIdsPresent`. The favourites reconcile uses it to split the starred payload into
 *  "mark the library row" and "keep the envelope in `favorite_songs`". Ids pass as a JSON
 *  array via `json_each` to dodge the bound-variable limit. */
export const songIdsPresent = (db: InternalDb, ids: string[]): Promise<Set<string>> =>
  ids.length === 0
    ? Promise.resolve(new Set<string>())
    : db
        .getAllAsync<{ id: string }>(
          'SELECT id FROM songs WHERE id IN (SELECT value FROM json_each(?))',
          [JSON.stringify(ids)],
        )
        .then((rows) => new Set(rows.map((r) => r.id)));

/** Distinct album ids that already have songs — the "done" set the basic-path song walk
 *  diffs against the album ids to find which albums still need their songs fetched. */
export const listSongAlbumIds = (db: InternalDb): Promise<string[]> =>
  db
    .getAllAsync<{ album_id: string }>(
      'SELECT DISTINCT album_id FROM songs WHERE album_id IS NOT NULL',
    )
    .then((rows) => rows.map((r) => r.album_id));

/** Is there any album with no songs? The gate-cheap form of the walk's
 *  `listAlbumIds − listSongAlbumIds` diff: an indexed `NOT EXISTS` probe that stops at the
 *  first hit, so it stays flat on a 200k-album library instead of materialising two id lists. */
export const hasAlbumWithoutSongs = (db: InternalDb): Promise<boolean> =>
  db
    .getFirstAsync<{ x: number }>(
      'SELECT 1 AS x FROM albums a WHERE NOT EXISTS (SELECT 1 FROM songs s WHERE s.album_id = a.id) LIMIT 1',
    )
    .then((r) => r != null);

/** Which of the given album ids already have their detail (≥1 song) in the normalized
 *  model — the "has detail cached" presence check the downloaded-metadata refresh uses.
 *  Ids pass as a JSON array via `json_each` to dodge the bound-variable limit. */
export const albumIdsWithSongs = (db: InternalDb, ids: string[]): Promise<Set<string>> =>
  ids.length === 0
    ? Promise.resolve(new Set<string>())
    : db
        .getAllAsync<{ album_id: string }>(
          'SELECT DISTINCT album_id FROM songs WHERE album_id IN (SELECT value FROM json_each(?))',
          [JSON.stringify(ids)],
        )
        .then((rows) => new Set(rows.map((r) => r.album_id)));
