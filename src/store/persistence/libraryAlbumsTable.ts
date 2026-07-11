/**
 * Per-row SQLite persistence for the lean album-browse LIST
 * (`albumLibraryStore`). Query helpers only — the shared handle, PRAGMAs,
 * schema (`library_albums`), health reporting, and test injection live in
 * `./db.ts`.
 *
 * Replaces the old `substreamer-album-library` KV blob: the paginated
 * album-list sync writes one page at a time via {@link upsertLibraryAlbumsAsync}
 * so a very large library persists progressively (no monolithic blob that fails
 * at ~100k) and resumes across restarts from `COUNT(*)`. `raw_json` holds the
 * full `AlbumID3` envelope (repo convention — never drop fields); the other
 * columns are hot paths only (`sortKey` for ordered hydration; `starred` /
 * `userRating` so ratings reconcile without parsing every blob).
 */
import type { AlbumID3 } from '../../services/subsonicService';

import { getDb } from './db';

/** How the caller derives the stored sort key for a row. Passed in (not
 *  computed here) so this table module doesn't import the stores that own the
 *  sort preference / ignored-articles list. */
export type LibraryAlbumSortKeyFn = (album: AlbumID3) => string;

/**
 * Serialize `library_albums` async transactions. expo-sqlite's
 * `withTransactionAsync` is NOT exclusive on the shared connection — concurrent
 * calls interleave BEGIN/COMMIT and can torn-commit or drop a batch. The
 * progressive pager, change-detection `upsertAlbums`, and `applyLocalPlay` can
 * all write concurrently, so a promise-chain mutex keeps at most one
 * transaction in flight (mirrors `serializeSongIndexWrite` in detailTables).
 */
let libraryAlbumWriteChain: Promise<unknown> = Promise.resolve();
function serializeLibraryAlbumWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = libraryAlbumWriteChain.then(task, task);
  libraryAlbumWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Coerce `AlbumID3.created` (a Date at the type level, but a string after a
 *  JSON round-trip) to an epoch-ms number for the hot column, or null. */
function createdToEpoch(created: AlbumID3['created'] | undefined): number | null {
  if (created == null) return null;
  const t = new Date(created as unknown as string).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Insert-or-replace a batch of library albums in ONE transaction on
 * expo-sqlite's background thread (via the serialization mutex). Written per
 * page by the pager so an interrupted list has no partial rows — the whole
 * page commits atomically or not at all, and resume continues from `COUNT(*)`.
 * `getDb()===null` → no-op (row tables refuse writes when the DB is down).
 */
export async function upsertLibraryAlbumsAsync(
  albums: readonly AlbumID3[],
  sortKeyFor: LibraryAlbumSortKeyFn,
): Promise<void> {
  const db = getDb();
  if (db === null || albums.length === 0) return;
  try {
    await serializeLibraryAlbumWrite(() =>
      db.withTransactionAsync(async () => {
        for (const album of albums) {
          if (!album.id) continue;
          // eslint-disable-next-line no-await-in-loop
          await db.runAsync(
            `INSERT OR REPLACE INTO library_albums
               (id, sortKey, starred, userRating, created, raw_json)
               VALUES (?, ?, ?, ?, ?, ?);`,
            [
              album.id,
              sortKeyFor(album),
              album.starred ? 1 : 0,
              album.userRating ?? null,
              createdToEpoch(album.created),
              JSON.stringify(album),
            ],
          );
        }
      }),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[libraryAlbumsTable] upsertLibraryAlbumsAsync failed', e);
  }
}

/** Album rows parsed per macrotask yield. Each `AlbumID3` blob is small
 *  (~0.5-1KB) so a large chunk keeps boot smooth (mirrors SONG_MAP_CHUNK). */
const LIBRARY_ALBUM_PARSE_CHUNK = 2000;

/**
 * Read every library album row (pre-sorted by the stored `sortKey`) into a
 * flat `AlbumID3[]`, parsing chunked with `setTimeout(0)` yields so a big
 * library doesn't freeze the JS thread at boot. setTimeout, not rAF — rAF can
 * stall on RN 0.85/Fabric. Used by `albumLibraryStore.hydrateFromDbAsync`.
 */
export async function hydrateLibraryAlbumsAsync(): Promise<AlbumID3[]> {
  const db = getDb();
  if (db === null) return [];
  try {
    const rows = await db.getAllAsync<{ raw_json: string }>(
      'SELECT raw_json FROM library_albums ORDER BY sortKey, id;',
    );
    const out: AlbumID3[] = [];
    for (let i = 0; i < rows.length; i++) {
      try {
        out.push(JSON.parse(rows[i].raw_json) as AlbumID3);
      } catch {
        /* skip unparseable row */
      }
      if (i > 0 && i % LIBRARY_ALBUM_PARSE_CHUNK === 0) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Total `library_albums` row count (async — background thread). The pager's
 *  resume offset + the startup "needs full fetch?" gate read this. */
export async function countLibraryAlbumsAsync(): Promise<number> {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = await db.getFirstAsync<{ c: number }>(
      'SELECT COUNT(*) AS c FROM library_albums;',
    );
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/** Sync counter — for boot-critical ordering / diagnostics only. */
export function countLibraryAlbums(): number {
  const db = getDb();
  if (db === null) return 0;
  try {
    const row = db.getFirstSync<{ c: number }>('SELECT COUNT(*) AS c FROM library_albums;');
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/** Delete a set of album rows by id (change-detection removals — keeps the
 *  list table from resurrecting server-deleted albums on the next hydrate). */
export async function deleteLibraryAlbumsAsync(ids: readonly string[]): Promise<void> {
  const db = getDb();
  if (db === null || ids.length === 0) return;
  try {
    await serializeLibraryAlbumWrite(() =>
      db.withTransactionAsync(async () => {
        for (const id of ids) {
          // eslint-disable-next-line no-await-in-loop
          await db.runAsync('DELETE FROM library_albums WHERE id = ?;', [id]);
        }
      }),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[libraryAlbumsTable] deleteLibraryAlbumsAsync failed', e);
  }
}

/** Wipe every library album row. Sync variant for the synchronous
 *  server-switch / force-resync clear path (rows must be gone before the new
 *  fetch starts). */
export function clearLibraryAlbums(): void {
  const db = getDb();
  if (db === null) return;
  try {
    db.runSync('DELETE FROM library_albums;');
  } catch {
    /* dropped */
  }
}

/** Async variant of {@link clearLibraryAlbums}. */
export async function clearLibraryAlbumsAsync(): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await serializeLibraryAlbumWrite(() => db.runAsync('DELETE FROM library_albums;').then(() => undefined));
  } catch {
    /* dropped */
  }
}
