// One-off repair for rows corrupted by the over-broad colorFromStyle regex
// in starttest_scraper.js (fixed in this commit). Affected rows have
// `correct=1` (StartTest QHistory authoritative) but `my_answer` differs
// from `correct_answer` — impossible unless Phase 2 misread the user's pick.
// For each such row we set my_answer = correct_answer and re-sync the
// per-choice isUserSelected flag in answer_choices so the modal highlights
// the right card.
const path = require('path');
const sqlite3 = require('sqlite3');

const dbPath = path.join(__dirname, '..', 'data', 'gmat-error-log.db');
const db = new sqlite3.Database(dbPath);
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r)));
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));

(async () => {
  const rows = await all(`
    SELECT id, q_id, q_code, my_answer, correct_answer, answer_choices
    FROM question_attempts
    WHERE correct = 1
      AND my_answer != correct_answer
      AND COALESCE(TRIM(correct_answer), '') != ''
      AND COALESCE(TRIM(my_answer), '') != ''
      AND LENGTH(correct_answer) = 1
      AND LENGTH(my_answer) = 1
  `);
  console.log(`Found ${rows.length} corrupted rows.`);
  for (const row of rows) {
    let choices = null;
    try { choices = JSON.parse(row.answer_choices || '[]'); } catch { choices = []; }
    if (Array.isArray(choices)) {
      for (const c of choices) {
        if (c) c.isUserSelected = String(c.label || '').toUpperCase() === String(row.correct_answer).toUpperCase();
      }
    }
    await run(
      `UPDATE question_attempts SET my_answer = ?, answer_choices = ? WHERE id = ?`,
      [row.correct_answer, JSON.stringify(choices), row.id]
    );
    console.log(`  id=${row.id} q_code=${row.q_code} my=${row.my_answer} → ${row.correct_answer}`);
  }
  console.log('Done.');
  db.close();
})().catch((e) => { console.error(e); process.exit(1); });
