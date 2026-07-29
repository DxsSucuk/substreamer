/**
 * Creates + evolves the normalized tables/indexes, idempotently and
 * NON-DESTRUCTIVELY. Runs at boot (from db.ts) alongside the legacy blob tables and
 * is headless-safe.
 *
 * Schema evolution (a new column/index added to src/db/schema.ts) is handled by
 * reconciling columns with `ALTER TABLE ADD COLUMN`, which PRESERVES every row —
 * NEVER by dropping tables. A new index is created only after its columns exist, so
 * `CREATE INDEX ... (sort_artist, …)` can't fail with `no such column` against a
 * table that predates the column. All normalized columns are nullable, so ADD COLUMN
 * is always legal. (A column added to an already-populated table is NULL until the
 * next sync rewrites the row — acceptable; we never wipe synced data to add a column.)
 *
 * The DDL is generated from src/db/schema.ts (drizzle-kit) so it cannot drift —
 * see src/db/normalizedDdl.ts + scripts/build-normalized-ddl.js.
 */
import type { InternalDb } from './client';
import { NORMALIZED_DDL } from './normalizedDdl';

const isCreateTable = (s: string): boolean => /^\s*CREATE TABLE/i.test(s);
const isCreateIndex = (s: string): boolean => /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(s);

/** Table name + its column (name, type) list, parsed from a CREATE TABLE statement.
 *  Constraint lines (FOREIGN KEY / PRIMARY KEY(...)) don't start with a
 *  backtick-quoted identifier followed by a type, so they're skipped. */
function parseTableColumns(stmt: string): { table: string; columns: { name: string; type: string }[] } | null {
  const nameM = stmt.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`([^`]+)`/i);
  if (!nameM) return null;
  const open = stmt.indexOf('(');
  const close = stmt.lastIndexOf(')');
  const body = open >= 0 && close > open ? stmt.slice(open + 1, close) : '';
  const columns: { name: string; type: string }[] = [];
  for (const rawLine of body.split('\n')) {
    const m = rawLine.trim().match(/^`([^`]+)`\s+(text|integer|real|blob|numeric)\b/i);
    if (m) columns.push({ name: m[1], type: m[2] });
  }
  return { table: nameM[1], columns };
}

const existingColumns = (db: InternalDb, table: string): Set<string> =>
  new Set(
    db.getAllSync<{ name: string }>(`PRAGMA table_info("${table}")`).map((r) => r.name),
  );

/**
 * Ensure the normalized schema exists and matches src/db/schema.ts, preserving data.
 * One transaction so it's all-or-nothing. FK targets are resolved at write time, not
 * CREATE time, so statement order within the DDL is irrelevant.
 */
export function ensureNormalizedSchema(db: InternalDb): void {
  db.withTransactionSync(() => {
    // 1. Create any missing tables (fresh install → full schema; existing → no-op).
    for (const stmt of NORMALIZED_DDL) {
      if (isCreateTable(stmt)) db.execSync(stmt);
    }
    // 2. Add any column schema.ts declares that a pre-existing table lacks — the
    //    non-destructive path that lets a new column land on populated tables.
    for (const stmt of NORMALIZED_DDL) {
      if (!isCreateTable(stmt)) continue;
      const parsed = parseTableColumns(stmt);
      if (!parsed) continue;
      const have = existingColumns(db, parsed.table);
      for (const col of parsed.columns) {
        if (!have.has(col.name)) {
          db.execSync(`ALTER TABLE "${parsed.table}" ADD COLUMN "${col.name}" ${col.type}`);
        }
      }
    }
    // 3. Indexes last — every referenced column now exists.
    for (const stmt of NORMALIZED_DDL) {
      if (isCreateIndex(stmt)) db.execSync(stmt);
    }
  });
}

/** Every normalized table name, parsed from the generated DDL so it can't drift. */
export function normalizedTableNames(): string[] {
  const names: string[] = [];
  for (const stmt of NORMALIZED_DDL) {
    const m = stmt.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+[`"]?([A-Za-z0-9_]+)[`"]?/i);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Drop every normalized table then recreate the schema — a clean COLD reset. This is
 * the ONLY place that drops normalized data, and it's used ONLY by an explicit full
 * library resync (`forceFullResync` → the normalized sync) and the dev spikes, where
 * the wipe is intended and immediately followed by a full repopulate. Boot must NEVER
 * call this. DROP+CREATE is metadata-only (fast) but runs synchronously.
 */
export function resetNormalizedSchema(db: InternalDb): void {
  db.withTransactionSync(() => {
    for (const name of normalizedTableNames()) db.execSync(`DROP TABLE IF EXISTS "${name}"`);
  });
  ensureNormalizedSchema(db);
}
