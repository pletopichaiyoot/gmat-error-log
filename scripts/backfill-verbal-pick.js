#!/usr/bin/env node
// Fix Verbal/CR/RC rows where Phase 1 says the user got it right (correct=1)
// but Phase 2 wrote a wrong my_answer (a known bug: the scraper used to
// default to choice A on review pages without color highlighting). The math
// guarantees my_answer = correct_answer when correct=1, so this is safe.

const path = require('path');
const sqlite3 = require('sqlite3');
const dbPath = path.resolve(__dirname, '..', 'data', 'gmat-error-log.db');
const db = new sqlite3.Database(dbPath);

const all = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows))));
const run = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function (e) { e ? reject(e) : resolve(this); }));

(async () => {
  const rows = await all(`
    SELECT id, my_answer, correct_answer, answer_choices
    FROM question_attempts
    WHERE subject_sub_raw IN ('Verbal','CR','RC')
      AND correct = 1
      AND my_answer IS NOT NULL
      AND correct_answer IS NOT NULL
      AND my_answer <> correct_answer
  `);
  let fixed = 0;
  for (const row of rows) {
    let choices = null;
    try { choices = JSON.parse(row.answer_choices || 'null'); } catch { /* skip */ }
    if (Array.isArray(choices)) {
      for (const c of choices) { if (c && typeof c === 'object') c.isUserSelected = false; }
      const idx = choices.findIndex((c) => c && c.label === row.correct_answer);
      if (idx >= 0) choices[idx].isUserSelected = true;
    }
    await run(
      'UPDATE question_attempts SET my_answer = ?, answer_choices = ? WHERE id = ?',
      [row.correct_answer, choices ? JSON.stringify(choices) : row.answer_choices, row.id],
    );
    fixed += 1;
  }
  console.log(`fixed=${fixed}`);
  db.close();
})().catch((e) => { console.error(e); process.exit(1); });
