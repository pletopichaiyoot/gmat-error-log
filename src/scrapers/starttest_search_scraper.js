'use strict';

// The page.evaluate() callbacks below run in the StartTest page, not in Node.
// eslint.config.mjs is edit-protected, so declare the browser globals here.
/* global document, window, location */

// ─── StartTest "Item ID" harvest ───────────────────────────────────────────
//
// WHY THIS EXISTS
// The `q_code` we store for StartTest rows is the ITD delivery engine's item
// **Key** (`vItemInformation[1].Key`, hidden field `CurrentItemKeys`) — e.g.
// 425773. StartTest's own Search panel ("Search by Item ID") does NOT accept
// that number; it matches the portal-side **Item Name** shown in the results
// table (e.g. 700216). Verified live: an ID search for 425773 returns "No
// matches found.", 700216 returns exactly that question.
//
// The Item Name is not reachable from any page the scrapers already walk:
//   - the Question History table has no Item Name column
//     (Date | Correct | Item Preview | Content Area | Time Spent | Difficulty | Actions)
//   - the ITDReview frame only ever exposes the ITD name + key (D211_002540 / 425773)
//   - the GetPracticeNowReviewItems AJAX answers `Data: "ERROR"` for these books
// It appears ONLY in the search-results table, so the only way to learn it is
// to run the search ourselves and read the rows back.
//
// PAGE CONTRACT (13.2, verified 2026-09-08)
//   search page  : router?...&cmd=GetPage&Page=PracticeNow-SearchInput
//                  radios #searchByText / #searchById (both .visuallyhidden —
//                  set .checked + dispatch change, a real click can't reach them),
//                  #searchText (keywords), #searchIDInput (ids, newline separated),
//                  submit #SubmitSrchInput
//   not-found    : a modal listing "The following Question IDs could not be found:"
//                  with a#SrchCntnue ("Ignore and Continue") — clicking it runs the
//                  search for the ids that DID resolve, so unknown ids are free.
//   results page : table tbody tr.pn-table-row, cells keyed by data-th
//                  (Date, Correct, Item Name, Question Preview, Content Area, Time Spent)
//                  Only ANSWERED items come back, one row per item, and results are
//                  scoped to the current product — so harvest runs per book.
//
// STRATEGY
// Seed with a couple of keyword searches purely to discover which id ranges this
// book uses (ids are clustered, e.g. 1003xx + 7001xx-7006xx), then sweep those
// ranges by id in chunks, growing outward until a chunk comes back empty.

const { sleep, jitter } = require('./scraper-utils');
const {
  SOURCE_PRODUCTS,
  ScrapeAnomalyError,
  normalizeProductHeading,
  _internals: { goto, resolvePageRelative },
} = require('./starttest_scraper');

// Keyword seeds: only used to find the id ranges, so a couple of hits is enough.
// Short stopwords ("the") are filtered by the search index and return nothing.
const SEED_KEYWORDS = ['question', 'following', 'which', 'value'];
// HARVEST_MAX_SEARCHES caps a debug run (e.g. "=1" to spend a single search).
const SEARCH_BUDGET = Number(process.env.HARVEST_MAX_SEARCHES) || 0;
const IDS_PER_SEARCH = 120;   // ponytail: 120 verified OK in one submit; raise only with a re-probe
const CLUSTER_GAP = 300;      // ids further apart than this start a new range
const EMPTY_CHUNKS_TO_STOP = 2;
const MAX_CHUNKS = 60;        // hard ceiling on requests per book

// NOTE — do NOT touch the session-timeout modal. StartTest renders its "Your
// session is about to expire" dialog (buttons #StoExtend / #StoCls) into every
// page, usually hidden, and an earlier version of this file clicked #StoExtend
// defensively before each search. Every run that did so ended with the account
// logged out on its first navigation. Manual runs that never touched it did a
// dozen searches on one session with no trouble. The harvester paces itself
// well inside the timeout (a navigation every few seconds), so the modal never
// legitimately fires — leave those buttons alone.

function assertStillSignedIn(page) {
  const url = page.url();
  if (/Account\/Logout|services\.gmac\.com/i.test(url)) {
    throw new ScrapeAnomalyError(
      'StartTest logged the session out (inactivity timeout). Re-open GMAT practice from mba.com and retry.'
    );
  }
  if (!/starttest\.com\/starttest2\//i.test(url)) {
    throw new ScrapeAnomalyError(
      `Tab left StartTest (now ${url}) — the session code was spent. Re-open GMAT practice and retry.`
    );
  }
}

// Every read here races the page's own navigations, and Playwright throws
// "Execution context was destroyed" when one lands mid-evaluate. That is not an
// error worth aborting a harvest for — retry once the page has settled.
// Codes are single-use and replaying one terminates the login, so remember
// every code this run has navigated with and refuse to use one twice. A stale
// page (one whose links were already consumed) then fails closed instead of
// killing the session.
const codeOf = (url) => (String(url).match(/[?&]code=([0-9a-f-]{36})/i) || [])[1] || null;

// StartTest reuses a code within one exchange (the search POST and the results
// GET that follows share it), so a code appearing twice is not by itself wrong —
// what kills the login is submitting a FORM whose action carries a code the page
// was already served with. The guard therefore tracks what we have navigated
// with so `formCodeIsStale` can veto that exact case.
function makeCodeGuard() {
  const navigated = new Set();
  return {
    claim(url) {
      const code = codeOf(url);
      if (code) navigated.add(code);
      return true;
    },
    sawAsNavigation(code) {
      return Boolean(code) && navigated.has(code);
    },
  };
}

async function safeEvaluate(page, fn, arg) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate(fn, arg);
    } catch (error) {
      if (!/Execution context was destroyed|Target closed|frame was detached/i.test(error?.message || '')) throw error;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(500);
    }
  }
  return null;
}

const findLink = (page, pattern) => safeEvaluate(page, (source) => {
  const re = new RegExp(source, 'i');
  const a = [...document.querySelectorAll('a')].find((x) => re.test(x.getAttribute('href') || ''));
  return a ? a.getAttribute('href') : null;
}, pattern);

// Land on the book's Search page from wherever we are, ALWAYS by following a
// link that is on the current page.
//
// Every `code` is single-use, and replaying a spent one does not merely fail —
// StartTest kills the whole login (the tab ends on services.gmac.com/.../Logout
// and the next sign-in needs the password). `navigateHome` rebuilds a URL from
// the address bar's already-spent code, so the first three harvest runs logged
// the account out on their very first navigation. Links rendered into the
// current page always carry a fresh code, so this module follows links only.
//
// A results page's own Search link is worse than useless: it re-issues the code
// that page was served with, and submitting the form it renders replays that
// code — which is what terminated the login. Always go home first.
async function openSearchPage(page, preset, codeGuard) {
  // Never read links off a document that is still navigating: those hrefs
  // belong to the outgoing page and their codes are already spent.
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(400);
  assertStillSignedIn(page);

  // Already sitting on the form (first call of a run, if the user left it there).
  if (await page.$('#SubmitSrchInput')) return;

  await followHomeThenSearch(page, preset, codeGuard);
}

// Home → (book switcher, if needed) → Search. Split out so a stale form code can
// re-enter the same way.
async function followHomeThenSearch(page, preset, codeGuard) {
  const followLink = async (pattern) => {
    const rel = await findLink(page, pattern);
    if (!rel) return false;
    const url = await resolvePageRelative(page, rel);
    codeGuard.claim(url);
    await goto(page, url);
    assertStillSignedIn(page);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    return true;
  };

  // ALWAYS route through the product home, never straight from a results page's
  // own "Search" link. That link re-issues the code the results page was served
  // with, the form it renders carries that same code, and POSTing it is a replay
  // — which StartTest answers by terminating the login (verified in a network
  // trace: search #1 POSTed cmd=PracticeNowSearch fine; search #2, entered via
  // the results page's Search link, replayed its code and hit Account/Logout
  // seconds later). Going home first mints a fresh code, which is exactly what
  // the manual runs that survived a dozen searches did.
  if (!(await followLink('PracticeNow-home')) && !(await followLink(`OrderProductID=${preset.productId}`))) {
    throw new ScrapeAnomalyError(
      `No way back to the practice home from ${page.url()}. Open the book's practice home in the StartTest tab and retry.`
    );
  }

  // The Search page searches whichever book is selected, so make sure it is ours
  // before entering it (the home page names the selected book in its heading).
  const bookName = normalizeProductHeading(preset.productName || '');
  const headingText = async () => (await safeEvaluate(page, () => (document.body.innerText || '').slice(0, 400))) || '';
  if (bookName && !normalizeProductHeading(await headingText()).includes(bookName)) {
    if (!(await followLink(`OrderProductID=${preset.productId}`))) {
      throw new ScrapeAnomalyError(
        `Practice home is not showing "${preset.label}" and no switcher link was found.`
      );
    }
  }

  if (!(await followLink('Page=PracticeNow-SearchInput'))) {
    throw new ScrapeAnomalyError(`No Search link on the practice home for "${preset.label}".`);
  }
  await page.waitForSelector('#SubmitSrchInput', { timeout: 30000 });
  if (bookName && !normalizeProductHeading(await headingText()).includes(bookName)) {
    throw new ScrapeAnomalyError(
      `Search page is not scoped to "${preset.label}" (heading: ${(await headingText()).replace(/\s+/g, ' ').slice(0, 120)}).`
    );
  }
}

// Submit one search and return its result rows. Handles the "ids not found"
// modal by continuing with whichever ids resolved.
async function runSearch(page, preset, mode, value, codeGuard) {
  await openSearchPage(page, preset, codeGuard);
  assertStillSignedIn(page);

  // Last line of defence for the logout bug: if the form's action carries a code
  // this run already navigated with, submitting it is a replay. Re-enter through
  // the home page (which mints a fresh one) rather than spending the login.
  const formCode = async () => codeOf(
    (await safeEvaluate(page, () => (document.getElementById('SubmitSrchInput')?.form?.action) || '')) || ''
  );
  if (codeGuard.sawAsNavigation(await formCode())) {
    await followHomeThenSearch(page, preset, codeGuard);
    if (codeGuard.sawAsNavigation(await formCode())) {
      throw new ScrapeAnomalyError(
        'Search form is still carrying an already-used code after re-entering; stopping rather than replaying it (that logs the account out).'
      );
    }
  }
  codeGuard.claim((await safeEvaluate(page, () => (document.getElementById('SubmitSrchInput')?.form?.action) || '')) || '');
  // Submitting is a full navigation for a hit and an in-place render for a miss,
  // so "did my search land?" cannot be answered by reading the DOM alone: a read
  // that races the navigation answers from the OUTGOING page. Stamp the current
  // document first — once the stamp is gone, we are demonstrably on the new one.
  // (Reading too early also made a landed search look like a miss, and the
  // harvester then followed the dying page's already-spent links — replaying a
  // code is what logged the account out.)
  await safeEvaluate(page, () => { window.__harvestMark = 1; });

  // The Search button ships `disabled` and the page's own validation enables it
  // only once the input really changed — assigning `.value` inside evaluate()
  // does not count, so `.click()` then fires on a disabled button and NOTHING
  // is submitted (the request never appears in a network trace; the harvest
  // just reports zero rows). Type through Playwright, which dispatches the
  // events the page listens for, and wait for the button to enable.
  const submit = async () => {
    const idMode = mode === 'id';
    // The radios are .visuallyhidden, so a real click can't reach them — but the
    // synthetic change DOES run the page's handler, which is what enables and
    // reveals the id textarea.
    await page.evaluate((byId) => {
      const radio = document.getElementById(byId ? 'searchById' : 'searchByText');
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      radio.dispatchEvent(new Event('click', { bubbles: true }));
    }, idMode);

    const field = idMode ? '#searchIDInput' : '#searchText';
    await page.waitForSelector(`${field}:not([disabled])`, { state: 'visible', timeout: 15000 });
    await page.fill(field, value);
    await page.waitForSelector('#SubmitSrchInput:not([disabled])', { timeout: 15000 });
    try {
      await page.click('#SubmitSrchInput');
    } catch (error) {
      // The click navigates; losing the element/context here means "submitted".
      if (!/Execution context was destroyed|frame was detached|Target closed/i.test(error?.message || '')) throw error;
    }
  };

  const readState = () => page.evaluate(() => {
    // "No matches found" also lives in the page as a hidden block, so only count
    // it when it is actually rendered.
    const noMatchEl = [...document.querySelectorAll('div, p, span, h2, h3')]
      .find((el) => /No matches found/i.test(el.textContent || '') && el.children.length === 0);
    return {
      stillOldPage: Boolean(window.__harvestMark),
      title: document.title,
      rows: document.querySelectorAll('table tbody tr.pn-table-row').length,
      noMatch: Boolean(noMatchEl && noMatchEl.offsetParent !== null),
      modal: Boolean(document.querySelector('a#SrchCntnue')),
    };
  }).catch(() => null); // mid-navigation reads throw; poll again

  const settle = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await readState();
      if (state) {
        // The unknown-id warning renders in place, before any navigation.
        if (state.modal) return 'modal';
        if (state.stillOldPage) {
          // A miss keeps you on the form and shows the message inline.
          if (state.noMatch) return 'empty';
        } else {
          if (state.rows > 0) return 'rows';
          if (state.noMatch) return 'empty';
        }
      }
      await sleep(400);
    }
    return null;
  };

  await submit();
  let outcome = await settle(30000);
  if (outcome === 'modal') {
    // Unknown ids: continue with the ones that did resolve.
    await safeEvaluate(page, () => { document.querySelector('a#SrchCntnue')?.click(); });
    outcome = await settle(30000);
  }
  assertStillSignedIn(page);
  if (!outcome) {
    const snippet = await page
      .evaluate(() => `${document.title} :: ${(document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200)}`)
      .catch(() => '(unreadable)');
    throw new ScrapeAnomalyError(`Search for ${mode}="${String(value).slice(0, 40)}" never settled. ${snippet}`);
  }
  if (outcome === 'empty') {
    if (process.env.HARVEST_DEBUG) {
      const dump = await safeEvaluate(page, () => ({
        url: location.href,
        title: document.title,
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1500),
      }));
      try {
        require('fs').appendFileSync(
          process.env.HARVEST_PAGE_LOG || 'tmp/harvest-page.log',
          `\n--- empty result for ${mode}="${String(value).slice(0, 60)}"\n${JSON.stringify(dump, null, 1)}\n`
        );
      } catch { /* tracing is best-effort */ }
    }
    return [];
  }

  const rows = await safeEvaluate(page, () => Array.from(document.querySelectorAll('table tbody tr.pn-table-row')).map((tr) => {
    const cell = (th) => {
      const td = Array.from(tr.children).find((c) => c.getAttribute('data-th') === th);
      return td ? (td.innerText || '').trim() : null;
    };
    return {
      itemId: cell('Item Name'),
      date: cell('Date'),
      correct: cell('Correct'),
      preview: cell('Question Preview'),
      contentArea: cell('Content Area'),
      timeSpent: cell('Time Spent'),
    };
  }));
  return rows || [];
}

function numericIds(rows) {
  return rows
    .map((r) => Number(String(r.itemId || '').trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// Split sorted ids into ranges, so the sweep only walks id space this book uses.
function clusterIds(ids, gap = CLUSTER_GAP) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const clusters = [];
  for (const id of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && id - last.max <= gap) last.max = id;
    else clusters.push({ min: id, max: id });
  }
  return clusters;
}

// Harvest every reachable (Item Name, preview, date, correct, time) row for one
// book. Returns { rows, stats } — `rows` is deduped by itemId.
async function harvestSearchItemIds(page, sourceId, { onProgress = () => {}, seedsOnly = false } = {}) {
  const preset = SOURCE_PRODUCTS[sourceId];
  if (!preset) throw new ScrapeAnomalyError(`Unknown StartTest sourceId "${sourceId}".`);

  // Deliberately no navigateToProduct()/navigateHome() anywhere in this module:
  // both rebuild a router URL from the address bar's spent `code`, and replaying
  // one gets the account logged out. openSearchPage only follows page links.
  assertStillSignedIn(page);

  const codeGuard = makeCodeGuard();
  const byId = new Map();
  let searches = 0;
  const absorb = (rows) => {
    let added = 0;
    for (const row of rows) {
      const id = String(row.itemId || '').trim();
      if (!id || byId.has(id)) continue;
      byId.set(id, row);
      added += 1;
    }
    return added;
  };

  // 1. Seeds — just enough hits to learn the id ranges.
  for (const word of SEED_KEYWORDS) {
    if (SEARCH_BUDGET && searches >= SEARCH_BUDGET) break;
    onProgress({ event: 'searching', mode: 'text', word });
    const rows = await runSearch(page, preset, 'text', word, codeGuard);
    searches += 1;
    const added = absorb(rows);
    onProgress({ event: 'seed', word, rows: rows.length, added, total: byId.size });
    await sleep(jitter(1500, 3000));
    if (byId.size >= 20) break;
  }
  if (!byId.size && !SEARCH_BUDGET) {
    throw new ScrapeAnomalyError(
      `No search results for any seed keyword in "${preset.label}" — cannot locate this book's item-id range.`
    );
  }

  // 2. Sweep each cluster by id, growing outward until chunks come back empty.
  const chunkFor = (start) => Array.from({ length: IDS_PER_SEARCH }, (_, i) => start + i);
  const sweep = async (start) => {
    const ids = chunkFor(start).filter((id) => !byId.has(String(id)));
    if (!ids.length) return 0;
    onProgress({ event: 'searching', mode: 'id', start, count: ids.length });
    const rows = await runSearch(page, preset, 'id', ids.join('\n'), codeGuard);
    searches += 1;
    const added = absorb(rows);
    onProgress({ event: 'sweep', start, rows: rows.length, added, total: byId.size });
    await sleep(jitter(1500, 3000));
    return rows.length;
  };

  // `seedsOnly` is the cheap pre-flight: two searches, no sweep. Worth running
  // first on a fresh login, because a broken run can cost the whole session.
  if (seedsOnly) {
    return { rows: [...byId.values()], stats: { searches, items: byId.size, source: preset.label, seedsOnly: true } };
  }

  for (const cluster of clusterIds(numericIds([...byId.values()]))) {
    // Inside the known span first, then outward in both directions.
    for (let start = cluster.min; start <= cluster.max && searches < MAX_CHUNKS; start += IDS_PER_SEARCH) {
      await sweep(start);
    }
    let empties = 0;
    for (let start = cluster.max + 1; empties < EMPTY_CHUNKS_TO_STOP && searches < MAX_CHUNKS; start += IDS_PER_SEARCH) {
      empties = (await sweep(start)) ? 0 : empties + 1;
    }
    empties = 0;
    for (let start = cluster.min - IDS_PER_SEARCH; empties < EMPTY_CHUNKS_TO_STOP && start > 0 && searches < MAX_CHUNKS; start -= IDS_PER_SEARCH) {
      empties = (await sweep(start)) ? 0 : empties + 1;
    }
  }

  return { rows: [...byId.values()], stats: { searches, items: byId.size, source: preset.label } };
}

// ─── Join: search rows → question_attempts ─────────────────────────────────

// The search preview is the same 60-char truncation the Question History table
// shows, so a Phase-1 row's stem equals it and a Phase-2 (enriched) row's stem
// starts with it — minus the "[item contains image]" marker Phase 2 drops.
function normalizeStemKey(text) {
  return String(text || '')
    .replace(/\[item contains image\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// "116 Seconds" → 116; "3+ Minutes" → null (the page stops printing seconds
// past 3 minutes, so those rows can only be range-checked).
function parseSearchSeconds(timeSpent) {
  const m = String(timeSpent || '').match(/^(\d+)\s*seconds?/i);
  return m ? Number(m[1]) : null;
}

function parseSearchDate(mdy) {
  const m = String(mdy || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

function attemptDateMs(sessionDate) {
  if (!sessionDate) return null;
  const iso = sessionDate instanceof Date
    ? sessionDate.toISOString().slice(0, 10)
    : String(sessionDate).slice(0, 10);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

const DAY = 86400000;

// Match one search row against one attempt on the signals both sides carry.
function rowMatchesAttempt(searchRow, attempt) {
  const key = normalizeStemKey(searchRow.preview);
  if (key.length < 12) return null; // too short to identify anything
  const stem = normalizeStemKey(attempt.question_stem);
  if (!stem.startsWith(key)) return null;

  const wantCorrect = /^y/i.test(String(searchRow.correct || ''));
  if (wantCorrect !== Boolean(attempt.correct)) return null;

  const seconds = parseSearchSeconds(searchRow.timeSpent);
  const attemptSeconds = Number.isFinite(Number(attempt.time_sec)) ? Number(attempt.time_sec) : null;
  if (seconds !== null && attemptSeconds !== null && Math.abs(seconds - attemptSeconds) > 3) return null;
  // "3+ Minutes" rows must pair with an attempt that actually ran long.
  if (seconds === null && attemptSeconds !== null && attemptSeconds < 170) return null;

  // The search prints the ANSWER date; we only store the session's start date,
  // and a session can span days — so score by how soon after the session the
  // answer landed and let the caller reject near-ties.
  const answerMs = parseSearchDate(searchRow.date);
  const sessionMs = attemptDateMs(attempt.session_date);
  if (answerMs === null || sessionMs === null) return { gapDays: null };
  const gapDays = (answerMs - sessionMs) / DAY;
  if (gapDays < 0 || gapDays > 10) return null;
  return { gapDays };
}

// Pure join used by the DB writer (and the unit test). Returns
// { assignments: [{attemptId, itemId}], byQCode: Map, ambiguous, unmatched }.
//
// Conservative on purpose: a wrong Item ID sends the user to the wrong question,
// so anything that stays ambiguous is left unassigned rather than guessed.
function matchSearchRowsToAttempts(searchRows, attempts) {
  const assignments = [];
  const byQCode = new Map();
  let ambiguous = 0;

  for (const attempt of attempts || []) {
    const candidates = [];
    for (const row of searchRows || []) {
      const hit = rowMatchesAttempt(row, attempt);
      if (hit) candidates.push({ itemId: String(row.itemId).trim(), gapDays: hit.gapDays });
    }
    if (!candidates.length) continue;

    const distinct = [...new Set(candidates.map((c) => c.itemId))];
    let itemId = null;
    if (distinct.length === 1) {
      itemId = distinct[0];
    } else {
      // Prefer the answer date closest to the session, but only when it is
      // clearly closer than the runner-up (>3 days), otherwise skip.
      const dated = candidates.filter((c) => c.gapDays !== null).sort((a, b) => a.gapDays - b.gapDays);
      if (dated.length >= 2 && dated[1].gapDays - dated[0].gapDays > 3) itemId = dated[0].itemId;
    }
    if (!itemId) { ambiguous += 1; continue; }

    assignments.push({ attemptId: attempt.id, itemId });
    const qCode = String(attempt.q_code || '').trim();
    if (qCode && !byQCode.has(qCode)) byQCode.set(qCode, itemId);
  }

  return {
    assignments,
    byQCode,
    ambiguous,
    unmatched: (attempts || []).length - assignments.length - ambiguous,
  };
}

module.exports = {
  harvestSearchItemIds,
  matchSearchRowsToAttempts,
  // Exposed for tests.
  _internals: { clusterIds, normalizeStemKey, parseSearchSeconds, rowMatchesAttempt },
};
