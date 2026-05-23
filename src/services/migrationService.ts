/**
 * Data migration service.
 *
 * Defines versioned migration tasks that run sequentially on app launch.
 * Each task has a numeric `id` (1-based, strictly increasing). The
 * migration runner compares these IDs against the store's
 * `completedVersion` to determine which tasks still need to run.
 *
 * See the bottom of this file for a template showing how to add new tasks.
 */

import { Directory, File, Paths } from 'expo-file-system';
import { listDirectoryAsync } from 'expo-async-fs';
import { Platform } from 'react-native';

import { defaultCollator } from '../utils/intl';

import { migrateV3BackupMetas, migrateV4BackupMetas } from './backupService';
import { deviceIdentityStore } from '../store/deviceIdentityStore';
import { getAllSongAlbumIds } from '../store/persistence/detailTables';
import {
  completedScrobbleStore,
  type CompletedScrobble,
} from '../store/completedScrobbleStore';
import { mbidOverrideStore, type MbidOverride } from '../store/mbidOverrideStore';
import { type PendingScrobble } from '../store/pendingScrobbleStore';
import { playbackSettingsStore } from '../store/playbackSettingsStore';
import { localeStore } from '../store/localeStore';
import {
  hydrateAlbumDetails,
  upsertAlbumDetail,
  upsertSongsForAlbum,
} from '../store/persistence/detailTables';
import { getDb } from '../store/persistence/db';
import {
  addColumnIfMissing,
  bulkReplace as bulkReplaceMusicCache,
  countCachedItems as countCachedItemsRow,
  countCachedItemSongs as countCachedItemSongsRow,
  countCachedSongs as countCachedSongsRow,
  countDownloadQueueItems as countDownloadQueueItemsRow,
  readPragma as readMusicCacheTablesPragma,
  type CachedItemRow,
  type CachedSongRow,
  type DownloadQueueRow,
} from '../store/persistence/musicCacheTables';
import { replaceAllPendingScrobbles } from '../store/persistence/pendingScrobbleTable';
import { replaceAllScrobbles } from '../store/persistence/scrobbleTable';
import {
  bulkInsertCachedImages,
  countCachedImages as countCachedImagesRow,
} from '../store/persistence/imageCacheTable';
import { kvStorage } from '../store/persistence';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MigrationTask {
  /** Sequential ID starting at 1. Must be unique and increasing. */
  id: number;
  /** Short name shown to the user during migration. */
  name: string;
  /** The work to perform. Use `log` to record findings. Throw on unrecoverable failure. */
  run: (log: (message: string) => void) => Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Shared body for Migration 7 (forward run) and Migration 9 (repair).
 * Reads auth credentials directly from the persisted SQLite blob rather
 * than from authStore.getState(), avoiding a race with Zustand rehydration.
 * The underlying migrateV3BackupMetas is idempotent — it only rewrites
 * files that are still at v3, so running this twice is safe.
 */
/**
 * Shared body for Migration 14 (forward run) and Migration 15 (recovery).
 * Reads the v1 `substreamer-music-cache` blob, resolves every track's parent
 * albumId, transforms into v2 rows, commits via `bulkReplaceMusicCache`,
 * writes the `maxConcurrentDownloads` setting, and re-homes files on disk
 * into the album-rooted layout. The filesystem migration is idempotent —
 * files already at the target path are no-ops, so calling this a second
 * time (Migration 15 recovery) is safe even when Migration 14 already moved
 * everything.
 *
 * Returns false if the blob is missing or unparseable (migration is a
 * no-op); true if the migration ran and `bulkReplaceMusicCache` was
 * invoked (even if it silently persisted nothing — the caller can cross-
 * check counts afterwards).
 */
async function migrateMusicCacheFromBlob(
  log: (message: string) => void,
): Promise<boolean> {
  const raw = await kvStorage.getItem('substreamer-music-cache');
  if (!raw) {
    log('No persisted music-cache blob — nothing to migrate.');
    return false;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await kvStorage.removeItem('substreamer-music-cache');
    log('Failed to parse music-cache blob — removed.');
    return false;
  }
  const state = parsed?.state;
  if (!state || typeof state !== 'object') {
    await kvStorage.removeItem('substreamer-music-cache');
    log('Music-cache blob had no state — removed.');
    return false;
  }

  const v1CachedItems: Record<string, any> = state.cachedItems ?? {};
  const v1DownloadQueue: any[] = Array.isArray(state.downloadQueue)
    ? state.downloadQueue
    : [];
  const v1DownloadedFormats: Record<string, any> =
    state.downloadedFormats ?? {};
  const v1MaxConcurrent = state.maxConcurrentDownloads;

  // ===== Diagnostic phase 1: v1 blob parse summary =====
  const v1ItemCount = Object.keys(v1CachedItems).length;
  const v1TypeCounts: Record<string, number> = {};
  const v1TrackCounts: Record<string, number> = {};
  for (const [id, it] of Object.entries(v1CachedItems)) {
    const t = (it as any)?.type ?? 'unknown';
    v1TypeCounts[t] = (v1TypeCounts[t] ?? 0) + 1;
    const tracks = (it as any)?.tracks;
    v1TrackCounts[id] = Array.isArray(tracks) ? tracks.length : 0;
  }
  log(
    `[diag] v1 blob: ${v1ItemCount} item(s) (` +
      Object.entries(v1TypeCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') +
      `), ${v1DownloadQueue.length} queue row(s), ` +
      `${Object.keys(v1DownloadedFormats).length} format stamp(s), ` +
      `maxConcurrent=${String(v1MaxConcurrent)}`,
  );

  // ===== Diagnostic phase 2: SQL pragma state =====
  log(
    `[diag] PRAGMA: foreign_keys=${readMusicCacheTablesPragma('foreign_keys') ?? 'null'}, ` +
      `journal_mode=${readMusicCacheTablesPragma('journal_mode') ?? 'null'}, ` +
      `synchronous=${readMusicCacheTablesPragma('synchronous') ?? 'null'}`,
  );

  // ===== Diagnostic phase 3: pre-bulkReplace SQL table state =====
  log(
    `[diag] SQL before bulkReplace: ` +
      `cached_items=${countCachedItemsRow()}, ` +
      `cached_songs=${countCachedSongsRow()}, ` +
      `cached_item_songs=${countCachedItemSongsRow()}, ` +
      `download_queue=${countDownloadQueueItemsRow()}`,
  );

  // Build trackId -> albumId map from every source that's reliably
  // available at migration time.
  const trackIdToAlbumId = new Map<string, string>();
  let resolvedVia1 = 0, resolvedVia2 = 0, resolvedVia3 = 0, resolvedVia4 = 0;

  // Source 1: v1 album items.
  for (const item of Object.values(v1CachedItems)) {
    if (item?.type === 'album' && Array.isArray(item.tracks)) {
      for (const t of item.tracks) {
        if (t?.id && !trackIdToAlbumId.has(t.id)) {
          trackIdToAlbumId.set(t.id, item.itemId);
          resolvedVia1++;
        }
      }
    }
  }

  // Source 2: song_index SQL table.
  try {
    const sqlMap = getAllSongAlbumIds();
    for (const [songId, albumId] of sqlMap) {
      if (!trackIdToAlbumId.has(songId)) {
        trackIdToAlbumId.set(songId, albumId);
        resolvedVia2++;
      }
    }
  } catch (e) {
    log(`[diag] resolver source 2 (song_index) threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Source 3: substreamer-playlist-details blob.
  try {
    const rawPlaylists = await kvStorage.getItem('substreamer-playlist-details');
    if (rawPlaylists) {
      const parsedPlaylists = JSON.parse(rawPlaylists);
      const playlists = parsedPlaylists?.state?.playlists ?? {};
      for (const entry of Object.values(playlists)) {
        const pl = (entry as any)?.playlist;
        const songs = Array.isArray(pl?.entry) ? pl.entry : [];
        for (const s of songs) {
          if (s?.id && s?.albumId && !trackIdToAlbumId.has(s.id)) {
            trackIdToAlbumId.set(s.id, s.albumId);
            resolvedVia3++;
          }
        }
      }
    }
  } catch (e) {
    log(`[diag] resolver source 3 (playlist-details blob) threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Source 4: substreamer-favorites blob.
  try {
    const rawFavs = await kvStorage.getItem('substreamer-favorites');
    if (rawFavs) {
      const parsedFavs = JSON.parse(rawFavs);
      const songs = Array.isArray(parsedFavs?.state?.songs)
        ? parsedFavs.state.songs
        : [];
      for (const s of songs) {
        if (s?.id && s?.albumId && !trackIdToAlbumId.has(s.id)) {
          trackIdToAlbumId.set(s.id, s.albumId);
          resolvedVia4++;
        }
      }
    }
  } catch (e) {
    log(`[diag] resolver source 4 (favorites blob) threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  log(
    `[diag] album_id resolver: ${trackIdToAlbumId.size} total mappings ` +
      `(v1-album-items=${resolvedVia1}, song_index=${resolvedVia2}, ` +
      `playlist-details=${resolvedVia3}, favorites=${resolvedVia4})`,
  );

  const resolveAlbumId = (trackId: string): string =>
    trackIdToAlbumId.get(trackId) ?? '_unknown';

  const mapV2Type = (
    itemId: string,
    v1Type: unknown,
  ): 'album' | 'playlist' | 'favorites' | 'song' => {
    if (itemId === '__starred__') return 'favorites';
    if (v1Type === 'album') return 'album';
    return 'playlist';
  };

  const itemRows: Array<Omit<CachedItemRow, 'songIds'>> = [];
  const songsById = new Map<string, CachedSongRow>();
  const edges: Array<{ itemId: string; position: number; songId: string }> = [];

  for (const item of Object.values(v1CachedItems)) {
    if (!item?.itemId) continue;
    const tracksArr: any[] = Array.isArray(item.tracks) ? item.tracks : [];
    const v2Type = mapV2Type(item.itemId, item.type);
    const downloadedAt =
      typeof item.downloadedAt === 'number' ? item.downloadedAt : Date.now();

    itemRows.push({
      itemId: item.itemId,
      type: v2Type,
      name: typeof item.name === 'string' ? item.name : 'Unknown',
      artist: typeof item.artist === 'string' ? item.artist : undefined,
      coverArtId:
        typeof item.coverArtId === 'string' ? item.coverArtId : undefined,
      expectedSongCount: tracksArr.length,
      parentAlbumId: undefined,
      lastSyncAt: downloadedAt,
      downloadedAt,
    });

    tracksArr.forEach((track: any, idx: number) => {
      if (!track?.id) return;

      const albumId =
        v2Type === 'album' ? item.itemId : resolveAlbumId(track.id);

      if (!songsById.has(track.id)) {
        const fileName =
          typeof track.fileName === 'string' ? track.fileName : '';
        const suffix = fileName.includes('.')
          ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
          : 'mp3';

        const fmt = v1DownloadedFormats[track.id];
        const formatCapturedAt =
          typeof fmt?.capturedAt === 'number' ? fmt.capturedAt : downloadedAt;

        const songRow: CachedSongRow = {
          id: track.id,
          title: typeof track.title === 'string' ? track.title : 'Unknown',
          albumId,
          bytes: typeof track.bytes === 'number' ? track.bytes : 0,
          duration: typeof track.duration === 'number' ? track.duration : 0,
          suffix,
          formatCapturedAt,
          downloadedAt,
        };
        if (typeof track.artist === 'string') songRow.artist = track.artist;
        if (typeof track.coverArt === 'string') songRow.coverArt = track.coverArt;
        if (typeof fmt?.bitRate === 'number') songRow.bitRate = fmt.bitRate;
        if (typeof fmt?.bitDepth === 'number') songRow.bitDepth = fmt.bitDepth;
        if (typeof fmt?.samplingRate === 'number') {
          songRow.samplingRate = fmt.samplingRate;
        }
        songsById.set(track.id, songRow);
      }

      edges.push({ itemId: item.itemId, position: idx + 1, songId: track.id });
    });
  }

  const queueRows: DownloadQueueRow[] = v1DownloadQueue
    .filter((q: any) => q?.queueId && q?.itemId)
    .map((q: any, idx: number) => {
      const v2Type = mapV2Type(q.itemId, q.type);
      const tracks: any[] = Array.isArray(q.tracks) ? q.tracks : [];
      const rawStatus =
        typeof q.status === 'string' ? q.status : 'queued';
      const status: DownloadQueueRow['status'] =
        rawStatus === 'downloading'
          ? 'queued'
          : (rawStatus as DownloadQueueRow['status']);
      const row: DownloadQueueRow = {
        queueId: q.queueId,
        itemId: q.itemId,
        type: v2Type,
        name: typeof q.name === 'string' ? q.name : 'Unknown',
        status,
        totalSongs:
          typeof q.totalTracks === 'number' ? q.totalTracks : tracks.length,
        completedSongs:
          typeof q.completedTracks === 'number' ? q.completedTracks : 0,
        addedAt: typeof q.addedAt === 'number' ? q.addedAt : Date.now(),
        queuePosition: idx + 1,
        songsJson: JSON.stringify(tracks),
      };
      if (typeof q.artist === 'string') row.artist = q.artist;
      if (typeof q.coverArtId === 'string') row.coverArtId = q.coverArtId;
      if (typeof q.error === 'string') row.error = q.error;
      return row;
    });

  // ===== Diagnostic phase 4: pre-bulkReplace input summary =====
  const uniqueAlbumIds = new Set<string>();
  for (const s of songsById.values()) uniqueAlbumIds.add(s.albumId);
  const uniqueEdgeItemIds = new Set<string>();
  for (const e of edges) uniqueEdgeItemIds.add(e.itemId);
  const itemIdsSet = new Set(itemRows.map((i) => i.itemId));
  const edgesWithOrphanItemId = edges.filter((e) => !itemIdsSet.has(e.itemId)).length;
  const edgesWithOrphanSongId = edges.filter((e) => !songsById.has(e.songId)).length;
  log(
    `[diag] bulkReplace inputs: items=${itemRows.length} ` +
      `(types=${itemRows.map((i) => i.type).join(',')}; ids=${Array.from(itemIdsSet).join(',')}), ` +
      `songs=${songsById.size}, ` +
      `edges=${edges.length} (spanning ${uniqueEdgeItemIds.size} item_id(s)), ` +
      `unique albumIds in songs=${uniqueAlbumIds.size}, ` +
      `queue=${queueRows.length}. ` +
      `FK sanity: ${edgesWithOrphanItemId} edge(s) ref missing item_id, ` +
      `${edgesWithOrphanSongId} edge(s) ref missing song_id.`,
  );

  let bulkReplaceError: string | null = null;
  try {
    bulkReplaceMusicCache({
      items: itemRows,
      songs: Array.from(songsById.values()),
      edges,
      queue: queueRows,
    });
  } catch (e) {
    bulkReplaceError = e instanceof Error ? e.message : String(e);
    log(`[diag] bulkReplace THREW: ${bulkReplaceError}`);
  }

  // ===== Diagnostic phase 5: post-bulkReplace SQL verification =====
  const afterItems = countCachedItemsRow();
  const afterSongs = countCachedSongsRow();
  const afterEdges = countCachedItemSongsRow();
  const afterQueue = countDownloadQueueItemsRow();
  log(
    `[diag] SQL after bulkReplace: ` +
      `cached_items=${afterItems} (expected ${itemRows.length}), ` +
      `cached_songs=${afterSongs} (expected ${songsById.size}), ` +
      `cached_item_songs=${afterEdges} (expected ${edges.length}), ` +
      `download_queue=${afterQueue} (expected ${queueRows.length})`,
  );
  if (
    afterItems !== itemRows.length ||
    afterSongs !== songsById.size ||
    afterEdges !== edges.length ||
    afterQueue !== queueRows.length
  ) {
    log(
      `[diag] !!! MISMATCH DETECTED !!! bulkReplace did not persist all ` +
        `expected rows. Differences: ` +
        `items Δ=${afterItems - itemRows.length}, ` +
        `songs Δ=${afterSongs - songsById.size}, ` +
        `edges Δ=${afterEdges - edges.length}, ` +
        `queue Δ=${afterQueue - queueRows.length}.`,
    );
  } else {
    log(`[diag] bulkReplace verified: all 4 tables match expected counts.`);
  }

  // Preserve the user's maxConcurrentDownloads setting.
  if (
    v1MaxConcurrent === 1 ||
    v1MaxConcurrent === 3 ||
    v1MaxConcurrent === 5
  ) {
    await kvStorage.setItem(
      'substreamer-music-cache-settings',
      JSON.stringify({ maxConcurrentDownloads: v1MaxConcurrent }),
    );
  }

  // Filesystem migration — idempotent + dedup-aware. Safe to call again in
  // the Migration 15 recovery path: files already at the target path are
  // treated as no-ops.
  let movedCount = 0;
  let noopCount = 0;
  let dupesDeleted = 0;
  let missingCount = 0;
  let staleDirsDeleted = 0;
  try {
    const cacheDir = new Directory(Paths.document, 'music-cache');
    if (cacheDir.exists) {
      const filesBySongId = new Map<string, File[]>();
      let topLevelNames: string[] = [];
      try {
        const listed = await listDirectoryAsync(cacheDir.uri);
        topLevelNames = Array.isArray(listed) ? listed : [];
      } catch { /* best-effort */ }

      for (const subDirName of topLevelNames) {
        const subDir = new Directory(cacheDir, subDirName);
        if (!subDir.exists) continue;
        let fileNames: string[] = [];
        try {
          const listed = await listDirectoryAsync(subDir.uri);
          fileNames = Array.isArray(listed) ? listed : [];
        } catch { continue; }
        for (const fileName of fileNames) {
          if (!fileName || fileName.endsWith('.tmp')) continue;
          const dotIdx = fileName.lastIndexOf('.');
          const songId = dotIdx >= 0 ? fileName.slice(0, dotIdx) : fileName;
          const file = new File(subDir, fileName);
          const bucket = filesBySongId.get(songId);
          if (bucket) bucket.push(file);
          else filesBySongId.set(songId, [file]);
        }
      }

      const validAlbumIds = new Set<string>();
      for (const song of songsById.values()) {
        validAlbumIds.add(song.albumId);

        const targetAlbumDir = new Directory(cacheDir, song.albumId);
        if (!targetAlbumDir.exists) {
          try { targetAlbumDir.create(); } catch { /* best-effort */ }
        }
        const targetFile = new File(targetAlbumDir, `${song.id}.${song.suffix}`);
        const sources = filesBySongId.get(song.id) ?? [];

        const alreadyInPlace = sources.find((f) => f.uri === targetFile.uri);
        if (alreadyInPlace) {
          noopCount++;
          for (const dup of sources) {
            if (dup.uri === targetFile.uri) continue;
            try { dup.delete(); dupesDeleted++; } catch { /* best-effort */ }
          }
          continue;
        }

        if (sources.length > 0) {
          const [first, ...rest] = sources;
          try {
            first.move(targetFile);
            movedCount++;
          } catch {
            /* best-effort move — reconciliation heals on next launch. */
          }
          for (const dup of rest) {
            try { dup.delete(); dupesDeleted++; } catch { /* best-effort */ }
          }
          continue;
        }

        missingCount++;
      }

      for (const name of topLevelNames) {
        if (validAlbumIds.has(name)) continue;
        const stale = new Directory(cacheDir, name);
        if (!stale.exists) continue;
        try { stale.delete(); staleDirsDeleted++; } catch { /* best-effort */ }
      }

      log(
        `Filesystem migration: ${noopCount} in-place, ${movedCount} moved, ` +
          `${dupesDeleted} duplicate(s) deleted, ${missingCount} missing, ` +
          `${staleDirsDeleted} stale dir(s) swept.`,
      );
    }
  } catch {
    /* best-effort filesystem migration — reconciliation heals. */
  }

  log(
    `Migrated ${itemRows.length} item(s), ${songsById.size} song(s), ` +
      `${edges.length} edge(s), ${queueRows.length} queue item(s) to per-row tables.`,
  );
  return true;
}

async function stampV3BackupsFromStoredAuth(
  log: (message: string) => void,
): Promise<void> {
  const raw = await kvStorage.getItem('substreamer-auth');
  if (!raw) {
    log('No persisted auth — skipping backup identity stamping.');
    return;
  }
  let serverUrl: string | undefined;
  let username: string | undefined;
  try {
    const parsed = JSON.parse(raw);
    serverUrl = parsed?.state?.serverUrl;
    username = parsed?.state?.username;
  } catch {
    log('Failed to parse persisted auth — skipping.');
    return;
  }
  if (!serverUrl || !username) {
    log('No active session in persisted auth — skipping.');
    return;
  }
  const count = await migrateV3BackupMetas(serverUrl, username);
  if (count > 0) {
    log(`Upgraded ${count} backup(s) from v3 to v4 with identity ${username}@${serverUrl}.`);
  } else {
    log('No v3 backup files found — skipping.');
  }
}

/**
 * Migration 18 body. Scans every `cached_songs` row with a NULL `raw_json`
 * and fills it from the richest local source available, in this priority:
 *
 *   1. `album_details` table (Migration 12) — full `AlbumWithSongsID3.song[]`.
 *   2. `substreamer-playlist-details` blob — `PlaylistWithSongs.entry[]`.
 *   3. `substreamer-favorites` blob — starred `Child[]`.
 *
 * Songs without a local source remain NULL. A future network-refresh
 * migration can target them.
 *
 * All UPDATEs run inside a single `withTransactionSync` for atomicity.
 */
async function backfillCachedSongEnvelopes(
  log: (message: string) => void,
): Promise<void> {
  const db = getDb();
  if (!db) {
    log('DB unavailable — skipping song-envelope backfill.');
    return;
  }

  // Fast path: if no rows need backfilling, we don't have to read any blobs.
  const pending = db.getAllSync<{ song_id: string }>(
    'SELECT song_id FROM cached_songs WHERE raw_json IS NULL;',
  );
  if (pending.length === 0) {
    log('All cached_songs rows already carry an envelope — nothing to backfill.');
    return;
  }

  const pendingIds = new Set(pending.map((r) => r.song_id));

  // Build a lookup map: songId -> full Child. We only populate entries for
  // songs that are pending — no point holding envelopes we won't use.
  const lookup = new Map<string, { child: unknown; source: 'album' | 'playlist' | 'favorites' }>();

  // Source 1: album_details rows.
  try {
    const albums = hydrateAlbumDetails();
    for (const entry of Object.values(albums)) {
      const songs = entry?.album?.song;
      if (!Array.isArray(songs)) continue;
      for (const s of songs) {
        if (!s?.id || lookup.has(s.id) || !pendingIds.has(s.id)) continue;
        lookup.set(s.id, { child: s, source: 'album' });
      }
    }
  } catch (e) {
    log(`[diag] album-details source threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Source 2: substreamer-playlist-details blob.
  try {
    const raw = await kvStorage.getItem('substreamer-playlist-details');
    if (raw) {
      const parsed = JSON.parse(raw);
      const playlists = parsed?.state?.playlists ?? {};
      for (const entry of Object.values(playlists)) {
        const pl = (entry as any)?.playlist;
        const songs: any[] = Array.isArray(pl?.entry) ? pl.entry : [];
        for (const s of songs) {
          if (!s?.id || lookup.has(s.id) || !pendingIds.has(s.id)) continue;
          lookup.set(s.id, { child: s, source: 'playlist' });
        }
      }
    }
  } catch (e) {
    log(`[diag] playlist-details source threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Source 3: substreamer-favorites blob.
  try {
    const raw = await kvStorage.getItem('substreamer-favorites');
    if (raw) {
      const parsed = JSON.parse(raw);
      const songs: any[] = Array.isArray(parsed?.state?.songs) ? parsed.state.songs : [];
      for (const s of songs) {
        if (!s?.id || lookup.has(s.id) || !pendingIds.has(s.id)) continue;
        lookup.set(s.id, { child: s, source: 'favorites' });
      }
    }
  } catch (e) {
    log(`[diag] favorites source threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  let viaAlbum = 0;
  let viaPlaylist = 0;
  let viaFavorites = 0;
  try {
    db.withTransactionSync(() => {
      for (const [songId, { child, source }] of lookup) {
        const json = JSON.stringify(child);
        db.runSync(
          'UPDATE cached_songs SET raw_json = ? WHERE song_id = ? AND raw_json IS NULL;',
          [json, songId],
        );
        if (source === 'album') viaAlbum++;
        else if (source === 'playlist') viaPlaylist++;
        else viaFavorites++;
      }
    });
  } catch (e) {
    log(`[diag] UPDATE transaction threw: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  const totalBackfilled = viaAlbum + viaPlaylist + viaFavorites;
  const stillNull = pending.length - totalBackfilled;
  log(
    `Backfilled ${totalBackfilled} of ${pending.length} cached_songs envelope(s) ` +
      `(${viaAlbum} via album_details, ${viaPlaylist} via playlist-details, ` +
      `${viaFavorites} via favorites). ${stillNull} row(s) remain without an envelope.`,
  );
}

/**
 * Migration 19 — Pass A. Fill `cached_items.raw_json` for every `album` and
 * `playlist` item whose envelope is NULL, using the same local caches
 * Migration 18 used: the `album_details` SQL table for albums, the
 * `substreamer-playlist-details` blob for playlists. Songs live in
 * `cached_songs.raw_json` so we strip `.song[]` / `.entry[]` from the
 * envelope before writing.
 *
 * `favorites` (__starred__) and `song` items have no natural envelope
 * and are skipped.
 */
async function backfillCachedItemEnvelopes(
  log: (message: string) => void,
): Promise<void> {
  const db = getDb();
  if (!db) {
    log('DB unavailable — skipping item-envelope backfill.');
    return;
  }

  const pending = db.getAllSync<{ item_id: string; type: string }>(
    "SELECT item_id, type FROM cached_items WHERE raw_json IS NULL AND type IN ('album', 'playlist');",
  );
  if (pending.length === 0) {
    log('All cached_items rows already carry an envelope — nothing to backfill.');
    return;
  }

  // Pre-build lookups once so we don't re-parse the playlist blob per row.
  let albumDetails: Record<string, { album: unknown; retrievedAt: number }> = {};
  try {
    albumDetails = hydrateAlbumDetails();
  } catch (e) {
    log(`[diag] album_details hydrate threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  let playlistBlob: Record<string, { playlist: unknown }> = {};
  try {
    const raw = await kvStorage.getItem('substreamer-playlist-details');
    if (raw) {
      const parsed = JSON.parse(raw);
      const source = parsed?.state?.playlists;
      if (source && typeof source === 'object') {
        playlistBlob = source as Record<string, { playlist: unknown }>;
      }
    }
  } catch (e) {
    log(`[diag] playlist-details blob read threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  let albumsDone = 0;
  let playlistsDone = 0;
  let skipped = 0;

  try {
    db.withTransactionSync(() => {
      for (const row of pending) {
        let envelope: string | null = null;
        if (row.type === 'album') {
          const album = albumDetails[row.item_id]?.album as any;
          if (album) {
            const { song: _s, ...meta } = album;
            envelope = JSON.stringify(meta);
          }
        } else if (row.type === 'playlist') {
          const pl = playlistBlob[row.item_id]?.playlist as any;
          if (pl) {
            const { entry: _e, ...meta } = pl;
            envelope = JSON.stringify(meta);
          }
        }
        if (envelope !== null) {
          db.runSync(
            'UPDATE cached_items SET raw_json = ? WHERE item_id = ? AND raw_json IS NULL;',
            [envelope, row.item_id],
          );
          if (row.type === 'album') albumsDone++;
          else playlistsDone++;
        } else {
          skipped++;
        }
      }
    });
  } catch (e) {
    log(`[diag] UPDATE transaction threw: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  log(
    `Backfilled ${albumsDone} album + ${playlistsDone} playlist envelope(s); ` +
      `${skipped} row(s) had no local source and remain NULL.`,
  );
}

/**
 * Migration 19 — Pass B. The Migration 14 path wrote the v1 7-field `track`
 * shape into `download_queue.songs_json`. Replace those lean entries with
 * the full Subsonic `Child` from `cached_songs.raw_json` wherever we can.
 *
 * A queue row whose entries already look full (cheapest sentinel: any
 * entry has `isDir`, a required field on the API type) is skipped — those
 * came from a post-bfe1886 runtime write and are already correct.
 */
async function repairDownloadQueueSongsJson(
  log: (message: string) => void,
): Promise<void> {
  const db = getDb();
  if (!db) return;

  const rows = db.getAllSync<{ queue_id: string; songs_json: string }>(
    'SELECT queue_id, songs_json FROM download_queue;',
  );
  if (rows.length === 0) {
    log('download_queue empty — no repair needed.');
    return;
  }

  // Preload cached_songs.raw_json keyed by id so each queue row's scan is O(n).
  const songEnvelopes = new Map<string, unknown>();
  try {
    const songRows = db.getAllSync<{ song_id: string; raw_json: string | null }>(
      'SELECT song_id, raw_json FROM cached_songs WHERE raw_json IS NOT NULL;',
    );
    for (const r of songRows) {
      if (!r.raw_json) continue;
      try {
        songEnvelopes.set(r.song_id, JSON.parse(r.raw_json));
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* best-effort */
  }

  let repaired = 0;
  let alreadyFull = 0;
  let malformed = 0;

  try {
    db.withTransactionSync(() => {
      for (const row of rows) {
        let entries: any[];
        try {
          entries = JSON.parse(row.songs_json);
        } catch {
          malformed++;
          continue;
        }
        if (!Array.isArray(entries) || entries.length === 0) continue;
        if (entries.every((e) => e && typeof e.isDir === 'boolean')) {
          // Every entry already has the API-required `isDir` flag — this is
          // a post-migration-14 write with full envelopes. Leave alone.
          alreadyFull++;
          continue;
        }

        let changed = false;
        const repairedEntries = entries.map((e) => {
          if (!e?.id) return e;
          if (typeof e.isDir === 'boolean') return e; // already full
          const full = songEnvelopes.get(e.id);
          if (full) {
            changed = true;
            return full;
          }
          return e;
        });

        if (changed) {
          db.runSync(
            'UPDATE download_queue SET songs_json = ? WHERE queue_id = ?;',
            [JSON.stringify(repairedEntries), row.queue_id],
          );
          repaired++;
        }
      }
    });
  } catch (e) {
    log(`[diag] UPDATE transaction threw: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  log(
    `download_queue repair: ${repaired} row(s) rewritten, ` +
      `${alreadyFull} already full, ${malformed} malformed.`,
  );
}

/**
 * Migration 20 body. Scans `cached_songs` for every distinct `album_id`
 * (skipping the `_unknown` sentinel), and for each one that does NOT have
 * a corresponding `type='album'` `cached_items` row creates one with all
 * edges pointing at the downloaded songs for that album.
 *
 * Metadata preference, richest first:
 *   1. `album_details` — authoritative `AlbumID3` envelope (full metadata
 *      + `songCount`).
 *   2. First cached_song's `raw_json` (Child envelope) — gives us `.album`
 *      name, `.artist`, `.coverArt`, and (indirectly) a per-track number.
 *   3. Hot columns on `cached_songs` — `album`, `artist`, `coverArt`.
 *
 * Edges are inserted in album track order: `discNumber` ASC, `track` ASC,
 * `id` ASC (stable tiebreak). Track/disc data is read from each song's
 * `raw_json` Child envelope, populated by Migration 18.
 */
async function backfillMissingPartialAlbums(
  log: (message: string) => void,
): Promise<void> {
  const db = getDb();
  if (!db) {
    log('DB unavailable — skipping partial-album backfill.');
    return;
  }

  // Step 1: gather all cached_songs grouped by albumId.
  const rows = db.getAllSync<{
    song_id: string;
    album_id: string;
    album: string | null;
    artist: string | null;
    cover_art: string | null;
    title: string | null;
    raw_json: string | null;
  }>(
    `SELECT song_id, album_id, album, artist, cover_art, title, raw_json
       FROM cached_songs
       WHERE album_id IS NOT NULL AND album_id != '_unknown';`,
  );
  if (rows.length === 0) {
    log('No cached_songs rows — nothing to backfill.');
    return;
  }

  // Step 2: existing album items (any type). We only skip when an
  // existing row has `type='album'`; a `playlist`/`favorites` row with
  // the same id is impossible (item_id is the album id, and playlist ids
  // don't collide with album ids in practice — if they do, we still want
  // the album row created so leave it to the UPSERT; the existing row
  // would have a different type).
  const existingAlbumItems = new Set(
    db
      .getAllSync<{ item_id: string }>(
        "SELECT item_id FROM cached_items WHERE type = 'album';",
      )
      .map((r) => r.item_id),
  );

  const byAlbum = new Map<
    string,
    Array<{
      songId: string;
      album: string | null;
      artist: string | null;
      coverArt: string | null;
      title: string | null;
      rawJson: string | null;
    }>
  >();
  for (const r of rows) {
    if (existingAlbumItems.has(r.album_id)) continue;
    let list = byAlbum.get(r.album_id);
    if (!list) {
      list = [];
      byAlbum.set(r.album_id, list);
    }
    list.push({
      songId: r.song_id,
      album: r.album,
      artist: r.artist,
      coverArt: r.cover_art,
      title: r.title,
      rawJson: r.raw_json,
    });
  }
  if (byAlbum.size === 0) {
    log('Every album_id already has a cached_items row — nothing to backfill.');
    return;
  }

  // Step 3: preload album_details once so we can enrich every group.
  let albumDetails: Record<string, { album: any; retrievedAt: number }> = {};
  try {
    albumDetails = hydrateAlbumDetails();
  } catch (e) {
    log(`[diag] album_details hydrate threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  let created = 0;
  let edgesInserted = 0;
  const now = Date.now();

  try {
    db.withTransactionSync(() => {
      for (const [albumId, members] of byAlbum) {
        const detail = albumDetails[albumId]?.album;
        const firstRaw = members.find((m) => m.rawJson)?.rawJson ?? null;
        let firstChild: any = null;
        if (firstRaw) {
          try {
            firstChild = JSON.parse(firstRaw);
          } catch {
            /* ignore malformed */
          }
        }

        const firstMember = members[0];
        const name: string =
          (typeof detail?.name === 'string' && detail.name) ||
          (typeof firstChild?.album === 'string' && firstChild.album) ||
          firstMember.album ||
          'Unknown';
        const artist: string | null =
          (typeof detail?.artist === 'string' && detail.artist) ||
          (typeof firstChild?.artist === 'string' && firstChild.artist) ||
          firstMember.artist ||
          null;
        const coverArt: string | null =
          (typeof detail?.coverArt === 'string' && detail.coverArt) ||
          (typeof firstChild?.coverArt === 'string' && firstChild.coverArt) ||
          firstMember.coverArt ||
          null;
        const expectedSongCount =
          typeof detail?.songCount === 'number'
            ? detail.songCount
            : Array.isArray(detail?.song)
              ? detail.song.length
              : Math.max(members.length, 1);
        let envelope: string | null = null;
        if (detail) {
          const { song: _songs, ...meta } = detail;
          envelope = JSON.stringify(meta);
        }

        // Sort members in album order using Child envelope fields.
        const withOrder = members.map((m) => {
          let disc = Number.MAX_SAFE_INTEGER;
          let track = Number.MAX_SAFE_INTEGER;
          if (m.rawJson) {
            try {
              const child = JSON.parse(m.rawJson);
              if (typeof child?.discNumber === 'number') disc = child.discNumber;
              if (typeof child?.track === 'number') track = child.track;
            } catch {
              /* ignore malformed */
            }
          }
          return { ...m, disc, track };
        });
        withOrder.sort((a, b) => {
          if (a.disc !== b.disc) return a.disc - b.disc;
          if (a.track !== b.track) return a.track - b.track;
          return defaultCollator.compare(a.songId, b.songId);
        });

        // Insert album row.
        db.runSync(
          `INSERT INTO cached_items
             (item_id, type, name, artist, cover_art_id, expected_song_count,
              parent_album_id, last_sync_at, downloaded_at, raw_json)
             VALUES (?, 'album', ?, ?, ?, ?, NULL, ?, ?, ?)
             ON CONFLICT(item_id) DO NOTHING;`,
          [albumId, name, artist, coverArt, expectedSongCount, now, now, envelope],
        );
        created++;

        // Insert edges — `INSERT OR IGNORE` against the unique
        // `(item_id, song_id)` index so an accidental double-run doesn't
        // create duplicates. Positions start at 1 in album order.
        let position = 1;
        for (const m of withOrder) {
          db.runSync(
            'INSERT OR IGNORE INTO cached_item_songs (item_id, position, song_id) VALUES (?, ?, ?);',
            [albumId, position, m.songId],
          );
          edgesInserted++;
          position++;
        }
      }
    });
  } catch (e) {
    log(`[diag] backfill transaction threw: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  log(
    `Created ${created} partial-album row(s) with ${edgesInserted} edge(s) ` +
      `across ${byAlbum.size} album_id(s).`,
  );
}

/* ------------------------------------------------------------------ */
/*  Migration 22 — reconcile image cache to full cover-art IDs         */
/* ------------------------------------------------------------------ */

/**
 * Historical strip — produced the legacy `cached_images.cover_art_id`
 * by lopping off a trailing `_<hex>` segment. Disabled as of v8.0.59.
 * Migration 22 still needs to reproduce the old form so it can find
 * pre-migration rows.
 */
const MIGRATION_22_HEX_RE = /^[0-9a-f]+$/i;
function legacyStripCoverArtSuffix(id: string): string {
  const i = id.lastIndexOf('_');
  if (i <= 0) return id;
  const suffix = id.slice(i + 1);
  if (!MIGRATION_22_HEX_RE.test(suffix)) return id;
  return id.slice(0, i);
}

/**
 * Historical filesystem sanitisation — replaced FS-unsafe characters
 * with `_`. The new sanitisation is reversible percent encoding; this
 * function lets us identify pre-migration directory names so we can
 * rename them.
 */
const MIGRATION_22_LEGACY_FS_UNSAFE = /[:\\/?<>*|"\x00]/g;
function legacyPathKey(coverArtId: string): string {
  return coverArtId.replace(MIGRATION_22_LEGACY_FS_UNSAFE, '_');
}

/**
 * New filesystem sanitisation — percent-encodes unsafe chars including
 * `%` itself so the mapping is injective. Mirrors the production
 * `coverArtPathKey` in `imageCacheService.ts`; duplicated here so the
 * migration is self-contained.
 */
const MIGRATION_22_FS_UNSAFE = /[%:\\/?<>*|"\x00]/g;
function newPathKey(coverArtId: string): string {
  return coverArtId.replace(MIGRATION_22_FS_UNSAFE, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'),
  );
}

/**
 * Migration 22 body.
 *
 * Background: the legacy `stripCoverArtSuffix` chopped the trailing
 * `_<hex>` re-index segment off cover-art IDs before they were written
 * to `cached_images.cover_art_id` and used as on-disk directory names.
 * We now use raw server IDs end-to-end. This migration reconciles the
 * existing on-device state without going to the network — every other
 * table (`cached_items.cover_art_id`, `cached_songs.cover_art`,
 * `song_index.coverArt`, `download_queue.cover_art_id`, and the
 * `raw_json` envelopes) already held the full ID, so we can cross-
 * reference and rewrite.
 *
 * After this runs:
 *   - `cached_images.cover_art_id` holds the full server ID.
 *   - `image-cache/<dir>/` directories are renamed to the new
 *     percent-encoded path of the full server ID.
 *   - Orphan rows + dirs (no entity in the local DB references them)
 *     are evicted; the next online access repopulates them.
 *
 * The recache pass (Phase 3 in the project plan, mounted at app
 * startup) handles fetching fresh server art under the canonical IDs
 * for every downloaded album/playlist — this migration does not need
 * the network.
 *
 * Idempotent: re-running on already-clean data produces an empty
 * mapping (every cover_art column already holds a full ID; no full ID
 * strips to a different form), so all branches no-op.
 */
async function reconcileImageCacheCoverArtIds(
  log: (message: string) => void,
): Promise<void> {
  const db = getDb();
  if (!db) {
    log('DB unavailable — skipping image-cache reconciliation.');
    return;
  }

  // ---------------------------------------------------------------
  // Step 1: collect all known full server cover-art IDs from every
  // table that already held them, and derive two mappings:
  //   - sqlMapping: legacyStrip(F) -> F   (rewrites `cached_images.cover_art_id`)
  //   - fsMapping : legacyPathKey(legacyStrip(F)) -> F  (renames disk dirs)
  // First writer wins; collisions keep the lex-greatest full ID
  // (proxy for newest re-index).
  // ---------------------------------------------------------------
  const allFullIds = new Set<string>();
  const sqlMapping = new Map<string, string>();
  const fsMapping = new Map<string, string>();
  let collisions = 0;

  function record(fullId: string | null | undefined): void {
    if (!fullId) return;
    allFullIds.add(fullId);

    // SQL legacy key: the historical `cached_images.cover_art_id` value.
    const legacySql = legacyStripCoverArtSuffix(fullId);
    if (legacySql !== fullId) {
      const existing = sqlMapping.get(legacySql);
      if (existing === undefined) {
        sqlMapping.set(legacySql, fullId);
      } else if (existing !== fullId) {
        collisions++;
        if (fullId > existing) sqlMapping.set(legacySql, fullId);
      }
    }

    // FS legacy dir name: legacy strip followed by the legacy `_`
    // substitution. Only worth a rename if the new path differs.
    const legacyDir = legacyPathKey(legacySql);
    const newDir = newPathKey(fullId);
    if (legacyDir !== newDir) {
      const existing = fsMapping.get(legacyDir);
      if (existing === undefined) {
        fsMapping.set(legacyDir, fullId);
      } else if (existing !== fullId && fullId > existing) {
        fsMapping.set(legacyDir, fullId);
      }
    }
  }

  try {
    const rows = db.getAllSync<{ cover_art_id: string | null }>(
      `SELECT DISTINCT cover_art_id FROM cached_items WHERE cover_art_id IS NOT NULL;`,
    );
    for (const r of rows) record(r.cover_art_id);
  } catch (e) {
    log(`[m22] cached_items source threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const rows = db.getAllSync<{ cover_art: string | null }>(
      `SELECT DISTINCT cover_art FROM cached_songs WHERE cover_art IS NOT NULL;`,
    );
    for (const r of rows) record(r.cover_art);
  } catch (e) {
    log(`[m22] cached_songs source threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const rows = db.getAllSync<{ cover_art_id: string | null }>(
      `SELECT DISTINCT cover_art_id FROM download_queue WHERE cover_art_id IS NOT NULL;`,
    );
    for (const r of rows) record(r.cover_art_id);
  } catch (e) {
    log(`[m22] download_queue source threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  // song_index column is `coverArt` (no underscore in the camelCase
  // column name actually used). Defensive try/catch in case the table
  // doesn't exist on very old installs.
  try {
    const rows = db.getAllSync<{ coverArt: string | null }>(
      `SELECT DISTINCT coverArt FROM song_index WHERE coverArt IS NOT NULL;`,
    );
    for (const r of rows) record(r.coverArt);
  } catch (e) {
    log(`[m22] song_index source threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Belt-and-braces: raw_json extracts. Should be a no-op given the
  // normalised columns above already covered them, but keeps the
  // migration robust if normalised columns ever drift.
  try {
    const rows = db.getAllSync<{ c: string | null }>(
      `SELECT DISTINCT json_extract(raw_json, '$.coverArt') AS c
         FROM cached_items WHERE raw_json IS NOT NULL;`,
    );
    for (const r of rows) record(r.c);
  } catch (e) {
    log(`[m22] cached_items.raw_json source threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const rows = db.getAllSync<{ c: string | null }>(
      `SELECT DISTINCT json_extract(raw_json, '$.coverArt') AS c
         FROM cached_songs WHERE raw_json IS NOT NULL;`,
    );
    for (const r of rows) record(r.c);
  } catch (e) {
    log(`[m22] cached_songs.raw_json source threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  log(
    `[m22] mapping: ${allFullIds.size} full ID(s), ${sqlMapping.size} SQL key(s) → rewrite, ` +
      `${fsMapping.size} FS dir(s) → rename, ${collisions} collision(s)`,
  );

  // ---------------------------------------------------------------
  // Step 2: reconcile cached_images rows.
  //   - mapped legacy key → UPDATE row to full ID
  //   - already at canonical full ID → skip
  //   - otherwise (orphan) → DELETE row
  // ---------------------------------------------------------------
  let sqlRowsUpdated = 0;
  let sqlRowsEvicted = 0;
  let sqlPkConflictsResolved = 0;

  try {
    db.withTransactionSync(() => {
      const existingRows = db.getAllSync<{ cover_art_id: string }>(
        `SELECT DISTINCT cover_art_id FROM cached_images;`,
      );

      for (const row of existingRows) {
        const cur = row.cover_art_id;

        // Already canonical → idempotent skip.
        if (allFullIds.has(cur)) continue;

        const fullId = sqlMapping.get(cur);
        if (fullId === undefined) {
          // Orphan — no entity in the local DB references this cover.
          const before = db.getFirstSync<{ c: number }>(
            `SELECT COUNT(*) AS c FROM cached_images WHERE cover_art_id = ?;`,
            [cur],
          );
          db.runSync(
            `DELETE FROM cached_images WHERE cover_art_id = ?;`,
            [cur],
          );
          sqlRowsEvicted += before?.c ?? 0;
          continue;
        }
        if (fullId === cur) continue; // shouldn't happen — sqlMapping skips identity — defensive only

        // Rewrite the row. Composite PK (cover_art_id, size) could collide
        // if a previous abandoned migration already inserted under fullId
        // at the same size. Reconcile size-by-size to handle that branch.
        const sizes = db.getAllSync<{ size: number; cached_at: number }>(
          `SELECT size, cached_at FROM cached_images WHERE cover_art_id = ?;`,
          [cur],
        );
        for (const s of sizes) {
          const dst = db.getFirstSync<{ cached_at: number }>(
            `SELECT cached_at FROM cached_images WHERE cover_art_id = ? AND size = ?;`,
            [fullId, s.size],
          );
          if (dst === undefined) {
            db.runSync(
              `UPDATE cached_images SET cover_art_id = ? WHERE cover_art_id = ? AND size = ?;`,
              [fullId, cur, s.size],
            );
            sqlRowsUpdated++;
          } else {
            sqlPkConflictsResolved++;
            // Keep the row with the newer cached_at — drop the loser.
            if (s.cached_at > dst.cached_at) {
              db.runSync(
                `DELETE FROM cached_images WHERE cover_art_id = ? AND size = ?;`,
                [fullId, s.size],
              );
              db.runSync(
                `UPDATE cached_images SET cover_art_id = ? WHERE cover_art_id = ? AND size = ?;`,
                [fullId, cur, s.size],
              );
              sqlRowsUpdated++;
            } else {
              db.runSync(
                `DELETE FROM cached_images WHERE cover_art_id = ? AND size = ?;`,
                [cur, s.size],
              );
            }
          }
        }
      }
    });
  } catch (e) {
    log(`[m22] SQL transaction threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ---------------------------------------------------------------
  // Step 3: rename / evict on-disk image-cache directories.
  // ---------------------------------------------------------------
  let dirsRenamed = 0;
  let dirsMerged = 0;
  let dirsEvicted = 0;
  let dirsSkipped = 0;
  let dirsUnknown = 0;

  const root = new Directory(Paths.document, 'image-cache');
  if (!root.exists) {
    log(
      `[m22] no image-cache dir present — sql=${sqlRowsUpdated} updated, ` +
        `${sqlRowsEvicted} evicted, ${sqlPkConflictsResolved} pk-conflicts; ` +
        `fs=skip (no dir).`,
    );
    return;
  }

  // Pre-compute the canonical FS-dir name for every known full ID so we
  // can recognise (and skip) directories that are already at the right
  // place on a fresh install or a re-run.
  const canonicalDirs = new Set<string>();
  for (const f of allFullIds) canonicalDirs.add(newPathKey(f));

  let topLevel: string[];
  try {
    topLevel = await listDirectoryAsync(root.uri);
  } catch (e) {
    log(`[m22] could not enumerate image-cache dir: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  for (const name of topLevel) {
    if (!name) continue;

    // Skip metadata sidecars: only handle subdirectories.
    const src = new Directory(root, name);
    if (!src.exists) continue;

    // (1) Already at the canonical new path for some full ID → idempotent skip.
    if (canonicalDirs.has(name)) {
      dirsSkipped++;
      continue;
    }

    // (2) Recognised as a legacy stripped/sanitised form → rename to canonical.
    const fullId = fsMapping.get(name);
    if (fullId !== undefined) {
      const dstName = newPathKey(fullId);
      const dst = new Directory(root, dstName);
      if (!dst.exists) {
        try {
          dst.create();
        } catch (e) {
          log(`[m22] could not create ${dstName}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
      } else {
        dirsMerged++;
      }

      let fileNames: string[] = [];
      try {
        fileNames = await listDirectoryAsync(src.uri);
      } catch {
        continue;
      }
      for (const fileName of fileNames) {
        const srcFile = new File(src, fileName);
        if (!srcFile.exists) continue;
        const dstFile = new File(dst, fileName);
        if (dstFile.exists) {
          // Collision — keep existing (already merged or canonical).
          try { srcFile.delete(); } catch { /* best-effort */ }
          continue;
        }
        try { srcFile.move(dstFile); } catch { /* best-effort */ }
      }
      try { src.delete(); } catch { /* best-effort */ }
      dirsRenamed++;
      continue;
    }

    // (3) Unrecognised — orphan or stale. Evict.
    try {
      src.delete();
      dirsEvicted++;
    } catch (e) {
      dirsUnknown++;
      log(`[m22] could not evict ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  log(
    `[m22] sql: ${sqlRowsUpdated} updated, ${sqlRowsEvicted} evicted, ` +
      `${sqlPkConflictsResolved} pk-conflicts. ` +
      `fs: ${dirsRenamed} renamed, ${dirsMerged} merged, ${dirsEvicted} evicted, ` +
      `${dirsSkipped} skipped, ${dirsUnknown} unknown-error.`,
  );

  // The post-Migration-22 recache used to be auto-triggered via the
  // (now-removed) coverArtRecacheStore. Under the persistent image queue
  // model, the user re-runs the refresh from Settings → Storage at their
  // convenience. No flag to reset.
}

/* ------------------------------------------------------------------ */
/*  Task definitions                                                   */
/* ------------------------------------------------------------------ */

const MIGRATION_TASKS: MigrationTask[] = [
  {
    id: 1,
    name: 'Legacy data migration',
    run: async (log) => {
      // Cordova cache folder names used across app versions.
      // 'music' and 'images' are from the earliest Substreamer releases;
      // 'musicCache', 'imageCache', 'podcastCache' from later versions.
      const legacyDirs = [
        'imageCache',
        'musicCache',
        'podcastCache',
        'images',
        'music',
      ];

      // cordova.file.dataDirectory maps to different native paths per platform:
      //   Android: getFilesDir()         → same as Expo Paths.document
      //   iOS:     Library/NoCloud/       → NOT Documents/
      // We also check the Cordova "internal" persistent root on Android
      // (getFilesDir() + "/files/") in case the W3C persistent API was used.
      const bases: Directory[] = [Paths.document];

      if (Platform.OS === 'android') {
        // Cordova "internal" persistent root: getFilesDir() + "/files/"
        bases.push(new Directory(Paths.document, 'files'));
      } else if (Platform.OS === 'ios') {
        // cordova.file.dataDirectory on iOS: Library/NoCloud/
        bases.push(
          new Directory(Paths.document.parentDirectory, 'Library', 'NoCloud'),
        );
      }

      for (const base of bases) {
        for (const name of legacyDirs) {
          const dir = new Directory(base, name);
          if (dir.exists) {
            try {
              dir.delete();
              log(`Removed: ${base.uri}${name}/`);
            } catch {
              log(`Failed to remove: ${base.uri}${name}/`);
            }
          } else {
            log(`Not found: ${base.uri}${name}/`);
          }
        }
      }
    },
  },

  {
    id: 2,
    name: 'Remove legacy Ionic database',
    run: async (log) => {
      let dbDir: Directory | undefined;

      if (Platform.OS === 'ios') {
        dbDir = new Directory(
          Paths.document.parentDirectory,
          'Library',
          'LocalDatabase',
        );
      } else if (Platform.OS === 'android') {
        dbDir = new Directory(Paths.document.parentDirectory, 'databases');
      }

      if (!dbDir?.exists) {
        log(`Database directory not found: ${dbDir?.uri ?? 'unknown'}`);
        return;
      }

      log(`Checking directory: ${dbDir.uri}`);

      const suffixes = ['', '-journal', '-wal', '-shm'];
      const basenames = ['__substreamer3', '__substreamer3.db'];

      for (const base of basenames) {
        for (const suffix of suffixes) {
          const fileName = base + suffix;
          const file = new File(dbDir, fileName);
          if (file.exists) {
            try {
              file.delete();
              log(`Removed: ${fileName}`);
            } catch {
              log(`Failed to remove: ${fileName}`);
            }
          } else {
            log(`Not found: ${fileName}`);
          }
        }
      }
    },
  },

  {
    id: 3,
    name: 'Build analytics aggregates',
    run: async (log) => {
      const state = completedScrobbleStore.getState();
      if (state.completedScrobbles.length === 0) {
        log('No scrobbles — skipping aggregate rebuild.');
        return;
      }
      state.rebuildAggregates();
      log(`Rebuilt aggregates for ${state.completedScrobbles.length} scrobbles.`);
    },
  },

  {
    id: 4,
    name: 'Fix corrupted shares data',
    run: async (log) => {
      const raw = await kvStorage.getItem('substreamer-shares');
      if (!raw) {
        log('No persisted shares data — skipping.');
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        const state = parsed?.state;
        if (state && !Array.isArray(state.shares)) {
          state.shares = [];
          kvStorage.setItem('substreamer-shares', JSON.stringify(parsed));
          log(`Fixed corrupted shares field (was ${typeof state.shares}).`);
        } else {
          log('Shares data is valid — no fix needed.');
        }
      } catch {
        /* Corrupted JSON — remove it entirely so the store starts fresh */
        kvStorage.removeItem('substreamer-shares');
        log('Removed unparseable shares data.');
      }
    },
  },

  {
    id: 5,
    name: 'Migrate MBID overrides to new shape',
    run: async (log) => {
      // Read raw from SQLite rather than from mbidOverrideStore.getState()
      // to avoid a race with Zustand rehydration: the store can still hold
      // its default empty state at the moment this migration runs, which
      // would cause the migration to silently skip and mark itself complete.
      const raw = await kvStorage.getItem('substreamer-mbid-overrides');
      if (!raw) {
        log('No persisted MBID overrides — skipping.');
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log('Failed to parse MBID overrides — skipping.');
        return;
      }
      const overrides = parsed?.state?.overrides;
      if (!overrides || typeof overrides !== 'object') {
        log('No overrides object in persisted data — skipping.');
        return;
      }
      const keys = Object.keys(overrides);
      if (keys.length === 0) {
        log('MBID overrides empty — skipping.');
        return;
      }

      // Check if already migrated (new keys use "artist:" or "album:" prefix)
      const alreadyMigrated = keys.some((k) => k.startsWith('artist:') || k.startsWith('album:'));
      if (alreadyMigrated) {
        log('MBID overrides already in new format — skipping.');
        return;
      }

      // Old format: keyed by artistId with { artistId, artistName, mbid }
      // New format: keyed by "artist:{artistId}" with { type, entityId, entityName, mbid }
      const migrated: Record<string, MbidOverride> = {};
      for (const key of keys) {
        const entry = overrides[key];
        const entityId = entry?.artistId ?? entry?.entityId ?? key;
        const entityName = entry?.artistName ?? entry?.entityName ?? '';
        const mbid = entry?.mbid;
        if (!mbid) continue;
        migrated[`artist:${entityId}`] = {
          type: 'artist',
          entityId,
          entityName,
          mbid,
        };
      }

      parsed.state.overrides = migrated;
      await kvStorage.setItem('substreamer-mbid-overrides', JSON.stringify(parsed));
      mbidOverrideStore.setState({ overrides: migrated });
      log(`Migrated ${keys.length} MBID override(s) to new format.`);
    },
  },

  {
    id: 6,
    name: 'Set platform default for estimate content length',
    run: async (log) => {
      const desired = Platform.OS === 'android';
      const raw = await kvStorage.getItem('substreamer-playback-settings');
      if (!raw) {
        playbackSettingsStore.setState({ estimateContentLength: desired });
        log('No persisted playback settings — set default on in-memory store.');
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        const state = parsed?.state;
        if (!state) {
          log('No state in persisted data — skipping.');
          return;
        }
        state.estimateContentLength = desired;
        await kvStorage.setItem('substreamer-playback-settings', JSON.stringify(parsed));
        // Also update the in-memory store so the current session reflects
        // the new value without waiting for an app restart.
        playbackSettingsStore.setState({ estimateContentLength: desired });
        log(`Set estimateContentLength to ${desired} (${Platform.OS}).`);
      } catch {
        log('Failed to parse playback settings — new default will apply.');
      }
    },
  },

  {
    id: 7,
    name: 'Stamp backup files with user identity',
    run: async (log) => {
      await stampV3BackupsFromStoredAuth(log);
    },
  },

  {
    id: 8,
    name: 'Repair MBID override shape',
    run: async (log) => {
      // Forward-only idempotent repair: walks the persisted MBID
      // overrides and normalizes any entries left in an inconsistent
      // shape by the original buggy Migration 5 (which read from
      // mbidOverrideStore.getState() before rehydration completed).
      // Runs unconditionally for every user — a no-op on fresh installs
      // and correctly-migrated users.
      const raw = await kvStorage.getItem('substreamer-mbid-overrides');
      if (!raw) {
        log('No persisted MBID overrides — nothing to repair.');
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log('Failed to parse MBID overrides — skipping repair.');
        return;
      }
      const overrides = parsed?.state?.overrides;
      if (!overrides || typeof overrides !== 'object') {
        log('No overrides object — nothing to repair.');
        return;
      }

      const repaired: Record<string, MbidOverride> = {};
      let repairCount = 0;
      let skippedCount = 0;
      const totalCount = Object.keys(overrides).length;

      for (const [key, value] of Object.entries(overrides) as [string, any][]) {
        if (!value || typeof value !== 'object' || !value.mbid) {
          skippedCount++;
          continue;
        }

        // Already in new shape: key has prefix AND entry has all required fields
        const hasPrefix = key.startsWith('artist:') || key.startsWith('album:');
        const hasNewFields =
          (value.type === 'artist' || value.type === 'album') &&
          typeof value.entityId === 'string';

        if (hasPrefix && hasNewFields) {
          repaired[key] = {
            type: value.type,
            entityId: value.entityId,
            entityName: typeof value.entityName === 'string' ? value.entityName : '',
            mbid: value.mbid,
          };
          continue;
        }

        // Synthesize a normalized entry. Default to 'artist' since the
        // old shape only had artist overrides — there was no album variant.
        const type: MbidOverride['type'] =
          value.type === 'album' || key.startsWith('album:') ? 'album' : 'artist';
        const entityId: string =
          value.entityId ?? value.artistId ?? (hasPrefix ? key.split(':')[1] : key);
        const entityName: string = value.entityName ?? value.artistName ?? '';
        const newKey = `${type}:${entityId}`;
        repaired[newKey] = { type, entityId, entityName, mbid: value.mbid };
        repairCount++;
      }

      if (repairCount === 0 && skippedCount === 0) {
        log(`All ${totalCount} override(s) already in correct shape.`);
        return;
      }

      parsed.state.overrides = repaired;
      await kvStorage.setItem('substreamer-mbid-overrides', JSON.stringify(parsed));
      mbidOverrideStore.setState({ overrides: repaired });
      log(
        `Repaired ${repairCount} entries, skipped ${skippedCount} malformed, ` +
        `${Object.keys(repaired).length} total after repair.`,
      );
    },
  },

  {
    id: 9,
    name: 'Repair v3 backup identity stamping',
    run: async (log) => {
      // Forward-only repair for users whose original Migration 7 silently
      // skipped stamping because authStore had not rehydrated yet, leaving
      // their v3 backups invisible in the UI. Delegates to the same helper
      // Migration 7 now uses. migrateV3BackupMetas is a no-op on already-v4
      // files, so this is safe for users who ran Migration 7 correctly and
      // for fresh installs.
      await stampV3BackupsFromStoredAuth(log);
    },
  },

  {
    id: 10,
    name: 'Backfill downloaded track formats (deprecated in v2)',
    run: async (log) => {
      // In v1 this migration backfilled the `downloadedFormats` map on the
      // musicCacheStore blob. In the v2 re-architecture (see
      // `plans/music-downloads-v2.md`) format metadata lives inline on the
      // `cached_songs` per-row table, so there is no longer a separate map
      // to populate here. Task #14 owns the v1→v2 migration and carries any
      // format info over during that pass. Kept as a no-op so the migration
      // ID sequence is preserved for users whose `completedVersion` is < 10.
      log('Task deprecated in v2; format data now lives in cached_songs — skipping.');
    },
  },

  {
    id: 11,
    name: 'Migrate legacy zh locale to zh-Hans',
    run: async (log) => {
      // Users who explicitly picked Chinese before the Simplified/Traditional
      // split had locale === 'zh'. That code is no longer in the supported
      // list, so left unchanged it would fall back to English on next launch.
      // Remap to 'zh-Hans' to preserve their previous (Simplified) experience.
      const raw = await kvStorage.getItem('substreamer-locale');
      if (!raw) {
        log('No persisted locale — skipping.');
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log('Failed to parse locale — skipping.');
        return;
      }
      const state = parsed?.state;
      if (!state) {
        log('No state in persisted locale — skipping.');
        return;
      }
      if (state.locale !== 'zh') {
        log(`Stored locale is ${state.locale ?? 'null'} — no remap needed.`);
        return;
      }
      state.locale = 'zh-Hans';
      await kvStorage.setItem('substreamer-locale', JSON.stringify(parsed));
      localeStore.setState({ locale: 'zh-Hans' });
      log('Remapped legacy "zh" locale preference to "zh-Hans".');
    },
  },

  {
    id: 12,
    name: 'Move album details to per-row SQLite tables',
    run: async (log) => {
      // albumDetailStore moved off the generic `persist(createJSONStorage)`
      // blob model to per-row tables (`album_details`, `song_index`) owned
      // by `src/store/persistence/detailTables.ts`. This task reads the old
      // blob once, upserts each album into the new tables, and deletes the
      // old blob key. Idempotent: if the blob is missing or already been
      // migrated, it's a no-op.
      const raw = await kvStorage.getItem('substreamer-album-details');
      if (!raw) {
        log('No persisted album-details blob — nothing to migrate.');
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Corrupt blob — drop it so the new tables start clean.
        await kvStorage.removeItem('substreamer-album-details');
        log('Failed to parse album-details blob — removed.');
        return;
      }
      const albums: Record<string, { album: any; retrievedAt?: number }> =
        parsed?.state?.albums ?? {};
      const ids = Object.keys(albums);
      if (ids.length === 0) {
        await kvStorage.removeItem('substreamer-album-details');
        log('Album-details blob was empty — removed.');
        return;
      }
      let albumCount = 0;
      let songCount = 0;
      for (const id of ids) {
        const entry = albums[id];
        const album = entry?.album;
        if (!album || typeof album !== 'object' || !album.id) continue;
        const retrievedAt = typeof entry.retrievedAt === 'number' ? entry.retrievedAt : Date.now();
        upsertAlbumDetail(id, album, retrievedAt);
        const songs = Array.isArray(album.song) ? album.song : [];
        upsertSongsForAlbum(id, songs);
        albumCount++;
        songCount += songs.length;
      }
      await kvStorage.removeItem('substreamer-album-details');
      log(`Migrated ${albumCount} album detail(s) and ${songCount} song(s) to per-row tables.`);
    },
  },

  {
    id: 13,
    name: 'Move completed scrobbles to per-row SQLite table',
    run: async (log) => {
      // completedScrobbleStore moved off the generic `persist(createJSONStorage)`
      // blob model onto the per-row `scrobble_events` table owned by
      // `src/store/persistence/scrobbleTable.ts`. This task reads the old blob
      // once, bulk-inserts valid scrobbles into the new table via a
      // transaction, then deletes the blob key. Idempotent: if the blob is
      // missing or already been migrated, it's a no-op.
      const raw = await kvStorage.getItem('substreamer-completed-scrobbles');
      if (!raw) {
        log('No persisted scrobble blob — nothing to migrate.');
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Corrupt blob — drop it so the new table starts clean.
        await kvStorage.removeItem('substreamer-completed-scrobbles');
        log('Failed to parse scrobble blob — removed.');
        return;
      }
      const raws: any[] = Array.isArray(parsed?.state?.completedScrobbles)
        ? parsed.state.completedScrobbles
        : [];
      if (raws.length === 0) {
        await kvStorage.removeItem('substreamer-completed-scrobbles');
        log('Scrobble blob was empty — removed.');
        return;
      }
      const valid: CompletedScrobble[] = [];
      const seen = new Set<string>();
      for (const s of raws) {
        if (!s || !s.id || !s.song?.id || !s.song?.title) continue;
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        valid.push(s as CompletedScrobble);
      }
      // Transactional bulk insert — blob removal only runs if the transaction
      // commits, so a mid-migration crash preserves the original blob for the
      // next launch to retry.
      replaceAllScrobbles(valid);
      await kvStorage.removeItem('substreamer-completed-scrobbles');
      const dropped = raws.length - valid.length;
      log(
        `Migrated ${valid.length} scrobble(s) to per-row table` +
          (dropped > 0 ? ` (dropped ${dropped} invalid/duplicate).` : '.'),
      );
    },
  },

  {
    id: 14,
    name: 'Move music cache to per-row SQLite tables and album-rooted directory layout',
    run: async (log) => {
      // musicCacheStore moved off the v1 monolithic
      // `substreamer-music-cache` blob + `{music-cache}/{itemId}/{trackId}.{ext}`
      // directory layout onto per-row SQLite tables
      // (`cached_items`, `cached_songs`, `cached_item_songs`,
      // `download_queue`) owned by
      // `src/store/persistence/musicCacheTables.ts`, with on-disk files
      // re-rooted under `{music-cache}/{albumId}/{songId}.{ext}`. v1 album
      // downloads already used this layout so they're a no-op migration;
      // playlist/__starred__ downloads move their files into the owning
      // album's directory (with dedup — duplicates across items collapse
      // to a single file).
      //
      // See `migrateMusicCacheFromBlob` for the full migration body.
      await migrateMusicCacheFromBlob(log);

      // Per-row tables are the canonical source of truth from here on.
      // Remove the v1 blob so a later migration can't resurrect stale
      // data after a `Clear All` / logout, and so the `storage` table
      // isn't carrying dead weight.
      await kvStorage.removeItem('substreamer-music-cache');
      log('v1 blob removed — per-row tables are the sole source of truth.');
    },
  },

  {
    id: 15,
    name: 'Move pending scrobbles to per-row SQLite table',
    run: async (log) => {
      // pendingScrobbleStore moved off the generic `persist(createJSONStorage)`
      // blob model onto the per-row `pending_scrobble_events` table owned by
      // `src/store/persistence/pendingScrobbleTable.ts`. Mirrors Task 13
      // (completed scrobbles). Transactional bulk insert — blob removal only
      // runs after the transaction commits, so a mid-migration crash preserves
      // the original blob for the next launch to retry.
      const raw = await kvStorage.getItem('substreamer-scrobbles');
      if (!raw) {
        log('No persisted pending scrobble blob — nothing to migrate.');
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await kvStorage.removeItem('substreamer-scrobbles');
        log('Failed to parse pending scrobble blob — removed.');
        return;
      }
      const raws: any[] = Array.isArray(parsed?.state?.pendingScrobbles)
        ? parsed.state.pendingScrobbles
        : [];
      if (raws.length === 0) {
        await kvStorage.removeItem('substreamer-scrobbles');
        log('Pending scrobble blob was empty — removed.');
        return;
      }
      const valid: PendingScrobble[] = [];
      const seen = new Set<string>();
      for (const s of raws) {
        if (!s || !s.id || !s.song?.id || !s.song?.title) continue;
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        valid.push(s as PendingScrobble);
      }
      replaceAllPendingScrobbles(valid);
      await kvStorage.removeItem('substreamer-scrobbles');
      const dropped = raws.length - valid.length;
      log(
        `Migrated ${valid.length} pending scrobble(s) to per-row table` +
          (dropped > 0 ? ` (dropped ${dropped} invalid/duplicate).` : '.'),
      );
    },
  },

  {
    id: 16,
    name: 'Index on-disk image cache into per-row SQLite table',
    run: async (log) => {
      // imageCacheStore moved off the monolithic aggregate blob. This task
      // walks the existing `{image-cache}/{coverArtId}/{size}.{ext}` tree
      // once, inserts one row per variant into `cached_images`, and removes
      // the legacy aggregates blob. Subsequent launches skip the walk and
      // read everything from SQL.
      //
      // Idempotent: uses UPSERT on (cover_art_id, size). Re-running is a
      // no-op against a populated table.
      const imageCacheDir = new Directory(Paths.document, 'image-cache');
      if (!imageCacheDir.exists) {
        log('No image-cache directory on disk — nothing to index.');
        await kvStorage.removeItem('substreamer-image-cache-stats');
        return;
      }

      const SIZE_FILE_RE = /^(50|150|300|600)\.(jpg|png|webp)$/;
      const rows: Array<{
        coverArtId: string;
        size: number;
        ext: string;
        bytes: number;
        cachedAt: number;
      }> = [];

      let topLevelNames: string[] = [];
      try {
        const listed = await listDirectoryAsync(imageCacheDir.uri);
        topLevelNames = Array.isArray(listed) ? listed : [];
      } catch {
        /* best-effort */
      }

      const now = Date.now();
      let skippedTmp = 0;
      let skippedUnknown = 0;
      for (const coverArtId of topLevelNames) {
        if (!coverArtId) continue;
        const subDir = new Directory(imageCacheDir, coverArtId);
        if (!subDir.exists) continue;
        let fileNames: string[] = [];
        try {
          const listed = await listDirectoryAsync(subDir.uri);
          fileNames = Array.isArray(listed) ? listed : [];
        } catch {
          continue;
        }
        for (const name of fileNames) {
          if (!name) continue;
          if (name.endsWith('.tmp')) {
            skippedTmp++;
            continue;
          }
          const match = SIZE_FILE_RE.exec(name);
          if (!match) {
            skippedUnknown++;
            continue;
          }
          const file = new File(subDir, name);
          if (!file.exists) continue;
          rows.push({
            coverArtId,
            size: Number(match[1]),
            ext: match[2],
            bytes: file.size ?? 0,
            // expo-file-system doesn't expose mtime reliably across
            // platforms; use a fixed baseline so ORDER BY cached_at stays
            // sensible even before any new downloads happen.
            cachedAt: now,
          });
        }
      }

      if (rows.length > 0) {
        bulkInsertCachedImages(rows);
      }
      const persisted = countCachedImagesRow();
      const uniqueCovers = new Set(rows.map((r) => r.coverArtId)).size;
      log(
        `Indexed ${uniqueCovers} cover art item(s), ${rows.length} variant file(s) ` +
          `(skipped ${skippedTmp} .tmp, ${skippedUnknown} unrecognised). ` +
          `cached_images row count after migrate: ${persisted}.`,
      );

      // Aggregate blob from the pre-migration era is no longer used.
      await kvStorage.removeItem('substreamer-image-cache-stats');
    },
  },
  {
    id: 17,
    name: 'Add raw_json envelope columns to cached_songs and cached_items',
    run: async (log) => {
      // Schema-only migration. The base `CREATE TABLE` in db.ts includes
      // `raw_json TEXT` for fresh installs; this task adds the column to
      // databases created by an earlier release. Migration 18 backfills
      // values from local caches (album_details.json, playlist-details
      // blob, favorites blob). Separate migration so a failure during
      // backfill doesn't roll back the schema change.
      //
      // Idempotent via `PRAGMA table_info`: no-op on a fresh install or
      // on a re-run.
      const songsAdded = addColumnIfMissing('cached_songs', 'raw_json', 'TEXT');
      const itemsAdded = addColumnIfMissing('cached_items', 'raw_json', 'TEXT');
      log(
        `raw_json column: cached_songs ${songsAdded ? 'added' : 'already present'}, ` +
          `cached_items ${itemsAdded ? 'added' : 'already present'}.`,
      );
    },
  },

  {
    id: 18,
    name: 'Backfill cached_songs.raw_json from local caches',
    run: async (log) => {
      // Recovery for songs whose full Subsonic `Child` envelope was
      // silently dropped by Migration 14 (v1 tracks had only 7 fields) and
      // by the pre-v8.0.56 runtime writes in `downloadSong`. Every
      // cached_songs row should ultimately carry the full envelope — see
      // CLAUDE.md / memory "Preserve full API envelope in row caches".
      //
      // Priority order per song:
      //   1. album_details table (full AlbumWithSongsID3 JSON)
      //   2. substreamer-playlist-details blob (PlaylistWithSongs.entry[])
      //   3. substreamer-favorites blob (Child[])
      //
      // Songs with no local source stay NULL — a future online refresh
      // (Migration 21, deferred) can fetch them from the server. The
      // runtime is tolerant of null `raw_json`; only Migration 20 would
      // observe degraded behaviour for those rows (which it handles with
      // the song-envelope fallback in `cached_songs` column data).
      await backfillCachedSongEnvelopes(log);
    },
  },

  {
    id: 19,
    name: 'Backfill cached_items.raw_json and repair download_queue.songs_json',
    run: async (log) => {
      // Two passes in one task because both depend on the same set of
      // local caches (album_details table + playlist-details blob) and
      // we want the accounting in one log line.
      //
      // Pass A — item envelopes: every `cached_items` row with `type='album'`
      // or `'playlist'` that has a NULL `raw_json` gets its full envelope
      // filled from the corresponding local cache. `favorites` / `song`
      // intents have no natural envelope and stay NULL.
      //
      // Pass B — download_queue repair: rows created by Migration 14's
      // `songsJson: JSON.stringify(tracks)` carry the v1 7-field shape,
      // missing every optional field. Walk each queue row; for each entry
      // look up the backfilled `cached_songs.raw_json` from Migration 18
      // and substitute when available. A row whose every entry already
      // looks full (has `isDir`, the cheapest sentinel) is skipped.
      await backfillCachedItemEnvelopes(log);
      await repairDownloadQueueSongsJson(log);
    },
  },

  {
    id: 20,
    name: 'Create missing partial-album cached_items rows',
    run: async (log) => {
      // Every downloaded song has an `album_id` in `cached_songs`, but
      // songs that came in via a playlist/favorites/song intent have
      // historically never had a corresponding `type='album'` row in
      // `cached_items`. The row-based UI (`useDownloadStatus`,
      // `albumPassesDownloadedFilter`, the music-cache-browser partial
      // tab, `DownloadButton`) derives "partial album" state from the
      // existence of that row, so those albums render as "not
      // downloaded" even though their files are on disk.
      //
      // This migration creates the missing rows. Metadata comes from
      // `album_details` (authoritative `AlbumID3` envelope + song count)
      // when available, or from the first `cached_songs.raw_json` for
      // the album otherwise, or finally from the hot columns on
      // `cached_songs`. Edges are inserted in album track order
      // (`discNumber` asc, `track` asc, `id` asc) so the cache browser
      // and any listing UI sees tracks in their intended sequence —
      // data now preserved thanks to Migration 18's `raw_json` backfill.
      await backfillMissingPartialAlbums(log);
    },
  },

  {
    id: 21,
    name: 'Tag device + upgrade backups to v5',
    run: async (log) => {
      // Initialise + force-persist the deviceIdentityStore so the freshly-
      // generated UUID survives the next launch. Zustand persist only saves
      // on explicit setState — the initializer's UUID is otherwise ephemeral
      // until the user touches a setter. Without this forced persist, the
      // deviceId stamped into backup files this run would not match the
      // deviceId on subsequent launches.
      const identity = deviceIdentityStore.getState();
      identity.refreshDeviceName();
      identity.ensureDefaultLabel();
      const refreshed = deviceIdentityStore.getState();
      // Force a persist by re-setting the current state — guarantees the
      // UUID + label land in storage on the very first launch.
      deviceIdentityStore.setState({
        deviceId: refreshed.deviceId,
        deviceName: refreshed.deviceName,
        deviceLabel: refreshed.deviceLabel,
        deviceLabelUserSet: refreshed.deviceLabelUserSet,
      });

      log(`Device identity: ${refreshed.deviceLabel} (${refreshed.deviceId.slice(0, 8)}…)`);

      const count = await migrateV4BackupMetas(
        refreshed.deviceId,
        refreshed.deviceName,
        refreshed.deviceLabel,
      );
      if (count > 0) {
        log(`Upgraded ${count} backup(s) from v4 to v5 with this device's identity.`);
      } else {
        log('No v4 backup files found — skipping.');
      }
    },
  },

  {
    id: 22,
    name: 'Reconcile image cache to full cover-art IDs',
    run: async (log) => {
      await reconcileImageCacheCoverArtIds(log);
    },
  },

  {
    id: 23,
    name: 'Clear legacy cover-art recache blob',
    run: async (log) => {
      // Phase 4 of the image-cache rework: the old coverArtRecacheStore
      // (persisted under `substreamer-cover-art-recache`) was replaced by
      // the persistent SQL image-download queue in v8.0.62+. Drop the
      // dead blob so it doesn't sit on disk forever.
      try {
        await kvStorage.removeItem('substreamer-cover-art-recache');
        log('[m23] cleared substreamer-cover-art-recache');
      } catch (e) {
        log(`[m23] could not clear blob: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },

  // -------------------------------------------------------------------
  // TEMPLATE – How to add a new migration task:
  //
  //   1. Add a new entry below with the next sequential `id`.
  //   2. Give it a human-readable `name` (shown briefly on the splash).
  //   3. Implement the async `run` function with the migration logic.
  //   4. The runner will pick it up automatically on next launch for
  //      any user whose completedVersion is below the new id.
  //
  // Example:
  //
  // {
  //   id: 8,
  //   name: 'Reset playback settings',
  //   run: async () => {
  //     // your migration logic here
  //   },
  // },
  // -------------------------------------------------------------------
];

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Returns tasks that have not yet been completed.
 */
export function getPendingTasks(completedVersion: number): MigrationTask[] {
  return MIGRATION_TASKS.filter((t) => t.id > completedVersion);
}

/**
 * Run all pending migration tasks sequentially.
 *
 * @param completedVersion – The highest task ID already completed.
 * @param onProgress       – Optional callback fired before each task runs.
 * @returns The new completedVersion (highest task ID that ran).
 */
export async function runMigrations(
  completedVersion: number,
  onProgress?: (task: MigrationTask) => void,
): Promise<number> {
  const pending = getPendingTasks(completedVersion);
  const lines: string[] = [];

  lines.push(`Migration run: ${new Date().toISOString()}`);
  lines.push(`Platform: ${Platform.OS}`);
  lines.push('');

  for (const task of pending) {
    onProgress?.(task);
    lines.push(`--- Task ${task.id}: ${task.name} ---`);
    try {
      await task.run((msg) => lines.push(msg));
      completedVersion = task.id;
      lines.push('');
    } catch (e) {
      lines.push(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
      lines.push('');
      // Stop processing further tasks — a failed migration may leave
      // later ones in an ambiguous state. Persist progress up to the
      // last successful task so they aren't re-run on next launch.
      break;
    }
  }

  try {
    const logFile = new File(Paths.document, 'migration-log.txt');
    logFile.write(lines.join('\n'));
  } catch {
    /* Non-critical: failing to write the migration log must not
       fail the migration run itself. */
  }

  return completedVersion;
}
