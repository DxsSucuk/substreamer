/**
 * Recreate the two scrobble tables with, or without, the legacy `song_json` column.
 *
 * `song_json` is gone from `src/db/schema.ts`, so the generated DDL a test DB is built
 * from no longer has it — but an upgrading install still does until
 * `legacyColumnDropService` drops it. Suites that need to stand in for such an install
 * build the legacy shape here.
 *
 * The column is spliced back into the CURRENT generated DDL rather than kept as a
 * frozen copy, so a later schema change to either table stays in step. It is
 * `NOT NULL` with no DEFAULT, exactly as it shipped — which is what makes "an INSERT
 * that omits it fails" a real assertion rather than a decorative one.
 *
 * `DROP TABLE` under `PRAGMA foreign_keys = ON` cascades the five child tables empty,
 * so this also leaves a clean slate.
 */
import { NORMALIZED_DDL } from '../db/normalizedDdl';
import { resetEnvelopeColumnCache } from '../store/persistence/scrobbleSnapshot';

import type { InternalDb } from '../db/client';

const TABLES = ['scrobble_events', 'pending_scrobble_events'] as const;

/** The CREATE TABLE + CREATE INDEX statements owning `table`. The backtick quoting is
 *  what keeps `scrobble_events` from matching `pending_scrobble_events`. */
const ddlFor = (table: string): readonly string[] =>
  NORMALIZED_DDL.filter((s) => s.includes(`\`${table}\``));

const spliceEnvelope = (ddl: string): string =>
  ddl.replace('`time` integer NOT NULL,', '`song_json` text NOT NULL,\n\t`time` integer NOT NULL,');

function rebuild(db: InternalDb, withEnvelope: boolean): void {
  for (const table of TABLES) {
    db.execSync(`DROP TABLE IF EXISTS ${table};`);
    for (const stmt of ddlFor(table)) db.execSync(withEnvelope ? spliceEnvelope(stmt) : stmt);
  }
  resetEnvelopeColumnCache();
}

/** Both tables as an install that has not run the drop still has them. */
export const createLegacyScrobbleTables = (db: InternalDb): void => rebuild(db, true);

/** Both tables as `src/db/schema.ts` now declares them — no `song_json`. */
export const createScrobbleTables = (db: InternalDb): void => rebuild(db, false);
