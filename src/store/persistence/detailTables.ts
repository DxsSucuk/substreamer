/**
 * Per-row SQLite persistence for `albumDetailStore` and `songIndexStore` —
 * query helpers only. The shared handle, PRAGMAs, schema, health reporting,
 * and test injection live in `./db.ts`.
 */
import type { AlbumWithSongsID3, Child } from '../../services/subsonicService';

import { getDb } from './db';

export interface AlbumDetailEntryRow {
  id: string;
  album: AlbumWithSongsID3;
  retrievedAt: number;
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
}

/** Remove a single album detail row AND the associated song_index rows. */
export function deleteAlbumDetail(id: string): void {
  const db = getDb();
  if (db === null) return;
  try {
    db.withTransactionSync(() => {
      db.runSync('DELETE FROM album_details WHERE id = ?;', [id]);
      db.runSync('DELETE FROM song_index WHERE albumId = ?;', [id]);
    });
  } catch {
    /* dropped */
  }
}

/** Remove every row from both tables. Used on logout / force-resync. */
export function clearDetailTables(): void {
  const db = getDb();
  if (db === null) return;
  try {
    db.withTransactionSync(() => {
      db.runSync('DELETE FROM album_details;');
      db.runSync('DELETE FROM song_index;');
    });
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
             (id, albumId, title, artist, album, duration, coverArt, userRating, starred, year, track, disc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
          ],
        );
      }
    });
  } catch {
    /* dropped */
  }
}

/**
 * Async counterpart of {@link upsertSongsForAlbum}. The DELETE + N INSERTs run
 * in one `withTransactionAsync` on expo-sqlite's background thread, so a large
 * album's song-index write doesn't block the JS thread on album-open. Used by
 * `songIndexStore.upsertSongsForAlbum` (fire-and-forget after the in-memory
 * patch). Atomic, like the sync version.
 */
export async function upsertSongsForAlbumAsync(albumId: string, songs: Child[]): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM song_index WHERE albumId = ?;', [albumId]);
      for (const song of songs) {
        if (!song.id) continue;
        // eslint-disable-next-line no-await-in-loop
        await db.runAsync(
          `INSERT OR REPLACE INTO song_index
             (id, albumId, title, artist, album, duration, coverArt, userRating, starred, year, track, disc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
          ],
        );
      }
    });
  } catch {
    /* dropped */
  }
}

/** Remove song_index rows for a set of album IDs. Used by orphan reaping. */
export function deleteSongsForAlbums(albumIds: readonly string[]): void {
  const db = getDb();
  if (db === null || albumIds.length === 0) return;
  try {
    db.withTransactionSync(() => {
      for (const id of albumIds) {
        db.runSync('DELETE FROM song_index WHERE albumId = ?;', [id]);
      }
    });
  } catch {
    /* dropped */
  }
}

/** Async counterpart of {@link deleteSongsForAlbums} — DELETEs run on the
 * background thread in one transaction. Used by `songIndexStore` reaping. */
export async function deleteSongsForAlbumsAsync(albumIds: readonly string[]): Promise<void> {
  const db = getDb();
  if (db === null || albumIds.length === 0) return;
  try {
    await db.withTransactionAsync(async () => {
      for (const id of albumIds) {
        // eslint-disable-next-line no-await-in-loop
        await db.runAsync('DELETE FROM song_index WHERE albumId = ?;', [id]);
      }
    });
  } catch {
    /* dropped */
  }
}

/** Return the total song-index row count. Used by settings / diagnostics. */
export function countSongIndex(): number {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = db.getFirstSync<{ c: number }>('SELECT COUNT(*) AS c FROM song_index;');
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/** Async counterpart of {@link countSongIndex} — runs the COUNT on the
 * background thread for the boot hydration path. */
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
    ` ${prefix}track AS track, ${prefix}disc AS disc` +
    ` FROM song_index${useJoin ? ' s INNER JOIN cached_songs c ON c.song_id = s.id' : ''}` +
    (wantFavorites ? ` WHERE ${prefix}starred = 1` : '') +
    ` ORDER BY (${prefix}title IS NULL), lower(${prefix}title), ${prefix}id;`
  );
}

/** Map one `song_index` row to the `Child` shape used by the library list. */
function mapSongRow(r: SongIndexRow): Child {
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

/** Return the total album_details row count. */
export function countAlbumDetails(): number {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = db.getFirstSync<{ c: number }>('SELECT COUNT(*) AS c FROM album_details;');
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}
