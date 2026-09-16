// Derive a practice question type for every usable OG question and write it
// into data/gmat-og-questions.json as `questionType`.
//
// Runs after og:parse (which rebuilds the pool) and before og:verify. No model
// and no cost: the type comes from the stem's prompt by rule, so re-running it
// is free and the result is reproducible.
//
//   node scripts/classify-og-types.mjs            # report only
//   node scripts/classify-og-types.mjs --merge    # write the pool

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyQuestionType } from '../client/src/lib/questionType.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const POOL = path.join(ROOT, 'data', 'gmat-og-questions.json');
const UNCLASSIFIED = '(unclassified)';

const merge = process.argv.includes('--merge');
const pool = JSON.parse(fs.readFileSync(POOL, 'utf-8'));

const counts = { CR: new Map(), RC: new Map() };
const totals = { CR: 0, RC: 0 };

for (const book of pool.books || []) {
  for (const section of book.sections || []) {
    const kind = section.kind;
    for (const q of section.questions || []) {
      // Unusable questions are never served, so leave them untouched rather
      // than classifying stems the pool has already rejected.
      if (!q.usable) { delete q.questionType; continue; }
      const type = classifyQuestionType(q.stem, kind);
      if (type) q.questionType = type; else delete q.questionType;
      if (!counts[kind]) continue;
      totals[kind] += 1;
      const key = type || UNCLASSIFIED;
      counts[kind].set(key, (counts[kind].get(key) || 0) + 1);
    }
  }
}

for (const kind of ['CR', 'RC']) {
  const unclassified = counts[kind].get(UNCLASSIFIED) || 0;
  const done = totals[kind] - unclassified;
  const pct = totals[kind] ? Math.round((100 * done) / totals[kind]) : 0;
  console.log(`\n${kind}: ${done}/${totals[kind]} classified (${pct}%)`);
  for (const [label, n] of [...counts[kind].entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${label}`);
  }
}

if (merge) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.copyFileSync(POOL, `${POOL}.bak-pretypes-${stamp}`);
  fs.writeFileSync(POOL, JSON.stringify(pool, null, 1));
  console.log(`\nmerged into ${POOL}`);
} else {
  console.log('\ndry run; pass --merge to write');
}
