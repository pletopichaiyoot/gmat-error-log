/**
 * Probe ITDReview pages to find where the user's pick is actually stored.
 *
 * Reuses the existing scraper navigation. Connects to the user's Chrome on
 * CDP 9222, runs Phase 2 against the configured session, but uses a custom
 * `readReviewFrame` that dumps every plausible signal (hidden inputs, all
 * radios with checked/defaultChecked, ALL .ITSMC* / .correctOption /
 * .incorrectOption nodes with their content, computed BG of every row,
 * any global that matches /answer|select|response|pick/i).
 *
 * Usage:
 *   SOURCE_ID=og-verbal SID=45940 node scripts/probe_user_pick.js
 *
 * Default: VERBAL (which has the buggy session 45940 / V188_000139-05).
 */
const { chromium } = require('playwright');

const SID = process.env.SID || '45940';
const SOURCE_ID = process.env.SOURCE_ID || 'og-verbal';
const TOTAL_Q = Number(process.env.TOTAL_Q || 6);

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctxs = browser.contexts();
  let page = null;
  for (const ctx of ctxs) {
    for (const p of ctx.pages()) {
      if (/starttest\.com/i.test(p.url())) { page = p; break; }
    }
    if (page) break;
  }
  if (!page) {
    console.error('No starttest.com tab found');
    process.exit(1);
  }
  console.log('Tab:', page.url().slice(0, 200));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // If we're already on a ReviewItems page, jump straight into the iteration loop.
  const alreadyOnReview = /cmd=ReviewItems/i.test(page.url());

  // If we're not on a report-shaped page (and not already on review), navigate to one.
  let onReport = !alreadyOnReview && await page.evaluate(() => typeof jsondata_reviewtable !== 'undefined');
  if (!alreadyOnReview && !onReport) {
    // Try clicking from product home table if we have one.
    const reportUrl = await page.evaluate((id) => {
      const tr = document.querySelector(
        `table.PracticeSessionsTable-tbl tbody tr#${CSS.escape(String(id))}`,
      );
      return tr?.querySelector(
        'a[href*="NavigateToDiagnosticReport"]:not([href*="widgetview"])',
      )?.href || null;
    }, SID);
    if (!reportUrl) {
      console.error('Not on report and not on product home. Click into the GMAT Verbal Review book home, then re-run.');
      process.exit(1);
    }
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    onReport = await page.evaluate(() => typeof jsondata_reviewtable !== 'undefined');
    if (!onReport) {
      console.error('Navigated to report but jsondata_reviewtable not exposed.');
      process.exit(1);
    }
  }
  if (!alreadyOnReview) {
    console.log('On report page; reading jsondata_reviewtable.');

    const qhRel = await page.evaluate((args) => {
      const cfg = (typeof jsondata_reviewtable !== 'undefined' && jsondata_reviewtable) || null;
      if (!cfg?.getqhistoryurl) return null;
      return `${cfg.getqhistoryurl}&sid=${encodeURIComponent(args.sid)}&d=0&c=0&s=2&liid=0&ct=${encodeURIComponent(args.totalQ)}`;
    }, { sid: SID, totalQ: TOTAL_Q });
    if (!qhRel) {
      console.error('No jsondata_reviewtable.getqhistoryurl on report page.');
      process.exit(1);
    }
    const absQh = new URL(qhRel, page.url()).href;
    console.log('QHistory:', absQh.slice(0, 200));
    await page.goto(absQh, { waitUntil: 'domcontentloaded' });
    await sleep(1500);

    const reviewUrlRel = await page.evaluate(() => {
      const a = document.querySelector('table tbody tr.pn-table-row a.opentestwindow[url]');
      return a ? a.getAttribute('url') : null;
    });
    if (!reviewUrlRel) {
      console.error('No review link on QHistory.');
      process.exit(1);
    }
    const reviewUrl = new URL(reviewUrlRel, page.url()).href;
    console.log('First review:', reviewUrl.slice(0, 200));
    await page.goto(reviewUrl, { waitUntil: 'domcontentloaded' });
  } else {
    console.log('Already on ReviewItems; iterating from current item.');
  }

  for (let i = 0; i < TOTAL_Q; i += 1) {
    let frame = null;
    for (let tries = 0; tries < 60; tries += 1) {
      frame = page.frames().find((f) => /ITDReview\.aspx/i.test(f.url()));
      if (frame) {
        try {
          const ready = await frame.evaluate(() => {
            return typeof window.vItemName !== 'undefined'
              && document.querySelectorAll('input[type="radio"][name="I1"]').length >= 2;
          });
          if (ready) break;
        } catch (_) { /* */ }
      }
      await sleep(300);
    }
    if (!frame) {
      console.error('No ITDReview frame at iteration', i);
      break;
    }
    // Generously wait for review highlights to populate
    await sleep(4000);

    const dump = await frame.evaluate(() => {
      const out = {};
      out.vItemName = window.vItemName || null;
      out.vItemType = window.vItemType || null;
      out.frameUrl = location.href.slice(0, 200);

      // Form/inputs
      const form = document.forms?.[0];
      out.formName = form?.name || null;
      const hidden = [];
      if (form) {
        for (const el of form.elements) {
          if (el.type === 'hidden') hidden.push({ name: el.name, value: String(el.value || '').slice(0, 200) });
        }
      }
      out.hiddenInputs = hidden;

      // All radios verbatim
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      out.radios = radios.map((r) => ({
        name: r.name,
        value: r.value,
        checked: r.checked,
        defaultChecked: r.defaultChecked,
      }));

      // Specific class signals + their location relative to choices
      const i1 = radios.filter((r) => r.name === 'I1');
      const valueOfRowContaining = (sel) => {
        const node = document.querySelector(sel);
        if (!node) return null;
        // Find the I1 radio inside this node
        const inside = node.querySelector('input[type="radio"][name="I1"]');
        if (inside) return { value: inside.value, checked: inside.checked };
        // Or, find a nearby I1 that this node's row wraps
        for (const r of i1) {
          if (node.contains(r)) return { value: r.value, checked: r.checked };
        }
        return null;
      };

      out.signals = {
        ITSMCOptionTableOn: {
          present: !!document.querySelector('.ITSMCOptionTableOn'),
          rowI1: valueOfRowContaining('.ITSMCOptionTableOn'),
          html: (document.querySelector('.ITSMCOptionTableOn')?.outerHTML || '').slice(0, 250),
        },
        correctOption: {
          present: !!document.querySelector('.correctOption'),
          rowI1: valueOfRowContaining('.correctOption'),
          html: (document.querySelector('.correctOption')?.outerHTML || '').slice(0, 250),
        },
        incorrectOption: {
          present: !!document.querySelector('.incorrectOption'),
          rowI1: valueOfRowContaining('.incorrectOption'),
          html: (document.querySelector('.incorrectOption')?.outerHTML || '').slice(0, 250),
        },
      };

      // Per-choice walk
      out.choices = i1.map((el) => {
        const labelText = (el.labels?.[0]?.innerText || el.parentElement?.innerText || '').trim().slice(0, 60);
        const tr = el.closest('tr') || el.parentElement;
        const trClasses = tr ? tr.className : null;
        const trBg = (typeof getComputedStyle === 'function' && tr) ? getComputedStyle(tr).backgroundColor : null;
        const ancestorClasses = [];
        for (let n = tr, depth = 0; n && depth < 6; n = n.parentElement, depth += 1) {
          ancestorClasses.push((n.className || '').toString().slice(0, 80));
        }
        return {
          value: el.value,
          checked: el.checked,
          defaultChecked: el.defaultChecked,
          labelText,
          trClasses,
          trBg,
          ancestorClasses,
        };
      });

      // Keys/answer-related globals
      const interesting = {};
      for (const k of Object.keys(window)) {
        if (!/answer|response|pick|select|chosen|saved|item.*answer|vKey|vCorrect/i.test(k)) continue;
        const v = window[k];
        if (typeof v === 'function') continue;
        try { interesting[k] = JSON.parse(JSON.stringify(v)); }
        catch { interesting[k] = String(v).slice(0, 200); }
      }
      out.interestingGlobals = interesting;

      return out;
    });
    console.log('═══ Item', i, '(' + (dump.vItemName || '?') + ') ═══');
    console.log(JSON.stringify(dump, null, 2));

    // Move to next item (must invoke processAction on the ITDStart harness frame)
    try {
      const startFrame = page.frames().find((f) => /ITDStart\.aspx/i.test(f.url()));
      if (startFrame) {
        const prevName = dump.vItemName;
        await startFrame.evaluate(() => {
          if (typeof window.processAction === 'function') window.processAction('Next');
        });
        // Wait for vItemName to flip
        for (let t = 0; t < 30; t += 1) {
          await sleep(500);
          const f2 = page.frames().find((f) => /ITDReview\.aspx/i.test(f.url()));
          if (!f2) continue;
          try {
            const newName = await f2.evaluate(() => window.vItemName || null);
            if (newName && newName !== prevName) break;
          } catch (_) {}
        }
      } else {
        console.error('No ITDStart frame for Next');
      }
    } catch (e) { console.error('Next click error', e.message); }
  }

  await browser.close().catch(() => {});
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
