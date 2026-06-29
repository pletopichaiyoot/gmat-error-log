/* global document, location, window */
// Node-side host that embeds page.evaluate() callbacks where the above
// browser globals are valid inside the page context.

// GMAT Official Practice Exam (OPE) scraper. Runs Node-side, drives the user's
// Chrome via CDP. Targets the StartTest 2 / 13.1 ITD engine — different URL
// scheme from the books (13.0, type=6): OPEs are type=1 on /starttest2/13.1/.
//
// Three phases (Phase 3 not yet implemented):
//
//   Phase 1 (list takes): On an OPE product landing page
//     (cmd=NavigateToProduct&OrderProductID=<ope>&type=1), enumerate the
//     "Take #" table (class `tbl-tbl tbl-test TestAllTable_table`). Each
//     completed take is an `<a class="launchitdwindow">View score report</a>`
//     with no data attributes — take number comes from row position.
//
//   Phase 2 (section summary, fast): For ONE chosen take, open / re-attach to
//     the Score Report popup (ITDStart.aspx?SVC=<uuid>). The popup's `cmd=item`
//     iframe renders the full Score Card up front — all 3 sections' question
//     tables (`table.table-table.type-%detailsTable%`) are already in the DOM,
//     NO section button clicks required. Read one row per question (Performance
//     view, not Time-Pressure view).
//
//   Phase 3 (per-question enrichment, slow, chunked): NOT YET IMPLEMENTED.
//     Will drive each `.navigate` anchor in the section tables, wait for the
//     cmd=REVIEW-ALL iframe, scrape stem/choices/Key1/user pick. Paced 1.5–3s
//     jitter. Error budget max(5, ceil(total/4)).
//
// Constraints (CLAUDE.md / HANDOFF):
//   - Never call browser.close(); user's Chrome is shared.
//   - Sessions synthesized one-per-take via takeGuid (field 7 of decoded
//     data= blob on the cmd=item iframe URL) for stable upserts across rescrapes.
//   - q_code namespace prefixed `ope-` to avoid collisions with practice books.

const { sanitizeStemHtml, stemHtmlToText } = require('./ope-stem');

const STARTTEST_HOST_RE = /starttest\.com/i;
const ITDSTART_HOST_RE = /ITDStart\.aspx/i;

const SOURCE_PRODUCTS = Object.freeze({
  'ope-1': { productId: 510723, type: 1, label: 'GMAT™ Official Practice Exam 1', productName: 'GMAT™ Official Practice Exam 1' },
  'ope-2': { productId: 510724, type: 1, label: 'GMAT™ Official Practice Exam 2', productName: 'GMAT™ Official Practice Exam 2' },
  'ope-3': { productId: 873268, type: 1, label: 'GMAT™ Official Practice Exam 3', productName: 'GMAT™ Official Practice Exam 3' },
  'ope-4': { productId: 873269, type: 1, label: 'GMAT™ Official Practice Exam 4', productName: 'GMAT™ Official Practice Exam 4' },
  'ope-5': { productId: 873270, type: 1, label: 'GMAT™ Official Practice Exam 5', productName: 'GMAT™ Official Practice Exam 5' },
  'ope-6': { productId: 873271, type: 1, label: 'GMAT™ Official Practice Exam 6', productName: 'GMAT™ Official Practice Exam 6' },
});

const ERROR_PAGE_PATTERNS = [
  /unexpected error has been encountered/i,
  /unexpected error has occurred/i,
  /unknown command/i,
  /support@testsys\.com/i,
  /you have an error/i,
  /the url is invalid/i,
  /session (?:has |)expired/i,
  /please (?:log|sign) in/i,
];

class ScrapeAnomalyError extends Error {
  constructor(message, { url, snippet } = {}) {
    super(message);
    this.name = 'ScrapeAnomalyError';
    this.url = url || null;
    this.snippet = snippet || null;
  }
}

function assertNotErrorPage(bodyText, url) {
  const sample = String(bodyText || '').slice(0, 4000);
  for (const pat of ERROR_PAGE_PATTERNS) {
    if (pat.test(sample)) {
      throw new ScrapeAnomalyError(
        `StartTest returned an error page (matched ${pat}). Aborting to avoid looking like a bot.`,
        { url, snippet: sample.slice(0, 400) },
      );
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
}

function parseDateMDY(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function parseMinutesToSeconds(raw) {
  const n = Number(String(raw || '').trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 60);
}

// Decode the base64 `data=` blob carried on every itd.aspx iframe URL. The
// decoded payload is a CSV; field 7 is the per-take GUID — stable across
// SVC rotations, immutable for the lifetime of the take.
//   "1396947524,24.3.0.0,469493,314,8,ENU,B8A784EA-...,..."
//                                       ^^^^^^^^^^^^ takeGuid
function decodeDataBlob(b64) {
  try {
    const decoded = Buffer.from(String(b64 || ''), 'base64').toString('utf-8');
    const fields = decoded.split(',');
    return {
      raw: decoded,
      takeSerial: fields[0] || null,
      engineVersion: fields[1] || null,
      programId: fields[3] || null,
      takeGuid: fields[6] || null,
    };
  } catch {
    return { raw: null, takeSerial: null, engineVersion: null, programId: null, takeGuid: null };
  }
}

// Deterministic 53-bit hash (same impl as ttp_scraper) — mints a stable
// session_external_id from a `${productId}|${takeGuid}` tuple.
function hashSessionExternalId(input) {
  const text = String(input || '');
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Recover the takeIdx from a session_external_id by inverting the hash. The
// session_external_id is computed as hashSessionExternalId(`ope-${productId}
// |take-${takeIdx}`); since takeIdx is a small positive integer we can just
// try 1..maxTakes and return the first hit. Needed because the takeIdx isn't
// persisted on the session row — the enrich endpoint has only the session's
// external id, but the Phase 3 runner needs takeIdx to drive the right popup.
function recoverTakeIdxFromSessionExternalId(sessionExternalId, productId, { maxTakes = 10 } = {}) {
  const target = Number(sessionExternalId);
  if (!Number.isFinite(target)) return null;
  for (let i = 1; i <= maxTakes; i += 1) {
    if (hashSessionExternalId(`ope-${productId}|take-${i}`) === target) {
      return i;
    }
  }
  return null;
}

function subjectFromItemName(itemName) {
  const prefix = String(itemName || '').trim().charAt(0).toUpperCase();
  if (prefix === 'V') return 'V';
  if (prefix === 'Q') return 'Q';
  if (prefix === 'D') return 'DI';
  return '';
}

function mapCategoryCode(subjectCode, questionType) {
  const qt = String(questionType || '').toLowerCase().trim();
  if (subjectCode === 'Q') return 'PS';
  if (subjectCode === 'V') {
    if (qt.includes('critical reasoning')) return 'CR';
    if (qt.includes('reading comprehension')) return 'RC';
    return '';
  }
  if (subjectCode === 'DI') {
    if (qt.includes('multi-source') || qt.includes('multi source') || qt === 'msr') return 'MSR';
    if (qt.includes('two-part') || qt.includes('two part')) return 'TPA';
    if (qt.includes('graphs') || qt.includes('graphics')) return 'GI';
    if (qt.includes('table analysis') || qt.startsWith('tables')) return 'TA';
    if (qt.includes('data sufficiency')) return 'DS';
    return '';
  }
  return '';
}

async function ensureStartTestTab(page) {
  if (!STARTTEST_HOST_RE.test(page.url())) {
    throw new ScrapeAnomalyError(
      `Tab is not on starttest.com (current: ${page.url()}). Log in via mba.com first.`,
    );
  }
  const url = new URL(page.url());
  if (!url.searchParams.get('session')) {
    throw new ScrapeAnomalyError(
      `Tab URL has no StartTest session token. Please log in via mba.com first.`,
    );
  }
}

// ─── Phase 1: list takes for a product ─────────────────────────────────────

async function navigateToOpeLanding(page, { productId, type = 1 }) {
  await ensureStartTestTab(page);

  if (new URL(page.url()).searchParams.get('OrderProductID') === String(productId)) {
    return;
  }

  const fromMenu = await page.evaluate(({ productId, type }) => {
    const sel = `a[href*="OrderProductID=${productId}"][href*="type=${type}"]`;
    return document.querySelector(sel)?.href || null;
  }, { productId, type });

  let target = fromMenu;
  if (!target) {
    const u = new URL(page.url());
    const next = new URL(u.origin + u.pathname);
    for (const k of ['programid', 'session', 'code']) {
      const v = u.searchParams.get(k);
      if (v) next.searchParams.set(k, v);
    }
    next.searchParams.set('cmd', 'NavigateToProduct');
    next.searchParams.set('OrderProductID', String(productId));
    next.searchParams.set('type', String(type));
    target = next.toString();
  }

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(800);
  const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000));
  assertNotErrorPage(bodyText, page.url());
}

async function listOpeAttemptsForProduct(page, { productId, type = 1 } = {}) {
  if (productId) await navigateToOpeLanding(page, { productId, type });

  const takes = await page.evaluate(() => {
    const table = document.querySelector('table.TestAllTable_table');
    if (!table) return { error: 'no-test-all-table', takes: [] };

    const rows = Array.from(table.querySelectorAll('tbody tr, tr')).filter(
      (tr) => tr.children.length >= 3 && !tr.querySelector('th'),
    );

    const takes = rows.map((tr, rowIdx) => {
      const cells = Array.from(tr.children).map((c) => (c.innerText || '').trim());
      const takeText = cells[0] || '';
      const completedText = cells[1] || '';
      const actionText = cells[2] || '';
      const takeMatch = takeText.match(/(\d+)\s+of/);
      const anchor = tr.querySelector('a.launchitdwindow');
      const isInProgress = /start test/i.test(anchor?.innerText || actionText);
      const isCompleted = /view score report/i.test(anchor?.innerText || actionText);
      return {
        rowIdx,
        takeIdx: takeMatch ? Number(takeMatch[1]) : null,
        completedAtText: completedText === '—' || completedText === '-' ? null : completedText,
        actionText: (anchor?.innerText || actionText).trim(),
        status: isInProgress ? 'in_progress' : (isCompleted ? 'completed' : 'unknown'),
        hasReport: isCompleted && !!anchor,
      };
    });
    return { takes };
  });

  if (takes.error) {
    throw new ScrapeAnomalyError(
      `Take # table not found on OPE landing for productId=${productId}. Page may not have loaded.`,
      { url: page.url() },
    );
  }

  return takes.takes.map((t) => ({
    ...t,
    completedAt: parseDateMDY(t.completedAtText),
  }));
}

// ─── Phase 2: section-summary scrape of a Take's Score Report ─────────────

// Open the Score Report popup for a specific take by clicking its anchor. The
// click rotates the landing page's `code` token and the popup opens in a new
// tab with a fresh SVC. Caller owns the returned popup lifecycle.
async function openTakeScoreReportPopup(landingPage, { takeIdx, timeoutMs = 30000 } = {}) {
  const ctx = landingPage.context();
  const popupPromise = ctx.waitForEvent('page', { timeout: timeoutMs });

  await landingPage.evaluate((wantTakeIdx) => {
    const anchors = Array.from(document.querySelectorAll('a.launchitdwindow'));
    const reportAnchors = anchors.filter((a) => /view score report/i.test(a.innerText || ''));
    const matched = reportAnchors.find((a) => {
      const tr = a.closest('tr');
      const takeText = tr?.children[0]?.innerText || '';
      const m = takeText.match(/(\d+)\s+of/);
      return m && Number(m[1]) === wantTakeIdx;
    });
    if (!matched) throw new Error(`Take #${wantTakeIdx} View Score Report anchor not found`);
    matched.click();
  }, takeIdx);

  const popup = await popupPromise;
  await popup.waitForSelector('iframe[src*="cmd=item"]', { timeout: timeoutMs });
  return popup;
}

// The popup has 4 iframes; the Score Card lives in a frame with no urid.
// Two cmd= values render the Score Card: `item` (initial popup landing,
// after clicking "View score report" from the OPE landing) and `review`
// (after clicking #Return from a question view). Both render the same
// detailsTable content; accept either.
const SCORE_CARD_FRAME_CMDS = new Set(['item', 'review']);
function findScoreCardFrame(popupPage) {
  return popupPage.frames().find((f) => {
    const url = f.url();
    if (!/\/itd\.aspx\?/i.test(url)) return false;
    try {
      const u = new URL(url);
      if (u.searchParams.get('urid')) return false;
      return SCORE_CARD_FRAME_CMDS.has(u.searchParams.get('cmd') || '');
    } catch {
      return false;
    }
  }) || null;
}

async function waitForScoreCardReady(popupPage, { timeoutMs = 30000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = findScoreCardFrame(popupPage);
    if (frame) {
      try {
        // The Score Card renders all 3 sections × 2 views (Performance +
        // Time-Pressure) = 6 detailsTable instances. Accept once at least 3
        // exist; that covers the "Performance" view for all sections.
        const detailsCount = await frame.evaluate(() => {
          return document.querySelectorAll('table.table-table.type-\\%detailsTable\\%').length;
        });
        if (detailsCount >= 3) return frame;
      } catch {
        // frame may detach during ITD bootstrap; retry
      }
    }
    await sleep(pollMs);
  }
  throw new ScrapeAnomalyError(
    `Score Card iframe did not render detailsTable rows within ${timeoutMs}ms.`,
  );
}

// Read all detailsTable rows from the Score Card frame. Time-Pressure-view
// tables are skipped (they duplicate the Performance view with different
// metrics). Each remaining row is one attempt — even if the itemName repeats,
// since RC passages and DI MSR sets fan out into N consecutive rows with the
// same itemName (each row is a distinct sub-question with its own performance
// and time). Caller composes a per-attempt q_id from `${itemName}-p${position}`.
async function readScoreCardSectionTables(scoreCardFrame) {
  return scoreCardFrame.evaluate(() => {
    const result = {
      takeGuid: null,
      takeSerial: null,
      scoreSummary: null,
      tables: [],
      questions: [],
    };

    try {
      const url = new URL(location.href);
      const b64 = url.searchParams.get('data') || '';
      const decoded = atob(b64);
      const fields = decoded.split(',');
      result.takeSerial = fields[0] || null;
      result.takeGuid = fields[6] || null;
    } catch {
      // best-effort
    }

    // Extract the Performance-By-Section table (scaled scores + percentiles).
    // DOM: <table class="chart-table"> with header ["Section", "Your Percentile",
    // "Your Score"] and 4 data rows (Total Score, Data Insights, Quant, Verbal).
    // Score cell innerText is "min mean user max" (4 numbers in order).
    try {
      const chartTables = Array.from(document.querySelectorAll('table.chart-table'));
      const sectionTable = chartTables.find((t) => {
        const txt = (t.innerText || '').toLowerCase();
        return txt.includes('total score') && txt.includes('quantitative') && txt.includes('your percentile');
      });
      if (sectionTable) {
        const rowToFields = (tr) => {
          const cells = Array.from(tr.cells).map((c) => (c.innerText || '').trim().replace(/\s+/g, ' '));
          if (cells.length < 3) return null;
          const sectionName = cells[0];
          const percentileMatch = cells[1].match(/(\d+)/);
          const percentile = percentileMatch ? Number(percentileMatch[1]) : null;
          const nums = cells[2].split(/\s+/).map((s) => Number(s.replace(/[^\d.-]/g, ''))).filter((n) => Number.isFinite(n));
          if (nums.length < 4) return { sectionName, percentile, scaleMin: null, mean: null, score: null, scaleMax: null };
          return {
            sectionName,
            percentile,
            scaleMin: nums[0],
            mean: nums[1],
            score: nums[2],
            scaleMax: nums[3],
          };
        };
        const rows = Array.from(sectionTable.rows).slice(1).map(rowToFields).filter(Boolean);
        const find = (re) => rows.find((r) => re.test(r.sectionName)) || null;
        result.scoreSummary = {
          total: find(/total\s*score/i),
          quant: find(/quantitative/i),
          verbal: find(/verbal/i),
          di: find(/data\s*insights/i),
        };
      }
    } catch {
      // best-effort; score summary is optional
    }

    const tables = Array.from(document.querySelectorAll('table.table-table.type-\\%detailsTable\\%'));

    for (let ti = 0; ti < tables.length; ti += 1) {
      const t = tables[ti];
      const headerCells = Array.from(t.rows[0]?.cells || []).map(
        (c) => c.innerText.replace(/[▲▼]+/g, '').replace(/\s+/g, ' ').trim(),
      );

      const isTimePressureView = headerCells.some((h) => /time pressure/i.test(h));

      const colIdx = {};
      headerCells.forEach((h, i) => { colIdx[h] = i; });

      const dataRows = Array.from(t.rows).slice(1);
      result.tables.push({
        tableIdx: ti,
        rowCount: dataRows.length,
        headerCells,
        isTimePressureView,
      });

      if (isTimePressureView) continue;

      for (const tr of dataRows) {
        const cells = Array.from(tr.cells).map((c) => (c.innerText || '').trim());
        const anchor = tr.querySelector('a.navigate');
        const onclick = anchor?.getAttribute('onclick') || '';
        const nm = onclick.match(/name=Item Review\/(\w+)/);
        const itemName = nm ? nm[1] : null;
        if (!itemName) continue;

        const pickByHeader = (h) => {
          const i = colIdx[h];
          if (typeof i !== 'number') return null;
          return cells[i] || null;
        };

        const perfText = pickByHeader('Performance') || '';
        const isCorrect = /^correct$/i.test(perfText);
        const isIncorrect = /^incorrect$/i.test(perfText);

        result.questions.push({
          position: Number(cells[0]) || null,
          itemName,
          responseTimeMin: pickByHeader('Response Time (Minutes)'),
          performanceText: perfText,
          correct: isCorrect ? 1 : (isIncorrect ? 0 : null),
          contentDomain: pickByHeader('Content Domain'),
          questionType: pickByHeader('Question Type'),
          fundamentalSkills: pickByHeader('Fundamental Skills'),
          tableIdx: ti,
        });
      }
    }

    return result;
  });
}

function buildQuestionRecord({ q }) {
  const subjectCode = subjectFromItemName(q.itemName);
  const categoryCode = mapCategoryCode(subjectCode, q.questionType);
  // For Q (Quant), "Content Domain" is Arithmetic/Algebra — the natural topic.
  // For V (Verbal), the high-level topic is the Question Type (CR / RC).
  // For DI, Content Domain is "Math Related"/"Non-Math Related" (too coarse) — prefer Question Type.
  const topic =
    subjectCode === 'Q' ? (q.contentDomain || q.questionType || null) :
    subjectCode === 'V' ? (q.questionType || null) :
    subjectCode === 'DI' ? (q.questionType || q.contentDomain || null) :
    (q.questionType || q.contentDomain || null);

  // Subcategory: drill-down. Q+V use Fundamental Skills; DI has no FS column so use Content Domain.
  const subcategory =
    (subjectCode === 'Q' || subjectCode === 'V') ? (q.fundamentalSkills || q.questionType || null) :
    subjectCode === 'DI' ? (q.contentDomain || null) :
    (q.fundamentalSkills || null);

  // q_code groups all attempts on the same passage / MSR set (same item).
  // q_id is per-attempt: passages and MSR sets fan out into multiple rows
  // with the same itemName, so position within the section disambiguates.
  return {
    q_code: q.itemName ? `ope-${q.itemName}` : null,
    q_id: q.itemName ? `ope-${q.itemName}-p${q.position ?? 0}` : null,
    cat_id: null,
    subject_code: subjectCode || null,
    category_code: categoryCode || null,
    subcategory: subcategory || null,
    subject_sub: subjectCode || null,
    subject_sub_raw: q.questionType || null,
    question_url: null,
    question_stem: null,
    answer_choices: null,
    response_format: null,
    response_details: null,
    correct: q.correct == null ? 0 : q.correct,
    difficulty: null,
    confidence: null,
    time_sec: parseMinutesToSeconds(q.responseTimeMin),
    my_answer: null,
    correct_answer: null,
    topic: topic || null,
    topic_source: 'ope-section-table',
    content_domain: q.contentDomain || null,
    mistake_type: null,
    notes: null,
    _position: q.position,
    _itemName: q.itemName,
    _questionType: q.questionType,
    _fundamentalSkills: q.fundamentalSkills,
  };
}

// Probe the Score Card frame for stable per-popup identity. The takeGuid is
// the strongest signal we have (field 7 of the `data=` blob, immutable for
// the popup's lifetime). It does NOT match across different popup-opens for
// the same take (each click on "View score report" mints a fresh GUID — see
// shapeForSaveScrapeResult comment) so it's only useful for verifying a
// popup against an expectation captured *during this run*, not across runs.
async function readScoreCardTakeIdentity(popupPage, { timeoutMs = 30000 } = {}) {
  const scoreCardFrame = await waitForScoreCardReady(popupPage, { timeoutMs });
  let dataBlob = null;
  try {
    dataBlob = new URL(scoreCardFrame.url()).searchParams.get('data') || null;
  } catch { /* best-effort */ }
  const decoded = decodeDataBlob(dataBlob);

  // Best-effort: any M/D/YYYY date strings rendered in the Score Card body.
  // We compare these against the landing row's completedAtText to verify the
  // popup represents the requested take (since neither the popup URL nor the
  // takeGuid carries the takeIdx, and the popup title is misleading per the
  // memory notes — it's a popup-instance counter, not the take number).
  const dateStrings = await scoreCardFrame.evaluate(() => {
    const text = (document.body?.innerText || '').slice(0, 16000);
    const matches = text.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g) || [];
    return Array.from(new Set(matches));
  }).catch(() => []);

  return {
    takeGuid: decoded.takeGuid || null,
    takeSerial: decoded.takeSerial || null,
    dataBlob,
    scoreCardFrameUrl: scoreCardFrame.url(),
    dateStrings,
  };
}

// Verify an already-open popup represents the requested takeIdx. Probes the
// landing page (no clicks, just reads the Take # table) to learn the
// completedAtText for that takeIdx, then checks that the popup's Score Card
// body contains the same date string. Returns `{matches, reason, identity,
// landingRow, landingDateText}` — `matches=false` is informational, not an
// error: callers decide whether to reuse, close, or throw.
async function verifyPopupMatchesTakeIdx(popupPage, landingPage, {
  productId,
  type = 1,
  takeIdx,
  timeoutMs = 30000,
} = {}) {
  const identity = await readScoreCardTakeIdentity(popupPage, { timeoutMs })
    .catch((e) => ({ error: e.message, takeGuid: null, dateStrings: [] }));
  if (identity.error) {
    return { matches: false, reason: `score-card-unreadable: ${identity.error}`, identity, landingRow: null, landingDateText: null };
  }

  await navigateToOpeLanding(landingPage, { productId, type });
  const takes = await listOpeAttemptsForProduct(landingPage, { productId, type });
  const row = takes.find((t) => t.takeIdx === takeIdx) || null;
  if (!row) {
    return { matches: false, reason: 'no-landing-row', identity, landingRow: null, landingDateText: null };
  }
  const landingDateText = row.completedAtText || null;
  if (!landingDateText) {
    // In-progress or never-completed takes don't have a Score Card to verify against.
    return { matches: false, reason: 'landing-row-not-completed', identity, landingRow: row, landingDateText: null };
  }
  // Reject if multiple takes share the same date AND the popup body could
  // belong to any of them — we can't disambiguate by date alone in that case.
  const sameDateTakes = takes.filter((t) => t.completedAtText === landingDateText);
  const dateInPopup = identity.dateStrings.includes(landingDateText);
  if (!dateInPopup) {
    return { matches: false, reason: 'date-not-in-popup', identity, landingRow: row, landingDateText };
  }
  if (sameDateTakes.length > 1) {
    return { matches: false, reason: 'date-ambiguous', identity, landingRow: row, landingDateText };
  }
  return { matches: true, reason: null, identity, landingRow: row, landingDateText };
}

// Scrape Phase 2 from an already-open Score Report popup. Caller is
// responsible for popup lifecycle (opened via openTakeScoreReportPopup, or
// re-attached to a popup the user opened manually for testing/retry).
async function scrapeScoreReportPopup(popup, { sourceId, takeIdx } = {}) {
  if (!ITDSTART_HOST_RE.test(popup.url())) {
    throw new ScrapeAnomalyError(
      `Popup is not an ITDStart.aspx Score Report tab (current: ${popup.url()}).`,
    );
  }
  const preset = SOURCE_PRODUCTS[sourceId];
  if (!preset) {
    throw new ScrapeAnomalyError(
      `Unknown sourceId "${sourceId}". Expected one of ${Object.keys(SOURCE_PRODUCTS).join(', ')}.`,
    );
  }

  const scoreCardFrame = await waitForScoreCardReady(popup);
  const raw = await readScoreCardSectionTables(scoreCardFrame);
  if (!raw.questions.length) {
    throw new ScrapeAnomalyError(
      `Score Card had ${raw.tables.length} detailsTable(s) but yielded 0 question rows. Selector drift suspected.`,
    );
  }

  const dataBlob = (() => {
    try { return new URL(scoreCardFrame.url()).searchParams.get('data'); } catch { return null; }
  })();
  const decoded = decodeDataBlob(dataBlob);
  const takeGuid = raw.takeGuid || decoded.takeGuid || null;

  const questions = raw.questions.map((q) => buildQuestionRecord({ q }));

  const subjectCodes = new Set(questions.map((q) => q.subject_code).filter(Boolean));
  const sessionSubject = subjectCodes.size === 1 ? [...subjectCodes][0] : null;

  const bySubject = { Q: [], V: [], DI: [] };
  for (const q of questions) {
    if (bySubject[q.subject_code]) bySubject[q.subject_code].push(q);
  }
  const sectionSummary = Object.fromEntries(
    Object.entries(bySubject).map(([k, arr]) => [k, {
      total: arr.length,
      correct: arr.filter((q) => q.correct === 1).length,
      time_sec: arr.reduce((acc, q) => acc + (Number.isFinite(q.time_sec) ? q.time_sec : 0), 0),
    }]),
  );

  return {
    sourceLabel: preset.label,
    productId: preset.productId,
    takeIdx: typeof takeIdx === 'number' ? takeIdx : null,
    takeGuid,
    takeSerial: raw.takeSerial || decoded.takeSerial || null,
    popupUrl: popup.url(),
    scoreCardFrameUrl: scoreCardFrame.url(),
    tables: raw.tables,
    sectionSummary,
    scoreSummary: raw.scoreSummary || null,
    sessionSubject,
    questions,
    extracted_at: new Date().toISOString(),
  };
}

// Reshape a Phase 2 `scrapeScoreReportPopup` result into the
// `{extracted_at, config, sessions: [{session_id, date, source, subject, stats,
// questions}]}` shape that `db.saveScrapeResult()` accepts. One OPE take = one
// session row (full mock spans all 3 sections; subject left null for "Mixed").
function shapeForSaveScrapeResult(scrapeResult, { completedDateISO = null } = {}) {
  // session_external_id must be stable per OPE take so re-scrapes upsert in
  // place rather than spawning a new session row each time. The popup's
  // `data=` blob carries a takeGuid (field 7) but that GUID is NOT stable —
  // it rotates each time the user clicks "View Score Report" (verified
  // empirically 2026-05-24). The only stable identifier is the take index
  // itself, so we key on `(productId, takeIdx)`.
  const sessionExternalId = hashSessionExternalId(
    `ope-${scrapeResult.productId}|take-${scrapeResult.takeIdx || 0}`,
  );

  // Strip underscore-prefixed bookkeeping keys; saveScrapeResult ignores them
  // but cleaner to drop before persistence.
  const questions = scrapeResult.questions.map((q) => {
    const out = {};
    for (const [k, v] of Object.entries(q)) {
      if (!k.startsWith('_')) out[k] = v;
    }
    return out;
  });

  const total = questions.length;
  const correct = questions.filter((q) => q.correct === 1).length;
  const timeSum = questions.reduce((acc, q) => acc + (Number.isFinite(q.time_sec) ? q.time_sec : 0), 0);
  const timeCorrect = questions.filter((q) => q.correct === 1 && Number.isFinite(q.time_sec));
  const timeIncorrect = questions.filter((q) => q.correct !== 1 && Number.isFinite(q.time_sec));
  const stats = {
    total_q_api: total,
    total_q_categories: total,
    correct,
    errors: total - correct,
    accuracy_pct: total ? Number(((correct / total) * 100).toFixed(2)) : 0,
    avg_time_sec: total ? Math.round(timeSum / total) : null,
    avg_correct_time_sec: timeCorrect.length
      ? Math.round(timeCorrect.reduce((a, q) => a + q.time_sec, 0) / timeCorrect.length)
      : null,
    avg_incorrect_time_sec: timeIncorrect.length
      ? Math.round(timeIncorrect.reduce((a, q) => a + q.time_sec, 0) / timeIncorrect.length)
      : null,
  };

  return {
    extracted_at: scrapeResult.extracted_at || new Date().toISOString(),
    config: {
      source: scrapeResult.sourceLabel,
      productId: scrapeResult.productId,
      takeIdx: scrapeResult.takeIdx,
      takeGuid: scrapeResult.takeGuid,
    },
    sessions: [
      {
        session_id: sessionExternalId,
        date: completedDateISO || null,
        source: scrapeResult.sourceLabel,
        subject: scrapeResult.sessionSubject, // null for full mock (mixed)
        stats,
        scoreSummary: scrapeResult.scoreSummary || null,
        questions,
      },
    ],
  };
}

// ─── Phase 3: per-question enrichment ───────────────────────────────────────
// For each question in the take, drill into the cmd=REVIEW-ALL iframe and
// capture stem, full choice texts, user's pick, correct answer, IRT difficulty,
// and precise time (vPreviousTimeSpent in ms). One-shot scrape: clicks the
// first .navigate anchor in the Score Card, then drives popup-level #Next 63
// times with 1.5–3s jitter. Aborts on max(5, ceil(total/4)) errors.
//
// Pre-conditions:
//   - Popup is on the Score Card (cmd=item iframe present).
//   - Phase 2 has already been run for this take so q_id rows exist to update.
//
// Post-condition:
//   - Popup is left in REVIEW-ALL mode at the last item (best-effort), caller
//     may navigate back via #Return for cleanup.

// The per-item review frame's `cmd=` varies based on item type AND how the
// frame was reached. Empirically observed (OPE1, engine 24.3.0.0):
//   - .navigate click from Score Card → cmd=REVIEW-ALL (first item)
//   - #Next on Quant/CR/DS items      → cmd=next
//   - #Previous                        → cmd=previous (UNUSED — never click Previous)
//   - #Next that lands on an RC sub-question, DI MSR sub-question, DI TPA, or
//     DI GI item → cmd=item (the engine reuses the Score Card's `cmd=item`
//     frame for these mixed-content items, leaving the prior cmd=next frame
//     stale). Without `item` in the allow-list, the scraper times out at the
//     first such transition (verified at Q3→Q4 V CR→RC boundary).
// All four render question review content (radios/matrix/dropdowns + Key1 +
// vItemInformation). Distinguish from cmd=display frames (Info / Whiteboard /
// VariableFrame / per-item passage) which all carry a urid query param.
const REVIEW_ITEM_FRAME_CMDS = new Set(['REVIEW-ALL', 'next', 'previous', 'item']);
const POPUP_TITLE_RE = /^([A-Za-z][A-Za-z ]*?)\s+(\d+)\s+of\s+(\d+)/;

function parsePopupTitle(title) {
  const m = String(title || '').match(POPUP_TITLE_RE);
  if (!m) return null;
  const sectionName = m[1].trim();
  let sectionCode = '';
  if (/quantitative/i.test(sectionName)) sectionCode = 'Q';
  else if (/verbal/i.test(sectionName)) sectionCode = 'V';
  else if (/data\s*insight/i.test(sectionName)) sectionCode = 'DI';
  return {
    sectionName,
    sectionCode,
    position: Number(m[2]),
    sectionTotal: Number(m[3]),
  };
}

function findCandidateItemFrames(popupPage) {
  // All frames that could possibly hold question content. Excludes cmd=display
  // (Info / Whiteboard / VariableFrame / passage-display — all carry a urid).
  // The Score Card's frame (cmd=item with detailsTable but no vItemInformation)
  // is filtered out by the readiness check inside waitForReviewAllItem; we
  // can't filter it out here without an async evaluate.
  return popupPage.frames().filter((f) => {
    const url = f.url();
    if (!/\/itd\.aspx\?/i.test(url)) return false;
    try {
      const u = new URL(url);
      if (u.searchParams.get('urid')) return false;
      return REVIEW_ITEM_FRAME_CMDS.has(u.searchParams.get('cmd') || '');
    } catch { return false; }
  });
}

function findReviewAllFrame(popupPage) {
  // Each Next click creates a new iframe; old item frames linger in the frame
  // list. Return the LAST matching frame (freshest in array order). Callers
  // that need a guaranteed-ready frame should use waitForReviewAllItem instead.
  const matches = findCandidateItemFrames(popupPage);
  return matches.length ? matches[matches.length - 1] : null;
}

async function waitForReviewAllItem(popupPage, prevItemName, prevTitle, { timeoutMs = 120000, pollMs = 500 } = {}) {
  // Wait for any of: (a) popup title changes from prevTitle, AND (b) the
  // REVIEW-ALL frame has vItemInformation populated AND choice DOM rendered.
  // We DON'T require itemName != prevItemName — RC passages and DI MSR sets
  // have multiple consecutive items with the same itemName but different
  // sub-questions, so the title (carrying "<section> N of M") is the
  // authoritative progression signal.
  // First Next click after popup attach can be slow (50–70s). Subsequent
  // clicks are usually fast (1–3s).
  const deadline = Date.now() + timeoutMs;
  // Initial settle: give the popup a moment to start transitioning before
  // polling, so we don't catch the previous frame in a transient ready state.
  if (prevTitle) await sleep(800);
  while (Date.now() < deadline) {
    let currentTitle = null;
    try {
      currentTitle = await popupPage.title();
    } catch { /* page may be transitioning */ }
    const titleChanged = !prevTitle || (currentTitle && currentTitle !== prevTitle);
    if (titleChanged) {
      // Iterate candidates freshest-first. RC/MSR/TPA/GI transitions land in
      // cmd=item while Quant/CR/DS transitions land in cmd=next. The freshest
      // ready frame wins regardless of which.
      const candidates = findCandidateItemFrames(popupPage);
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const candidate = candidates[i];
        try {
          const state = await candidate.evaluate(() => {
            if (!Array.isArray(window.vItemInformation) || window.vItemInformation.length < 2) {
              return { ready: false, reason: 'no-vItemInformation' };
            }
            const itemName = window.vItemInformation[1]?.Name;
            if (!itemName) return { ready: false, reason: 'no-itemName' };
            const hasRadios = document.querySelectorAll('input[name="I1"]').length > 0;
            const hasMatrix = !!document.querySelector('table.ITSMatrixTable');
            const hasSelect = Array.from(document.querySelectorAll('select')).some((s) => !['sessionlist'].includes(s.id));
            if (!hasRadios && !hasMatrix && !hasSelect) return { ready: false, reason: 'no-choice-dom' };
            return { ready: true, itemName };
          });
          if (state.ready) return candidate;
        } catch {
          // frame may detach mid-transition; try next candidate
        }
      }
    }
    await sleep(pollMs);
  }
  throw new ScrapeAnomalyError(
    `Phase 3: REVIEW-ALL frame did not load new item within ${timeoutMs}ms (prevItem=${prevItemName || 'none'}, prevTitle=${prevTitle || 'none'})`,
  );
}

async function readReviewAllFrame(frame) {
  return frame.evaluate(() => {
    const VALUE_TO_LETTER = ['', 'A', 'B', 'C', 'D', 'E'];
    const itemInfo = window.vItemInformation?.[1] || {};

    // RC passages and DI MSR sets render each sub-question as its own screen
    // with vItemInformation[1].Name like "V188_000300-02" (passage-base-NN).
    // Phase 2's Score Card regex `name=Item Review/(\w+)` only captures up to
    // the dash, so q_id rows are keyed by the base name. Strip the suffix here
    // so the DB writer can match.
    const rawName = itemInfo.Name || null;
    const baseItemName = rawName ? rawName.replace(/-\d+$/, '') : null;

    const form = document.forms?.[0];
    const correctKey = form?.elements?.Key1?.value || null;

    let choicesType = null;
    let choices = [];
    let myAnswerStr = null;
    let correctAnswerStr = correctKey || null;

    const matrixTable = document.querySelector('table.ITSMatrixTable');
    const allSelects = Array.from(document.querySelectorAll('select'));
    const questionSelects = allSelects.filter((s) => {
      if (['sessionlist', 'difficulty', 'confidence', 'attributes', 'blueprintlist', 'font', 'contrast'].includes(s.id)) return false;
      if (s.closest('.itd-toolbar, .nav-toolbar, .qhistory-flex-tb-container, header, footer')) return false;
      return true;
    });
    const radios = Array.from(document.querySelectorAll('input[name="I1"]'));

    if (matrixTable) {
      // DI Two-Part Analysis (TPA) and DI MSR matrix sub-questions. Cell
      // coloring: yellow=correct, red=user-wrong, green=user-right;
      // radiochecked.gif on user's pick.
      //
      // Two axis-orientations exist:
      //   - column-major (TPA): each column is one sub-question, user picks
      //     one row per column. Key1 has N=colCount values; each is the
      //     row index for that column.
      //   - row-major (MSR matrix): each row is one sub-question, user picks
      //     one column per row. Key1 has N=rowCount values; each is the
      //     column index for that row.
      // Detect by matching Key1 length to row/col count. Both my_answer and
      // correct_answer are formatted along the same axis ("dim: pick" pairs).
      choicesType = 'matrix';
      const colorOf = (td) => {
        const inner = td.querySelector('div[style*="background"], div[align="center"][style]');
        const style = (inner && inner.getAttribute('style')) || '';
        if (/(?:background(?:-color)?\s*:\s*)?yellow/i.test(style)) return 'yellow';
        if (/(?:background(?:-color)?\s*:\s*)?red/i.test(style)) return 'red';
        if (/(?:background(?:-color)?\s*:\s*)?green/i.test(style)) return 'green';
        return null;
      };
      const headerCells = Array.from(matrixTable.querySelectorAll('tr.header td.ITSMatrixLabel'));
      const headers = headerCells.map((td) => (td.innerText || '').trim()).filter(Boolean);
      const rowEls = Array.from(matrixTable.querySelectorAll('tr.row'));
      const rowLabels = rowEls.map((tr, i) => {
        const labelCell = tr.querySelector('td.ITSMatrixLabel');
        return labelCell ? (labelCell.innerText || '').trim() : `row${i + 1}`;
      });
      // Build grid[rowIdx][colIdx] = {isCorrect, isUserSelected}
      const grid = rowEls.map((tr) => Array.from(tr.querySelectorAll('td.ITSMatrixOption')).map((td) => {
        const styleAttr = td.getAttribute('style') || '';
        const hasRadioChecked = /radiochecked\.gif/i.test(styleAttr);
        const color = colorOf(td);
        return {
          isCorrect: color === 'yellow' || color === 'green',
          isUserSelected: color === 'red' || color === 'green' || hasRadioChecked,
        };
      }));
      rowEls.forEach((_, rowIdx) => {
        (grid[rowIdx] || []).forEach((cell, colIdx) => {
          choices.push({
            label: `${rowLabels[rowIdx]}=${headers[colIdx] || `col${colIdx + 1}`}`,
            value: `${rowIdx + 1}:${colIdx + 1}`,
            text: `${rowLabels[rowIdx]} → ${headers[colIdx] || `col${colIdx + 1}`}`,
            isCorrect: cell.isCorrect,
            isUserSelected: cell.isUserSelected,
          });
        });
      });

      const keyParts = correctKey ? correctKey.split(',').map((s) => s.trim()) : [];
      // Axis detection: prefer Key1 length signal; fall back to counting flags.
      let axis = null;
      if (keyParts.length === headers.length && keyParts.length !== rowEls.length) axis = 'col';
      else if (keyParts.length === rowEls.length && keyParts.length !== headers.length) axis = 'row';
      else {
        // Ambiguous or no Key1 — count cells flagged isCorrect along each axis.
        const correctPerRow = grid.map((row) => row.filter((c) => c.isCorrect).length);
        const correctPerCol = headers.map((_, colIdx) => grid.reduce((acc, row) => acc + (row[colIdx]?.isCorrect ? 1 : 0), 0));
        const rowsWithOne = correctPerRow.filter((n) => n === 1).length;
        const colsWithOne = correctPerCol.filter((n) => n === 1).length;
        axis = (colsWithOne >= rowsWithOne) ? 'col' : 'row';
      }

      const formatAlongAxis = (predicate) => {
        if (axis === 'col') {
          return headers.map((colHeader, colIdx) => {
            const rowIdx = grid.findIndex((row) => predicate(row[colIdx]));
            const rowLabel = rowIdx >= 0 ? rowLabels[rowIdx] : '';
            return `${colHeader}: ${rowLabel || '—'}`;
          }).join(' | ');
        }
        // row-major
        return rowLabels.map((rowLabel, rowIdx) => {
          const colIdx = (grid[rowIdx] || []).findIndex(predicate);
          const colHeader = colIdx >= 0 ? (headers[colIdx] || `col${colIdx + 1}`) : '';
          return `${rowLabel}: ${colHeader || '—'}`;
        }).join(' | ');
      };

      const anyUser = grid.some((row) => row.some((c) => c.isUserSelected));
      const anyCorrect = grid.some((row) => row.some((c) => c.isCorrect));
      myAnswerStr = anyUser ? formatAlongAxis((c) => c && c.isUserSelected) : null;
      correctAnswerStr = anyCorrect ? formatAlongAxis((c) => c && c.isCorrect) : (correctKey || null);
    } else if (questionSelects.length > 0) {
      // DI Graphics Interpretation (GI): inline <select> dropdowns. The user's
      // pick is select.value (option.selected may reflect static HTML, not the
      // saved state). When Key1 is populated, it's a CSV of correct option
      // values per dropdown — decode each to the option's display text so
      // correct_answer mirrors my_answer's "text | text | ..." format.
      choicesType = 'dropdown';
      const keyParts = correctKey ? correctKey.split(',').map((s) => s.trim()) : [];
      const userPicks = [];
      const correctPicks = [];
      questionSelects.forEach((sel, idx) => {
        const opts = Array.from(sel.options || []);
        const selectedOpt = opts.find((o) => o.value === sel.value) || null;
        const selectedText = selectedOpt ? (selectedOpt.text || '').trim() : (sel.value || '');
        const wantValue = keyParts[idx];
        const correctOpt = wantValue != null ? opts.find((o) => o.value === wantValue) : null;
        const correctText = correctOpt ? (correctOpt.text || '').trim() : (wantValue || '');
        opts.forEach((o) => {
          choices.push({
            label: `dd${idx + 1}=${(o.text || '').trim()}`,
            value: `${idx + 1}:${o.value}`,
            text: `Dropdown ${idx + 1} → ${(o.text || '').trim()}`,
            isCorrect: wantValue != null && o.value === wantValue,
            isUserSelected: o.value === sel.value,
          });
        });
        userPicks.push(selectedText || '—');
        correctPicks.push(correctText || '—');
      });
      myAnswerStr = userPicks.length ? userPicks.join(' | ') : null;
      correctAnswerStr = correctPicks.some((s) => s && s !== '—') ? correctPicks.join(' | ') : (correctKey || null);
    } else if (radios.length) {
      choicesType = 'single';
      const checked = radios.find((r) => r.checked);
      const myValue = checked?.value || null;
      myAnswerStr = myValue ? (VALUE_TO_LETTER[Number(myValue)] || myValue) : null;
      correctAnswerStr = correctKey ? (VALUE_TO_LETTER[Number(correctKey)] || correctKey) : null;
      // Extractor handles three rendering modes the StartTest engine uses:
      //   1) Plain text inside <span class="ITSMCOptionText"> — innerText.
      //   2) Math rendered as inline <img alt="..."> — fall back to alt/title.
      //   3) Math rendered via MathML <math> with descendant tokens
      //      (<mn>/<mi>/<mo>/<mtext>/<msup>/<mfrac>/<mroot>/…). innerText is
      //      empty in some Chrome builds when MathML is rendered as glyph runs,
      //      so we walk descendants and assemble a readable token string.
      const MATHML_TOKEN_TAGS = new Set(['MN', 'MI', 'MO', 'MTEXT', 'MS', 'MSPACE']);
      const walkMathTokens = (node) => {
        const parts = [];
        const visit = (n) => {
          if (!n) return;
          if (n.nodeType === 3) {
            const t = (n.nodeValue || '').replace(/\s+/g, ' ');
            if (t.trim()) parts.push(t.trim());
            return;
          }
          if (n.nodeType !== 1) return;
          if (MATHML_TOKEN_TAGS.has(n.nodeName?.toUpperCase?.() || '')) {
            const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) parts.push(t);
            return;
          }
          for (const c of n.childNodes) visit(c);
        };
        visit(node);
        return parts.join(' ').replace(/\s+/g, ' ').trim();
      };
      const extractOptionText = (el) => {
        if (!el) return '';
        const it = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (it) return it;
        const tc = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (tc) return tc;
        const mathRoot = el.querySelector('math, [class*="math"], [class*="Math"]');
        if (mathRoot) {
          const m = walkMathTokens(mathRoot);
          if (m) return m;
        }
        const img = el.querySelector('img[alt], img[title]');
        if (img) {
          const alt = (img.getAttribute('alt') || img.getAttribute('title') || '').trim();
          if (alt) return alt;
        }
        const anyAlt = Array.from(el.querySelectorAll('[alt], [title], [aria-label]'))
          .map((n) => n.getAttribute('alt') || n.getAttribute('title') || n.getAttribute('aria-label') || '')
          .map((s) => s.trim())
          .filter(Boolean);
        return anyAlt.join(' ').replace(/\s+/g, ' ').trim();
      };

      choices = radios.map((r) => {
        // ITDStart REVIEW-ALL DOM: each radio is <input id="chk{itemseq}{seq}">
        // wrapped in <div class="its-item-table ITSMCOptionTable" id="mctbl{...}">,
        // and the option prose is <span id="radio{itemseq}{seq}" class="ITSMCOptionText|ITSMCOptionTextOn">.
        // The earlier `[class*="MCOption"]` selector matched the input itself
        // (its class is ITSMCOptionMarker) so the text span was never found.
        const textId = r.id ? r.id.replace(/^chk/, 'radio') : null;
        const container = r.closest('.ITSMCOptionTable') || r.parentElement;
        const textSpan =
          (textId && document.getElementById(textId))
          || container?.querySelector('.ITSMCOptionTextOn, .ITSMCOptionText, .optionText')
          || null;
        const text = extractOptionText(textSpan);
        const letter = VALUE_TO_LETTER[Number(r.value)] || r.value;
        // Like the stem, math answer choices (fractions, radicals, expressions)
        // render as inline raster <img> with no alt, so extractOptionText comes
        // back empty/mangled. Capture the option's HTML (chrome stripped) so the
        // Node side can keep the equation image and derive a clean text label.
        let textHtml = null;
        if (textSpan && textSpan.querySelector('img, sup, sub')) {
          const clone = textSpan.cloneNode(true);
          clone.querySelectorAll('.solIcon, script, style, button, input, [role="button"], [aria-hidden="true"]').forEach((n) => n.remove());
          textHtml = clone.innerHTML;
        }
        return {
          label: letter,
          value: r.value,
          text,
          textHtml,
          isUserSelected: !!r.checked,
          isCorrect: String(r.value) === String(correctKey),
        };
      });
    }

    // Stem extraction. Prefer the dedicated .ITSStemText container: it holds the
    // full item body (prompt + CR argument / DS statements) but NOT the answer
    // choices (those are separate .ITSMCOptionText spans). OPE renders inline
    // math as raster <img> (base64 data: URIs, no alt text), which innerText
    // silently drops — gutting Quant/DS stems. So we return the container's HTML
    // (status icon + UI chrome stripped) and let the Node side keep the equation
    // images while deriving a clean text stem. Falls back to the original
    // body-innerText "cut at A)" approach for any frame without .ITSStemText, so
    // those item types are byte-for-byte unaffected.
    const stemEl = document.querySelector('.ITSStemText')
      || document.querySelector('.stem-container-inner')
      || document.querySelector('.stem-block-inner');
    let stem = '';
    let stemHtml = null;
    if (stemEl) {
      const clone = stemEl.cloneNode(true);
      clone.querySelectorAll('.solIcon, script, style, button, input, select, [role="button"], [aria-hidden="true"]').forEach((n) => n.remove());
      stemHtml = clone.innerHTML;
    } else {
      let bodyText = (document.body?.innerText || '').replace(/\r\n/g, '\n');
      bodyText = bodyText.replace(
        /^This is a read only version[^.]*\.[^.]*\.[^.]*\.\s*/i,
        '',
      ).trim();
      const cutMatch = bodyText.match(/\n\s*A[)\s]\s*[^\n]/);
      stem = cutMatch ? bodyText.slice(0, cutMatch.index).trim() : bodyText;
      stem = stem.replace(/\n\s*(?:Comments?|Rationale|Key Point):.*$/is, '').trim();
    }

    return {
      itemName: baseItemName,
      rawItemName: rawName,
      choicesType,
      difficulty: typeof itemInfo.Difficulty === 'number' ? itemInfo.Difficulty : null,
      strand: itemInfo.Strand || null,
      objective: itemInfo.Objective || null,
      vPreviousTimeSpentMs: typeof window.vPreviousTimeSpent === 'number' ? window.vPreviousTimeSpent : null,
      stem,
      stemHtml,
      choices,
      correctKey,
      my_answer: myAnswerStr,
      correct_answer: correctAnswerStr,
    };
  });
}

async function clickPhase3Next(popupPage, prevItemName, prevTitle, { timeoutMs = 120000 } = {}) {
  const clickResult = await popupPage.evaluate(() => {
    const btn = document.querySelector('button.cpButton.Next, #Next');
    if (!btn) return { ok: false, reason: 'no-next-button' };
    if (btn.disabled) return { ok: false, reason: 'next-disabled' };
    if (btn.offsetParent === null) return { ok: false, reason: 'next-hidden' };
    btn.click();
    return { ok: true };
  });
  if (!clickResult.ok) {
    throw new ScrapeAnomalyError(`Phase 3: Next button click failed (${clickResult.reason})`);
  }
  return waitForReviewAllItem(popupPage, prevItemName, prevTitle, { timeoutMs });
}

async function enterPhase3Mode(popupPage, { timeoutMs = 60000 } = {}) {
  const scoreCardFrame = await waitForScoreCardReady(popupPage);
  const prevTitle = await popupPage.title().catch(() => null);
  await scoreCardFrame.evaluate(() => {
    const a = document.querySelector(
      'table.table-table.type-\\%detailsTable\\% a.navigate',
    );
    if (!a) throw new Error('No .navigate anchor in Score Card to enter REVIEW-ALL mode');
    a.click();
  });
  return waitForReviewAllItem(popupPage, null, prevTitle, { timeoutMs });
}

// Main Phase 3 loop. Returns one enriched record per question. Caller (the
// DB writer in db.js) matches them back to question_attempts rows by q_id
// composed as `ope-${itemName}-p${positionInSection}`.
async function scrapeAttemptPhase3(popup, {
  sourceId,
  takeIdx,
  expectedTotal = 64,
  expectedTakeGuid = null,
  minDelayMs = 1500,
  maxDelayMs = 3000,
  onProgress = null,
} = {}) {
  if (!ITDSTART_HOST_RE.test(popup.url())) {
    throw new ScrapeAnomalyError(`Phase 3: popup is not an ITDStart.aspx Score Report (${popup.url()})`);
  }
  const preset = SOURCE_PRODUCTS[sourceId];
  if (!preset) throw new ScrapeAnomalyError(`Unknown OPE sourceId "${sourceId}"`);

  // Defense-in-depth guard: when the runner has captured an expectedTakeGuid
  // (the popup's takeGuid at the moment it was opened or verified), reject
  // immediately if the popup's current Score Card frame carries a different
  // GUID. This catches the case where another scraper instance or the user
  // rotated the popup between the runner's verification and now. We re-read
  // the score card frame here rather than trusting the popup URL (the
  // ITDStart.aspx SVC param doesn't change when the inner frame transitions
  // between item/review/REVIEW-ALL).
  if (expectedTakeGuid) {
    const scoreCardFrame = findScoreCardFrame(popup);
    if (scoreCardFrame) {
      let observedGuid = null;
      try {
        const blob = new URL(scoreCardFrame.url()).searchParams.get('data');
        observedGuid = decodeDataBlob(blob).takeGuid || null;
      } catch { /* score card may have transitioned to a question view */ }
      if (observedGuid && observedGuid !== expectedTakeGuid) {
        throw new ScrapeAnomalyError(
          `Phase 3 guard: popup takeGuid ${observedGuid} does not match expected ${expectedTakeGuid} for takeIdx=${takeIdx}. ` +
          `Popup likely points at a different take — refusing to walk 64 items into the wrong session.`,
        );
      }
    }
  }

  const enriched = [];
  const errors = [];
  const errorBudget = Math.max(5, Math.ceil(expectedTotal / 4));
  let aborted = false;
  let abortReason = null;

  // Detect starting state: poll generously because iframes are enumerated
  // lazily after attaching via CDP — first reads can return an empty frames
  // list even when frames are loaded. If a REVIEW-ALL frame appears, start
  // scraping from the current item. Otherwise (popup is on Score Card),
  // click the first .navigate anchor to enter Phase 3 mode.
  // NOTE: Caller should ensure the popup is on item 1 of Quantitative section
  // OR on the Score Card for a full 64-question scrape. Otherwise the runner
  // scrapes from wherever the popup is and misses earlier items.
  try { await popup.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch { /* best effort */ }
  // Decide entry path: if popup is on Score Card (a cmd=item or cmd=review
  // frame with detailsTable rows), click .navigate to enter REVIEW-ALL mode.
  // Otherwise assume popup is already on a question view and find the active
  // item frame. We probe content rather than URL alone because both Score Card
  // and item views can carry cmd=item.
  let frame = null;
  const scoreCardCandidate = findScoreCardFrame(popup);
  let isOnScoreCard = false;
  if (scoreCardCandidate) {
    try {
      isOnScoreCard = await scoreCardCandidate.evaluate(() => (
        document.querySelectorAll('table.table-table.type-\\%detailsTable\\%').length >= 3
      ));
    } catch { /* frame may detach during poll */ }
  }
  if (isOnScoreCard) {
    frame = await enterPhase3Mode(popup);
  } else {
    // Try to attach to an already-loaded item view. Short timeout so we fall
    // back to enterPhase3Mode if the popup is in some other state.
    frame = await waitForReviewAllItem(popup, null, null, { timeoutMs: 8000 })
      .catch(() => null);
    if (!frame) frame = await enterPhase3Mode(popup);
  }

  let prevItemName = null;

  for (let seq = 0; seq < expectedTotal; seq += 1) {
    const currentTitle = await popup.title().catch(() => null);
    const titleInfo = parsePopupTitle(currentTitle);
    let data;
    try {
      data = await readReviewAllFrame(frame);
      // .ITSStemText path returns raw container HTML in data.stemHtml. Sanitize
      // it to a render-safe subset (inline data: equation images preserved) and
      // derive the clean text stem from it. The body-innerText fallback path
      // leaves stemHtml null and keeps its pre-baked text stem untouched.
      if (data && data.stemHtml != null) {
        const safeHtml = sanitizeStemHtml(data.stemHtml);
        data.stemHtml = safeHtml || null;
        data.stem = stemHtmlToText(safeHtml) || data.stem || '';
      }
      // Same treatment for single-choice answer options whose math renders as an
      // inline image: keep the equation image in choice.textHtml, derive a clean
      // text label. Choices without textHtml (plain text / DI matrix / dropdown)
      // are untouched.
      if (data && Array.isArray(data.choices)) {
        for (const c of data.choices) {
          if (c && c.textHtml != null) {
            const safe = sanitizeStemHtml(c.textHtml);
            c.textHtml = safe || null;
            const t = stemHtmlToText(safe);
            if (t) c.text = t;
          }
        }
      }
    } catch (e) {
      errors.push({ seq, message: `read failed: ${e.message}` });
      if (e instanceof ScrapeAnomalyError) { aborted = true; abortReason = e.message; break; }
      if (errors.length >= errorBudget) { aborted = true; abortReason = 'too-many-errors'; break; }
      if (seq < expectedTotal - 1) {
        try {
          await sleep(jitter(minDelayMs, maxDelayMs));
          frame = await clickPhase3Next(popup, prevItemName, currentTitle);
        } catch (ne) {
          errors.push({ seq, message: `next failed during recovery: ${ne.message}` });
          aborted = true; abortReason = ne.message; break;
        }
      }
      continue;
    }

    enriched.push({
      seq,
      section: titleInfo?.sectionCode || subjectFromItemName(data.itemName),
      positionInSection: titleInfo?.position || null,
      sectionTotal: titleInfo?.sectionTotal || null,
      ...data,
    });
    prevItemName = data.itemName || prevItemName;
    if (onProgress) onProgress({
      event: 'item_done',
      seq,
      total: expectedTotal,
      itemName: data.itemName,
      section: titleInfo?.sectionCode || null,
      position: titleInfo?.position || null,
    });

    // Advance to next item (except after the last)
    if (seq < expectedTotal - 1) {
      try {
        await sleep(jitter(minDelayMs, maxDelayMs));
        frame = await clickPhase3Next(popup, prevItemName, currentTitle);
      } catch (e) {
        errors.push({ seq, message: `next failed: ${e.message}` });
        if (e instanceof ScrapeAnomalyError) { aborted = true; abortReason = e.message; break; }
        if (errors.length >= errorBudget) { aborted = true; abortReason = 'too-many-errors'; break; }
      }
    }
  }

  return {
    sourceLabel: preset.label,
    productId: preset.productId,
    takeIdx,
    items: enriched,
    errors,
    aborted,
    abortReason,
    qhTotal: expectedTotal,
    extracted_at: new Date().toISOString(),
  };
}

function jitter(minMs, maxMs) {
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || lo);
  return lo + Math.random() * (hi - lo);
}

module.exports = {
  SOURCE_PRODUCTS,
  ScrapeAnomalyError,
  hashSessionExternalId,
  recoverTakeIdxFromSessionExternalId,
  // Phase 1
  navigateToOpeLanding,
  listOpeAttemptsForProduct,
  // Phase 2
  openTakeScoreReportPopup,
  scrapeScoreReportPopup,
  shapeForSaveScrapeResult,
  // Identity / verification (shared between Phase 2 and Phase 3 runners)
  readScoreCardTakeIdentity,
  verifyPopupMatchesTakeIdx,
  // Phase 3
  scrapeAttemptPhase3,
  _internals: {
    decodeDataBlob,
    parseDateMDY,
    parseMinutesToSeconds,
    subjectFromItemName,
    mapCategoryCode,
    findScoreCardFrame,
    waitForScoreCardReady,
    readScoreCardSectionTables,
    buildQuestionRecord,
    parsePopupTitle,
    findReviewAllFrame,
    waitForReviewAllItem,
    readReviewAllFrame,
    clickPhase3Next,
    enterPhase3Mode,
    jitter,
  },
};
