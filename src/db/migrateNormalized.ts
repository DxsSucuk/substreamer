/**
 * In-place migration: legacy blob tables → normalized tables.
 *
 * Reads the cached full-object envelopes we already hold — `library_albums.raw_json`
 * (AlbumID3), `song_index.raw_json` (Child), `album_details.json`
 * (AlbumWithSongsID3) and the Zustand KV blobs each of those tables replaced — and
 * upserts them into the normalized schema. Every legacy location is read HERE, so the
 * ETL stands alone: it does not need the migration chain to have replayed the moves
 * between them. NO network. The SOURCE is read keyset-paginated by id so a
 * 200k-album / 467k-song library never loads whole tables into JS (the very OOM
 * this rebuild fixes); each page is parsed, upserted (id-sorted chunked txns),
 * freed, and the JS thread yields between pages.
 *
 * Idempotent (upsert ON CONFLICT), so it's safe to re-run — which the dev spike
 * does for validation. Not yet wired into the boot migration runner; that happens
 * once it's validated on-device.
 */
import type {
  AlbumID3,
  AlbumWithSongsID3,
  ArtistID3,
  ArtistInfo2,
  Child,
  Playlist,
} from 'subsonic-api';

import type { InternalDb } from './client';
import { upsertAlbumInfoRow, upsertAlbums } from './repository/albums';
import { nonEmptyBio } from '../utils/formatters';
import { getSortArticles } from './sortArticles';
import { setArtistTopSongs, upsertArtistBio, upsertArtistInfo, upsertArtists } from './repository/artists';
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
const ALBUM_INFO_KEY = 'substreamer-album-info';
/** Pre-`library_albums` installs (before 2026-07-11) kept the album list ONLY here.
 *  Its table seeder lived in the since-deleted `albumLibraryStore`, so without this
 *  read an upgrade from those versions loses the whole album library. */
const ALBUM_LIBRARY_KEY = 'substreamer-album-library';
/** Pre-`album_details` installs kept the same `{album, retrievedAt}` entries here.
 *  Read directly so this ETL doesn't need the migration that moved them to the table. */
const ALBUM_DETAILS_KEY = 'substreamer-album-details';

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
interface AlbumInfoEntryLite {
  albumInfo?: {
    notes?: string;
    lastFmUrl?: string;
    musicBrainzId?: string;
    smallImageUrl?: string;
    mediumImageUrl?: string;
    largeImageUrl?: string;
  };
  enrichedNotes?: string | null;
  enrichedNotesUrl?: string | null;
  overrideMbid?: string | null;
  retrievedAt?: number;
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
    const info = e.artistInfo;
    if (info) {
      upsertArtistInfo(
        db,
        id,
        {
          // Normalise empties: a blob bio that sanitises to nothing must read as "this
          // server has none", or it becomes a permanent local hit that renders blank and
          // suppresses the MusicBrainz fallback forever.
          biography: nonEmptyBio(info.biography),
          lastFmUrl: info.lastFmUrl ?? null,
          musicBrainzId: info.musicBrainzId ?? null,
          imageUrlSmall: info.smallImageUrl ?? null,
          imageUrlMedium: info.mediumImageUrl ?? null,
          imageUrlLarge: info.largeImageUrl ?? null,
          retrievedAt: Date.now(),
        },
        info,
      );
    }
    const top = e.topSongs ?? [];
    if (top.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await upsertSongs(db, top, undefined, articles);
      // Stamp the state row too, or the migrated artist reads as never-fetched and
      // re-fetches on first open. `listLength` is unknown here, so use what was stored.
      // eslint-disable-next-line no-await-in-loop
      await setArtistTopSongs(db, id, top.map((s) => s.id), { listLength: top.length });
    }
    // The RESOLVED bio is its own table now.
    if (e.biography != null || e.resolvedMbid != null || e.bioCheckedAt != null) {
      // eslint-disable-next-line no-await-in-loop
      await upsertArtistBio(db, id, {
        biography: nonEmptyBio(e.biography),
        resolvedMbid: e.resolvedMbid ?? null,
        checkedAt: e.bioCheckedAt ?? null,
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

/** Album info (getAlbumInfo2 + the Wikipedia enrichment) used to live in a KV blob.
 *  Move it into `album_info`, keyed by album, so it stops being a legacy split. */
async function migrateAlbumInfo(db: InternalDb, log?: Log): Promise<number> {
  const state = await readKvState<{ entries?: Record<string, AlbumInfoEntryLite> }>(
    db,
    ALBUM_INFO_KEY,
  );
  const entries = Object.entries(state?.entries ?? {});
  let migrated = 0;
  for (const [albumId, e] of entries) {
    if (!albumId || !e) continue;
    const info = e.albumInfo ?? {};
    // eslint-disable-next-line no-await-in-loop
    await upsertAlbumInfoRow(db, albumId, {
      notes: info.notes ?? null,
      lastFmUrl: info.lastFmUrl ?? null,
      musicBrainzId: info.musicBrainzId ?? null,
      imageUrlSmall: info.smallImageUrl ?? null,
      imageUrlMedium: info.mediumImageUrl ?? null,
      imageUrlLarge: info.largeImageUrl ?? null,
      enrichedNotes: e.enrichedNotes ?? null,
      enrichedNotesUrl: e.enrichedNotesUrl ?? null,
      overrideMbid: e.overrideMbid ?? null,
      retrievedAt: e.retrievedAt ?? Date.now(),
    }).catch(() => { /* album row may not exist (FK) — skip that entry */ });
    migrated += 1;
  }
  log?.(`album info: ${migrated} entries`);
  return migrated;
}

/** Album-detail ids scanned per gate query. The gate is index-only, so the page is
 *  wide; the ENVELOPES are fetched in a much smaller batch — each is 50-200KB, so a
 *  whole page of them would be tens of MB parsed in one tick. */
const DETAIL_ID_PAGE = 500;
const DETAIL_ENVELOPE_BATCH = 25;

interface AlbumDetailEntryLite {
  album?: AlbumWithSongsID3;
  retrievedAt?: number;
}

/** Upsert a batch of `AlbumWithSongsID3` envelopes: album rows for `needAlbum` ids,
 *  their `song[]` for `needSongs` ids. Returns what each side wrote. */
async function upsertDetailEnvelopes(
  db: InternalDb,
  envelopes: readonly { album: AlbumWithSongsID3; needAlbum: boolean; needSongs: boolean }[],
  articles: readonly string[] | undefined,
): Promise<{ albums: number; songs: number }> {
  const albumRows: AlbumID3[] = [];
  const songRows: Child[] = [];
  for (const { album, needAlbum, needSongs } of envelopes) {
    if (needAlbum) albumRows.push(album);
    if (!needSongs) continue;
    for (const s of album.song ?? []) if (s?.id) songRows.push(s);
  }
  const albums = albumRows.length ? await upsertAlbums(db, albumRows, undefined, articles) : 0;
  const songs = songRows.length ? await upsertSongs(db, songRows, undefined, articles) : 0;
  return { albums, songs };
}

/**
 * `album_details` (`AlbumWithSongsID3` envelopes) as a DIRECT source.
 *
 * NB: this table used to be skipped deliberately, and the reasoning still holds for a
 * RECENT upgrader — it is written atomically alongside `song_index` (one disk write per
 * album-detail fetch), so `song_index` is a superset and reading both is redundant. It
 * INVERTS for an old one: rows written before `song_index.raw_json` existed (pre
 * 2026-06-04) carry NULL, the song pass skips them, and `album_details.song[]` is their
 * only local source. So each id is gated on an actual gap — no `albums` row, no
 * `song_index` rows, or a NULL `raw_json` among them — and the redundant case costs
 * three index probes per row with no JSON parsed at all.
 */
async function migrateAlbumDetailsTable(
  db: InternalDb,
  articles: readonly string[] | undefined,
  log?: Log,
  bump?: (rowsProcessed: number) => void,
): Promise<{ albums: number; songs: number }> {
  let albums = 0;
  let songs = 0;
  let scanned = 0;
  let cursor = '';

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await db.getAllAsync<{
      id: string;
      has_album: number;
      has_song_json: number;
      has_null_json: number;
    }>(
      `SELECT d.id AS id,
              EXISTS(SELECT 1 FROM albums a WHERE a.id = d.id) AS has_album,
              EXISTS(SELECT 1 FROM song_index s WHERE s.albumId = d.id AND s.raw_json IS NOT NULL)
                AS has_song_json,
              EXISTS(SELECT 1 FROM song_index s WHERE s.albumId = d.id AND s.raw_json IS NULL)
                AS has_null_json
         FROM album_details d
        WHERE d.id > ? ORDER BY d.id LIMIT ?`,
      [cursor, DETAIL_ID_PAGE],
    );
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;
    scanned += page.length;
    bump?.(page.length);

    const gaps = new Map<string, { needAlbum: boolean; needSongs: boolean }>();
    for (const r of page) {
      const needAlbum = !r.has_album;
      const needSongs = !r.has_song_json || !!r.has_null_json;
      if (needAlbum || needSongs) gaps.set(r.id, { needAlbum, needSongs });
    }
    const ids = [...gaps.keys()];
    for (let i = 0; i < ids.length; i += DETAIL_ENVELOPE_BATCH) {
      const batch = ids.slice(i, i + DETAIL_ENVELOPE_BATCH);
      // eslint-disable-next-line no-await-in-loop
      const rows = await db.getAllAsync<{ id: string; json: string | null }>(
        `SELECT id, json FROM album_details WHERE id IN (${batch.map(() => '?').join(',')})`,
        batch,
      );
      const parsed: { album: AlbumWithSongsID3; needAlbum: boolean; needSongs: boolean }[] = [];
      for (const r of rows) {
        if (!r.json) continue;
        try {
          const album = JSON.parse(r.json) as AlbumWithSongsID3;
          if (album?.id) parsed.push({ album, ...gaps.get(r.id)! });
        } catch {
          /* unparseable envelope — nothing recoverable in it */
        }
      }
      // eslint-disable-next-line no-await-in-loop
      const wrote = await upsertDetailEnvelopes(db, parsed, articles);
      albums += wrote.albums;
      songs += wrote.songs;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (scanned > 0) {
    log?.(`album_details: scanned ${scanned}, filled ${albums} album(s) + ${songs} song(s)`);
  }
  return { albums, songs };
}

/** The pre-table location of the same album-detail envelopes, as a `{albums: Record<id,
 *  {album, retrievedAt}>}` KV state. Unconditional (upserts): it only survives on
 *  installs whose move-to-table migration never ran, so nothing else holds this data. */
async function migrateAlbumDetailsKv(
  db: InternalDb,
  articles: readonly string[] | undefined,
  log?: Log,
): Promise<{ albums: number; songs: number }> {
  const state = await readKvState<{ albums?: Record<string, AlbumDetailEntryLite> }>(
    db,
    ALBUM_DETAILS_KEY,
  );
  const entries = state?.albums ? Object.values(state.albums) : [];
  let albums = 0;
  let songs = 0;
  for (let i = 0; i < entries.length; i += DETAIL_ENVELOPE_BATCH) {
    const batch = entries
      .slice(i, i + DETAIL_ENVELOPE_BATCH)
      .map((e) => e?.album)
      .filter((a): a is AlbumWithSongsID3 => !!a?.id)
      .map((album) => ({ album, needAlbum: true, needSongs: true }));
    // eslint-disable-next-line no-await-in-loop
    const wrote = await upsertDetailEnvelopes(db, batch, articles);
    albums += wrote.albums;
    songs += wrote.songs;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (entries.length > 0) {
    log?.(`album-details KV: ${albums} album(s) + ${songs} song(s)`);
  }
  return { albums, songs };
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
  // The legacy blob tables are no longer created at boot (F2d). Which of them exist
  // depends on how old the install is — a pre-2026-07-11 upgrader has album_details +
  // song_index but no library_albums — so probe each one independently. A fresh install
  // has none and skips all three.
  const present = new Set(
    (
      await db.getAllAsync<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('library_albums','song_index','album_details')",
      )
    ).map((r) => r.name),
  );
  const EMPTY: TableMigration = { source: 0, migrated: 0, skipped: 0 };
  // Progress total = the three blob tables (albums + songs + the album-detail scan).
  // Artists/playlists come from small KV blobs and finish fast at the end (folded to
  // 100% below).
  const totalAlbums = present.has('library_albums')
    ? (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM library_albums'))?.n ?? 0
    : 0;
  const totalSongs = present.has('song_index')
    ? (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM song_index'))?.n ?? 0
    : 0;
  const totalDetails = present.has('album_details')
    ? (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM album_details'))?.n ?? 0
    : 0;
  const total = totalAlbums + totalSongs + totalDetails;
  let done = 0;
  const bump = (n: number): void => {
    done += n;
    onProgress?.(done, total);
  };
  // Article-aware sort keys (server list, else local default) — same as the sync.
  const articles = getSortArticles();
  let albums = present.has('library_albums')
    ? await migrateBlobTable<AlbumID3>(
        db,
        'library_albums',
        'raw_json',
        (d, items) => upsertAlbums(d, items, undefined, articles),
        log,
        profile,
        bump,
      )
    : EMPTY;
  // Union the pre-table KV blob. Installs older than `library_albums` (2026-07-11)
  // have an empty table and their entire album list in this key; the table wins where
  // both exist, so this only fills gaps. Upserts, so re-running is harmless.
  const legacyAlbums = await readKvState<{ albums?: AlbumID3[] }>(db, ALBUM_LIBRARY_KEY);
  const kvAlbums = legacyAlbums?.albums?.filter((a) => a?.id) ?? [];
  if (kvAlbums.length > 0) {
    await upsertAlbums(db, kvAlbums, undefined, articles);
    log?.(`[normalized] album-library KV: ${kvAlbums.length} album(s)`);
    albums = {
      source: albums.source + kvAlbums.length,
      migrated: albums.migrated + kvAlbums.length,
      skipped: albums.skipped,
    };
  }
  let songs = present.has('song_index')
    ? await migrateBlobTable<Child>(
        db,
        'song_index',
        'raw_json',
        (d, items) => upsertSongs(d, items, undefined, articles),
        log,
        profile,
        bump,
      )
    : EMPTY;
  // Gap-fill from the album-detail envelopes (table, then the pre-table KV blob) — the
  // only local source for albums missing from the list and for songs whose `song_index`
  // row predates `raw_json`. See `migrateAlbumDetailsTable` for why reading this is
  // redundant for a recent upgrader but load-bearing for an old one.
  // Its page query reads BOTH tables, so both must exist. (They shipped together, so
  // gating on `album_details` alone is only incidentally safe — make it explicit.)
  const detailTable =
    present.has('album_details') && present.has('song_index')
      ? await migrateAlbumDetailsTable(db, articles, log, bump)
      : { albums: 0, songs: 0 };
  const detailKv = await migrateAlbumDetailsKv(db, articles, log);
  const detailAlbums = detailTable.albums + detailKv.albums;
  const detailSongs = detailTable.songs + detailKv.songs;
  albums = {
    source: albums.source + detailAlbums,
    migrated: albums.migrated + detailAlbums,
    skipped: albums.skipped,
  };
  songs = {
    source: songs.source + detailSongs,
    migrated: songs.migrated + detailSongs,
    skipped: songs.skipped,
  };
  const artists = await migrateArtists(db, articles, log);
  const playlists = await migratePlaylists(db, articles, log);
  // Album info must run AFTER albums exist — its rows FK to `albums`.
  await migrateAlbumInfo(db, log);
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
