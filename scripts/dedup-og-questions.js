#!/usr/bin/env node
// Dedup the OG pool across editions, preferring the newer book.
// Usage: node scripts/dedup-og-questions.js [--dry-run]

const fs = require('fs');
const path = require('path');
const { dedupPool } = require('./og/dedup');

const FILE = path.join(__dirname, '..', 'data', 'gmat-og-questions.json');
const dryRun = process.argv.includes('--dry-run');

const count = p => p.books.flatMap(b => b.sections.map(s =>
  `${b.code} ${s.kind} ${s.questions.length}/${s.questions.filter(q => q.usable).length}`));

const pool = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
const before = count(pool);
const { pool: out, report } = dedupPool(pool, { prefer: ['OG13', 'OG12', 'VR2'] });
const after = count(out);

console.log('before (total/usable):', before.join(' | '));
console.log('after  (total/usable):', after.join(' | '));
console.log(`CR questions dropped as duplicates: ${report.crDropped}`);
console.log(`RC passage groups dropped as duplicates: ${report.rcGroupsDropped}`);

const usable = out.books.flatMap(b => b.sections.flatMap(s => s.questions))
  .filter(q => q.usable).length;
console.log(`${usable} usable questions remain.`);

if (!dryRun) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.copyFileSync(FILE, `${FILE}.bak-predupe-${stamp}`);
  fs.writeFileSync(FILE, JSON.stringify(out, null, 1));
  console.log('wrote', FILE);
}
