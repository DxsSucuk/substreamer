/**
 * Per-row SQLite persistence for `albumDetailStore` and `songIndexStore` —
 * query helpers only. The shared handle, PRAGMAs, schema, health reporting,
 * and test injection live in `./db.ts`.
 */
import type { AlbumWithSongsID3, Child } from '../../services/subsonicService';
import { normalize, normalizeArtist, metaphoneKey } from '../../services/searchMatch';
import { writeAlbumDetailToNormalized, writeSongsToNormalized } from '../../db/normalizedSyncWriter';

import { getDb, serializeDbWrite } from './db';

/**
 * The four fuzzy-search column values for a `song_index` row, in column order:
 * `norm_title`, `norm_artist`, `dmeta_title`, `dmeta_artist`. Populated at every
 * write path so candidate SQL runs without a re-sync. Empty/non-Latin input
 * yields '' — never matched at lookup. See `searchMatch.ts`.
 */
function songSearchCols(s: Child): [string, string, string, string] {
  const title = s.title ?? '';
  const artist = s.artist ?? '';
  return [normalize(title), normalizeArtist(artist), metaphoneKey(title), metaphoneKey(artist)];
}

/* ------------------------------------------------------------------ */
/*  album_details                                                      */
/* ------------------------------------------------------------------ */

/**
 * Read every album detail row into a Record shaped like the pre-migration
 * in-memory state. Used once on app start to hydrate `albumDetailStore`.
 */
export function hydrateAlbumDetails(): Record<string, { album: AlbumWithSongsID3; retrievedAt: number }> {
  const db = getDb();
  if (db === null) return {};
  try {
    const rows = db.getAllSync<{ id: string; json: string; retrievedAt: number }>(
      'SELECT id, json, retrievedAt FROM album_details;',
    );
    const out: Record<string, { album: AlbumWithSongsID3; retrievedAt: number }> = {};
    for (const row of rows) {
      try {
        const album = JSON.parse(row.json) as AlbumWithSongsID3;
        out[row.id] = { album, retrievedAt: row.retrievedAt };
      } catch {
        /* skip unparseable row */
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Album rows parsed per macrotask yield. Each `json` blob is 50-200KB, so
 * a small chunk keeps any single tick short. */
const ALBUM_DETAIL_PARSE_CHUNK = 50;

/**
 * Async counterpart of {@link hydrateAlbumDetails}. The read runs on
 * expo-sqlite's background thread (`getAllAsync`) and the per-row
 * `JSON.parse` of each (large) album envelope is chunked with `setTimeout(0)`
 * yields so a big detail cache doesn't freeze the JS thread at boot. Used by
 * `albumDetailStore.hydrateFromDbAsync`. setTimeout, not rAF — rAF can stall
 * on RN 0.85/Fabric.
 */
export async function hydrateAlbumDetailsAsync(): Promise<
  Record<string, { album: AlbumWithSongsID3; retrievedAt: number }>
> {
  const db = getDb();
  if (db === null) return {};
  try {
    const rows = await db.getAllAsync<{ id: string; json: string; retrievedAt: number }>(
      'SELECT id, json, retrievedAt FROM album_details;',
    );
    const out: Record<string, { album: AlbumWithSongsID3; retrievedAt: number }> = {};
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const album = JSON.parse(row.json) as AlbumWithSongsID3;
        out[row.id] = { album, retrievedAt: row.retrievedAt };
      } catch {
        /* skip unparseable row */
      }
      if (i > 0 && i % ALBUM_DETAIL_PARSE_CHUNK === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Insert-or-replace a single album detail row. */
export function upsertAlbumDetail(id: string, album: AlbumWithSongsID3, retrievedAt: number): void {
  const db = getDb();
  if (db === null) return;
  try {
    db.runSync(
      'INSERT OR REPLACE INTO album_details (id, json, retrievedAt) VALUES (?, ?, ?);',
      [id, JSON.stringify(album), retrievedAt],
    );
  } catch {
    /* dropped */
  }
  void serializeSongIndexWrite(() => writeAlbumDetailToNormalized(db, album));
}

/**
 * Async counterpart of {@link upsertAlbumDetail}. The album envelope is
 * 50-200KB, so the write IO runs off the JS thread (`runAsync`). Used by the
 * interactive paths (`albumDetailStore.fetchAlbum` on album-open and
 * `applyLocalPlay` on every track play) where the in-memory state is set
 * first, so the disk write is fire-and-forget. (`JSON.stringify` still runs on
 * the JS thread — unavoidable for JSON storage — but the blocking IO does not.)
 */
export async function upsertAlbumDetailAsync(
  id: string,
  album: AlbumWithSongsID3,
  retrievedAt: number,
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.runAsync(
      'INSERT OR REPLACE INTO album_details (id, json, retrievedAt) VALUES (?, ?, ?);',
      [id, JSON.stringify(album), retrievedAt],
    );
  } catch {
    /* dropped */
  }
  // Dual-write the album row + its songs into the normalized tables (serialized on
  // the shared mutex so its transaction never overlaps a blob-write transaction).
  await serializeSongIndexWrite(() => writeAlbumDetailToNormalized(db, album));
}

/** Remove a single album detail row AND the associated song_index rows. */
export async function deleteAlbumDetail(id: string): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeSongIndexWrite(() =>
      db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM album_details WHERE id = ?;', [id]);
        await db.runAsync('DELETE FROM song_index WHERE albumId = ?;', [id]);
      }),
    );
  } catch {
    /* dropped */
  }
}

/** Remove every row from both tables. Used on logout / force-resync. */
export async function clearDetailTables(): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeSongIndexWrite(() =>
      db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM album_details;');
        await db.runAsync('DELETE FROM song_index;');
      }),
    );
  } catch {
    /* dropped */
  }
}

/* ------------------------------------------------------------------ */
/*  song_index                                                         */
/* ------------------------------------------------------------------ */

/**
 * Replace every song row for a given album with the provided list. Used
 * whenever `fetchAlbum` succeeds so the flat index stays in sync.
 * Runs in a single transaction for efficiency.
 */
export function upsertSongsForAlbum(albumId: string, songs: Child[]): void {
  const db = getDb();
  if (db === null) return;
  try {
    db.withTransactionSync(() => {
      // Drop whatever was associated with this album so retagged/reordered
      // songs don't leave orphans.
      db.runSync('DELETE FROM song_index WHERE albumId = ?;', [albumId]);
      for (const song of songs) {
        if (!song.id) continue;
        db.runSync(
          `INSERT OR REPLACE INTO song_index
             (id, albumId, title, artist, album, duration, coverArt, userRating, starred, year, track, disc, raw_json, norm_title, norm_artist, dmeta_title, dmeta_artist)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            song.id,
            albumId,
            song.title ?? null,
            song.artist ?? null,
            song.album ?? null,
            song.duration ?? null,
            song.coverArt ?? null,
            song.userRating ?? null,
            song.starred ? 1 : 0,
            song.year ?? null,
            song.track ?? null,
            song.discNumber ?? null,
            JSON.stringify(song),
            ...songSearchCols(song),
          ],
        );
      }
    });
  } catch {
    /* dropped */
  }
  void serializeSongIndexWrite(() => writeSongsToNormalized(db, songs));
}

/**
 * Async counterpart of {@link upsertSongsForAlbum}. The DELETE + N INSERTs run
 * in one `withTransactionAsync` on expo-sqlite's background thread, so a large
 * album's song-index write doesn't block the JS thread on album-open. Used by
 * `songIndexStore.upsertSongsForAlbum` (fire-and-forget after the in-memory
 * patch). Atomic, like the sync version.
 */
/**
 * Serialize song_index async transactions through the connection-wide mutex.
 * expo-sqlite's `withTransactionAsync` is NOT exclusive — concurrent async
 * transactions on the shared connection interleave BEGIN/COMMIT (Android rejects
 * the nested BEGIN; iOS tolerates it). song_index, album_details, and
 * library_albums all share ONE connection, so they must share ONE chain — see
 * `serializeDbWrite` in ./db. (Kept as a named alias so the intent reads locally
 * at each call site.)
 */
const serializeSongIndexWrite = serializeDbWrite;

export async function upsertSongsForAlbumAsync(albumId: string, songs: Child[]): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeSongIndexWrite(() =>
      db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM song_index WHERE albumId = ?;', [albumId]);
        for (const song of songs) {
          if (!song.id) continue;
          // eslint-disable-next-line no-await-in-loop
          await db.runAsync(
            `INSERT OR REPLACE INTO song_index
               (id, albumId, title, artist, album, duration, coverArt, userRating, starred, year, track, disc, raw_json, norm_title, norm_artist, dmeta_title, dmeta_artist)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [
              song.id,
              albumId,
              song.title ?? null,
              song.artist ?? null,
              song.album ?? null,
              song.duration ?? null,
              song.coverArt ?? null,
              song.userRating ?? null,
              song.starred ? 1 : 0,
              song.year ?? null,
              song.track ?? null,
              song.discNumber ?? null,
              JSON.stringify(song),
              ...songSearchCols(song),
            ],
          );
        }
      }),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[detailTables] upsertSongsForAlbumAsync failed albumId=' + albumId, e);
  }
  await serializeSongIndexWrite(() => writeSongsToNormalized(db, songs));
}

/**
 * Persist an album's detail row AND its song-index rows in ONE transaction
 * (serialized on the same mutex as other song_index writes). The detail row
 * exists **iff** its songs are persisted — so a crash mid-write can never leave
 * a half-persisted album (a stuck "detailed but song-less" state that the walk
 * would treat as done). The detail row's presence is the crash-safe "walk done"
 * marker. Replaces the previous two separate writes (`upsertAlbumDetailAsync` +
 * `upsertSongsForAlbumAsync`) on the album-fetch / walk path. An empty album (0
 * songs) commits atomically = complete (not falsely broken).
 */
export async function persistAlbumDetailAndSongsAsync(
  id: string,
  album: AlbumWithSongsID3,
  retrievedAt: number,
): Promise<number> {
  const db = getDb();
  if (db === null) return 0;
  const songs = album.song ?? [];
  // Net change to the song_index row count = rows inserted − rows the DELETE
  // removed. Lets callers keep a running total without a `SELECT COUNT(*)` per
  // album (which was O(n) on a growing table → O(n²) over a full sync). For a
  // fresh walk album the DELETE removes nothing, so this is just "songs written".
  let delta = 0;
  try {
    await serializeSongIndexWrite(() =>
      db.withTransactionAsync(async () => {
        await db.runAsync(
          'INSERT OR REPLACE INTO album_details (id, json, retrievedAt) VALUES (?, ?, ?);',
          [id, JSON.stringify(album), retrievedAt],
        );
        const del = await db.runAsync('DELETE FROM song_index WHERE albumId = ?;', [id]);
        let inserted = 0;
        for (const song of songs) {
          if (!song.id) continue;
          // eslint-disable-next-line no-await-in-loop
          await db.runAsync(
            `INSERT OR REPLACE INTO song_index
               (id, albumId, title, artist, album, duration, coverArt, userRating, starred, year, track, disc, raw_json, norm_title, norm_artist, dmeta_title, dmeta_artist)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [
              song.id,
              id,
              song.title ?? null,
              song.artist ?? null,
              song.album ?? null,
              song.duration ?? null,
              song.coverArt ?? null,
              song.userRating ?? null,
              song.starred ? 1 : 0,
              song.year ?? null,
              song.track ?? null,
              song.discNumber ?? null,
              JSON.stringify(song),
              ...songSearchCols(song),
            ],
          );
          inserted += 1;
        }
        delta = inserted - (del.changes ?? 0);
      }),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[detailTables] persistAlbumDetailAndSongsAsync failed id=' + id, e);
    return 0;
  }
  return delta;
}

/**
 * Bulk `INSERT OR REPLACE` a page of songs into `song_index` (the fast paged
 * `search3` sync). One transaction (via the mutex) with chunked multi-row
 * INSERTs (~500 rows/statement). No leading DELETE — pages accumulate by song
 * id; removals are handled by the album-removal reap, and a force-resync clears
 * the table first. Skips rows without `id`/`albumId` (the caller guards that
 * `albumId` is populated before choosing this path). Returns the number of rows
 * written (for the running `totalCount`, no `SELECT COUNT(*)`).
 */
export async function bulkUpsertSongs(songs: readonly Child[]): Promise<number> {
  const db = getDb();
  if (db === null) return 0;
  const valid = songs.filter((s) => s.id && s.albumId);
  if (valid.length === 0) return 0;
  const COLS = 17;
  const CHUNK = 500;
  try {
    await serializeSongIndexWrite(() =>
      db.withTransactionAsync(async () => {
        for (let i = 0; i < valid.length; i += CHUNK) {
          const batch = valid.slice(i, i + CHUNK);
          const rowPlaceholder = `(${Array(COLS).fill('?').join(', ')})`;
          const placeholders = batch.map(() => rowPlaceholder).join(', ');
          const params: unknown[] = [];
          for (const s of batch) {
            params.push(
              s.id,
              s.albumId,
              s.title ?? null,
              s.artist ?? null,
              s.album ?? null,
              s.duration ?? null,
              s.coverArt ?? null,
              s.userRating ?? null,
              s.starred ? 1 : 0,
              s.year ?? null,
              s.track ?? null,
              s.discNumber ?? null,
              JSON.stringify(s),
              ...songSearchCols(s),
            );
          }
          // eslint-disable-next-line no-await-in-loop
          await db.runAsync(
            `INSERT OR REPLACE INTO song_index
               (id, albumId, title, artist, album, duration, coverArt, userRating, starred, year, track, disc, raw_json, norm_title, norm_artist, dmeta_title, dmeta_artist)
               VALUES ${placeholders};`,
            params,
          );
        }
      }),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[detailTables] bulkUpsertSongs failed', e);
    return 0;
  }
  // NB: NO inline normalized dual-write on this bulk fast-sync path. Deriving norm/
  // dmeta for every page here doubles the JS-thread work and holding pages for a
  // deferred write would blow memory at 200k. The normalized tables are populated
  // off this critical path by the background drift migration instead.
  return valid.length;
}

/** Remove song_index rows for a set of album IDs — DELETEs run on the background
 * thread in one transaction. Used by `songIndexStore` orphan reaping. */
export async function deleteSongsForAlbumsAsync(albumIds: readonly string[]): Promise<void> {
  const db = getDb();
  if (db === null || albumIds.length === 0) return;
  try {
    await serializeSongIndexWrite(() =>
      db.withTransactionAsync(async () => {
        for (const id of albumIds) {
          // eslint-disable-next-line no-await-in-loop
          await db.runAsync('DELETE FROM song_index WHERE albumId = ?;', [id]);
        }
      }),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[detailTables] deleteSongsForAlbumsAsync failed', e);
  }
}

/** Return the total song-index row count — runs the COUNT on the background
 * thread. Used by settings / diagnostics + the boot hydration path. */
export async function countSongIndexAsync(): Promise<number> {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM song_index;');
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Count of DISTINCT albums with at least one row in `song_index` — the
 * "albums whose songs we have processed" numerator for song-sync progress
 * (over the total album count). Uses the `albumId` index (no table scan).
 * Resumable by nature: derived from the persisted `song_index`, not memory.
 */
export async function countAlbumsWithSongsAsync(): Promise<number> {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(DISTINCT albumId) AS n FROM song_index;',
    );
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

interface SongIndexRow {
  id: string;
  albumId: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;
  coverArt: string | null;
  userRating: number | null;
  starred: number | null;
  year: number | null;
  track: number | null;
  disc: number | null;
  /** Full serialized Subsonic `Child` envelope. Null only for rows written
   * before the column existed (pre-backfill). */
  raw_json: string | null;
}

interface SongsByTitleOpts {
  downloadedOnly?: boolean;
  favoritesOnly?: boolean;
}

/** Build the songs-library SELECT, honoring the downloaded/favorites filters. */
function buildSongsByTitleSql(opts: SongsByTitleOpts): string {
  const useJoin = opts.downloadedOnly === true;
  const wantFavorites = opts.favoritesOnly === true;
  const prefix = useJoin ? 's.' : '';
  return (
    `SELECT ${prefix}id AS id, ${prefix}albumId AS albumId, ${prefix}title AS title,` +
    ` ${prefix}artist AS artist, ${prefix}album AS album,` +
    ` ${prefix}duration AS duration, ${prefix}coverArt AS coverArt,` +
    ` ${prefix}userRating AS userRating, ${prefix}starred AS starred, ${prefix}year AS year,` +
    ` ${prefix}track AS track, ${prefix}disc AS disc, ${prefix}raw_json AS raw_json` +
    ` FROM song_index${useJoin ? ' s INNER JOIN cached_songs c ON c.song_id = s.id' : ''}` +
    (wantFavorites ? ` WHERE ${prefix}starred = 1` : '') +
    ` ORDER BY (${prefix}title IS NULL), lower(${prefix}title), ${prefix}id;`
  );
}

/**
 * Map one `song_index` row to the `Child` used by the library list.
 *
 * Prefer the full stored envelope (`raw_json`) so the songs list returns the
 * real server `Child` with ALL metadata (artistId, genre, format, ReplayGain,
 * contributors, MusicBrainz ids, …) — not a reconstruction that silently drops
 * fields. Falls back to the indexed columns only for legacy rows written
 * before `raw_json` existed (until the backfill migration / next album fetch).
 */
function mapSongRow(r: SongIndexRow): Child {
  if (r.raw_json) {
    try {
      return JSON.parse(r.raw_json) as Child;
    } catch {
      /* fall through to the column-reconstructed Child */
    }
  }
  return {
    id: r.id,
    albumId: r.albumId,
    title: r.title ?? '',
    artist: r.artist ?? undefined,
    album: r.album ?? undefined,
    duration: r.duration ?? undefined,
    coverArt: r.coverArt ?? undefined,
    userRating: r.userRating ?? undefined,
    starred: r.starred ? new Date(0) : undefined,
    year: r.year ?? undefined,
    track: r.track ?? undefined,
    discNumber: r.disc ?? undefined,
    isDir: false,
  } as Child;
}

/** Rows mapped per macrotask yield, keeping the JS thread responsive. */
const SONG_MAP_CHUNK = 2000;

/**
 * Read every song row sorted alphabetically by title (case-insensitive), with
 * optional downloadedOnly / favoritesOnly filters. Used by the Songs library
 * segment. Backed by `idx_song_index_title` so the sort is free; NULL titles
 * sort to the end and `id` is the stable tie-breaker.
 *
 * The SQLite read runs on expo-sqlite's background thread (`getAllAsync`), and
 * the JS row→`Child` mapping is chunked with `setTimeout(0)` yields so neither
 * stage blocks the JS thread for long — even on a large library.
 */
export async function fetchAllSongsByTitleAsync(
  opts: SongsByTitleOpts = {},
): Promise<Child[]> {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = await db.getAllAsync<SongIndexRow>(buildSongsByTitleSql(opts));
    const out: Child[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      out[i] = mapSongRow(rows[i]);
      if (i > 0 && i % SONG_MAP_CHUNK === 0) {
        // Yield to the event loop so touches/animations aren't starved.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Read every (song_id, album_id) pair from the song_index table. Used by
 * migration task #14 to resolve a song's parent album without relying on
 * the blob/store hydration path. Returns an empty map if the DB is
 * unavailable or the table is empty.
 */
export function getAllSongAlbumIds(): Map<string, string> {
  const out = new Map<string, string>();
  const db = getDb();
  if (db === null) return out;
  try {
    const rows = db.getAllSync<{ id: string; albumId: string }>(
      'SELECT id, albumId FROM song_index;',
    );
    for (const row of rows) {
      if (row.id && row.albumId) out.set(row.id, row.albumId);
    }
  } catch {
    /* return whatever we collected */
  }
  return out;
}

/**
 * The set of album ids that have a persisted detail row — the detail walk's
 * completion signal. Lean (`SELECT id` only), so it scales to a 100k library
 * without parsing every envelope. The walk computes `missing = libraryIds − this`
 * from disk truth instead of the in-memory `albumDetailStore.albums` map, so it
 * never re-walks already-detailed albums even if that map isn't hydrated.
 */
export async function getDetailedAlbumIdsAsync(): Promise<Set<string>> {
  const db = getDb();
  if (db === null) return new Set();
  try {
    const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM album_details;');
    const out = new Set<string>();
    for (const r of rows) out.add(r.id);
    return out;
  } catch {
    return new Set();
  }
}
