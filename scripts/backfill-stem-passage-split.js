// One-time backfill: clean the StartTest-2 single-choice `question_stem` rows
// whose `.ITSStemText` capture glued together boilerplate + prompt + (CR)
// argument + every answer choice. Uses the shared splitStemAndPassage parser to
// rewrite `question_stem` to just the prompt and lift any CR argument into
// `passage_text` — entirely from data already in the DB (no browser / re-scrape).
//
// Scope is deliberately narrow: only rows carrying StartTest's boilerplate line
// ("This is a ... question for which you need to select ...") are touched. That
// precisely targets the broken StartTest-2 rows and leaves GMAT Club / TTP /
// LSAT / legacy-Nuxt rows (no boilerplate, no duplicated choices) untouched.
//
// Idempotent: once a row is cleaned the boilerplate is gone, so a second run
// skips it. Dry-run by default; pass --apply to write.
//
//   node scripts/backfill-stem-passage-split.js          # dry run (report only)
//   node scripts/backfill-stem-passage-split.js --apply   # write changes

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { all, withTransaction, closePool } = require('../src/db');
const { splitStemAndPassage, BOILERPLATE_RE } = require('../src/scrapers/question-stem-split');

const APPLY = process.argv.includes('--apply');

function parseChoices(raw) {
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
}

// Single-choice shape (CR/DS/RC/SC/PS): a flat array whose elements have NO
// nested `options` (that's what distinguishes matrix / dropdown DI items). We do
// NOT require `text` to be a string — image/MathML choices store `text: null`
// but still carry the same boilerplate prefix that needs stripping, and skipping
// them would leave PS rows inconsistently cleaned.
function isSingleChoiceShape(choices) {
  return (
    Array.isArray(choices)
    && choices.length >= 2
    && choices.every((c) => c && !Array.isArray(c.options))
  );
}

function clip(s, n = 90) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

async function main() {
  const rows = await all(
    `SELECT id, q_id, category_code, question_stem, passage_text, answer_choices
       FROM question_attempts
      WHERE answer_choices IS NOT NULL
        AND question_stem IS NOT NULL
        AND question_stem LIKE 'This is a%'`
  );

  const changes = [];
  const byCategory = {};
  let withPassage = 0;

  for (const r of rows) {
    const choices = parseChoices(r.answer_choices);
    if (!isSingleChoiceShape(choices)) continue;

    const firstLine = r.question_stem.split('\n')[0];
    const choiceTexts = choices.map((c) => c.text).filter(Boolean);
    const qualifies = BOILERPLATE_RE.test(firstLine)
      || choiceTexts.some((t) => t.length >= 8 && r.question_stem.includes(t));
    if (!qualifies) continue;

    const { stem, passage } = splitStemAndPassage(r.question_stem, choiceTexts);
    if (!stem) continue; // never blank out a stem

    const hadPassage = !!(r.passage_text && r.passage_text.trim());
    const willAddPassage = !!passage && !hadPassage;
    if (stem === r.question_stem && !willAddPassage) continue; // already clean

    changes.push({
      id: r.id,
      category: r.category_code || '?',
      oldStem: r.question_stem,
      newStem: stem,
      newPassage: willAddPassage ? passage : null,
    });
    byCategory[r.category_code || '?'] = (byCategory[r.category_code || '?'] || 0) + 1;
    if (willAddPassage) withPassage += 1;
  }

  console.log(`Scanned ${rows.length} boilerplate-prefixed single-choice rows.`);
  console.log(`Rows to update: ${changes.length}  (${withPassage} will also get a derived passage_text)`);
  console.log('By category:', JSON.stringify(byCategory));
  console.log('\n--- sample diffs (up to 4) ---');
  for (const c of changes.slice(0, 4)) {
    console.log(`\n[id ${c.id} · ${c.category}]`);
    console.log(`  OLD stem : ${clip(c.oldStem, 120)}`);
    console.log(`  NEW stem : ${clip(c.newStem, 120)}`);
    console.log(`  passage  : ${c.newPassage ? clip(c.newPassage, 120) : '(unchanged)'}`);
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to write these changes.');
    return;
  }
  if (!changes.length) {
    console.log('\nNothing to apply.');
    return;
  }

  // Rollback backup of the exact fields we overwrite.
  const backupDir = path.join(__dirname, '..', 'tmp');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, 'backfill-stem-passage-backup.json');
  const backup = changes.map((c) => ({ id: c.id, question_stem: c.oldStem }));
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nWrote rollback backup (${backup.length} rows) to ${backupPath}`);

  await withTransaction(async (tx) => {
    for (const c of changes) {
      await tx.run(
        `UPDATE question_attempts
            SET question_stem = ?,
                passage_text = COALESCE(NULLIF(?, ''), passage_text)
          WHERE id = ?`,
        [c.newStem, c.newPassage || '', c.id]
      );
    }
  });
  console.log(`Applied ${changes.length} updates.`);
}

main()
  .then(() => closePool())
  .catch((err) => {
    console.error(err);
    return closePool().finally(() => process.exit(1));
  });
