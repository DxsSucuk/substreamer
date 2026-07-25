/**
 * In-place migration: legacy blob tables → normalized tables (Phase 2.4).
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
import type { AlbumID3, Child } from 'subsonic-api';

import type { InternalDb } from './client';
import { ensureNormalizedSchema } from './createNormalizedTables';
import { upsertAlbums } from './repository/albums';
import { upsertSongs } from './repository/songs';

export interface TableMigration {
  source: number;
  migrated: number;
  skipped: number; // rows with no/invalid raw_json
}
export interface MigrationResult {
  albums: TableMigration;
  songs: TableMigration;
  ms: number;
}

type Log = (message: string) => void;

async function migrateBlobTable<T extends { id: string }>(
  db: InternalDb,
  sourceTable: string,
  jsonCol: string,
  upsert: (db: InternalDb, items: T[]) => Promise<number>,
  log?: Log,
): Promise<TableMigration> {
  const source =
    db.getFirstSync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${sourceTable}`)?.n ?? 0;
  let migrated = 0;
  let skipped = 0;
  let cursor = '';
  const PAGE = 1000;

  for (;;) {
    const rows = db.getAllSync<{ id: string; j: string | null }>(
      `SELECT id, ${jsonCol} AS j FROM ${sourceTable} WHERE id > ? ORDER BY id LIMIT ?`,
      [cursor, PAGE],
    );
    if (rows.length === 0) break;

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
    migrated += await upsert(db, items);
    cursor = rows[rows.length - 1].id;
    log?.(`${sourceTable}: ${migrated}/${source} migrated (${skipped} skipped)`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { source, migrated, skipped };
}

/** Migrate the album + song blob caches into the normalized tables. */
export async function migrateBlobsToNormalized(db: InternalDb, log?: Log): Promise<MigrationResult> {
  const start = Date.now();
  ensureNormalizedSchema(db);
  log?.('normalized schema ensured');
  const albums = await migrateBlobTable<AlbumID3>(db, 'library_albums', 'raw_json', upsertAlbums, log);
  const songs = await migrateBlobTable<Child>(db, 'song_index', 'raw_json', upsertSongs, log);
  // Fold the migration's (large) WAL into the main DB now. A bulk write is exactly
  // when a checkpoint pays off — without it, every subsequent app read (e.g. home
  // hydration reading song_index) has to traverse a huge WAL, which hard-stalls on
  // iOS. This is a POST-write checkpoint, not the per-boot one we removed.
  try {
    db.execSync('PRAGMA wal_checkpoint(TRUNCATE);');
    log?.('WAL checkpointed (TRUNCATE)');
  } catch (e) {
    log?.(`WAL checkpoint failed: ${String(e)}`);
  }
  return { albums, songs, ms: Date.now() - start };
}
