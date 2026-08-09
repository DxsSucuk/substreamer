/** Playlists repository: bulk upsert (row + allowed users), list, count, by-id,
 *  and the ordered `playlist_songs` membership junction. */
import type { Playlist } from 'subsonic-api';

import type { BatchCommand, InternalDb } from '../client';
import { playlistAllowedUserRows, playlistRow } from './mappers';
import {
  bulkUpsert,
  colsOf,
  countRows,
  keysetPage,
  keysetPageBefore,
  type Complete,
  type Cursor,
  type Page,
} from './core';

/** The `playlists` columns every list read projects: the full row MINUS the internal
 *  derivatives — the `norm_*`/`dmeta_*` search copies and the `detail_*` sync markers,
 *  which have no API counterpart and have their own read (`listPlaylistDetailState`).
 *  `sort_title` stays — the keyset cursor and the A–Z scroller read it. */
export interface PlaylistListRow {
  id: string;
  name: string | null;
  comment: string | null;
  cover_art: string | null;
  created: number | null;
  changed: number | null;
  duration: number | null;
  owner: string | null;
  public: number | null;
  song_count: number | null;
  sort_title: string | null;
}

/** Typed against the row so a stale or misspelled column is a compile error, and the
 *  COLS string derives from it so the SQL cannot drift from the row type. */
const PLAYLIST_LIST_FIELDS: readonly (keyof PlaylistListRow)[] = [
  'id', 'name', 'comment', 'cover_art', 'created', 'changed', 'duration', 'owner',
  'public', 'song_count', 'sort_title',
];

/** Exported for `details.ts`, which projects the same columns for playlist detail. */
export const PLAYLIST_LIST_COLS = colsOf(PLAYLIST_LIST_FIELDS);

/** A `Playlist` built from a projected row: every field the `playlists` table holds is
 *  present (possibly `undefined`). `allowedUser` is NOT hydrated — it is a permissions
 *  list no list or detail consumer reads. */
export type LibraryPlaylist = Complete<
  Playlist,
  'changed' | 'comment' | 'coverArt' | 'created' | 'owner' | 'public'
>;

/** Adapt a projected row to the `Playlist` the row/card components and the playlist
 *  screen read. `created`/`changed` stay `undefined` when unknown — an epoch-0 default
 *  is truthy and renders as a real 1970 date. */
export function playlistListRowToPlaylist(r: PlaylistListRow): LibraryPlaylist {
  return {
    id: r.id,
    name: r.name ?? '',
    comment: r.comment ?? undefined,
    coverArt: r.cover_art ?? undefined,
    songCount: r.song_count ?? 0,
    duration: r.duration ?? 0,
    owner: r.owner ?? undefined,
    public: r.public == null ? undefined : Boolean(r.public),
    created: r.created ? new Date(r.created) : undefined,
    changed: r.changed ? new Date(r.changed) : undefined,
  };
}

/** Keyset cursor for a playlist row (name A–Z). */
export const playlistCursorOf = (r: PlaylistListRow): Cursor => ({
  sortKey: r.sort_title ?? '',
  id: r.id,
});

export function upsertPlaylists(
  db: InternalDb,
  playlists: Playlist[],
  onProgress?: (done: number, total: number) => void,
  articles?: readonly string[],
): Promise<number> {
  return bulkUpsert(
    db,
    {
      table: 'playlists',
      idOf: (p) => p.id,
      rowOf: (p) => playlistRow(p, articles),
      children: [
        { table: 'playlist_allowed_users', parentCol: 'playlist_id', rows: playlistAllowedUserRows },
      ],
      onProgress,
    },
    playlists,
  );
}

/** Delete one playlist row (children cascade). */
export const deletePlaylist = (db: InternalDb, id: string): Promise<unknown> =>
  db.runAsync('DELETE FROM playlists WHERE id = ?', [id]);

/**
 * Prune playlists no longer on the server after a full fetch. Id sets pass as JSON
 * arrays via `json_each` to dodge the SQLite bound-variable limit — `NOT IN`, not the
 * `NOT EXISTS` favourites insists on, for the reason given at `disjointClause`
 * (`favorites.ts`): the ids arrive as a JS array, so the ephemeral b-tree SQLite builds
 * IS that list, and this runs once per full fetch rather than once per page read.
 *
 * An empty `keepIds` is REFUSED, not honoured: `getAllPlaylists` returns `[]` rather
 * than throwing whenever the API is unavailable (offline, mid-logout, before auth
 * restore), so an empty set means "couldn't ask" far more often than "the server has
 * none". The cost of refusing is that deleting every playlist server-side no longer
 * propagates until one is re-created; the cost of honouring it was wiping the user's
 * playlists — including downloaded ones — on any offline refresh.
 */
export const deletePlaylistsNotIn = (
  db: InternalDb,
  keepIds: string[],
  protectedIds: string[] = [],
): Promise<unknown> => {
  if (keepIds.length === 0) return Promise.resolve();
  return db.runAsync(
    'DELETE FROM playlists WHERE id NOT IN (SELECT value FROM json_each(?)) ' +
      'AND id NOT IN (SELECT value FROM json_each(?))',
    [JSON.stringify(keepIds), JSON.stringify(protectedIds)],
  );
};

/** Per-playlist detail-sync markers. Read BEFORE the list upsert; compared against the
 *  LIST envelope to decide whether a playlist's tracks need re-fetching. NULL = never
 *  fetched. See `reconcilePlaylistDetails`. */
export interface PlaylistDetailStateRow {
  id: string;
  detail_changed: number | null;
  detail_song_count: number | null;
}

export const listPlaylistDetailState = (db: InternalDb): Promise<PlaylistDetailStateRow[]> =>
  db.getAllAsync<PlaylistDetailStateRow>(
    'SELECT id, detail_changed, detail_song_count FROM playlists',
  );

/** Record that this playlist's tracks are current as of the LIST envelope's values.
 *  Only ever called after a genuine server round-trip — stamping on a cached/offline read
 *  would suppress the refetch permanently. */
export const stampPlaylistDetailSynced = (
  db: InternalDb,
  id: string,
  changedEpoch: number,
  songCount: number,
): Promise<unknown> =>
  db.runAsync('UPDATE playlists SET detail_changed = ?, detail_song_count = ? WHERE id = ?', [
    changedEpoch,
    songCount,
    id,
  ]);

/** Clear every marker so a full resync actually re-fetches membership — the resync
 *  overwrites rows in place rather than dropping them, so markers would otherwise survive
 *  and make the one manual repair the UI offers a no-op. */
export const clearPlaylistDetailMarkers = (db: InternalDb): Promise<unknown> =>
  db.runAsync('UPDATE playlists SET detail_changed = NULL, detail_song_count = NULL');

/** Keyset A–Z list of playlists (article-stripped `sort_title`), with letter seek —
 *  consistent with albums/songs/artists. */
export function listPlaylists(
  db: InternalDb,
  opts: { cursor?: Cursor | null; letter?: string | null; limit: number },
): Promise<Page<PlaylistListRow>> {
  return keysetPage<PlaylistListRow>(db, {
    table: 'playlists',
    sortCol: 'sort_title',
    columns: PLAYLIST_LIST_COLS,
    limit: opts.limit,
    cursor: opts.cursor,
    letter: opts.letter,
    sortKeyOf: (r) => r.sort_title ?? '',
  });
}

export function listPlaylistsBefore(
  db: InternalDb,
  opts: { before: Cursor; limit: number },
): Promise<{ rows: PlaylistListRow[]; prevCursor: Cursor | null }> {
  return keysetPageBefore<PlaylistListRow>(db, {
    table: 'playlists',
    sortCol: 'sort_title',
    columns: PLAYLIST_LIST_COLS,
    limit: opts.limit,
    before: opts.before,
    sortKeyOf: (r) => r.sort_title ?? '',
  });
}

export const countPlaylists = (db: InternalDb): Promise<number> => countRows(db, 'playlists');

/** Every playlist id — enumeration for callers such as the full-library download. */
export const listPlaylistIds = (db: InternalDb): Promise<string[]> =>
  db.getAllAsync<{ id: string }>('SELECT id FROM playlists').then((rows) => rows.map((r) => r.id));

/** The columns the whole-table browse read projects. Deliberately NOT
 *  `PlaylistListRow`: `listAllPlaylists` has no LIMIT and runs on the headless boot
 *  path and in the add-to-playlist sheet, neither of which reads anything past the
 *  name, artwork and track count. Its own type so a browse row can never be mistaken
 *  for a full playlist. */
export interface PlaylistBrowseRow {
  id: string;
  name: string | null;
  cover_art: string | null;
  song_count: number | null;
}

const PLAYLIST_BROWSE_COLS = colsOf<keyof PlaylistBrowseRow>([
  'id', 'name', 'cover_art', 'song_count',
]);

/** Adapt a browse row for the CarPlay/add-to-playlist consumers. Intentionally
 *  minimal — the required `Playlist` scalars past `songCount` are placeholders. */
export const playlistBrowseRowToPlaylist = (r: PlaylistBrowseRow): Playlist => ({
  id: r.id,
  name: r.name ?? '',
  coverArt: r.cover_art ?? undefined,
  songCount: r.song_count ?? 0,
  duration: 0,
});

/** Every playlist as a browse row, sort-title order — the CarPlay/headless browse, the
 *  voice vocabulary, and the add-to-playlist sheet. */
export const listAllPlaylists = (db: InternalDb): Promise<PlaylistBrowseRow[]> =>
  db.getAllAsync<PlaylistBrowseRow>(
    `SELECT ${PLAYLIST_BROWSE_COLS} FROM playlists ORDER BY sort_title, "id"`,
  );

/** Full rows for a set of playlist ids (unordered) — the downloaded set for offline
 *  search. Ids pass as a JSON array via `json_each`; empty id set → no rows. */
export const listPlaylistsByIds = (db: InternalDb, ids: string[]): Promise<PlaylistListRow[]> =>
  db.getAllAsync<PlaylistListRow>(
    `SELECT ${PLAYLIST_LIST_COLS} FROM playlists WHERE id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(ids)],
  );

export const getPlaylist = (db: InternalDb, id: string): Promise<Record<string, unknown> | null> =>
  db.getFirstAsync('SELECT * FROM playlists WHERE id = ?', [id]);

/** Replace a playlist's ordered song membership (position = array index). ONE atomic
 *  batch: a failure part-way leaves the previous membership rather than an empty
 *  playlist, which album/playlist detail would read as "cached, no tracks". */
export const setPlaylistSongs = (
  db: InternalDb,
  playlistId: string,
  songIds: string[],
): Promise<void> =>
  db.runAtomicBatchAsync([
    ['DELETE FROM playlist_songs WHERE playlist_id = ?', [playlistId]],
    ...songIds.map(
      (songId, position): BatchCommand => [
        'INSERT INTO playlist_songs (playlist_id, position, song_id) VALUES (?, ?, ?)',
        [playlistId, position, songId],
      ],
    ),
  ]);

/** Which of the given playlist ids already have their membership (≥1 track) in the
 *  normalized model — the "has detail cached" presence check for the downloaded-metadata
 *  refresh. Ids pass as a JSON array via `json_each` to dodge the bound-variable limit. */
export const playlistIdsWithSongs = (db: InternalDb, ids: string[]): Promise<Set<string>> =>
  ids.length === 0
    ? Promise.resolve(new Set<string>())
    : db
        .getAllAsync<{ playlist_id: string }>(
          'SELECT DISTINCT playlist_id FROM playlist_songs WHERE playlist_id IN (SELECT value FROM json_each(?))',
          [JSON.stringify(ids)],
        )
        .then((rows) => new Set(rows.map((r) => r.playlist_id)));
