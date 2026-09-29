#!/usr/bin/env node
'use strict';
/* global document, location */

// Re-enrich StartTest sessions whose Phase-2 data was degraded by the two
// rescrape bugs fixed on 2026-09-09 (see CLAUDE.md, "Phase-1 rescrapes must
// never downgrade Phase-2 data"): stems truncated back to the ~60-char Question
// History preview, and answer_choices flattened to {label, text} — which strips
// matrix/dropdown options and every per-choice flag. Both only recover on a
// Phase-2 re-enrichment.
//
// Usage (the app's API must be up, and a logged-in StartTest tab open):
//   node scripts/reenrich-degraded.js            # 5 worst sessions
//   node scripts/reenrich-degraded.js --limit 3
//   node scripts/reenrich-degraded.js --list     # show the queue, run nothing
//   node scripts/reenrich-degraded.js --subject any   # not just DI
//   node scripts/reenrich-degraded.js --skip 432      # pass over sessions that keep aborting
//   node scripts/reenrich-degraded.js --unenriched    # sessions Phase 2 never ran on
//
// Deliberately opportunistic: an aborted Phase-2 run leaves the StartTest tab
// blank and only an mba.com sign-in brings it back, so this checks the tab
// before every session and stops the moment it goes dead rather than burning
// calls (and rate-limit goodwill) against a corpse.

const { all } = require('../src/db');

const API = process.env.GMAT_API_URL || 'http://127.0.0.1:4310';
const CDP = process.env.GMAT_CDP_URL || 'http://127.0.0.1:9222';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const LIMIT = Number(flag('limit', 5));
const LIST_ONLY = args.includes('--list');
// Sessions Phase 2 never ran on (all rows Phase-1 only: a 60-char preview, no
// choices or answers) are not "degraded", so the default queue skips them.
// --unenriched queues exactly those instead, most wrong answers first.
const UNENRICHED = args.includes('--unenriched');
// Session ids to pass over, e.g. one that keeps aborting: with one usable
// enrich per sign-in, a bad session at the head of the queue wastes each one.
const SKIP = new Set(String(flag('skip', '')).split(',').map((v) => v.trim()).filter(Boolean));
const SUBJECT = String(flag('subject', 'DI')).toUpperCase();

// A row is degraded if Phase 1 clobbered its stem, or its choices lost the
// per-choice flags Phase 2 writes. Dropdown rows are excluded from the flag
// half: they store `selected` on each option, never isUserSelected.
//
// (A stimulus holding a `data:image/png` used to count too, as the mark of the
// old element-screenshot chart capture — misclipped by starttest.com's browser
// zoom, or blank. That backlog was re-enriched on 2026-09-29 and the rule is
// retired: what PNGs remain are StartTest's own inline equation images, charts
// its itdmedia endpoint genuinely serves as PNG, and a few older captures the
// new walk finds nothing to replace — all checked by eye, all intact except one
// blank in session 291, which aborts. Re-walking changes none of them.)
//
// So is an enriched row reading 0 s. Phase 2 stores the exact
// vPreviousTimeSpent, but rescrapes before 2026-09-29 overwrote it with
// Question History's display, which caps at "3+ Minutes" and was stored as 0 —
// so these are all questions that took OVER three minutes. Re-enrichment
// writes the exact time back (a rescrape now would only give the 180 s floor).
//
// A short stem only counts when the row's choices have lost their pick/key
// flags. The same buggy rescrape truncated stems and stripped flags together,
// so intact flags mean Phase 2's output survived — its short stem is either a
// genuinely short question ("125% of 5 =") or a CR item whose argument Phase 2
// files under passage_text, and re-walking the session changes neither. Without
// this, such sessions re-queued on every run (45 rows, 2026-09-29).
const DEGRADED = `(
  (LENGTH(q.question_stem) <= 65
    AND COALESCE(q.answer_choices, '') NOT LIKE '%isUserSelected%'
    AND COALESCE(q.answer_choices, '') NOT LIKE '%"selected"%')
  OR (LOWER(q.response_format) IN ('single', 'matrix') AND q.answer_choices NOT LIKE '%isUserSelected%')
  OR COALESCE(q.time_sec, 0) = 0
)`;

// Only sessions from a StartTest book can be re-enriched. Excluding other
// sources by name let a custom one ("Algebra Word Problems Drill (Claude)")
// into the queue, where the enrich endpoint rejected it as an unknown source;
// the server's own preset list is the authority.
async function startTestLabels() {
  const res = await fetch(`${API}/api/sources`);
  const body = await res.json();
  return (body.sources || body).filter((p) => p.platform === 'starttest').map((p) => p.label);
}

async function loadQueue() {
  const labels = await startTestLabels();
  if (!labels.length) throw new Error('The API listed no StartTest sources — is it running?');
  const subjectClause = SUBJECT === 'ANY' ? '' : `AND q.subject_code = '${SUBJECT.replace(/'/g, '')}'`;
  return all(`
    SELECT s.id AS sid, MIN(s.source) AS source, MIN(s.session_date::text) AS session_date,
           COUNT(*) FILTER (WHERE ${DEGRADED}) AS degraded,
           COUNT(*) AS enriched
    FROM question_attempts q
    INNER JOIN sessions s ON s.id = q.session_id
    WHERE COALESCE(s.excluded, 0) = 0
      ${UNENRICHED ? '' : "AND COALESCE(q.response_format, '') <> ''"}
      AND s.source IN (${labels.map(() => '?').join(', ')})
      ${subjectClause}
    GROUP BY s.id
    ${UNENRICHED
    ? "HAVING COUNT(*) FILTER (WHERE COALESCE(q.response_format, '') <> '') = 0\n    ORDER BY COUNT(*) FILTER (WHERE q.correct = 0) DESC, s.id DESC"
    : `HAVING COUNT(*) FILTER (WHERE ${DEGRADED}) > 0\n    ORDER BY COUNT(*) FILTER (WHERE ${DEGRADED}) DESC, s.id DESC`}
  `, labels);
}

// A usable tab has a title AND the product switcher. "A starttest.com tab
// exists" is not enough — a blank harness shell matches the URL but resolves no
// product, which surfaces as a misleading "Product <id> not found".
async function tabIsLive() {
  const { chromium } = require('playwright');
  let browser = null;
  try {
    browser = await chromium.connectOverCDP(CDP, { timeout: 10000 });
    for (const page of browser.contexts().flatMap((ctx) => ctx.pages())) {
      if (!/starttest\.com/i.test(page.url())) continue;
      const live = await Promise.race([
        page.evaluate(() => {
          if (!(document.title || '').trim()) return false;
          if (document.querySelector('a[href*="OrderProductID="]')) return true;
          // Any other signed-in page reaches the products through its own Home
          // link — a book's report page (cmd=ShowReview) ended a clean run on
          // 2026-09-29 and was wrongly treated as dead. The one genuinely
          // stranded state is a Home listing NO products, left by an aborted
          // session; from there the enrich fails fast on "Product not found"
          // without entering a review, and this check (then on that Home) stops.
          const onHome = /[?&]cmd=HomePage(&|$)/i.test(location.href);
          return !onHome && Boolean(document.querySelector('a[href*="cmd=HomePage"]'));
        }),
        new Promise((resolve) => { setTimeout(() => resolve(false), 6000); }),
      ]).catch(() => false);
      if (live) return true;
    }
  } catch {
    return false;
  }
  return false;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function enrich(sid) {
  const res = await fetch(`${API}/api/sessions/${sid}/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return res.json();
}

async function main() {
  const queue = await loadQueue();
  const totalDegraded = queue.reduce((sum, row) => sum + Number(row.degraded), 0);
  console.log(`${queue.length} sessions carry ${totalDegraded} degraded questions (subject: ${SUBJECT}).`);

  if (LIST_ONLY) {
    for (const row of queue) {
      console.log(`  ${row.sid}\t${row.session_date}\t${row.degraded}/${row.enriched}\t${row.source}`);
    }
    return;
  }

  const batch = queue.filter((row) => !SKIP.has(String(row.sid))).slice(0, LIMIT);
  if (!batch.length) {
    console.log('Nothing to do.');
    return;
  }

  let repaired = 0;
  for (const row of batch) {
    if (!(await tabIsLive())) {
      console.log('No live StartTest tab — open GMAT practice from mba.com and run this again.');
      break;
    }
    process.stdout.write(`session ${row.sid} (${row.degraded} degraded) … `);
    const result = await enrich(row.sid).catch((error) => ({ ok: false, error: error.message }));
    const failed = !result.ok || result.aborted || result.scrapeErrors?.length || result.dbErrors?.length;
    if (failed) {
      // An abort writes nothing, so the session is simply left for next time.
      console.log(`skipped — ${result.abortReason || result.error || 'scrape errors'}`);
    } else {
      repaired += 1;
      console.log(`repaired ${result.dbUpdated}/${result.qhTotal}`);
    }
    await sleep(25000 + Math.floor(Math.random() * 25000));
  }

  console.log(`\nRepaired ${repaired} of ${batch.length} attempted. ${queue.length - repaired} sessions still degraded.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
