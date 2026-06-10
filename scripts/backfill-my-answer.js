// One-time migration: backfill `my_answer` for single-choice rows where
// the StartTest scraper failed to flag the user's pick at enrichment time.
// Recovery is only possible when correct=1 (then my_answer == correct_answer).
// Also patches each row's answer_choices JSON to set isUserSelected on the
// matching label so the review modal can color-code it.

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.resolve(__dirname, '..', 'data', 'gmat-error-log.db');
const db = new sqlite3.Database(dbPath);

const all = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
const run = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    })
  );

(async () => {
  const rows = await all(
    `
      SELECT id, q_code, correct, correct_answer, answer_choices
      FROM question_attempts
      WHERE response_format = 'single'
        AND COALESCE(TRIM(my_answer), '') = ''
        AND correct = 1
        AND COALESCE(TRIM(correct_answer), '') != ''
    `
  );
  console.log(`[backfill-my-answer] candidates: ${rows.length}`);

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const letter = String(row.correct_answer || '').trim().toUpperCase();
    if (!/^[A-E]$/.test(letter)) {
      skipped += 1;
      continue;
    }

    let choices = null;
    try {
      choices = JSON.parse(row.answer_choices || '[]');
    } catch (_err) {
      choices = null;
    }
    let nextChoices = row.answer_choices;
    if (Array.isArray(choices)) {
      const idx = choices.findIndex((c) => c && String(c.label).toUpperCase() === letter);
      if (idx >= 0) {
        choices[idx] = { ...choices[idx], isUserSelected: true, isCorrect: true };
        nextChoices = JSON.stringify(choices);
      }
    }

    await run(
      `
        UPDATE question_attempts
        SET my_answer = ?,
            answer_choices = ?
        WHERE id = ?
      `,
      [letter, nextChoices, row.id]
    );
    updated += 1;
    console.log(`  • id=${row.id} q_code=${row.q_code}: my_answer="" → "${letter}"`);
  }

  console.log(`[backfill-my-answer] updated=${updated}, skipped=${skipped}`);

  const stillBroken = await all(
    `
      SELECT id, q_code, correct
      FROM question_attempts
      WHERE response_format = 'single'
        AND COALESCE(TRIM(my_answer), '') = ''
    `
  );
  if (stillBroken.length) {
    console.log(`[backfill-my-answer] ${stillBroken.length} row(s) remain unrecoverable from stored data:`);
    for (const r of stillBroken) {
      console.log(`  • id=${r.id} q_code=${r.q_code} correct=${r.correct} — re-enrich the session via the dashboard to recapture`);
    }
  }

  db.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
