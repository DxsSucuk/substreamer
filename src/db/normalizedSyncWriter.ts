/**
 * Dual-write bridge. As the library sync + detail fetches land data in the legacy
 * blob tables (`library_albums`, `song_index`, `album_details`), these ALSO upsert it
 * into the normalized tables so the new model stays fresh — not merely seeded by the
 * one-time migration. A re-sync therefore keeps normalized in step (which is also why
 * the migration's drift check settles to a no-op).
 *
 * BEST-EFFORT: a normalized-write failure must NEVER break the blob write or the
 * sync — every call is wrapped, logged, and swallowed. Bounded memory: it reuses the
 * same page array the blob write already holds; the repository chunks + writes off
 * the JS thread. Once consumers read from the normalized tables and the blob tables
 * are dropped, the blob writes go away and these become the sole writes.
 */
import type { AlbumID3, AlbumWithSongsID3, ArtistID3, ArtistInfo2, Child, Playlist } from 'subsonic-api';

import type { InternalDb } from './client';
import { upsertAlbums } from './repository/albums';
import { setArtistDetailMeta, setArtistTopSongs, upsertArtistInfo, upsertArtists } from './repository/artists';
import { setPlaylistSongs, upsertPlaylists } from './repository/playlists';
import { upsertSongs } from './repository/songs';
import { getSortArticles } from './sortArticles';

const warn = (where: string, e: unknown): void => {
  // eslint-disable-next-line no-console
  console.warn(`[normalizedSyncWriter] ${where} failed`, e);
};

/** Effective ignored-article list (server's, else local default) for sort keys —
 *  read from the dependency-free mirror to avoid a store-import require cycle. */
const articles = (): readonly string[] | undefined => getSortArticles();

/** Album-list / incremental album pages → the `albums` table (+ children). */
export async function writeAlbumsToNormalized(db: InternalDb, albums: readonly AlbumID3[]): Promise<void> {
  if (albums.length === 0) return;
  try {
    await upsertAlbums(db, albums as AlbumID3[], undefined, articles());
  } catch (e) {
    warn('writeAlbums', e);
  }
}

/** Song pages (fast-path sync, album-referenced) → the `songs` table (+ children). */
export async function writeSongsToNormalized(db: InternalDb, songs: readonly Child[]): Promise<void> {
  if (songs.length === 0) return;
  try {
    await upsertSongs(db, songs as Child[], undefined, articles());
  } catch (e) {
    warn('writeSongs', e);
  }
}

/** Album detail (`getAlbum` → AlbumWithSongsID3): the album row + its songs. */
export async function writeAlbumDetailToNormalized(db: InternalDb, album: AlbumWithSongsID3): Promise<void> {
  try {
    await upsertAlbums(db, [album], undefined, articles());
    if (album.song && album.song.length > 0) await upsertSongs(db, album.song, undefined, articles());
  } catch (e) {
    warn('writeAlbumDetail', e);
  }
}

/** The resolved artist-detail extras the store computes on fetch — the FINAL biography
 *  (Subsonic → MusicBrainz fallback, not necessarily `info.biography`), the MBID actually
 *  used, the negative-cache marker, and the getTopSongs list. */
export interface ArtistDetailExtras {
  biography: string | null;
  resolvedMbid: string | null;
  bioCheckedAt: number | null;
  topSongs: readonly Child[];
}

/** Artist detail (getArtist + getArtistInfo2 + resolved bio/topSongs): the artist row +
 *  albums + images/similar + the RESOLVED bio meta + persisted top songs. */
export async function writeArtistDetailToNormalized(
  db: InternalDb,
  artist: ArtistID3 & { album?: AlbumID3[] },
  info: ArtistInfo2 | null,
  extras: ArtistDetailExtras,
): Promise<void> {
  try {
    await upsertArtists(db, [artist], undefined, articles());
    // The artist's albums (from getArtist) — upsert so the detail grid's
    // `albums WHERE artist_id` resolves even before a full library sync.
    if (artist.album && artist.album.length > 0) await upsertAlbums(db, artist.album, undefined, articles());
    // Images + similar artists (+ server bio, immediately overridden below).
    if (info) upsertArtistInfo(db, artist.id, info);
    // Persist the top songs (upsert the rows, then the ordered junction).
    const top = extras.topSongs;
    if (top.length > 0) await upsertSongs(db, top as Child[], undefined, articles());
    await setArtistTopSongs(
      db,
      artist.id,
      top.map((s) => s.id),
    );
    // RESOLVED bio + negative-cache marker last, so it wins over info.biography.
    await setArtistDetailMeta(db, artist.id, {
      biography: extras.biography,
      bioCheckedAt: extras.bioCheckedAt,
      resolvedMbid: extras.resolvedMbid,
    });
  } catch (e) {
    warn('writeArtistDetail', e);
  }
}

/** Playlist detail (getPlaylist → Playlist + entry): the row + member songs + ordered
 *  membership. Upserts the entry songs first so the `playlist_songs JOIN songs` read in
 *  `getPlaylistDetail` resolves (a playlist may hold songs not otherwise synced). */
export async function writePlaylistDetailToNormalized(
  db: InternalDb,
  playlist: Playlist & { entry?: Child[] },
): Promise<void> {
  try {
    await upsertPlaylists(db, [playlist], undefined, articles());
    const entry = playlist.entry ?? [];
    if (entry.length > 0) await upsertSongs(db, entry, undefined, articles());
    setPlaylistSongs(
      db,
      playlist.id,
      entry.map((e) => e.id),
    );
  } catch (e) {
    warn('writePlaylistDetail', e);
  }
}
