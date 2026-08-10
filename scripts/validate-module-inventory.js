#!/usr/bin/env node

/**
 * Cross-checks the local-module inventory against:
 *  - which modules have tests (via scripts/discover-modules.js)
 *  - which entries jest.config.js includes in `collectCoverageFrom`
 *
 * Errors (fail CI):
 *  - jest.config.js references a `modules/<name>/...` file that doesn't exist
 *
 * Warnings (do not fail CI):
 *  - A module has tests but isn't represented in `collectCoverageFrom`
 *    (it still runs via `npm run test:modules`, just no coverage signal)
 */

const fs = require('fs');
const path = require('path');

const { list: discoveredModules } = require('./discover-modules');

const REPO_ROOT = path.join(__dirname, '..');

function main() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const jestConfig = require(path.join(REPO_ROOT, 'jest.config.js'));
  const coverageEntries = jestConfig.collectCoverageFrom || [];

  const modules = discoveredModules();

  let errors = 0;
  let warnings = 0;

  // ERROR: jest.config.js references a file that doesn't exist
  for (const entry of coverageEntries) {
    if (entry.startsWith('!')) continue; // negation
    if (!entry.startsWith('modules/')) continue;
    if (entry.includes('*')) continue; // skip glob entries
    const fullPath = path.join(REPO_ROOT, entry);
    if (!fs.existsSync(fullPath)) {
      console.error(`[validate-module-inventory] jest.config.js references missing file: ${entry}`);
      errors++;
    }
  }

  // WARNING: tested module not represented in collectCoverageFrom
  for (const m of modules) {
    const hasEntry = coverageEntries.some(
      (p) => !p.startsWith('!') && p.includes(`modules/${m}/`),
    );
    if (!hasEntry) {
      console.warn(
        `[validate-module-inventory] module '${m}' has tests but no entry in jest.config.js collectCoverageFrom`,
      );
      warnings++;
    }
  }

  if (errors > 0) {
    console.error(`[validate-module-inventory] ${errors} error(s)`);
    process.exit(1);
  }
  console.log(
    `[validate-module-inventory] OK — ${modules.length} tested module(s)` +
      (warnings > 0 ? `, ${warnings} coverage warning(s)` : ''),
  );
}

main();
