/**
 * Test fixture: hand-create the three legacy blob tables.
 *
 * Nothing creates these at boot — the only production creator is Migration 12 (for
 * `album_details` / `song_index`) — so suites exercising the blob→normalized ETL must
 * create what they seed. Only the columns the ETL reads are declared; the sort/filter
 * and fuzzy columns have no reader left.
 */
import type { InternalDb } from '@/db/client';

export function createLegacyBlobTables(db: InternalDb): void {
  db.execSync(
    `CREATE TABLE IF NOT EXISTS album_details (
       id TEXT PRIMARY KEY NOT NULL,
       json TEXT NOT NULL,
       retrievedAt INTEGER NOT NULL
     );`,
  );
  db.execSync(
    `CREATE TABLE IF NOT EXISTS song_index (
       id TEXT PRIMARY KEY NOT NULL,
       albumId TEXT NOT NULL,
       raw_json TEXT
     );`,
  );
  db.execSync(
    `CREATE TABLE IF NOT EXISTS library_albums (
       id TEXT PRIMARY KEY NOT NULL,
       sortKey TEXT NOT NULL,
       raw_json TEXT NOT NULL
     );`,
  );
}
