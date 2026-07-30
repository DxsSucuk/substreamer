/** Playlists repository: bulk upsert (row + allowed users), list, count, by-id,
 *  and the ordered `playlist_songs` membership junction. */
import type { Playlist } from 'subsonic-api';

import type { InternalDb } from '../client';
import { playlistAllowedUserRows, playlistRow } from './mappers';
import { bulkUpsert, countRows, keysetPage, keysetPageBefore, type Cursor, type Page } from './core';

/** Lean projection for list rendering (the fields PlaylistRow/PlaylistCard read:
 *  name, cover art, song count, duration). `owner` is carried so offline search can
 *  render a downloaded playlist as an album row with its owner on the artist line
 *  (AlbumRow shows `artist ?? unknownArtist`). */
export interface PlaylistListRow {
  id: string;
  name: string | null;
  cover_art: string | null;
  song_count: number | null;
  duration: number | null;
  owner: string | null;
  sort_title: string | null;
}

const PLAYLIST_LIST_COLS =
  '"id", "name", "cover_art", "song_count", "duration", "owner", "sort_title"';

/** Adapt a lean row to the `Playlist` shape the row/card components render.
 *  Required scalars get harmless defaults (list rows never show created/changed). */
export function playlistListRowToPlaylist(r: PlaylistListRow): Playlist {
  return {
    id: r.id,
    name: r.name ?? '',
    coverArt: r.cover_art ?? undefined,
    songCount: r.song_count ?? 0,
    duration: r.duration ?? 0,
    owner: r.owner ?? undefined,
    created: new Date(0),
    changed: new Date(0),
  } as Playlist;
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
 * arrays via `json_each` to dodge the SQLite bound-variable limit.
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

/** All playlist lean rows, sort-title order — the normalized replacement for reading
 *  `playlistLibraryStore.playlists` (CarPlay/headless browse + voice vocabulary). */
/** Every playlist id — the normalized replacement for enumerating
 *  `playlistLibraryStore.playlists` (e.g. the full-library download). */
export const listPlaylistIds = (db: InternalDb): Promise<string[]> =>
  db.getAllAsync<{ id: string }>('SELECT id FROM playlists').then((rows) => rows.map((r) => r.id));

export const listAllPlaylists = (db: InternalDb): Promise<PlaylistListRow[]> =>
  db.getAllAsync<PlaylistListRow>(`SELECT ${PLAYLIST_LIST_COLS} FROM playlists ORDER BY sort_title, "id"`);

/** Lean rows for a set of playlist ids (unordered) — the downloaded set for offline
 *  search. Ids pass as a JSON array via `json_each`; empty id set → no rows. */
export const listPlaylistsByIds = (db: InternalDb, ids: string[]): Promise<PlaylistListRow[]> =>
  db.getAllAsync<PlaylistListRow>(
    `SELECT ${PLAYLIST_LIST_COLS} FROM playlists WHERE id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(ids)],
  );

export const getPlaylist = (db: InternalDb, id: string): Promise<Record<string, unknown> | null> =>
  db.getFirstAsync('SELECT * FROM playlists WHERE id = ?', [id]);

/** Replace a playlist's ordered song membership (position = array index). */
export function setPlaylistSongs(db: InternalDb, playlistId: string, songIds: string[]): void {
  db.withTransactionSync(() => {
    db.runSync('DELETE FROM playlist_songs WHERE playlist_id = ?', [playlistId]);
    songIds.forEach((songId, position) => {
      db.runSync('INSERT INTO playlist_songs (playlist_id, position, song_id) VALUES (?, ?, ?)', [
        playlistId,
        position,
        songId,
      ]);
    });
  });
}

/** Ordered song ids for a playlist (junction rows, in position order). */
export const listPlaylistSongIds = (db: InternalDb, playlistId: string): Promise<string[]> =>
  db
    .getAllAsync<{ song_id: string }>(
      'SELECT song_id FROM playlist_songs WHERE playlist_id = ? ORDER BY position',
      [playlistId],
    )
    .then((rows) => rows.map((r) => r.song_id));

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
