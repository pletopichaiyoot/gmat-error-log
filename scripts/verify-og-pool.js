#!/usr/bin/env node
// Check data/gmat-og-questions.json against the acceptance criteria.
// Exits non-zero if any check fails, so it can gate the pipeline.

const fs = require('fs');
const path = require('path');
const { verifyPool } = require('./og/verify');

const FILE = path.join(__dirname, '..', 'data', 'gmat-og-questions.json');
if (!fs.existsSync(FILE)) {
  console.error(`No pool at ${FILE} — run npm run og:parse first.`);
  process.exit(1);
}

const pool = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
const { ok, checks, usable } = verifyPool(pool);

for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(42)} ${c.detail}`);
}
console.log(`\n${usable} usable questions.`);
process.exit(ok ? 0 : 1);
