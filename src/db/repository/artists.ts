/** Artists repository: bulk upsert (row + roles), bio merge, keyset list, count, by-id. */
import type { ArtistID3, ArtistInfo2 } from 'subsonic-api';

import type { InternalDb } from '../client';
import { artistInfoRow, artistRoleRows, artistRow, artistSimilarRows } from './mappers';
import {
  bulkUpsert,
  colsOf,
  countRows,
  fetchChildren,
  keysetPage,
  keysetPageBefore,
  replaceChildrenSync,
  upsertRowSync,
  type Complete,
  type Cursor,
  type Page,
} from './core';

/** The `artists` columns every list read projects: the full row MINUS the internal
 *  search derivatives (`norm_*`/`dmeta_*`). `sort_title` stays — the keyset cursor
 *  and the A–Z scroller read it. */
interface ArtistColumns {
  id: string;
  name: string | null;
  sort_name: string | null;
  sort_title: string | null;
  cover_art: string | null;
  artist_image_url: string | null;
  album_count: number | null;
  starred: number | null;
  user_rating: number | null;
  music_brainz_id: string | null;
}

/** A projected artist row: its columns plus `artist_roles`, hydrated one batched
 *  query per page. Absent (not `[]`) when the artist has no roles. */
export interface ArtistListRow extends ArtistColumns {
  roles?: string[];
}

/** Typed against the row so a stale or misspelled column is a compile error, and the
 *  COLS string derives from it so the SQL cannot drift from the row type. */
const ARTIST_LIST_FIELDS: readonly (keyof ArtistColumns)[] = [
  'id', 'name', 'sort_name', 'sort_title', 'cover_art', 'artist_image_url', 'album_count',
  'starred', 'user_rating', 'music_brainz_id',
];

export const ARTIST_LIST_COLS = colsOf(ARTIST_LIST_FIELDS);

/** An `ArtistID3` built from a projected row: every field the `artists` table holds
 *  is present (possibly `undefined`). */
export type LibraryArtist = Complete<
  ArtistID3,
  'artistImageUrl' | 'coverArt' | 'starred' | 'userRating' | 'musicBrainzId' | 'sortName' | 'roles'
>;

/** Adapt a projected row to the `ArtistID3` the row/card components and the artist
 *  screen read. */
export function artistListRowToArtistID3(r: ArtistListRow): LibraryArtist {
  return {
    id: r.id,
    name: r.name ?? '',
    // See songListRowToChild — the scroller's letter must match `sort_title`.
    sortName: r.sort_name ?? undefined,
    coverArt: r.cover_art ?? undefined,
    artistImageUrl: r.artist_image_url ?? undefined,
    albumCount: r.album_count ?? 0,
    userRating: r.user_rating ?? undefined,
    starred: r.starred ? new Date(r.starred) : undefined,
    musicBrainzId: r.music_brainz_id ?? undefined,
    roles: r.roles,
  };
}

/** Attach `artist_roles` to a page of artist rows — one batched query, stitched in
 *  JS. Rows with no roles keep the key absent rather than holding an empty array. */
export async function hydrateArtistRows(db: InternalDb, rows: ArtistListRow[]): Promise<void> {
  if (rows.length === 0) return;
  const roles = await fetchChildren<{ role: string }, string>(
    db,
    { table: 'artist_roles', parentCol: 'artist_id', columns: ['role'] },
    rows.map((r) => r.id),
    (c) => c.role,
  );
  for (const row of rows) {
    const r = roles.get(row.id);
    if (r) row.roles = r;
  }
}

/** Build the keyset cursor for an artist row — used by the screen to seed a
 *  backward page from the first loaded row. Artists sort by name only (no compound). */
export const artistCursorOf = (r: ArtistListRow): Cursor => ({
  sortKey: r.sort_title ?? '',
  id: r.id,
});

export function upsertArtists(
  db: InternalDb,
  artists: ArtistID3[],
  onProgress?: (done: number, total: number) => void,
  articles?: readonly string[],
): Promise<number> {
  return bulkUpsert(
    db,
    {
      table: 'artists',
      idOf: (a) => a.id,
      rowOf: (a) => artistRow(a, articles),
      children: [{ table: 'artist_roles', parentCol: 'artist_id', rows: artistRoleRows }],
      onProgress,
    },
    artists,
  );
}

/**
 * Merge getArtistInfo2 (bio/images + similar artists) into an existing artist.
 * A partial upsert — it only touches the bio columns, never the base ArtistID3
 * fields, so a later library re-sync and a bio fetch don't clobber each other.
 */
/** The getArtistInfo2 envelope. `biography` is the SERVER bio; NULL means this server has
 *  none — empty and markup-only stubs are normalised away by the caller, so a non-null
 *  value always renders. Hand-written SQL rather than a mapper so `retrieved_at` is an
 *  explicit input, matching `upsertAlbumInfoRow`. */
export interface ArtistInfoWrite {
  biography: string | null;
  lastFmUrl: string | null;
  musicBrainzId: string | null;
  imageUrlSmall: string | null;
  imageUrlMedium: string | null;
  imageUrlLarge: string | null;
  retrievedAt: number;
}

/** Sole writer of `artist_info` + `artist_similar`, in one transaction. The bio
 *  RESOLUTION is a different concern and lives in `artist_bio`. */
export function upsertArtistInfo(
  db: InternalDb,
  id: string,
  info: ArtistInfoWrite,
  similar: ArtistInfo2,
): void {
  db.withTransactionSync(() => {
    db.runSync(
      `INSERT INTO artist_info
         (artist_id, biography, last_fm_url, music_brainz_id,
          image_url_small, image_url_medium, image_url_large, retrieved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(artist_id) DO UPDATE SET
         biography = excluded.biography, last_fm_url = excluded.last_fm_url,
         music_brainz_id = excluded.music_brainz_id,
         image_url_small = excluded.image_url_small,
         image_url_medium = excluded.image_url_medium,
         image_url_large = excluded.image_url_large,
         retrieved_at = excluded.retrieved_at`,
      [
        id, info.biography, info.lastFmUrl, info.musicBrainzId,
        info.imageUrlSmall, info.imageUrlMedium, info.imageUrlLarge, info.retrievedAt,
      ],
    );
    replaceChildrenSync(db, 'artist_similar', 'artist_id', id, artistSimilarRows(similar, id));
  });
}

/** The RESOLVED biography (server, else MusicBrainz) + its negative cache. A present row
 *  means "we attempted this artist" — the presence predicate the MBID-override screens use.
 *  `checked_at` is nullable so that marker can exist without claiming a cache timestamp. */
export const upsertArtistBio = (
  db: InternalDb,
  id: string,
  bio: { biography: string | null; resolvedMbid: string | null; checkedAt: number | null },
): Promise<unknown> =>
  db.runAsync(
    `INSERT INTO artist_bio (artist_id, biography, resolved_mbid, checked_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(artist_id) DO UPDATE SET
       biography = excluded.biography, resolved_mbid = excluded.resolved_mbid,
       checked_at = excluded.checked_at`,
    [id, bio.biography, bio.resolvedMbid, bio.checkedAt],
  );

export async function listArtists(
  db: InternalDb,
  opts: { cursor?: Cursor | null; letter?: string | null; limit: number },
): Promise<Page<ArtistListRow>> {
  const page = await keysetPage<ArtistListRow>(db, {
    table: 'artists',
    sortCol: 'sort_title',
    columns: ARTIST_LIST_COLS,
    limit: opts.limit,
    cursor: opts.cursor,
    letter: opts.letter,
    sortKeyOf: (r) => r.sort_title ?? '',
  });
  await hydrateArtistRows(db, page.rows);
  return page;
}

export async function listArtistsBefore(
  db: InternalDb,
  opts: { before: Cursor; limit: number },
): Promise<{ rows: ArtistListRow[]; prevCursor: Cursor | null }> {
  const page = await keysetPageBefore<ArtistListRow>(db, {
    table: 'artists',
    sortCol: 'sort_title',
    columns: ARTIST_LIST_COLS,
    limit: opts.limit,
    before: opts.before,
    sortKeyOf: (r) => r.sort_title ?? '',
  });
  await hydrateArtistRows(db, page.rows);
  return page;
}

/**
 * Prune artists no longer on the server after a full fetch. Exact rather than
 * epoch-based because `getAllArtists` returns the COMPLETE set in one call.
 *
 * An empty `keepIds` is REFUSED, not honoured — `getAllArtists` returns `[]` rather than
 * throwing whenever there is no usable API (offline, mid-logout, before auth restore),
 * so an empty set means "couldn't ask" far more often than "the server has none".
 */
export const deleteArtistsNotIn = (db: InternalDb, keepIds: string[]): Promise<unknown> => {
  if (keepIds.length === 0) return Promise.resolve();
  return db.runAsync('DELETE FROM artists WHERE id NOT IN (SELECT value FROM json_each(?))', [
    JSON.stringify(keepIds),
  ]);
};

export const countArtists = (db: InternalDb): Promise<number> => countRows(db, 'artists');

/** Full rows for a set of artist ids (unordered) — the downloaded-artist filter hydrates
 *  the artists who own a downloaded album. Ids pass as a JSON array via `json_each` to
 *  dodge the bound-variable limit; an empty id set returns no rows. */
export const listArtistsByIds = async (db: InternalDb, ids: string[]): Promise<ArtistListRow[]> => {
  const rows = await db.getAllAsync<ArtistListRow>(
    `SELECT ${ARTIST_LIST_COLS} FROM artists WHERE id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(ids)],
  );
  await hydrateArtistRows(db, rows);
  return rows;
};

/** Which of the given artist ids are in the table — the id-only presence check, mirroring
 *  `albumIdsPresent`. Used by the favourites reconcile to split the starred payload. */
export const artistIdsPresent = (db: InternalDb, ids: string[]): Promise<Set<string>> =>
  ids.length === 0
    ? Promise.resolve(new Set<string>())
    : db
        .getAllAsync<{ id: string }>(
          'SELECT id FROM artists WHERE id IN (SELECT value FROM json_each(?))',
          [JSON.stringify(ids)],
        )
        .then((rows) => new Set(rows.map((r) => r.id)));

export const getArtist = (db: InternalDb, id: string): Promise<Record<string, unknown> | null> =>
  db.getFirstAsync('SELECT * FROM artists WHERE id = ?', [id]);

/** Artists that already have persisted top songs — the set whose top-song lists a
 *  list-length change refreshes (replaces the doomed detail store's in-memory map). */
/** Replace an artist's ordered top-song membership (position = array index). The songs
 *  themselves must already be upserted into `songs` by the caller. ONE atomic batch: a
 *  failure part-way through restores the previous list rather than leaving the DELETE
 *  applied and the INSERTs missing. Takes no mutex of its own — callers hold
 *  `serializeDbWrite`. */
export const setArtistTopSongs = (
  db: InternalDb,
  artistId: string,
  songIds: string[],
  /** Present = also record presence/freshness. OMIT when the fetch failed: stamping then
   *  would mark the artist "fetched, 0 songs" with no TTL to recover from. */
  state?: { listLength: number },
): Promise<unknown> =>
  db.runAtomicBatchAsync([
    ['DELETE FROM artist_top_songs WHERE artist_id = ?', [artistId]],
    ...songIds.map(
      (songId, pos): [string, (string | number)[]] => [
        'INSERT INTO artist_top_songs (artist_id, pos, song_id) VALUES (?, ?, ?)',
        [artistId, pos, songId],
      ],
    ),
    ...(state
      ? ([
          [
            `INSERT INTO artist_top_songs_state (artist_id, retrieved_at, list_length, song_count)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(artist_id) DO UPDATE SET
               retrieved_at = excluded.retrieved_at, list_length = excluded.list_length,
               song_count = excluded.song_count`,
            [artistId, Date.now(), state.listLength, songIds.length],
          ],
        ] as [string, (string | number)[]][])
      : []),
  ]);
