/**
 * In-place migration: legacy blob tables → normalized tables.
 *
 * Reads the cached full-object envelopes we already hold — `library_albums.raw_json`
 * (AlbumID3) and `song_index.raw_json` (Child) — and upserts them into the
 * normalized schema. NO network. The SOURCE is read keyset-paginated by id so a
 * 200k-album / 467k-song library never loads whole tables into JS (the very OOM
 * this rebuild fixes); each page is parsed, upserted (id-sorted chunked txns),
 * freed, and the JS thread yields between pages.
 *
 * Idempotent (upsert ON CONFLICT), so it's safe to re-run — which the dev spike
 * does for validation. Not yet wired into the boot migration runner; that happens
 * once it's validated on-device.
 */
import type { AlbumID3, ArtistID3, ArtistInfo2, Child, Playlist } from 'subsonic-api';

import type { InternalDb } from './client';
import { ensureNormalizedSchema } from './createNormalizedTables';
import { upsertAlbums } from './repository/albums';
import { getSortArticles } from './sortArticles';
import { setArtistDetailMeta, setArtistTopSongs, upsertArtistInfo, upsertArtists } from './repository/artists';
import { setPlaylistSongs, upsertPlaylists } from './repository/playlists';
import { upsertSongs } from './repository/songs';

export interface TableMigration {
  source: number;
  migrated: number;
  skipped: number; // rows with no/invalid raw_json
}
export interface MigrationResult {
  albums: TableMigration;
  songs: TableMigration;
  artists: TableMigration;
  playlists: TableMigration;
  ms: number;
}

type Log = (message: string) => void;

/** Optional timing accumulator for the dev spike — source read (SQL) vs JSON parse.
 *  The derive/write split is captured separately via the repository chunk profiler. */
export interface MigrationProfile {
  readMs: number;
  parseMs: number;
}
const nowMs = (): number => {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
};

async function migrateBlobTable<T extends { id: string }>(
  db: InternalDb,
  sourceTable: string,
  jsonCol: string,
  upsert: (db: InternalDb, items: T[]) => Promise<number>,
  log?: Log,
  profile?: MigrationProfile,
  bump?: (rowsProcessed: number) => void,
): Promise<TableMigration> {
  const source =
    (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${sourceTable}`))?.n ?? 0;
  let migrated = 0;
  let skipped = 0;
  let cursor = '';
  const PAGE = 1000;

  for (;;) {
    const rd0 = nowMs();
    // Async read: keep the source-blob paging OFF the JS thread (on Android the
    // sync read of raw_json blobs was ~3.5s of UI-blocking; the mandate is that
    // nothing in a background sync/migration blocks the UI).
    // eslint-disable-next-line no-await-in-loop
    const rows = await db.getAllAsync<{ id: string; j: string | null }>(
      `SELECT id, ${jsonCol} AS j FROM ${sourceTable} WHERE id > ? ORDER BY id LIMIT ?`,
      [cursor, PAGE],
    );
    if (profile) profile.readMs += nowMs() - rd0;
    if (rows.length === 0) break;

    const ps0 = nowMs();
    const items: T[] = [];
    for (const r of rows) {
      if (!r.j) {
        skipped++;
        continue;
      }
      try {
        items.push(JSON.parse(r.j) as T);
      } catch {
        skipped++;
      }
    }
    if (profile) profile.parseMs += nowMs() - ps0;
    migrated += await upsert(db, items);
    cursor = rows[rows.length - 1].id;
    bump?.(rows.length);
    log?.(`${sourceTable}: ${migrated}/${source} migrated (${skipped} skipped)`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { source, migrated, skipped };
}

// ── Artists + Playlists ───────────────────────────────────────────────────────
// These aren't in the SQL blob tables — they live in the Zustand-persisted KV
// blobs in the `storage` table. Library rows come from the `*-library` KV; detail
// children (artist bio/similar, playlist song order) from the on-demand `*-details`
// KV where a user opened them — else they re-sync later (artists/playlists are not
// fully synced locally today).

const ARTIST_LIBRARY_KEY = 'substreamer-artist-library';
const ARTIST_DETAILS_KEY = 'substreamer-artist-details';
const PLAYLIST_LIBRARY_KEY = 'substreamer-playlist-library';
const PLAYLIST_DETAILS_KEY = 'substreamer-playlist-details';

/** Read a Zustand-persisted store's `state` object from the KV `storage` table
 *  (the `{state, version}` envelope). Defensive: missing table/row/parse → null. */
async function readKvState<T>(db: InternalDb, key: string): Promise<T | null> {
  try {
    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM storage WHERE key = ?', [key]);
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as { state?: T };
    return parsed?.state ?? null;
  } catch {
    return null;
  }
}

interface ArtistDetailLite {
  artist?: ArtistID3;
  artistInfo?: ArtistInfo2 | null;
  biography?: string | null;
  topSongs?: Child[];
  resolvedMbid?: string | null;
  bioCheckedAt?: number;
}
interface PlaylistDetailLite {
  playlist?: Playlist & { entry?: Child[] };
}

/** Artists: library rows (ArtistID3[]) + full detail (images/similar + top songs +
 *  resolved bio & negative-cache markers) from cached artist details. */
async function migrateArtists(
  db: InternalDb,
  articles: readonly string[] | undefined,
  log?: Log,
): Promise<TableMigration> {
  const lib = await readKvState<{ artists?: ArtistID3[] }>(db, ARTIST_LIBRARY_KEY);
  const libraryArtists = lib?.artists ?? [];
  let migrated = libraryArtists.length ? await upsertArtists(db, libraryArtists, undefined, articles) : 0;

  // Detail cache: ensure a row exists for any opened-but-not-in-list artist, then write
  // its images/similar (upsertArtistInfo), its top songs (rows + ordered junction), and
  // the RESOLVED bio + negative-cache markers — exactly what the live detail fetch
  // writes, so a migrated artist opens offline with full detail and won't re-hit MB.
  const det = await readKvState<{ artists?: Record<string, ArtistDetailLite> }>(db, ARTIST_DETAILS_KEY);
  const entries = det?.artists ? Object.values(det.artists) : [];
  const detailArtists = entries.map((e) => e?.artist).filter((a): a is ArtistID3 => !!a?.id);
  if (detailArtists.length) migrated += await upsertArtists(db, detailArtists, undefined, articles);
  for (const e of entries) {
    const id = e?.artist?.id;
    if (!id) continue;
    if (e.artistInfo || e.biography) {
      const info = {
        ...(e.artistInfo ?? {}),
        biography: e.biography ?? e.artistInfo?.biography ?? undefined,
      } as ArtistInfo2;
      upsertArtistInfo(db, id, info);
    }
    const top = e.topSongs ?? [];
    if (top.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await upsertSongs(db, top, undefined, articles);
      // eslint-disable-next-line no-await-in-loop
      await setArtistTopSongs(db, id, top.map((s) => s.id));
    }
    // Resolved bio + negative-cache markers last, so they win over info.biography.
    if (e.biography != null || e.resolvedMbid != null || e.bioCheckedAt != null) {
      // eslint-disable-next-line no-await-in-loop
      await setArtistDetailMeta(db, id, {
        biography: e.biography ?? null,
        bioCheckedAt: e.bioCheckedAt ?? null,
        resolvedMbid: e.resolvedMbid ?? null,
      });
    }
  }
  log?.(`artists: ${migrated} rows (${libraryArtists.length} library, ${entries.length} detail-cached)`);
  return { source: libraryArtists.length, migrated, skipped: 0 };
}

/** Playlists: library rows (Playlist[]) + ordered song membership (+ the member songs
 *  themselves) from cached details. */
async function migratePlaylists(
  db: InternalDb,
  articles: readonly string[] | undefined,
  log?: Log,
): Promise<TableMigration> {
  const lib = await readKvState<{ playlists?: Playlist[] }>(db, PLAYLIST_LIBRARY_KEY);
  const libraryPlaylists = lib?.playlists ?? [];
  const migrated = libraryPlaylists.length ? await upsertPlaylists(db, libraryPlaylists, undefined, articles) : 0;

  const det = await readKvState<{ playlists?: Record<string, PlaylistDetailLite> }>(db, PLAYLIST_DETAILS_KEY);
  const detEntries = det?.playlists ? Object.entries(det.playlists) : [];
  for (const [pid, pe] of detEntries) {
    const pl = pe?.playlist;
    if (!pl) continue;
    // Ensure the parent row exists (FK) even if the playlist isn't in the list.
    // eslint-disable-next-line no-await-in-loop
    await upsertPlaylists(db, [pl], undefined, articles);
    // Upsert the member songs FIRST so `playlist_songs JOIN songs` resolves: a playlist
    // can hold tracks from albums the library never fully synced (absent from
    // `song_index`); without this they'd be silently dropped from the offline playlist.
    const entry = pl.entry ?? [];
    // eslint-disable-next-line no-await-in-loop
    if (entry.length > 0) await upsertSongs(db, entry, undefined, articles);
    const ids = entry.map((s) => s.id).filter(Boolean);
    if (ids.length) setPlaylistSongs(db, pid, ids);
  }
  log?.(`playlists: ${migrated} rows (${libraryPlaylists.length} library, ${detEntries.length} detail-cached)`);
  return { source: libraryPlaylists.length, migrated, skipped: 0 };
}

/** Migrate the album + song blob caches AND the artist/playlist KV blobs into the
 *  normalized tables. Pass `profile` (dev spike only) to accumulate read/parse time. */
export async function migrateBlobsToNormalized(
  db: InternalDb,
  log?: Log,
  profile?: MigrationProfile,
  onProgress?: (done: number, total: number) => void,
): Promise<MigrationResult> {
  const start = Date.now();
  ensureNormalizedSchema(db);
  log?.('normalized schema ensured');
  // Progress total = the two big blob tables (albums + songs). Artists/playlists
  // come from small KV blobs and finish fast at the end (folded to 100% below).
  const totalAlbums =
    (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM library_albums'))?.n ?? 0;
  const totalSongs =
    (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM song_index'))?.n ?? 0;
  const total = totalAlbums + totalSongs;
  let done = 0;
  const bump = (n: number): void => {
    done += n;
    onProgress?.(done, total);
  };
  // Article-aware sort keys (server list, else local default) — same as the sync.
  const articles = getSortArticles();
  const albums = await migrateBlobTable<AlbumID3>(
    db,
    'library_albums',
    'raw_json',
    (d, items) => upsertAlbums(d, items, undefined, articles),
    log,
    profile,
    bump,
  );
  const songs = await migrateBlobTable<Child>(
    db,
    'song_index',
    'raw_json',
    (d, items) => upsertSongs(d, items, undefined, articles),
    log,
    profile,
    bump,
  );
  // NB: `album_details` is intentionally NOT read — it was written atomically alongside
  // `song_index` (one disk write per album-detail fetch), so `song_index` is a superset
  // of its songs; migrating both would be redundant.
  const artists = await migrateArtists(db, articles, log);
  const playlists = await migratePlaylists(db, articles, log);
  onProgress?.(total, total); // settle at 100% (artists/playlists done)
  // NB: the WAL checkpoint is deliberately NOT run here. Folding the migration's
  // (large) WAL takes seconds and must NOT hold up "migration complete" — the
  // caller runs `checkpointWalAsync` in the BACKGROUND after signalling done (see
  // Spike D and the boot wiring). Until it finishes, reads just traverse a larger
  // WAL (slower, never broken).
  return { albums, songs, artists, playlists, ms: Date.now() - start };
}

/**
 * Fold the WAL back into the main DB (`wal_checkpoint(TRUNCATE)`), ASYNC/off the JS
 * thread. Run AFTER a bulk migration/sync completes, in the BACKGROUND — a large
 * bulk write leaves a big WAL that slows later reads until checkpointed, but the
 * checkpoint itself takes seconds, so it must never block completion. Awaiting is
 * optional (fire-and-forget is fine). Returns the ms it took (for the dev spike).
 */
export async function checkpointWalAsync(db: InternalDb, log?: Log): Promise<number> {
  const t0 = Date.now();
  try {
    await db.runAsync('PRAGMA wal_checkpoint(TRUNCATE);');
    log?.('WAL checkpointed (TRUNCATE, background)');
  } catch (e) {
    log?.(`WAL checkpoint failed: ${String(e)}`);
  }
  return Date.now() - t0;
}
