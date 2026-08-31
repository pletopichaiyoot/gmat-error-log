#!/usr/bin/env node
/**
 * Backfill PS vs DS on GMAT Club rows, from the enriched question stem.
 *
 * WHY THIS EXISTS
 * ---------------
 * The GMAT Club Phase-1 analytics table has no question-format column — its
 * "Category" cell holds a CONTENT topic ("Percent and Interest Problems",
 * "Remainders"), which `GMATCLUB_CATEGORY_TO_CODE` maps to `PS` for every
 * quant row. Result: every GMAT Club Data Sufficiency question in the log was
 * silently labelled Problem Solving (verified 2026-08-29 — 671 "PS" rows, 0 DS,
 * while the underlying threads were plainly DS).
 *
 * Phase 2 now reads the true format from the topic page title
 * (see extractFormat() in scrapers/gmat_club_question_scraper.js), but that
 * requires re-visiting every topic page. For rows that are ALREADY enriched we
 * don't need the browser at all: a DS stem is self-identifying, because the two
 * numbered statements are part of the question text.
 *
 * DETECTION (deliberately conservative — only relabels on a clear signal):
 *   - stem contains both a "(1)" and a "(2)" statement marker, OR
 *   - stem contains the DS answer boilerplate ("ALONE is sufficient").
 * Anything ambiguous is left untouched.
 *
 * USAGE
 *   node scripts/backfill-gmatclub-format.js          # dry run (default)
 *   node scripts/backfill-gmatclub-format.js --apply  # write changes
 */
const { all, run, closePool } = require('../src/db');

const SELECT_SQL = `
  SELECT q.id, q.q_id, q.category_code, q.question_stem
  FROM question_attempts q
  JOIN sessions s ON s.id = q.session_id
  WHERE LOWER(s.source) LIKE '%gmat club error log%'
    AND COALESCE(TRIM(q.question_stem), '') <> ''
    AND COALESCE(q.category_code, '') IN ('PS', '')
`;

// A DS stem carries its two statements inline. Require BOTH markers so a stray
// "(1)" in a normal PS stem (e.g. a footnote) can't trigger a relabel.
const STMT_1 = /\((?:1|I)\)\s*\S/;
const STMT_2 = /\((?:2|II)\)\s*\S/;
const BOILERPLATE = /alone\s+is\s+sufficient/i;

function looksLikeDs(stem) {
  const s = String(stem || '');
  if (BOILERPLATE.test(s)) return true;
  return STMT_1.test(s) && STMT_2.test(s);
}

(async () => {
  const apply = process.argv.includes('--apply');
  const rows = await all(SELECT_SQL, []);
  const hits = rows.filter((r) => looksLikeDs(r.question_stem));

  console.log(`scanned   : ${rows.length} enriched GMAT Club rows currently labelled PS`);
  console.log(`detected  : ${hits.length} that are actually Data Sufficiency`);
  console.log(`mode      : ${apply ? 'APPLY (writing)' : 'DRY RUN (no writes) — pass --apply to commit'}`);

  for (const r of hits.slice(0, 10)) {
    console.log(`  ${r.q_id}  ${String(r.question_stem).replace(/\s+/g, ' ').slice(0, 72)}`);
  }
  if (hits.length > 10) console.log(`  … and ${hits.length - 10} more`);

  if (apply && hits.length) {
    let n = 0;
    for (const r of hits) {
      await run(`UPDATE question_attempts SET category_code = 'DS' WHERE id = ?`, [r.id]);
      n += 1;
    }
    console.log(`updated   : ${n} rows -> category_code = 'DS'`);
  }

  await closePool?.();
  process.exit(0);
})().catch((e) => { console.error('BACKFILL FAILED:', e.message); process.exit(1); });
