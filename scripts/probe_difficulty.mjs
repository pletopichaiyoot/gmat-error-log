#!/usr/bin/env node
// One-off probe: open the QHistory table on the user's logged-in StartTest
// tab and report what's in the Difficulty column for every row.
//
// Usage: node scripts/probe_difficulty.js
//
// Reads the FIRST starttest tab it finds via CDP. Must have a session report
// open whose "Question History" link is reachable; we'll either reuse the
// current page if it's already QHistory, or click through from a report.

import { chromium } from 'playwright';

const CDP_URL = 'http://127.0.0.1:9222';

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const contexts = browser.contexts();
    const pages = contexts.flatMap((c) => c.pages());
    const stTab = pages.find((p) => /starttest\.com/i.test(p.url()));
    if (!stTab) {
      console.error('No starttest.com tab found. Open a session report first.');
      process.exit(2);
    }
    console.log('Active starttest tab URL:', stTab.url());

    // Look for a QHistory router URL on the page (set by report pages as a JSON blob).
    const ctx = await stTab.evaluate(() => {
      const out = { hasQHistoryTable: false, qhRouterUrl: null, sid: null, totalCount: null };
      const tbl = document.querySelector('table tbody tr.pn-table-row');
      out.hasQHistoryTable = Boolean(tbl);
      try {
        const el = document.getElementById('jsondata_reviewtable');
        if (el && el.textContent) {
          const obj = JSON.parse(el.textContent);
          out.qhRouterUrl = obj.qhistory || obj.queryhistory || null;
        }
      } catch {}
      // Try to lift sid + total from inputs/anchors.
      const sidInput = document.querySelector('input[name="sid"], input[name="SID"]');
      if (sidInput) out.sid = sidInput.value;
      const tot = document.querySelector('[data-totalcount]');
      if (tot) out.totalCount = tot.getAttribute('data-totalcount');
      return out;
    });
    console.log('Page context:', ctx);

    if (!ctx.hasQHistoryTable) {
      console.log('No QHistory table on current page. To probe difficulty, navigate to a session report\nand expand "Question History" first, then re-run this script.');
      process.exit(0);
    }

    // Inspect every row's Difficulty cell.
    const rows = await stTab.evaluate(() => {
      const trs = Array.from(document.querySelectorAll('table tbody tr.pn-table-row'));
      // Capture all data-th values that exist on the first row to see column inventory.
      const sample = trs[0] ? Array.from(trs[0].children).map((c) => c.getAttribute('data-th')) : [];
      const probe = trs.slice(0, 50).map((tr, i) => {
        const cells = Array.from(tr.children);
        const byTh = (th) => {
          const td = cells.find((c) => c.getAttribute('data-th') === th);
          return td ? { text: (td.innerText || '').trim(), html: (td.innerHTML || '').slice(0, 200) } : null;
        };
        return {
          idx: i,
          contentArea: byTh('Content Area')?.text || null,
          correct: byTh('Correct')?.text || null,
          difficulty: byTh('Difficulty'),
          // Also capture any column whose header looks similar (rename detection).
          allDataTh: cells.map((c) => c.getAttribute('data-th')),
        };
      });
      return { columnInventory: sample, rowCount: trs.length, probe };
    });

    console.log('\nColumn inventory (data-th attrs of row 0):');
    console.log(' ', rows.columnInventory);
    console.log('\nTotal rows:', rows.rowCount);

    const missing = rows.probe.filter((r) => !r.difficulty || !r.difficulty.text);
    const present = rows.probe.filter((r) => r.difficulty && r.difficulty.text);
    console.log(`\nDifficulty present: ${present.length}/${rows.probe.length}, missing: ${missing.length}/${rows.probe.length}`);
    console.log('\n— Up to 5 PRESENT samples —');
    for (const r of present.slice(0, 5)) {
      console.log(` [${r.idx}] content=${r.contentArea} correct=${r.correct} diff="${r.difficulty.text}" html=${r.difficulty.html}`);
    }
    console.log('\n— Up to 5 MISSING samples —');
    for (const r of missing.slice(0, 5)) {
      console.log(` [${r.idx}] content=${r.contentArea} correct=${r.correct} diff_cell=${r.difficulty ? `present-but-empty html="${r.difficulty.html}"` : 'NO_CELL'}`);
    }
  } finally {
    // Detach without closing user's Chrome.
    try { await browser.close(); } catch {}
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
