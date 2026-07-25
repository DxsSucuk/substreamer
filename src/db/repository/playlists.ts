/** Playlists repository: bulk upsert (row + allowed users), list, count, by-id,
 *  and the ordered `playlist_songs` membership junction. */
import type { Playlist } from 'subsonic-api';

import type { InternalDb } from '../client';
import { playlistAllowedUserRows, playlistRow } from './mappers';
import { bulkUpsert, countRows, keysetPage, type Cursor, type Page } from './core';

/** Lean projection for list rendering. */
export interface PlaylistListRow {
  id: string;
  name: string | null;
  comment: string | null;
  cover_art: string | null;
  song_count: number | null;
  owner: string | null;
}

const PLAYLIST_LIST_COLS = '"id", "name", "comment", "cover_art", "song_count", "owner"';

export function upsertPlaylists(
  db: InternalDb,
  playlists: Playlist[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  return bulkUpsert(
    db,
    {
      table: 'playlists',
      idOf: (p) => p.id,
      rowOf: playlistRow,
      children: [
        { table: 'playlist_allowed_users', parentCol: 'playlist_id', rows: playlistAllowedUserRows },
      ],
      onProgress,
    },
    playlists,
  );
}

/**
 * Keyset list of playlists ordered by name. (No A–Z letter seek: playlists have
 * no folded sort key and there are few of them, so plain cursor paging suffices.)
 */
export function listPlaylists(
  db: InternalDb,
  opts: { cursor?: Cursor | null; limit: number },
): Promise<Page<PlaylistListRow>> {
  return keysetPage<PlaylistListRow>(db, {
    table: 'playlists',
    sortCol: 'name',
    columns: PLAYLIST_LIST_COLS,
    limit: opts.limit,
    cursor: opts.cursor,
    sortKeyOf: (r) => r.name ?? '',
  });
}

export const countPlaylists = (db: InternalDb): Promise<number> => countRows(db, 'playlists');

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
