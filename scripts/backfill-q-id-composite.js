#!/usr/bin/env node
// Backfill q_id on existing StartTest-platform question_attempts rows so that
// future Phase 1 re-scrapes can match the snapshot/annotation indexes by q_id
// and preserve enrichment + user annotations.
//
// Why this exists: prior to the fix in db.js, Phase 2 enrichment overwrote
// q_id from the composite "<sessionExternalId>-seq-<N>" form to the StartTest
// ItemName. A subsequent Phase 1 re-scrape then deleted+reinserted rows with
// composite q_ids, the snapshot lookup missed (existing index was keyed on
// ItemName), and question_stem/answer_choices/passage_text/mistake_type/notes
// were silently wiped. Resetting q_id back to the composite shape closes that
// hole for existing rows; the code fix prevents new losses.
//
// Algorithm:
//   - Iterate StartTest sessions only (GMAT Club uses gc-att-* ids, which are
//     stable and don't need this).
//   - For each session, order rows by id ASC and assign seq = 0..N-1.
//     Confirmed against the 119 already-composite rows: id ASC == seq ASC.
//   - Skip rows whose q_id already matches the composite shape.
//   - Update q_id to "<session_external_id>-seq-<position>".
//
// Usage:
//   node scripts/backfill-q-id-composite.js          # dry run
//   node scripts/backfill-q-id-composite.js --apply  # write changes

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.resolve(__dirname, '..', 'data', 'gmat-error-log.db');
const APPLY = process.argv.includes('--apply');

const db = new sqlite3.Database(DB_PATH);

const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

(async () => {
  const sessions = await all(`
    SELECT id, session_external_id, source
    FROM sessions
    WHERE LOWER(COALESCE(source, '')) NOT LIKE '%gmat club%'
    ORDER BY id
  `);

  let totalRows = 0;
  let totalRewrites = 0;
  let totalAlreadyComposite = 0;
  let totalSkippedNoExternalId = 0;
  const updates = [];

  for (const s of sessions) {
    if (!s.session_external_id) {
      totalSkippedNoExternalId += 1;
      continue;
    }
    const rows = await all(
      `SELECT id, q_id FROM question_attempts WHERE session_id = ? ORDER BY id ASC`,
      [s.id]
    );
    const compositeRe = new RegExp(`^${s.session_external_id}-seq-\\d+$`);
    rows.forEach((row, idx) => {
      totalRows += 1;
      const composite = `${s.session_external_id}-seq-${idx}`;
      if (compositeRe.test(row.q_id || '')) {
        totalAlreadyComposite += 1;
        return;
      }
      if (row.q_id === composite) {
        totalAlreadyComposite += 1;
        return;
      }
      updates.push({ id: row.id, oldQid: row.q_id, newQid: composite, sessionExt: s.session_external_id });
      totalRewrites += 1;
    });
  }

  console.log(`Sessions scanned (StartTest only): ${sessions.length - totalSkippedNoExternalId}`);
  console.log(`Sessions skipped (no external id): ${totalSkippedNoExternalId}`);
  console.log(`Total rows: ${totalRows}`);
  console.log(`Already-composite (skip):  ${totalAlreadyComposite}`);
  console.log(`Will rewrite:              ${totalRewrites}`);

  if (updates.length) {
    console.log('\nFirst 10 planned rewrites:');
    for (const u of updates.slice(0, 10)) {
      console.log(`  id=${u.id}  ${u.oldQid}  →  ${u.newQid}`);
    }
  }

  if (!APPLY) {
    console.log('\n[dry run] pass --apply to write changes');
    db.close();
    return;
  }

  console.log('\nApplying...');
  await run('BEGIN');
  try {
    for (const u of updates) {
      await run('UPDATE question_attempts SET q_id = ? WHERE id = ?', [u.newQid, u.id]);
    }
    await run('COMMIT');
    console.log(`Updated ${updates.length} rows.`);
  } catch (err) {
    await run('ROLLBACK');
    console.error('Failed, rolled back:', err.message);
    process.exit(1);
  }
  db.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
