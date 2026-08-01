/** Artists repository: bulk upsert (row + roles), bio merge, keyset list, count, by-id. */
import type { ArtistID3, ArtistInfo2 } from 'subsonic-api';

import type { InternalDb } from '../client';
import { artistInfoRow, artistRoleRows, artistRow, artistSimilarRows } from './mappers';
import {
  bulkUpsert,
  countRows,
  keysetPage,
  keysetPageBefore,
  replaceChildrenSync,
  upsertRowSync,
  type Cursor,
  type Page,
} from './core';

/** Lean projection for list rendering. */
export interface ArtistListRow {
  id: string;
  name: string | null;
  cover_art: string | null;
  album_count: number | null;
  sort_title: string | null;
  starred: number | null;
  user_rating: number | null;
}

export const ARTIST_LIST_COLS =
  '"id", "name", "cover_art", "album_count", "sort_title", "starred", "user_rating"';

/** Adapt a lean list row to the `ArtistID3` shape the row/card components render
 *  (they read `coverArt`, not `artistImageUrl`, so the lean projection suffices). */
export function artistListRowToArtistID3(r: ArtistListRow): ArtistID3 {
  return {
    id: r.id,
    name: r.name ?? '',
    coverArt: r.cover_art ?? undefined,
    albumCount: r.album_count ?? 0,
    userRating: r.user_rating ?? undefined,
    starred: r.starred ? new Date(r.starred) : undefined,
  } as ArtistID3;
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

export function listArtists(
  db: InternalDb,
  opts: { cursor?: Cursor | null; letter?: string | null; limit: number; starredOnly?: boolean },
): Promise<Page<ArtistListRow>> {
  return keysetPage<ArtistListRow>(db, {
    table: 'artists',
    sortCol: 'sort_title',
    columns: ARTIST_LIST_COLS,
    limit: opts.limit,
    cursor: opts.cursor,
    letter: opts.letter,
    where: opts.starredOnly ? 'starred IS NOT NULL' : undefined,
    sortKeyOf: (r) => r.sort_title ?? '',
  });
}

export function listArtistsBefore(
  db: InternalDb,
  opts: { before: Cursor; limit: number; starredOnly?: boolean },
): Promise<{ rows: ArtistListRow[]; prevCursor: Cursor | null }> {
  return keysetPageBefore<ArtistListRow>(db, {
    table: 'artists',
    sortCol: 'sort_title',
    columns: ARTIST_LIST_COLS,
    limit: opts.limit,
    before: opts.before,
    where: opts.starredOnly ? 'starred IS NOT NULL' : undefined,
    sortKeyOf: (r) => r.sort_title ?? '',
  });
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

export const countArtists = (db: InternalDb, starredOnly = false): Promise<number> =>
  countRows(db, 'artists', starredOnly ? 'starred IS NOT NULL' : undefined);

/** Lean rows for a set of artist ids (unordered) — the downloaded-artist filter hydrates
 *  the artists who own a downloaded album. Ids pass as a JSON array via `json_each` to
 *  dodge the bound-variable limit; an empty id set returns no rows. */
export const listArtistsByIds = (db: InternalDb, ids: string[]): Promise<ArtistListRow[]> =>
  db.getAllAsync<ArtistListRow>(
    `SELECT ${ARTIST_LIST_COLS} FROM artists WHERE id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(ids)],
  );

export const getArtist = (db: InternalDb, id: string): Promise<Record<string, unknown> | null> =>
  db.getFirstAsync('SELECT * FROM artists WHERE id = ?', [id]);

/** Artists that already have persisted top songs — the set whose top-song lists a
 *  list-length change refreshes (replaces the doomed detail store's in-memory map). */
/** Replace an artist's ordered top-song membership (position = array index). The songs
 *  themselves must already be upserted into `songs` by the caller. Async batch (no
 *  sync transaction) so it can't collide with a concurrent write. */
export const setArtistTopSongs = (
  db: InternalDb,
  artistId: string,
  songIds: string[],
  /** Present = also record presence/freshness. OMIT when the fetch failed: stamping then
   *  would mark the artist "fetched, 0 songs" with no TTL to recover from. */
  state?: { listLength: number },
): Promise<unknown> =>
  db.runBatchAsync([
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
