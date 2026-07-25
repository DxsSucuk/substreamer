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

// Newest .sql migration in the folder (there is only one for the initial schema).
const sqlFile = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .pop();
if (!sqlFile) {
  throw new Error('No .sql migration found — run `npx drizzle-kit generate` first.');
}

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
