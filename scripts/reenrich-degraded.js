#!/usr/bin/env node
'use strict';
/* global document */

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
const SUBJECT = String(flag('subject', 'DI')).toUpperCase();

// A row is degraded if Phase 1 clobbered its stem, or its choices lost the
// per-choice flags Phase 2 writes. Dropdown rows are excluded from the flag
// half: they store `selected` on each option, never isUserSelected.
const DEGRADED = `(
  LENGTH(q.question_stem) <= 65
  OR (LOWER(q.response_format) IN ('single', 'matrix') AND q.answer_choices NOT LIKE '%isUserSelected%')
)`;

async function loadQueue() {
  const subjectClause = SUBJECT === 'ANY' ? '' : `AND q.subject_code = '${SUBJECT.replace(/'/g, '')}'`;
  return all(`
    SELECT s.id AS sid, MIN(s.source) AS source, MIN(s.session_date::text) AS session_date,
           COUNT(*) FILTER (WHERE ${DEGRADED}) AS degraded,
           COUNT(*) AS enriched
    FROM question_attempts q
    INNER JOIN sessions s ON s.id = q.session_id
    WHERE COALESCE(s.excluded, 0) = 0
      AND COALESCE(q.response_format, '') <> ''
      AND LOWER(s.source) NOT LIKE '%practice exam%'
      AND LOWER(s.source) NOT LIKE '%gmat club%'
      AND LOWER(s.source) NOT LIKE '%target test prep%'
      AND LOWER(s.source) NOT LIKE '%ai curated%'
      ${subjectClause}
    GROUP BY s.id
    HAVING COUNT(*) FILTER (WHERE ${DEGRADED}) > 0
    ORDER BY COUNT(*) FILTER (WHERE ${DEGRADED}) DESC, s.id DESC
  `);
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
        page.evaluate(() => Boolean(
          (document.title || '').trim() && document.querySelector('a[href*="OrderProductID="]')
        )),
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

  const batch = queue.slice(0, LIMIT);
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
