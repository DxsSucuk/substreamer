/**
 * Generates src/db/normalizedDdl.ts from the drizzle-kit output so the runtime
 * table creation can never drift from src/db/schema.ts.
 *
 * Pipeline: edit schema.ts → `npx drizzle-kit generate` → `node scripts/build-normalized-ddl.js`.
 * Splits the generated migration into individual statements and makes each
 * CREATE idempotent (IF NOT EXISTS) so it's headless-safe to run on every boot.
 */
const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '../src/db/migrations');
const outPath = path.join(__dirname, '../src/db/normalizedDdl.ts');

// The runtime applies the WHOLE schema on every boot, so this file must contain every
// CREATE — not a delta. drizzle-kit emits incremental ALTER-only migrations once a
// baseline exists, and taking the newest of those would silently reduce NORMALIZED_DDL
// to those ALTERs: ensureNormalizedSchema becomes a no-op and normalizedTableNames()
// returns [], which looks fine on an existing install and gives fresh installs zero
// tables. Refuse rather than guess — regenerate from scratch instead:
//   rm src/db/migrations/0000_*.sql && rm -rf src/db/migrations/meta
//   npx drizzle-kit generate && node scripts/build-normalized-ddl.js
const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
if (sqlFiles.length === 0) {
  throw new Error('No .sql migration found — run `npx drizzle-kit generate` first.');
}
if (sqlFiles.length > 1) {
  throw new Error(
    `Expected exactly one .sql migration, found ${sqlFiles.length}: ${sqlFiles.join(', ')}.\n` +
      'Delete src/db/migrations/*.sql + meta/ and regenerate so the DDL is a full schema, not a delta.',
  );
}
const sqlFile = sqlFiles[0];

const raw = fs.readFileSync(path.join(migrationsDir, sqlFile), 'utf8');
const statements = raw
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) =>
    s
      .replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ')
      .replace(/^CREATE UNIQUE INDEX /i, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
      .replace(/^CREATE INDEX /i, 'CREATE INDEX IF NOT EXISTS '),
  );

const banner =
  '// AUTO-GENERATED from src/db/migrations by scripts/build-normalized-ddl.js — do not edit.\n' +
  '// Regenerate: edit src/db/schema.ts -> `npx drizzle-kit generate` -> `node scripts/build-normalized-ddl.js`.\n\n';
const body =
  '/** Idempotent DDL creating the normalized tables + indexes (headless-safe). */\n' +
  'export const NORMALIZED_DDL: readonly string[] = [\n' +
  statements.map((s) => `  ${JSON.stringify(s)},`).join('\n') +
  '\n];\n';

fs.writeFileSync(outPath, banner + body);
console.log(`Wrote ${statements.length} statements to ${path.relative(process.cwd(), outPath)}`);
