import type { Config } from 'drizzle-kit';

// Dev-time only: used to generate accurate DDL from src/db/schema.ts. The runtime
// creates the normalized tables via CREATE TABLE IF NOT EXISTS (headless-safe),
// derived from this output — we do NOT ship the drizzle-kit runtime migrator.
export default {
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
} satisfies Config;
