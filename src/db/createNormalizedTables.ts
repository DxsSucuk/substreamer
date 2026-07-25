/**
 * Creates the normalized tables + indexes (Phase 2), idempotently. Additive:
 * runs ALONGSIDE the legacy blob tables during the migration window, and is
 * headless-safe (every statement is CREATE ... IF NOT EXISTS). Not yet wired
 * into boot — called explicitly by the blob→row migration and the dev spike
 * until consumers are cut over (Phase 3), so the boot schema stays lean and the
 * existing db.ts schema assertions keep holding.
 *
 * The DDL is generated from src/db/schema.ts (drizzle-kit) so it cannot drift —
 * see src/db/normalizedDdl.ts + scripts/build-normalized-ddl.js.
 */
import type { InternalDb } from './client';
import { NORMALIZED_DDL } from './normalizedDdl';

/**
 * Ensure the normalized schema exists. Wrapped in one transaction so the tables
 * either all appear or none do (no half-created schema on a mid-run failure).
 * Foreign keys reference tables created later in the same batch — SQLite resolves
 * FK targets at write time, not CREATE time, so statement order is irrelevant.
 */
export function ensureNormalizedSchema(db: InternalDb): void {
  db.withTransactionSync(() => {
    for (const statement of NORMALIZED_DDL) {
      db.execSync(statement);
    }
  });
}
