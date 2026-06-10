#!/usr/bin/env node
// Backfill `passage_text` for existing rows whose passage was previously
// captured inside response_details (StartTest Phase 2 enrichment used to
// stash it there only). One-shot, idempotent — safe to re-run.

const path = require('path');
const sqlite3 = require('sqlite3');

const dbPath = path.resolve(__dirname, '..', 'data', 'gmat-error-log.db');
const db = new sqlite3.Database(dbPath);

const all = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows))));
const run = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function (e) { e ? reject(e) : resolve(this); }));

(async () => {
  // Ensure the column exists. initDb() in src/db.js does the same migration,
  // but this script may run before the API server has started — make it
  // self-sufficient.
  const cols = await all('PRAGMA table_info(question_attempts)');
  if (!cols.some((c) => c.name === 'passage_text')) {
    await run('ALTER TABLE question_attempts ADD COLUMN passage_text TEXT');
    console.log('added passage_text column');
  }

  // Only touch rows that have response_details JSON, no current passage_text,
  // and a non-empty `passage` field inside the JSON.
  const rows = await all(`
    SELECT id, response_details
    FROM question_attempts
    WHERE response_details IS NOT NULL
      AND TRIM(response_details) <> ''
      AND COALESCE(passage_text, '') = ''
  `);
  let updated = 0;
  let scanned = 0;
  for (const row of rows) {
    scanned += 1;
    let parsed = null;
    try { parsed = JSON.parse(row.response_details); } catch { /* skip */ }
    const passage = (parsed && typeof parsed.passage === 'string') ? parsed.passage.trim() : '';
    if (!passage) continue;
    await run('UPDATE question_attempts SET passage_text = ? WHERE id = ?', [passage, row.id]);
    updated += 1;
  }
  console.log(`scanned=${scanned} updated=${updated}`);
  db.close();
})().catch((e) => { console.error(e); process.exit(1); });
