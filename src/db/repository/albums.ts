/** Albums repository: bulk upsert (row + children), keyset list, count, by-id. */
import type { AlbumID3, ArtistID3, DiscTitle, ItemDate, RecordLabel } from 'subsonic-api';

import type { BatchCommand, InternalDb } from '../client';
import {
  albumArtistRows,
  albumDiscTitleRows,
  albumGenreRows,
  albumMoodRows,
  albumRecordLabelRows,
  albumReleaseTypeRows,
  albumRow,
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

/** The `albums` columns every list read projects: the full row MINUS the internal
 *  search derivatives (`norm_*`/`dmeta_*`). `sort_title`/`sort_artist` stay — the
 *  keyset cursor and the A–Z scroller read them. `artist_id` lets the search screen's
 *  downloaded-artist filter map an album back to its artist. */
interface AlbumColumns {
  id: string;
  artist_id: string | null;
  name: string | null;
  artist: string | null;
  display_artist: string | null;
  cover_art: string | null;
  song_count: number | null;
  duration: number | null;
  play_count: number | null;
  created: number | null;
  starred: number | null;
  year: number | null;
  genre: string | null;
  played: string | null;
  user_rating: number | null;
  version: string | null;
  music_brainz_id: string | null;
  sort_name: string | null;
  sort_title: string | null;
  sort_artist: string | null;
  is_compilation: number | null;
  explicit_status: string | null;
  original_release_year: number | null;
  original_release_month: number | null;
  original_release_day: number | null;
  release_year: number | null;
  release_month: number | null;
  release_day: number | null;
}

/** A projected album row: its columns plus the multi-value children, hydrated one
 *  batched query per child table per page. Absent (not `[]`) when the album has none. */
export interface AlbumListRow extends AlbumColumns {
  artists?: ArtistID3[];
  genres?: string[];
  discTitles?: DiscTitle[];
  moods?: string[];
  recordLabels?: RecordLabel[];
  releaseTypes?: string[];
}

/** Typed against the row so a stale or misspelled column is a compile error, and the
 *  COLS string derives from it so the SQL cannot drift from the row type. */
const ALBUM_LIST_FIELDS: readonly (keyof AlbumColumns)[] = [
  'id', 'artist_id', 'name', 'artist', 'display_artist', 'cover_art', 'song_count',
  'duration', 'play_count', 'created', 'starred', 'year', 'genre', 'played', 'user_rating',
  'version', 'music_brainz_id', 'sort_name', 'sort_title', 'sort_artist', 'is_compilation',
  'explicit_status', 'original_release_year', 'original_release_month',
  'original_release_day', 'release_year', 'release_month', 'release_day',
];

export const ALBUM_LIST_COLS = colsOf(ALBUM_LIST_FIELDS);

export type AlbumSortOrder = 'title' | 'artist';

/** An `AlbumID3` built from a projected row: every field the `albums` table holds is
 *  present (possibly `undefined`). The `artists` entries are reference stubs. */
export type LibraryAlbum = Complete<
  AlbumID3,
  | 'artist' | 'artistId' | 'coverArt' | 'created' | 'genre' | 'playCount' | 'starred'
  | 'year' | 'version' | 'played' | 'userRating' | 'recordLabels' | 'musicBrainzId'
  | 'genres' | 'artists' | 'displayArtist' | 'releaseTypes' | 'moods' | 'sortName'
  | 'originalReleaseDate' | 'releaseDate' | 'isCompilation' | 'explicitStatus' | 'discTitles'
>;

/** A flattened `*_year/_month/_day` triple back to an ItemDate — `undefined` when the
 *  server sent no date at all, so a reader can tell "none" from "year only". */
const itemDate = (
  year: number | null,
  month: number | null,
  day: number | null,
): ItemDate | undefined =>
  year == null && month == null && day == null
    ? undefined
    : { year: year ?? undefined, month: month ?? undefined, day: day ?? undefined };

/** Adapt a projected row to the `AlbumID3` the row/card components, the details sheet
 *  and every more-options action read. `created` is left `undefined` when unknown —
 *  an epoch-0 default is truthy and renders as "Added 1 January 1970". */
export function albumListRowToAlbumID3(r: AlbumListRow): LibraryAlbum {
  return {
    id: r.id,
    name: r.name ?? '',
    artistId: r.artist_id ?? undefined,
    // The artist TAG is the artist. `display_artist` is only a fallback for a server
    // that populates the display form alone — most (classic Subsonic, Airsonic, gonic)
    // send `artist` and no `displayArtist` at all.
    artist: r.artist ?? r.display_artist ?? undefined,
    displayArtist: r.display_artist ?? undefined,
    coverArt: r.cover_art ?? undefined,
    songCount: r.song_count ?? 0,
    duration: r.duration ?? 0,
    playCount: r.play_count ?? undefined,
    created: r.created ? new Date(r.created) : undefined,
    starred: r.starred ? new Date(r.starred) : undefined,
    year: r.year ?? undefined,
    genre: r.genre ?? undefined,
    played: r.played ?? undefined,
    userRating: r.user_rating ?? undefined,
    version: r.version ?? undefined,
    musicBrainzId: r.music_brainz_id ?? undefined,
    // See songListRowToChild — the scroller's letter must match `sort_title`.
    sortName: r.sort_name ?? undefined,
    isCompilation: r.is_compilation == null ? undefined : Boolean(r.is_compilation),
    explicitStatus: r.explicit_status ?? undefined,
    originalReleaseDate: itemDate(
      r.original_release_year, r.original_release_month, r.original_release_day,
    ),
    releaseDate: itemDate(r.release_year, r.release_month, r.release_day),
    artists: r.artists,
    genres: r.genres,
    discTitles: r.discTitles,
    moods: r.moods,
    recordLabels: r.recordLabels,
    releaseTypes: r.releaseTypes,
  };
}

/** Reference stub for a nested artist — the child table holds id + name only and
 *  `ArtistID3.albumCount` is required, so it is fabricated. Never a complete artist. */
const artistStub = (id: string | null, name: string | null): ArtistID3 => ({
  id: id ?? '',
  name: name ?? '',
  albumCount: 0,
});

/**
 * Attach the multi-value children to a page of album rows — one batched query per
 * child table, stitched in JS. Rows with no children keep the key absent rather than
 * holding an empty array (consumers treat the two identically).
 */
export async function hydrateAlbumRows(db: InternalDb, rows: AlbumListRow[]): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const [artists, genres, discTitles, moods, recordLabels, releaseTypes] = await Promise.all([
    fetchChildren<{ artist_id: string | null; artist_name: string | null }, ArtistID3>(
      db,
      { table: 'album_artists', parentCol: 'album_id', columns: ['artist_id', 'artist_name'] },
      ids,
      (c) => artistStub(c.artist_id, c.artist_name),
    ),
    fetchChildren<{ name: string }, string>(
      db, { table: 'album_genres', parentCol: 'album_id', columns: ['name'] }, ids, (c) => c.name,
    ),
    // Disc titles are keyed (album_id, disc) — there is no `pos` to order by.
    fetchChildren<{ disc: number; title: string }, DiscTitle>(
      db,
      { table: 'album_disc_titles', parentCol: 'album_id', columns: ['disc', 'title'], orderBy: 'disc' },
      ids,
      (c) => ({ disc: c.disc, title: c.title }),
    ),
    fetchChildren<{ mood: string }, string>(
      db, { table: 'album_moods', parentCol: 'album_id', columns: ['mood'] }, ids, (c) => c.mood,
    ),
    fetchChildren<{ name: string }, RecordLabel>(
      db,
      { table: 'album_record_labels', parentCol: 'album_id', columns: ['name'] },
      ids,
      (c) => ({ name: c.name }),
    ),
    fetchChildren<{ name: string }, string>(
      db,
      { table: 'album_release_types', parentCol: 'album_id', columns: ['name'] },
      ids,
      (c) => c.name,
    ),
  ]);
  for (const row of rows) {
    const ar = artists.get(row.id);
    if (ar) row.artists = ar;
    const g = genres.get(row.id);
    if (g) row.genres = g;
    const d = discTitles.get(row.id);
    if (d) row.discTitles = d;
    const m = moods.get(row.id);
    if (m) row.moods = m;
    const rl = recordLabels.get(row.id);
    if (rl) row.recordLabels = rl;
    const rt = releaseTypes.get(row.id);
    if (rt) row.releaseTypes = rt;
  }
}

/**
 * @param opts.merge SUPPLEMENTARY writer — the payload is a partial view of the album
 * (a list endpoint, an artist's album array), so columns and child sets it does not
 * carry keep what the row already holds. Omit for the library sync and any other writer
 * that speaks for the whole entity. See `buildUpsertRow` in `core.ts`.
 */
export function upsertAlbums(
  db: InternalDb,
  albums: AlbumID3[],
  onProgress?: (done: number, total: number) => void,
  articles?: readonly string[],
  opts?: { merge?: boolean },
): Promise<number> {
  return bulkUpsert(
    db,
    {
      table: 'albums',
      idOf: (a) => a.id,
      rowOf: (a) => albumRow(a, articles),
      children: [
        { table: 'album_genres', parentCol: 'album_id', rows: albumGenreRows },
        { table: 'album_artists', parentCol: 'album_id', rows: albumArtistRows },
        { table: 'album_release_types', parentCol: 'album_id', rows: albumReleaseTypeRows },
        { table: 'album_moods', parentCol: 'album_id', rows: albumMoodRows },
        { table: 'album_record_labels', parentCol: 'album_id', rows: albumRecordLabelRows },
        { table: 'album_disc_titles', parentCol: 'album_id', rows: albumDiscTitleRows },
      ],
      onProgress,
      merge: opts?.merge,
    },
    albums,
  );
}

/** On-demand album info: the getAlbumInfo2 payload + the client-side Wikipedia
 *  enrichment. Its own row so a library re-sync (which rewrites the album row on every
 *  page) and an info fetch can't clobber each other. */
export interface AlbumInfoRow {
  notes: string | null;
  lastFmUrl: string | null;
  musicBrainzId: string | null;
  imageUrlSmall: string | null;
  imageUrlMedium: string | null;
  imageUrlLarge: string | null;
  enrichedNotes: string | null;
  enrichedNotesUrl: string | null;
  overrideMbid: string | null;
  retrievedAt: number;
}

interface AlbumInfoDbRow {
  notes: string | null;
  last_fm_url: string | null;
  music_brainz_id: string | null;
  image_url_small: string | null;
  image_url_medium: string | null;
  image_url_large: string | null;
  enriched_notes: string | null;
  enriched_notes_url: string | null;
  override_mbid: string | null;
  retrieved_at: number;
}

export const getAlbumInfoRow = async (
  db: InternalDb,
  albumId: string,
): Promise<AlbumInfoRow | null> => {
  const r = await db.getFirstAsync<AlbumInfoDbRow>(
    'SELECT * FROM album_info WHERE album_id = ?',
    [albumId],
  );
  if (!r) return null;
  return {
    notes: r.notes,
    lastFmUrl: r.last_fm_url,
    musicBrainzId: r.music_brainz_id,
    imageUrlSmall: r.image_url_small,
    imageUrlMedium: r.image_url_medium,
    imageUrlLarge: r.image_url_large,
    enrichedNotes: r.enriched_notes,
    enrichedNotesUrl: r.enriched_notes_url,
    overrideMbid: r.override_mbid,
    retrievedAt: r.retrieved_at,
  };
};


export const upsertAlbumInfoRow = (
  db: InternalDb,
  albumId: string,
  info: AlbumInfoRow,
): Promise<unknown> =>
  db.runAsync(
    `INSERT INTO album_info
       (album_id, notes, last_fm_url, music_brainz_id, image_url_small, image_url_medium,
        image_url_large, enriched_notes, enriched_notes_url, override_mbid, retrieved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(album_id) DO UPDATE SET
       notes = excluded.notes, last_fm_url = excluded.last_fm_url,
       music_brainz_id = excluded.music_brainz_id,
       image_url_small = excluded.image_url_small,
       image_url_medium = excluded.image_url_medium,
       image_url_large = excluded.image_url_large,
       enriched_notes = excluded.enriched_notes,
       enriched_notes_url = excluded.enriched_notes_url,
       override_mbid = excluded.override_mbid, retrieved_at = excluded.retrieved_at`,
    [
      albumId, info.notes, info.lastFmUrl, info.musicBrainzId, info.imageUrlSmall,
      info.imageUrlMedium, info.imageUrlLarge, info.enrichedNotes, info.enrichedNotesUrl,
      info.overrideMbid, info.retrievedAt,
    ],
  );

/** The four home-screen album lists. Ordered ids in `album_list_entries`; the albums
 *  themselves are rows in `albums`, so a list can never disagree with the library. */
export type AlbumListType =
  | 'recentlyAdded'
  | 'recentlyPlayed'
  | 'frequentlyPlayed'
  | 'randomSelection';

/**
 * Replace one list's membership, ordered. ONE atomic batch: a failure part-way leaves
 * the previous list rather than an empty home row.
 *
 * The caller must have upserted the albums FIRST — `album_id` has an FK to `albums` and
 * `PRAGMA foreign_keys = ON`, so an id with no row fails the insert.
 */
export const replaceAlbumList = (
  db: InternalDb,
  listType: AlbumListType,
  albumIds: string[],
): Promise<void> =>
  db.runAtomicBatchAsync([
    ['DELETE FROM album_list_entries WHERE list_type = ?', [listType]],
    ...albumIds.map(
      (albumId, pos): BatchCommand => [
        'INSERT INTO album_list_entries (list_type, pos, album_id) VALUES (?, ?, ?)',
        [listType, pos, albumId],
      ],
    ),
  ]);

/** One list's albums as projected rows, in list order. */
export const listAlbumListRows = (
  db: InternalDb,
  listType: AlbumListType,
): Promise<AlbumListRow[]> =>
  db.getAllAsync<AlbumListRow>(
    `SELECT ${colsOf(ALBUM_LIST_FIELDS, 'a')} FROM album_list_entries e
       JOIN albums a ON a.id = e.album_id
      WHERE e.list_type = ? ORDER BY e.pos`,
    [listType],
  );

/** Synchronous counterpart — for the headless/CarPlay read at cold start, which has no
 *  UI to defer to and must answer before the browse tree is built. */
export const listAlbumListRowsSync = (db: InternalDb, listType: AlbumListType): AlbumListRow[] =>
  db.getAllSync<AlbumListRow>(
    `SELECT ${colsOf(ALBUM_LIST_FIELDS, 'a')} FROM album_list_entries e
       JOIN albums a ON a.id = e.album_id
      WHERE e.list_type = ? ORDER BY e.pos`,
    [listType],
  );

/** Drop every cached album-info row (settings "clear metadata"). */
export const clearAlbumInfo = (db: InternalDb): Promise<unknown> =>
  db.runAsync('DELETE FROM album_info');

/** Sort by artist uses the compound key (sort_artist, sort_title, id) so albums by
 *  the same artist stay grouped and alphabetised; sort by title is the plain
 *  (sort_title, id) key. The A–Z scroller seeks on the primary column either way. */
function albumSortCols(sortOrder?: AlbumSortOrder) {
  const byArtist = sortOrder === 'artist';
  return {
    sortCol: byArtist ? 'sort_artist' : 'sort_title',
    sortCol2: byArtist ? 'sort_title' : undefined,
    sortKeyOf: (r: AlbumListRow) => (byArtist ? r.sort_artist : r.sort_title) ?? '',
    sortKey2Of: byArtist ? (r: AlbumListRow) => r.sort_title ?? '' : undefined,
  };
}

/** Build the keyset cursor for an album row under the active sort order — used by
 *  the screen to seed a backward page from the first loaded row. */
export function albumCursorOf(r: AlbumListRow, sortOrder?: AlbumSortOrder): Cursor {
  return sortOrder === 'artist'
    ? { sortKey: r.sort_artist ?? '', sortKey2: r.sort_title ?? '', id: r.id }
    : { sortKey: r.sort_title ?? '', id: r.id };
}

export async function listAlbums(
  db: InternalDb,
  opts: {
    cursor?: Cursor | null;
    letter?: string | null;
    limit: number;
    sortOrder?: AlbumSortOrder;
  },
): Promise<Page<AlbumListRow>> {
  const page = await keysetPage<AlbumListRow>(db, {
    table: 'albums',
    columns: ALBUM_LIST_COLS,
    limit: opts.limit,
    cursor: opts.cursor,
    letter: opts.letter,
    ...albumSortCols(opts.sortOrder),
  });
  await hydrateAlbumRows(db, page.rows);
  return page;
}

export async function listAlbumsBefore(
  db: InternalDb,
  opts: { before: Cursor; limit: number; sortOrder?: AlbumSortOrder },
): Promise<{ rows: AlbumListRow[]; prevCursor: Cursor | null }> {
  const page = await keysetPageBefore<AlbumListRow>(db, {
    table: 'albums',
    columns: ALBUM_LIST_COLS,
    limit: opts.limit,
    before: opts.before,
    ...albumSortCols(opts.sortOrder),
  });
  await hydrateAlbumRows(db, page.rows);
  return page;
}

export const countAlbums = (db: InternalDb): Promise<number> => countRows(db, 'albums');

/** Server-reported total track count across the library. Lets the song phase derive
 *  progress from its resume cursor instead of counting rows it may not have written. */
export const sumAlbumSongCounts = async (db: InternalDb): Promise<number> =>
  (await db.getFirstAsync<{ n: number }>('SELECT COALESCE(SUM(song_count), 0) AS n FROM albums'))
    ?.n ?? 0;

/** Full rows for a set of album ids (unordered) — the downloaded set for offline
 *  search. Ids pass as a JSON array via `json_each` to dodge the bound-variable limit;
 *  an empty id set is the caller's job to guard (this returns no rows for it). */
export const listAlbumsByIds = async (db: InternalDb, ids: string[]): Promise<AlbumListRow[]> => {
  const rows = await db.getAllAsync<AlbumListRow>(
    `SELECT ${ALBUM_LIST_COLS} FROM albums WHERE id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(ids)],
  );
  await hydrateAlbumRows(db, rows);
  return rows;
};

/** Which of the given album ids are in the table — the id-only presence check. Its
 *  own read because the callers need nothing else, and one of them runs on every
 *  `recentlyAdded` change: `listAlbumsByIds` would fetch ~28 columns plus six child
 *  queries to answer a question `id` alone settles. */
export const albumIdsPresent = (db: InternalDb, ids: string[]): Promise<Set<string>> =>
  ids.length === 0
    ? Promise.resolve(new Set<string>())
    : db
        .getAllAsync<{ id: string }>(
          'SELECT id FROM albums WHERE id IN (SELECT value FROM json_each(?))',
          [JSON.stringify(ids)],
        )
        .then((rows) => new Set(rows.map((r) => r.id)));

/** Eager +1 play-count + last-played for a just-scrobbled album — a TARGETED scalar
 *  UPDATE (no child-table churn) so normalized play stats stay current for the detail
 *  screens. Relative increment mirrors the store bumps; a full resync overwrites with
 *  the server value. No-op if the album isn't in the table yet. */
export const bumpAlbumPlayStats = (db: InternalDb, id: string, played: string): Promise<unknown> =>
  db.runAsync(
    'UPDATE albums SET play_count = COALESCE(play_count, 0) + 1, played = ? WHERE id = ?',
    [played, id],
  );

export const getAlbum = (db: InternalDb, id: string): Promise<Record<string, unknown> | null> =>
  db.getFirstAsync('SELECT * FROM albums WHERE id = ?', [id]);

/** Every album id in the table — the sync's known-id set, for change-detect and walk
 *  enumeration. */
export const listAlbumIds = (db: InternalDb): Promise<string[]> =>
  db.getAllAsync<{ id: string }>('SELECT id FROM albums').then((rows) => rows.map((r) => r.id));

/** The four columns the whole-table browse read projects. Deliberately NOT
 *  `AlbumListRow`: `listAllAlbums` has no LIMIT, so the widened projection would mean
 *  ~28 columns and six child-table hydrations over every row in the table on the
 *  headless boot path, at a ~200k-album target. Its own type so a browse row can
 *  never be mistaken for a full album. */
export interface AlbumBrowseRow {
  id: string;
  name: string | null;
  display_artist: string | null;
  cover_art: string | null;
}

const ALBUM_BROWSE_COLS = colsOf<keyof AlbumBrowseRow>([
  'id', 'name', 'display_artist', 'cover_art',
]);

/** Adapt a browse row for the CarPlay/voice consumers. Intentionally minimal — the
 *  required `AlbumID3` scalars are placeholders, and no consumer of `listAllAlbums`
 *  reads them (title, artist and artwork only). */
export const albumBrowseRowToAlbumID3 = (r: AlbumBrowseRow): AlbumID3 => ({
  id: r.id,
  name: r.name ?? '',
  artist: r.display_artist ?? undefined,
  coverArt: r.cover_art ?? undefined,
  songCount: 0,
  duration: 0,
});

/** Every album as a browse row, sort-title order — the CarPlay/headless A–Z browse and
 *  voice vocabulary. Whole-table read, which is why the projection is four columns. */
export const listAllAlbums = (db: InternalDb): Promise<AlbumBrowseRow[]> =>
  db.getAllAsync<AlbumBrowseRow>(
    `SELECT ${ALBUM_BROWSE_COLS} FROM albums ORDER BY sort_title, "id"`,
  );
