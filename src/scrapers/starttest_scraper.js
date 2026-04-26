// StartTest 2 / ITD scraper. Runs Node-side (not injected into the page).
// Called with an already-navigated Playwright `page` connected to the user's
// logged-in Chrome via CDP.
//
// Two phases:
//   Phase 1 (fast, default): Home → Diagnostic Report → QHistory → ReviewItems AJAX.
//     Yields every answered item per session with correctness, topic, difficulty,
//     coarse time, stem preview, stable q_id (ItemName).
//   Phase 2 (opt-in, paced): per-item iframe src swap into ITDReview.aspx to pull
//     full stem/passage/choices/user-answer/precise time_ms. Human-like delays.

const STARTTEST_HOST_RE = /starttest\.com/i;
const BOOK_SESSION_TABLE_SEL = 'table.PracticeSessionsTable-tbl tbody tr';

// Source preset → StartTest `OrderProductID`. 1:1 with the old Nuxt sources.
// `productName` is the exact heading text StartTest shows in `h2#PgHdngPracticeDash`
// when the product is active — used for trust-the-tab verification.
const SOURCE_PRODUCTS = Object.freeze({
  'og-main-2024-2025': {
    productId: 1373434, type: 6,
    label: 'GMAT™ Official Guide 2024-2025',
    productName: 'GMAT™ Official Guide 2024-2025',
  },
  'og-verbal-review-2024-2025': {
    productId: 1554373, type: 6,
    label: 'GMAT™ Official Guide 2024-2025 - Verbal',
    productName: 'GMAT™ Official Guide 2024-2025 - Verbal',
  },
  'og-quantitative-review-2024-2025': {
    productId: 1519887, type: 6,
    label: 'GMAT™ Official Guide 2024-2025 - Quantitative',
    productName: 'GMAT™ Official Guide 2024-2025 - Quantitative',
  },
  'og-data-insights-review-2024-2025': {
    productId: 1452568, type: 6,
    label: 'GMAT™ Official Guide 2024-2025 - Data Insights',
    productName: 'GMAT™ Official Guide 2024-2025 - Data Insights',
  },
  'focus-quant-practice': {
    productId: 1213806, type: 6,
    label: 'GMAT™ Official Practice - Quantitative',
    productName: 'GMAT™ Official Practice - Quantitative',
  },
  'focus-verbal-practice': {
    productId: 1213807, type: 6,
    label: 'GMAT™ Official Practice - Verbal',
    productName: 'GMAT™ Official Practice - Verbal',
  },
  'focus-data-insights-practice': {
    productId: 1213805, type: 6,
    label: 'GMAT™ Official Practice - Data Insights',
    productName: 'GMAT™ Official Practice - Data Insights',
  },
});

// StartTest shows several distinct error-page wordings. Any of these means the
// current page isn't a usable response — navigating further would look bot-ish.
const ERROR_PAGE_PATTERNS = [
  /unexpected error has been encountered/i,
  /unexpected error has occurred/i,        // the "Retry" error screen
  /unknown command/i,                       // stale/invalid code hit an endpoint
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
        { url, snippet: sample.slice(0, 400) }
      );
    }
  }
}

// Normalize a product heading for comparison. Handles two StartTest quirks:
//   1) Different pages render the heading differently. The Home page shows
//      "Dashboard - <product>" while the Report page shows just "<product>".
//   2) Unicode trademark/hyphen characters can vary; whitespace can collapse.
// We strip the "Dashboard - " prefix, NFKC-normalize, collapse whitespace,
// and lowercase so the comparison works across pages and across OS locales.
function normalizeProductHeading(raw) {
  return String(raw || '')
    .normalize('NFKC')
    .replace(/^\s*Dashboard\s*[-–—]\s*/i, '') // strip "Dashboard - " prefix (any dash)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function absolutize(maybeRelative, base) {
  if (!maybeRelative) return null;
  try {
    return new URL(maybeRelative, base).toString();
  } catch (_e) {
    return null;
  }
}

function jitter(minMs, maxMs) {
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || lo);
  return lo + Math.random() * (hi - lo);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
}

// "5 Seconds" / "2 Minutes 3 Seconds" → seconds
function parseTimeSpent(raw) {
  const text = String(raw || '').toLowerCase();
  if (!text) return null;
  let total = 0;
  const hoursMatch = text.match(/(\d+)\s*hours?/);
  const minsMatch = text.match(/(\d+)\s*minutes?|(\d+)\s*mins?/);
  const secsMatch = text.match(/(\d+)\s*seconds?|(\d+)\s*secs?/);
  if (hoursMatch) total += Number(hoursMatch[1]) * 3600;
  if (minsMatch) total += Number(minsMatch[1] || minsMatch[2]) * 60;
  if (secsMatch) total += Number(secsMatch[1] || secsMatch[2]);
  return total || null;
}

// "4/22/2026" → "2026-04-22" (StartTest uses M/D/YYYY in en-US locale)
function parseDateMDY(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function parsePctCorrect(raw) {
  const text = String(raw || '').trim();
  const pctMatch = text.match(/(\d+(?:\.\d+)?)\s*%/);
  const fracMatch = text.match(/\((\d+)\s+of\s+(\d+)\)/i);
  const out = {};
  if (pctMatch) out.pct = Number(pctMatch[1]);
  if (fracMatch) {
    out.correct = Number(fracMatch[1]);
    out.total = Number(fracMatch[2]);
  }
  return Object.keys(out).length ? out : null;
}

// StartTest data-index top-tier → our normalized subject_code.
function mapSubjectCode(tier1) {
  if (tier1 === 'Verbal') return 'V';
  if (tier1 === 'Quant') return 'Q';
  if (tier1 === 'Data') return 'DI';
  return '';
}

// Best-effort category_code normalization. Leaves '' when ambiguous.
function mapCategoryCode(subjectCode, tier2) {
  if (subjectCode === 'V') {
    if (tier2 === 'CR' || tier2 === 'RC') return tier2;
    return '';
  }
  if (subjectCode === 'Q') return 'PS'; // StartTest uses Quant.PS for all Problem Solving
  if (subjectCode === 'DI') {
    if (tier2 === 'M2I' || tier2 === 'MSR') return 'MSR';
    if (tier2 === 'TAN' || tier2 === 'TAB') return 'TA';
    if (tier2 === 'GRI' || tier2 === 'GRA') return 'GI';
    if (tier2 === 'TPA') return 'TPA';
    if (tier2 === 'DS')  return 'DS';
    return ''; // ALG/ARI/PAD etc. — DI math-flavored; leave empty until taxonomy is confirmed
  }
  return '';
}

// Derive subject from ItemName letter prefix: "V188_..." | "Q..." | "D211_..."
function subjectFromItemName(itemName) {
  const prefix = String(itemName || '').trim().charAt(0).toUpperCase();
  if (prefix === 'V') return 'V';
  if (prefix === 'Q') return 'Q';
  if (prefix === 'D') return 'DI';
  return '';
}

// ─── Navigation helpers ─────────────────────────────────────────────────────

async function goto(page, url, { waitUntil = 'domcontentloaded', timeoutMs = 30000 } = {}) {
  if (!url) throw new ScrapeAnomalyError('Empty URL passed to goto');
  // Pre-flight: refuse to navigate to a URL that's missing the router params we
  // know StartTest requires. This prevents a mangled URL built from an error
  // page (or a bad DOM state) from triggering further server-side errors.
  let parsed;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || !parsed.searchParams.get('session') || !parsed.searchParams.get('code') || !parsed.searchParams.get('cmd')) {
    throw new ScrapeAnomalyError(
      `Refusing to navigate to a URL missing session/code/cmd. Likely built from a stale page; resetting is safer than continuing. URL: ${url}`
    );
  }
  // Pre-flight: if the CURRENT page is already an error page, don't compound it with another nav.
  const preNavSnippet = await page.evaluate(() => (document.body?.innerText || '').slice(0, 1200)).catch(() => '');
  try { assertNotErrorPage(preNavSnippet, page.url()); } catch (e) {
    throw new ScrapeAnomalyError(
      `Current tab is on an error page; refusing to navigate further. Reload or click a home link manually, then retry.`,
      { url: page.url(), snippet: preNavSnippet.slice(0, 400) }
    );
  }
  await page.goto(url, { waitUntil, timeout: timeoutMs });
  // Give the server a breath; avoid racing page scripts.
  await sleep(jitter(400, 900));
  const snippet = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => '');
  assertNotErrorPage(snippet, page.url());
}

// Re-resolve an absolute URL from a `router?...` relative link on the currently-loaded page.
async function resolvePageRelative(page, relative) {
  return page.evaluate((rel) => new URL(rel, location.href).toString(), relative);
}

// ─── Home page ──────────────────────────────────────────────────────────────

async function navigateHome(page) {
  const u = new URL(page.url());
  const next = new URL(u.origin + u.pathname);
  for (const k of ['programid', 'session', 'code']) {
    const v = u.searchParams.get(k);
    if (v) next.searchParams.set(k, v);
  }
  next.searchParams.set('cmd', 'HomePage');
  await goto(page, next.toString());
}

async function navigateToProduct(page, productId, type = 6) {
  // Landing Home first guarantees we have a live router URL with a fresh code.
  await navigateHome(page);
  // Find the product link in the product-switcher menu (its href has a live code).
  const productUrl = await page.evaluate(
    ({ productId, type }) => {
      const sel = `a[href*="OrderProductID=${productId}"][href*="type=${type}"]`;
      return document.querySelector(sel)?.href || null;
    },
    { productId, type }
  );
  if (!productUrl) {
    throw new ScrapeAnomalyError(
      `Product ${productId} not found in the StartTest home menu. Verify the account owns this practice bank.`
    );
  }
  await goto(page, productUrl);
}

async function listSessionsOnHome(page) {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).map((tr) => {
      const cells = Array.from(tr.children).map((c) => (c.innerText || '').trim());
      const reportLink = tr.querySelector(
        'a[href*="NavigateToDiagnosticReport"]:not([href*="widgetview"])'
      );
      return {
        sid: tr.id || null,
        startDate: cells[0] || null,
        lastAnswerDate: cells[1] || null,
        totalQ: cells[2] || null,
        pctCorrect: cells[3] || null,
        reportUrl: reportLink?.href || null,
      };
    });
  }, BOOK_SESSION_TABLE_SEL);
}

// ─── Diagnostic Report ─────────────────────────────────────────────────────

// Walks tr.review-area tree, builds:
//   taxonomy: Map<listitemid -> {path, depth, labels[], subjectCode, categoryCode, subcategory, topic}>
//   labelIndex: Map<topicLabel -> listitemid> (for matching QHistory rows by Content Area text)
//   jsondata_reviewtable (fresh URLs with codes)
async function readReport(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr.review-area[data-index]'));
    const byPath = new Map();
    for (const tr of rows) {
      const path = tr.getAttribute('data-index') || '';
      if (!path) continue;
      const depth = Number(tr.getAttribute('data-depth')) || 0;
      const rowLabel = (tr.querySelector('span.row-text, [id^="RowTxt-"]')?.innerText || '').trim();
      byPath.set(path, { path, depth, label: rowLabel });
    }

    // For each leaf (data-has-children=False), collect listitemid + resolve parent labels.
    const leafRows = rows.filter((tr) => tr.getAttribute('data-has-children') === 'False');
    const taxonomy = [];
    const labelIndex = new Map();
    for (const tr of leafRows) {
      const path = tr.getAttribute('data-index') || '';
      if (!path) continue;
      const parts = path.split('.');
      const labels = [];
      for (let i = 1; i <= parts.length; i += 1) {
        const sub = parts.slice(0, i).join('.');
        const entry = byPath.get(sub);
        labels.push(entry?.label || null);
      }
      // Any `a.itemaction[listitemid]` on this row gives us the listitemid
      const liid = tr.querySelector('a.itemaction[listitemid]')?.getAttribute('listitemid') || null;
      const record = {
        listitemid: liid ? Number(liid) : null,
        path,
        parts,
        labels,
        depth: Number(tr.getAttribute('data-depth')) || parts.length,
      };
      taxonomy.push(record);
      const leafLabel = labels[labels.length - 1] || null;
      if (leafLabel) {
        // A leaf label can repeat across subjects (e.g., Percent in Quant and DI).
        // Key the index by "subject|label" to disambiguate; fall back by label alone is handled in the scraper.
        const subj = parts[0];
        labelIndex.set(`${subj}|${leafLabel}`, record);
        if (!labelIndex.has(leafLabel)) labelIndex.set(leafLabel, record);
      }
    }

    const cfg = (typeof jsondata_reviewtable !== 'undefined' && jsondata_reviewtable) || null;
    return {
      jsondata_reviewtable: cfg ? { ...cfg } : null,
      taxonomy,
      labelIndexEntries: Array.from(labelIndex.entries()),
    };
  });
}

// ─── Question History ──────────────────────────────────────────────────────

// Build the QHistory URL from a live report page's jsondata_reviewtable.
function buildQHistoryUrl(jsondataUrl, sid, totalCount) {
  if (!jsondataUrl) return null;
  // jsondataUrl is relative ("router?..."). Must be absolutized against the current page.
  return `${jsondataUrl}&sid=${encodeURIComponent(sid)}&d=0&c=0&s=2&liid=0&ct=${encodeURIComponent(totalCount || 0)}`;
}

async function readQHistoryRows(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr.pn-table-row'));
    return rows.map((tr) => {
      const cellByTh = (th) => {
        const td = Array.from(tr.children).find((c) => c.getAttribute('data-th') === th);
        return td ? (td.innerText || '').trim() : null;
      };
      const reviewAnchor = tr.querySelector('a.opentestwindow[url]');
      const reviewUrlRel = reviewAnchor?.getAttribute('url') || null;
      const seqMatch = reviewUrlRel?.match(/[?&]seq=(\d+)/);
      return {
        date: cellByTh('Date'),
        correct: cellByTh('Correct'),
        preview: cellByTh('Item Preview'),
        contentArea: cellByTh('Content Area'),
        timeSpent: cellByTh('Time Spent'),
        difficulty: cellByTh('Difficulty'),
        reviewUrlRel,
        seq: seqMatch ? Number(seqMatch[1]) : null,
      };
    });
  });
}

// ─── ReviewItems AJAX (per-item ItemName list) ─────────────────────────────

// Phase 2 only (deferred). Do NOT call this from Phase 1. Grabbing ItemNames via the
// GetPracticeNowReviewItems AJAX requires a ReviewItems navigation, which adds
// per-session navigation count and has occasionally caused StartTest to return
// "An error occurred while processing this page" on follow-on loads. Keep the
// helper wired only for the eventual per-session opt-in Phase 2 flow.
async function fetchReviewItemList(page, firstRowReviewUrl) {
  // Navigate to the review outer page (any row's URL works; they share the same filter set).
  await goto(page, firstRowReviewUrl);
  const ajaxUrl = await page.evaluate(() => {
    const el = document.getElementById('data_reviewitems');
    try { return el ? JSON.parse(el.textContent || '').getreviewitems : null; }
    catch { return null; }
  });
  if (!ajaxUrl) {
    return { items: null, reason: 'no-data-reviewitems-script' };
  }
  const resp = await page.evaluate(async (u) => {
    const full = new URL(u, location.href).toString();
    const r = await fetch(full, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return { status: r.status, body: await r.text() };
  }, ajaxUrl);
  if (resp.status !== 200) {
    throw new ScrapeAnomalyError(
      `GetPracticeNowReviewItems returned HTTP ${resp.status}`,
      { url: ajaxUrl, snippet: String(resp.body || '').slice(0, 400) }
    );
  }
  let outer;
  try { outer = JSON.parse(resp.body); } catch (_e) {
    throw new ScrapeAnomalyError('GetPracticeNowReviewItems did not return JSON', {
      snippet: String(resp.body || '').slice(0, 400),
    });
  }
  if (!outer?.Success) {
    throw new ScrapeAnomalyError(
      `GetPracticeNowReviewItems Success=false, ErrorCode="${outer?.ErrorCode || ''}"`
    );
  }
  // Some sessions (typically 0-or-1-item ones) return Data: "ERROR" or similar non-array strings.
  // That's a StartTest quirk, not a bot signal — treat as "list not available" and let the caller
  // fall back to seq-based IDs.
  let list;
  if (typeof outer.Data === 'string') {
    const inner = outer.Data.trim();
    if (inner === 'ERROR' || inner === '' || /^error/i.test(inner)) {
      return { items: null, reason: `data=${inner.slice(0, 30)}` };
    }
    try { list = JSON.parse(inner); } catch (_e) {
      return { items: null, reason: 'inner-data-not-json' };
    }
  } else if (Array.isArray(outer.Data)) {
    list = outer.Data;
  }
  if (!Array.isArray(list)) {
    return { items: null, reason: 'no-array' };
  }
  // [{FormQuestionID, ValidationGuid, ItemName, ResultID}, ...]
  return { items: list, reason: null };
}

// ─── Phase 1: compose a session's question list ────────────────────────────

function matchTaxonomyEntry(labelIndex, subjectHint, topicLabel) {
  if (!topicLabel) return null;
  if (subjectHint) {
    const scoped = labelIndex.get(`${subjectHint}|${topicLabel}`);
    if (scoped) return scoped;
  }
  return labelIndex.get(topicLabel) || null;
}

function buildQuestionRecord({ qhRow, itemMeta, taxonomyHit, sessionSource }) {
  const correct = String(qhRow.correct || '').toUpperCase().startsWith('Y') ? 1 : 0;
  const parts = taxonomyHit?.parts || [];
  const labels = taxonomyHit?.labels || [];
  const subjectCodeByPath = mapSubjectCode(parts[0]);
  const subjectCodeByItem = subjectFromItemName(itemMeta?.ItemName);
  const subjectCode = subjectCodeByPath || subjectCodeByItem;
  const categoryCode = mapCategoryCode(subjectCode, parts[1]);
  // "subcategory" in existing data is a short string; use tier-3 code; fall back to leaf label
  const subcategoryCode = parts[2] || null;
  const topic = labels[labels.length - 1] || qhRow.contentArea || null;
  // Prefer the human label for content_domain (e.g., "Data Insights" rather than "Data").
  const contentDomain = labels[0] || parts[0] || null;
  return {
    q_code: null,                                           // filled in Phase 2 from vItemInformation.Key
    q_id: itemMeta?.ItemName || (qhRow.seq !== null ? `seq-${qhRow.seq}` : null),
    cat_id: taxonomyHit?.listitemid ?? null,
    subject_code: subjectCode || null,
    category_code: categoryCode || null,
    subcategory: subcategoryCode,
    subject_sub: subjectCodeByPath || subjectCodeByItem || null,
    subject_sub_raw: parts[0] || null,
    question_url: null,                                     // starttest review URL is code-rotating; don't persist
    question_stem: qhRow.preview || null,                   // preview only; Phase 2 replaces with full stem
    answer_choices: null,                                   // Phase 2
    response_format: null,                                  // Phase 2
    response_details: null,                                 // Phase 2
    correct,
    difficulty: qhRow.difficulty || null,
    confidence: null,                                       // Phase 2 from QSurvey if captured
    time_sec: parseTimeSpent(qhRow.timeSpent),
    my_answer: null,                                        // Phase 2
    correct_answer: null,                                   // Phase 2
    topic,
    topic_source: 'starttest-report',
    content_domain: contentDomain,
    mistake_type: null,
    notes: null,
    // Extras carried through for Phase 2 bookkeeping (not stored directly):
    _seq: qhRow.seq,
    _reviewUrlRel: qhRow.reviewUrlRel,
    _validation_guid: itemMeta?.ValidationGuid || null,
    _result_id: itemMeta?.ResultID || null,
    _form_question_id: itemMeta?.FormQuestionID || null,
  };
}

function summarizeQuestions(questions, sessionDate) {
  const total = questions.length;
  let correct = 0;
  let timeSum = 0;
  let timeCorrectSum = 0;
  let timeIncorrectSum = 0;
  let timeCorrectCount = 0;
  let timeIncorrectCount = 0;
  for (const q of questions) {
    if (q.correct) correct += 1;
    if (Number.isFinite(q.time_sec)) {
      timeSum += q.time_sec;
      if (q.correct) { timeCorrectSum += q.time_sec; timeCorrectCount += 1; }
      else          { timeIncorrectSum += q.time_sec; timeIncorrectCount += 1; }
    }
  }
  return {
    total_q_api: total,
    total_q_categories: total,
    correct,
    errors: total - correct,
    accuracy_pct: total ? Number(((correct / total) * 100).toFixed(2)) : 0,
    avg_time_sec: total ? Math.round(timeSum / total) : null,
    avg_correct_time_sec: timeCorrectCount ? Math.round(timeCorrectSum / timeCorrectCount) : null,
    avg_incorrect_time_sec: timeIncorrectCount ? Math.round(timeIncorrectSum / timeIncorrectCount) : null,
  };
}

async function scrapeSessionPhase1({ page, sid, sourceLabel, homeMeta }) {
  // Safety: Phase 1 hits exactly TWO URLs per session — Report and QHistory.
  // Both are captured upfront from the initial Home page render, so each code
  // is fresh and used once. We deliberately skip ReviewItems + the
  // GetPracticeNowReviewItems AJAX to minimize navigation count and keep to
  // URL paths a normal user clicks through.
  // q_id is a sid-seq composite in Phase 1. Phase 2 (opt-in per session) will
  // later fill in the stable ITD ItemName/Key.
  if (!homeMeta?.reportUrl) {
    throw new ScrapeAnomalyError(`sid=${sid}: no Report URL captured from Home.`);
  }
  await goto(page, homeMeta.reportUrl);
  const reportInfo = await readReport(page);
  const jsonCfg = reportInfo.jsondata_reviewtable;
  if (!jsonCfg?.getqhistoryurl) {
    throw new ScrapeAnomalyError(`Report for sid=${sid} did not expose jsondata_reviewtable.`);
  }

  // Build labelIndex (re-hydrate Map on Node side)
  const labelIndex = new Map(reportInfo.labelIndexEntries);

  // Fetch QHistory (single page, all answered items)
  const totalQ = Number(homeMeta?.totalQ) || 0;
  const qhUrlRel = buildQHistoryUrl(jsonCfg.getqhistoryurl, sid, totalQ);
  const qhUrl = await resolvePageRelative(page, qhUrlRel);
  await goto(page, qhUrl);
  const qhRows = await readQHistoryRows(page);
  if (!qhRows.length) {
    // Session with no answered items — skip cleanly.
    return {
      session_id: Number(sid),
      date: null,
      source: sourceLabel,
      subject: null,
      stats: summarizeQuestions([], null),
      questions: [],
    };
  }

  const questions = [];
  for (let i = 0; i < qhRows.length; i += 1) {
    const row = qhRows[i];
    const parts = (matchTaxonomyEntry(labelIndex, null, row.contentArea)?.parts) || [];
    const subjectHint = mapSubjectCode(parts[0]);
    const subjectPathKey =
      subjectHint === 'V' ? 'Verbal' :
      subjectHint === 'Q' ? 'Quant' :
      subjectHint === 'DI' ? 'Data' : null;
    const hit = matchTaxonomyEntry(labelIndex, subjectPathKey, row.contentArea);
    // q_id = "<sid>-seq-<N>". Unique per row, non-random, and easy to upgrade
    // to the real ItemName later when Phase 2 runs for this session.
    const composite = row.seq != null ? `${sid}-seq-${row.seq}` : `${sid}-row-${i}`;
    questions.push(buildQuestionRecord({
      qhRow: row,
      itemMeta: { ItemName: composite }, // acts as stable key for later UPSERT
      taxonomyHit: hit,
      sessionSource: sourceLabel,
    }));
  }

  const firstDate = qhRows[0]?.date ? parseDateMDY(qhRows[0].date) : null;

  // Prefer the deepest common subject from the taxonomy paths (single-subject books return one)
  const subjectCodes = new Set(questions.map((q) => q.subject_code).filter(Boolean));
  const subject = subjectCodes.size === 1 ? [...subjectCodes][0] : null;

  return {
    session_id: Number(sid),
    date: firstDate,
    source: sourceLabel,
    subject,
    stats: summarizeQuestions(questions, firstDate),
    questions,
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

// options: { sourceId, since (YYYYMMDDHHmmss ICT), sessionSids (optional, limit to these), onProgress }
async function runPhase1({ page, options = {} }) {
  const sourceId = String(options.sourceId || '').trim();
  const preset = SOURCE_PRODUCTS[sourceId];
  if (!preset) {
    throw new ScrapeAnomalyError(`Unknown sourceId "${sourceId}". Expected one of ${Object.keys(SOURCE_PRODUCTS).join(', ')}.`);
  }
  if (!STARTTEST_HOST_RE.test(page.url())) {
    throw new ScrapeAnomalyError(
      `Tab is not on starttest.com (current: ${page.url()}). Log in via mba.com first.`
    );
  }
  const curUrl = (() => { try { return new URL(page.url()); } catch { return null; } })();
  if (!curUrl?.searchParams.get('session')) {
    throw new ScrapeAnomalyError(
      `Tab URL has no StartTest session token. Please log in via mba.com and open GMAT practice first.`
    );
  }

  // Trust the user's current tab. We expect them to have navigated to the right product
  // already (manually, or via the /api/open-product helper). This gives us 0 Home navs
  // in the scrape — every URL we go to is either Report or QHistory.
  const pageState = await page.evaluate(() => ({
    hasTable: !!document.querySelector('table.PracticeSessionsTable-tbl'),
    productHeading: (document.querySelector('#PgHdngPracticeDash')?.innerText || '').trim(),
  }));
  if (!pageState.hasTable) {
    throw new ScrapeAnomalyError(
      `Tab is not on the Practice Sessions home page. Open the product's home page first (use the "Open in GMAT" button or navigate manually), then retry.`
    );
  }
  // Exact match after normalization. This disambiguates "GMAT™ Official Guide 2024-2025"
  // from "GMAT™ Official Guide 2024-2025 - Verbal" which a loose contains-check would conflate.
  if (preset.productName) {
    const actual = normalizeProductHeading(pageState.productHeading);
    const expected = normalizeProductHeading(preset.productName);
    if (actual !== expected) {
      throw new ScrapeAnomalyError(
        `You selected source "${preset.label}" but the tab heading is "${pageState.productHeading}". ` +
        `Switch products first (click "Open in GMAT" next to the source dropdown, or click the product in the GMAT menu), then retry.`
      );
    }
  }

  const sessionsOnHome = await listSessionsOnHome(page);
  const sessionSidFilter = Array.isArray(options.sessionSids) && options.sessionSids.length
    ? new Set(options.sessionSids.map(String))
    : null;
  const sinceYmd = parseSinceYmd(options.since);

  const candidates = sessionsOnHome.filter((s) => {
    if (!s.sid) return false;
    if (sessionSidFilter && !sessionSidFilter.has(String(s.sid))) return false;
    if (sinceYmd) {
      const last = s.lastAnswerDate ? parseDateMDY(s.lastAnswerDate) : null;
      if (last && last < sinceYmd) return false;
    }
    return true;
  });

  const sessions = [];
  const warnings = [];
  for (const homeMeta of candidates) {
    try {
      if (typeof options.onProgress === 'function') {
        options.onProgress({ phase: 'phase1', event: 'session_start', sid: homeMeta.sid });
      }
      const session = await scrapeSessionPhase1({
        page,
        sid: homeMeta.sid,
        sourceLabel: preset.label,
        homeMeta,
      });
      sessions.push(session);
      if (typeof options.onProgress === 'function') {
        options.onProgress({
          phase: 'phase1',
          event: 'session_done',
          sid: homeMeta.sid,
          questions: session.questions.length,
        });
      }
    } catch (error) {
      const msg = error?.message || String(error);
      warnings.push({ sid: homeMeta.sid, message: msg });
      // Surface ScrapeAnomalyError immediately — that's the bot-signal we want to back off on.
      if (error instanceof ScrapeAnomalyError) throw error;
      // eslint-disable-next-line no-console
      console.warn(`[starttest] sid=${homeMeta.sid} phase-1 failed:`, msg);
    }
  }

  return {
    extracted_at: new Date().toISOString(),
    config: { since: options.since || null, source: preset.label, sourceId, productId: preset.productId },
    sessions,
    warnings,
  };
}

// "20260101000000" → "2026-01-01". Returns null on non-parsable.
function parseSinceYmd(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ─── Phase 2 ────────────────────────────────────────────────────────────────
// Per-session deep enrichment. For each answered item:
//   - Navigate outer ReviewItems page to seq=N (full ITDStart harness loaded).
//   - Read globals (vItemName, vItemType, vItemInformation.Key, answerSelection,
//     vPreviousTimeSpent, vPassageName) from the ITDReview.aspx child frame.
//   - Read DOM (stem, passage, choices, rationale, score-text) from the same frame.
// Pacing: human-like jitter (3–6 s) between items. Anomaly = abort.
//
// IMPORTANT design choice: we navigate the OUTER page per item, not an iframe
// src swap. Earlier probing showed that swapping ExamIframe.src directly to
// ITDReview.aspx breaks ITDStart's parent harness and the JS globals never
// populate. Going through the official `seq=N` URL is the only reliable path.

async function fetchReviewItemNames(page, firstReviewUrl) {
  // Navigate to the ReviewItems shell (used to bootstrap the session and get the
  // AJAX list). After this, jsondata_reviewtable on the page has fresh codes.
  await goto(page, firstReviewUrl);
  const ajaxUrl = await page.evaluate(() => {
    const el = document.getElementById('data_reviewitems');
    try { return el ? JSON.parse(el.textContent || '').getreviewitems : null; } catch { return null; }
  });
  if (!ajaxUrl) return { items: null, reason: 'no-data-reviewitems-script' };
  const resp = await page.evaluate(async (u) => {
    const full = new URL(u, location.href).toString();
    const r = await fetch(full, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    return { status: r.status, body: await r.text() };
  }, ajaxUrl);
  if (resp.status !== 200) {
    throw new ScrapeAnomalyError(
      `GetPracticeNowReviewItems returned HTTP ${resp.status}`,
      { url: ajaxUrl, snippet: String(resp.body || '').slice(0, 400) }
    );
  }
  let outer;
  try { outer = JSON.parse(resp.body); } catch { throw new ScrapeAnomalyError('AJAX did not return JSON'); }
  if (!outer?.Success) throw new ScrapeAnomalyError(`AJAX Success=false (${outer?.ErrorCode || ''})`);
  let list;
  if (typeof outer.Data === 'string') {
    const inner = outer.Data.trim();
    if (inner === 'ERROR' || /^error/i.test(inner)) return { items: null, reason: `data=${inner.slice(0, 30)}` };
    try { list = JSON.parse(inner); } catch { return { items: null, reason: 'inner-not-json' }; }
  } else if (Array.isArray(outer.Data)) {
    list = outer.Data;
  }
  if (!Array.isArray(list)) return { items: null, reason: 'no-array' };
  return { items: list, reason: null };
}

// For dropdown items, the user's saved answer is restored to the <select>
// elements asynchronously after the item bootstraps. Reading the frame too
// eagerly catches the dropdowns at their "Select..." default. Poll briefly for
// any dropdown's value to leave default; if all stay default within budget,
// accept that the user genuinely didn't answer.
async function waitForDropdownsRestored(frame, { timeoutMs = 6000, pollMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const populated = await frame.evaluate(() => {
        const selects = Array.from(document.querySelectorAll('select')).filter(
          (s) => !['sessionlist', 'difficulty', 'confidence', 'attributes', 'blueprintlist'].includes(s.id)
        );
        if (!selects.length) return true; // not a dropdown item
        // True if at least one dropdown has a non-default value.
        return selects.some((s) => {
          const v = String(s.value || '').trim();
          return v && !/^select\.\.\.?$/i.test(v);
        });
      });
      if (populated) return true;
    } catch (_e) { /* frame may detach; retry */ }
    await sleep(pollMs);
  }
  return false; // budget elapsed; caller should proceed with whatever is there
}

// Wait for the ITDReview frame to be present AND its globals to indicate the
// expected itemname is loaded AND the choices DOM has rendered. Returns the
// Frame handle. The choice DOM rendering can lag the globals by 100s of ms, so
// reading too eagerly (just on globals being set) yields empty choice arrays.
async function waitForReviewFrame(page, expectedItemName, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let frameSeenWithoutGlobals = false;
  let frameSeenWithoutChoices = false;
  let lastFramesSnapshot = [];
  while (Date.now() < deadline) {
    const frames = page.frames();
    const frame = frames.find((f) => /ITDReview\.aspx/i.test(f.url()));
    if (frame) {
      frameSeenWithoutGlobals = true;
      try {
        const state = await frame.evaluate((expected) => {
          if (typeof window.vItemName === 'undefined') return { ready: false, reason: 'no-vItemName' };
          if (expected && window.vItemName !== expected) return { ready: false, reason: 'name-mismatch' };
          if (!Array.isArray(window.vItemInformation) || window.vItemInformation.length < 2) {
            return { ready: false, reason: 'no-vItemInformation' };
          }
          // Choice DOM check: at least one of the recognized choice containers
          // must have rendered with at least one input or table row.
          const hasRadios = document.querySelectorAll('input[type="radio"][name^="I"]').length > 0;
          const hasMatrix = !!document.querySelector('table.ITSMatrixTable');
          const hasOptions = !!document.querySelector('.options-container input, .options-container-inner input');
          // Graphics Interpretation / fill-blank items use <select> dropdowns.
          // Filter out chrome selects that exist on Report/QHistory pages.
          const hasDropdown = Array.from(document.querySelectorAll('select')).some((s) =>
            !['sessionlist', 'difficulty', 'confidence', 'attributes', 'blueprintlist'].includes(s.id)
          );
          if (!hasRadios && !hasMatrix && !hasOptions && !hasDropdown) {
            return { ready: false, reason: 'no-choice-dom' };
          }
          return { ready: true };
        }, expectedItemName || null);
        if (state.ready) return frame;
        if (state.reason === 'no-choice-dom') frameSeenWithoutChoices = true;
      } catch (_e) { /* frame may have detached during navigation; retry */ }
    }
    lastFramesSnapshot = frames.map((f) => f.url().slice(0, 140));
    await sleep(300);
  }
  let reason = 'No ITDReview.aspx frame ever appeared in the page';
  if (frameSeenWithoutChoices) reason = 'ITDReview frame loaded but choice DOM never rendered (no radios / matrix / options-container inputs)';
  else if (frameSeenWithoutGlobals) reason = 'ITDReview frame loaded but globals never populated';
  const diag = JSON.stringify({
    pageUrl: page.url().slice(0, 200),
    framesAtTimeout: lastFramesSnapshot,
    reason,
  });
  throw new ScrapeAnomalyError(
    `Timed out waiting for ITDReview frame${expectedItemName ? ` (expected itemname=${expectedItemName})` : ''}. ${reason}`,
    { url: page.url(), snippet: diag.slice(0, 800) }
  );
}

// Read everything we want from the ITDReview frame's globals + DOM.
//
// StartTest's ITDReview DOM has TWO useful payloads we now exploit:
//   1. <input name="Key1" type="hidden" value="..."> — the correct answer key.
//      For single-choice MC: a single value like "4". For matrix items: a CSV
//      like "2,2,1" (one value per sub-question).
//   2. window.answerSelection[1] — the user's selection in the same shape.
//
// Choice DOM has two shapes:
//   A. Single-choice MC: 5 <input type="radio" name="I1"> — value 1..5, with
//      labels prefixed "A) ", "B) ", etc. The user's pick has either
//      input:checked OR the row has class .ITSMCOptionTableOn.
//   B. Matrix (DI Multi-Source Reasoning): a <table class="ITSMatrixTable">
//      where each row has <td class="ITSMatrixOption"> cells. The CORRECT cell
//      has style "background-image: URL('ITD/radiochecked.gif')". The USER's
//      selected cell contains <div style="background-color:yellow">.
async function readReviewFrame(frame) {
  return frame.evaluate(() => {
    const text = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return (el.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    };
    const safeJson = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch { return null; } };

    // --- Correct answer key (works for both MC and Matrix) ---
    let correctKey = null;
    try {
      const form = document.forms?.[0];
      const k = form?.elements?.Key1?.value;
      if (typeof k === 'string' && k.length) correctKey = k;
    } catch (_e) { /* ignore */ }

    // --- Choice extraction by item type ---
    let choicesType = null;
    let choices = null;

    // First, detect <select> dropdowns inside the question content. These are
    // Graphics Interpretation / fill-in-the-blank style items where the stem
    // has 1-3 inline dropdowns. Filter out navigation/filter dropdowns from
    // the StartTest harness UI (sessionlist, difficulty, etc.).
    const allSelects = Array.from(document.querySelectorAll('select'));
    const questionSelects = allSelects.filter((s) => {
      // Skip the global filters that appear on Report/QHistory pages
      if (['sessionlist', 'difficulty', 'confidence', 'attributes', 'blueprintlist'].includes(s.id)) return false;
      // Skip selects that are clearly UI chrome
      if (s.closest('.itd-toolbar, .nav-toolbar, .qhistory-flex-tb-container, header, footer')) return false;
      return true;
    });

    const matrixTable = document.querySelector('table.ITSMatrixTable');
    if (questionSelects.length > 0 && !matrixTable) {
      // Graphics Interpretation / drop-down style item. Each dropdown is its
      // own sub-question. The user's pick is reflected in `select.value`,
      // which the page sets via JS — `option.selected` is the static HTML flag
      // and may not reflect the user's actual choice. Match by value instead.
      choicesType = 'dropdown';
      choices = {
        dropdowns: questionSelects.map((sel, idx) => {
          const opts = Array.from(sel.options || []).map((o) => ({
            value: o.value,
            text: (o.text || '').trim(),
            selected: o.selected,
          }));
          // Authoritative match: find the option whose value === select.value.
          const selectedOpt = opts.find((o) => o.value === sel.value) || null;
          return {
            idx,
            name: sel.name || sel.id || null,
            selected: sel.value,
            selectedText: selectedOpt ? selectedOpt.text : sel.value,
            options: opts,
          };
        }),
      };
    } else if (matrixTable) {
      // Matrix: rows × columns. Read all cells, mark correct + user-selected.
      choicesType = 'matrix';
      const headerCells = Array.from(matrixTable.querySelectorAll('tr.header td.ITSMatrixLabel'));
      const headers = headerCells.map((td) => (td.innerText || '').trim()).filter(Boolean);
      const rowEls = Array.from(matrixTable.querySelectorAll('tr.row'));
      // Color coding StartTest uses on cells (per user's observation):
      //   yellow → the correct answer (regardless of whether picked)
      //   green  → user picked AND it's correct
      //   red    → user picked AND it's wrong
      // Combined with the radiochecked.gif background image (visual radio fill,
      // shown on the user's selected cell), we derive isCorrect and isUserSelected.
      const colorOf = (td) => {
        const inner = td.querySelector('div[style*="background"], div[align="center"][style]');
        const style = (inner && inner.getAttribute('style')) || '';
        if (/(?:background(?:-color)?\s*:\s*)?yellow/i.test(style)) return 'yellow';
        if (/(?:background(?:-color)?\s*:\s*)?red/i.test(style)) return 'red';
        if (/(?:background(?:-color)?\s*:\s*)?green/i.test(style)) return 'green';
        return null;
      };
      const rows = rowEls.map((tr) => {
        const optionCells = Array.from(tr.querySelectorAll('td.ITSMatrixOption'));
        const labelCell = tr.querySelector('td.ITSMatrixLabel');
        return {
          label: labelCell ? (labelCell.innerText || '').trim() : '',
          options: optionCells.map((td) => {
            const styleAttr = td.getAttribute('style') || '';
            const hasRadioChecked = /radiochecked\.gif/i.test(styleAttr);
            const color = colorOf(td);
            return {
              cellId: td.id || null,
              color,                                                 // yellow|red|green|null
              isCorrect: color === 'yellow' || color === 'green',    // primary signal
              isUserSelected: color === 'red' || color === 'green' || hasRadioChecked,
            };
          }),
        };
      });
      choices = { headers, rows };
    } else {
      // Single-choice MC. StartTest's review mode highlights each choice's
      // container with a background color:
      //   yellow → the correct answer (regardless of whether the user picked it)
      //   green  → the user picked AND it's correct
      //   red    → the user picked AND it's wrong
      // We walk up from each I1 radio to its visible row container, sample the
      // background color from inline style and from getComputedStyle, then
      // derive isCorrect / isUserSelected the same way as for matrix.
      const radios = Array.from(document.querySelectorAll('input[type="radio"][name^="I"]'));
      const i1Radios = radios.filter((r) => r.name === 'I1');
      const colorFromStyle = (styleStr) => {
        if (!styleStr) return null;
        const s = String(styleStr);
        if (/(?:background(?:-color)?\s*:\s*)?yellow/i.test(s)) return 'yellow';
        if (/(?:background(?:-color)?\s*:\s*)?(?:#?ff[a-f0-9]{4}|#?ffeb|gold)/i.test(s)) return 'yellow';
        if (/(?:background(?:-color)?\s*:\s*)?(?:red|#?ff0000|#?e7|#?d4)/i.test(s)) return 'red';
        if (/(?:background(?:-color)?\s*:\s*)?(?:green|#?00ff00|#?0[0-9a-f]a|#?2[0-9a-f]b)/i.test(s)) return 'green';
        return null;
      };
      // Match an rgb() to one of yellow/red/green by dominant channel.
      const rgbToColor = (rgb) => {
        const m = String(rgb || '').match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (!m) return null;
        const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
        // Skip near-white / near-transparent backgrounds
        if (r > 245 && g > 245 && b > 245) return null;
        if (r > 200 && g > 200 && b < 120) return 'yellow';
        if (r > 180 && g < 130 && b < 130) return 'red';
        if (g > 150 && r < 200 && b < 150) return 'green';
        return null;
      };
      if (i1Radios.length >= 2) {
        choicesType = 'single';
        const userSelectedRow = document.querySelector('.ITSMCOptionTableOn');
        choices = i1Radios.map((el) => {
          const labelText = (el.labels?.[0]?.innerText || el.parentElement?.innerText || '').trim();
          // Walk up the DOM looking at backgrounds. Stop at the first colored
          // ancestor or after a few levels.
          let color = null;
          let container = el.closest('tr, li, .ITSMCOption, .ITSMCOptionTable, [class*="MCOption"], [class*="OptionRow"]') || el.parentElement;
          for (let node = container, depth = 0; node && depth < 4 && !color; node = node.parentElement, depth += 1) {
            color = colorFromStyle(node.getAttribute && node.getAttribute('style'));
            if (!color) {
              const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(node) : null;
              if (cs) color = rgbToColor(cs.backgroundColor);
            }
          }
          const inUserSelectedRow = !!(userSelectedRow && container && (container === userSelectedRow || userSelectedRow.contains(container) || container.contains(userSelectedRow)));
          return {
            value: el.value,
            label: labelText,
            color,                                                  // yellow|red|green|null
            checked: el.checked || color === 'red' || color === 'green' || inUserSelectedRow,
            isCorrect: color === 'yellow' || color === 'green',
            isUserSelected: el.checked || color === 'red' || color === 'green' || inUserSelectedRow,
          };
        });
      } else if (radios.length) {
        choicesType = 'other';
        choices = radios.map((el) => ({
          name: el.name, value: el.value, checked: el.checked,
          label: (el.labels?.[0]?.innerText || '').trim(),
        }));
      }
    }

    return {
      vItemName: window.vItemName || null,
      vItemType: window.vItemType || null,
      vItemInformation: safeJson(window.vItemInformation),
      answerSelection: safeJson(window.answerSelection),
      vPreviousTimeSpent: typeof window.vPreviousTimeSpent === 'number' ? window.vPreviousTimeSpent : null,
      vPassageName: window.vPassageName || null,
      vPublishingKey: window.vPublishingKey || null,
      correctKey, // CSV string from <input name="Key1">; "4" for MC, "2,2,1" for matrix
      stem: text('.ITSStemText') || text('.stem-container-inner') || text('.stem-block-inner'),
      passage: text('.passage-block-inner') || text('.passage-block'),
      keyPoint: text('.sol-key-point-content'),
      rationale: text('.ItemRationaleText'),
      yourScoreText: text('.sol-your-score-container'),
      choicesType,
      choices,
    };
  });
}

// Click the Next button inside the ITDStart harness frame to advance to the
// next review item, then wait for the ITDReview frame's globals to flip to the
// new item. Returns the new ITDReview Frame handle.
//
// Why this approach: the ReviewItems outer page only exposes data_reviewitems
// (an item-list AJAX URL) — it does NOT expose data_reviewtable (the URLs
// needed to build a fresh ReviewItems&seq=N navigation). So instead of doing
// 20 outer-page navigations, we do ONE outer nav + 19 in-harness Next clicks.
// processAction(buttonId) is the exact handler the visible Next button fires.
async function clickNextAndWait(page, prevItemName, { timeoutMs = 25000 } = {}) {
  const startFrame = page.frames().find((f) => /ITDStart\.aspx/i.test(f.url()));
  if (!startFrame) {
    throw new ScrapeAnomalyError('ITDStart harness frame not found; cannot click Next.');
  }

  const clickResult = await startFrame.evaluate(() => {
    const btn =
      document.getElementById('Next') ||
      document.getElementById('NextTop') ||
      Array.from(document.querySelectorAll('button')).find(
        (b) => /^\s*Next\s*$/i.test(b.innerText || '') && !b.disabled
      );
    if (!btn) return { ok: false, reason: 'no-next-button-in-harness' };
    if (typeof window.processAction !== 'function') return { ok: false, reason: 'no-processAction-fn' };
    try {
      window.processAction(btn.id || 'Next');
      return { ok: true, btnId: btn.id || null };
    } catch (e) {
      return { ok: false, reason: `processAction-threw: ${e?.message || String(e)}` };
    }
  }).catch((e) => ({ ok: false, reason: `evaluate-threw: ${e?.message || String(e)}` }));

  if (!clickResult.ok) {
    throw new ScrapeAnomalyError(`Failed to click Next: ${clickResult.reason}`);
  }

  // Poll for the new ITDReview frame to be ready: vItemName flipped + globals
  // populated + at least one choice element in the DOM (matches the same
  // readiness criteria used at initial load to avoid empty-choices reads).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reviewFrame = page.frames().find((f) => /ITDReview\.aspx/i.test(f.url()));
    if (reviewFrame) {
      try {
        const ready = await reviewFrame.evaluate((prev) => {
          if (typeof window.vItemName === 'undefined') return false;
          if (prev && window.vItemName === prev) return false;
          if (!Array.isArray(window.vItemInformation) || window.vItemInformation.length < 2) return false;
          const hasRadios = document.querySelectorAll('input[type="radio"][name^="I"]').length > 0;
          const hasMatrix = !!document.querySelector('table.ITSMatrixTable');
          const hasOptions = !!document.querySelector('.options-container input, .options-container-inner input');
          // Graphics Interpretation / fill-blank items use <select> dropdowns.
          // Filter out chrome selects that exist on Report/QHistory pages.
          const hasDropdown = Array.from(document.querySelectorAll('select')).some((s) =>
            !['sessionlist', 'difficulty', 'confidence', 'attributes', 'blueprintlist'].includes(s.id)
          );
          return hasRadios || hasMatrix || hasOptions || hasDropdown;
        }, prevItemName);
        if (ready) return reviewFrame;
      } catch (_e) { /* frame may detach mid-transition; retry */ }
    }
    await sleep(300);
  }
  throw new ScrapeAnomalyError(
    `Next click did not produce a new item within ${timeoutMs}ms (was on itemname=${prevItemName}).`
  );
}

// Best-effort: navigate the tab back to HomePage at the end of a Phase 2 run.
// Skips its own pre-flight checks because we may be on an error or partially-
// loaded page after an anomaly — the goal is to leave the tab in a usable
// state, not to assert correctness. Any failure is silently swallowed; the
// worst case is the user reloads manually.
async function cleanupReturnToHome(page) {
  try {
    const homeUrl = await page.evaluate(() => {
      // Try to mine a fresh code from the embedded data_reviewtable script first
      // (server-rendered, available even if the JS variable wasn't initialized).
      let code = null;
      const el = document.getElementById('data_reviewtable');
      if (el && el.textContent) {
        try {
          const parsed = JSON.parse(el.textContent);
          const m = String(parsed?.showreviewurl || '').match(/code=([^&]+)/);
          if (m) code = decodeURIComponent(m[1]);
        } catch (_e) { /* fall through */ }
      }
      // Fall back to the code in the current URL (may be stale, but try).
      if (!code) {
        try { code = new URL(location.href).searchParams.get('code'); } catch (_e) { /* ignore */ }
      }
      const u = new URL(location.href);
      const out = new URL(u.origin + u.pathname);
      const programid = u.searchParams.get('programid') || '314';
      const session = u.searchParams.get('session') || '';
      out.searchParams.set('programid', programid);
      if (session) out.searchParams.set('session', session);
      if (code) out.searchParams.set('code', code);
      out.searchParams.set('cmd', 'HomePage');
      return out.toString();
    });
    if (homeUrl) {
      await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
    }
  } catch (_e) {
    // Silent fail — leaving the tab as-is is acceptable; user can reload.
  }
}

// Robust read of the `reviewitems` base URL from the current page. Tries the JS
// variable first (set by PracticeNow scripts after page load), then falls back
// to parsing the embedded `<script id="data_reviewtable">` JSON blob. Polls
// because the JS variable initialization can race with iframe load completion.
// Returns null if neither is available after the budget; on null, captures
// diagnostic info on the page object for the caller to surface in errors.
async function readReviewitemsBase(page, { attempts = 12, delayMs = 400 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const result = await page.evaluate(() => {
      // Path 1: the global JS variable, set by PracticeNow scripts.
      try {
        if (typeof jsondata_reviewtable !== 'undefined' && jsondata_reviewtable?.reviewitems) {
          return jsondata_reviewtable.reviewitems;
        }
      } catch (_e) { /* ReferenceError if not defined yet */ }
      // Path 2: the embedded <script type="application/json"> blob — present as
      // soon as the DOM is parsed, doesn't depend on script execution timing.
      const el = document.getElementById('data_reviewtable');
      if (el && el.textContent) {
        try {
          const parsed = JSON.parse(el.textContent);
          return parsed?.reviewitems || null;
        } catch { return null; }
      }
      return null;
    }).catch(() => null);
    if (result) return result;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return null;
}

// Capture diagnostics about the page state for debugging Phase 2 stalls.
async function snapshotPageState(page) {
  return page.evaluate(() => ({
    url: location.href.slice(0, 200),
    title: document.title,
    readyState: document.readyState,
    scriptIds: Array.from(document.querySelectorAll('script[id]')).map((s) => s.id),
    hasJsondataReviewtable: typeof jsondata_reviewtable !== 'undefined',
    hasDataReviewtableScript: !!document.getElementById('data_reviewtable'),
    hasExamIframe: !!document.getElementById('ExamIframe'),
    examIframeSrc: (document.getElementById('ExamIframe')?.src || '').slice(0, 200),
    bodyTextSample: (document.body?.innerText || '').slice(0, 250).replace(/\s+/g, ' '),
  })).catch((e) => ({ err: e.message }));
}

// runPhase2 for a SINGLE session.
//
// options:
//   sourceId      — preset id; we'll verify the tab's product matches this preset.
//   sid           — practice session id.
//   totalQ        — total answered count (informs the ct= query param).
//   minDelayMs/maxDelayMs — pacing between item iframe loads (default 3000–6000).
//   onProgress    — callback(evt: { event, sid, seq, total, itemName, ... }).
async function runPhase2({ page, options = {} }) {
  const sourceId = String(options.sourceId || '').trim();
  const preset = SOURCE_PRODUCTS[sourceId];
  if (!preset) {
    throw new ScrapeAnomalyError(`Unknown sourceId "${sourceId}".`);
  }
  const sid = String(options.sid || '').trim();
  if (!sid) throw new ScrapeAnomalyError('Phase 2 requires sid.');
  const totalQ = Number(options.totalQ) || 0;
  const minDelay = Number.isFinite(Number(options.minDelayMs)) ? Number(options.minDelayMs) : 3000;
  const maxDelay = Number.isFinite(Number(options.maxDelayMs)) ? Number(options.maxDelayMs) : 6000;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  if (!STARTTEST_HOST_RE.test(page.url())) {
    throw new ScrapeAnomalyError(`Tab is not on starttest.com.`);
  }
  const curUrl = (() => { try { return new URL(page.url()); } catch { return null; } })();
  if (!curUrl?.searchParams.get('session')) {
    throw new ScrapeAnomalyError(`Tab URL has no StartTest session token.`);
  }

  // Verify product (same trust-the-tab pattern as Phase 1).
  const pageState = await page.evaluate(() => ({
    hasTable: !!document.querySelector('table.PracticeSessionsTable-tbl'),
    productHeading: (document.querySelector('#PgHdngPracticeDash')?.innerText || '').trim(),
  }));
  if (!pageState.hasTable) {
    throw new ScrapeAnomalyError(
      `Tab is not on the Practice Sessions home page. Open the product home first, then retry.`
    );
  }
  if (preset.productName) {
    const actual = normalizeProductHeading(pageState.productHeading);
    const expected = normalizeProductHeading(preset.productName);
    if (actual !== expected) {
      throw new ScrapeAnomalyError(
        `Tab heading "${pageState.productHeading}" doesn't match preset "${preset.productName}". Switch products first.`
      );
    }
  }

  // From Home, find this session's report link (fresh code).
  const reportUrl = await page.evaluate((id) => {
    const tr = document.querySelector(
      `table.PracticeSessionsTable-tbl tbody tr#${CSS.escape(String(id))}`
    );
    return tr?.querySelector(
      'a[href*="NavigateToDiagnosticReport"]:not([href*="widgetview"])'
    )?.href || null;
  }, sid);
  if (!reportUrl) {
    throw new ScrapeAnomalyError(`sid=${sid} not found on Home (may have been reset).`);
  }
  await goto(page, reportUrl);
  const reportInfo = await readReport(page);
  if (!reportInfo.jsondata_reviewtable?.getqhistoryurl) {
    throw new ScrapeAnomalyError(`Report for sid=${sid} did not expose jsondata_reviewtable.`);
  }
  const labelIndex = new Map(reportInfo.labelIndexEntries);

  // QHistory to learn how many items we have and pick up the first Review URL.
  const qhUrlRel = buildQHistoryUrl(reportInfo.jsondata_reviewtable.getqhistoryurl, sid, totalQ);
  const qhUrl = await resolvePageRelative(page, qhUrlRel);
  await goto(page, qhUrl);
  const qhRows = await readQHistoryRows(page);
  if (!qhRows.length) {
    return { sid, items: [], skipped: [], errors: [], qhTotal: 0 };
  }
  const firstReviewAbs = qhRows[0].reviewUrlRel
    ? await resolvePageRelative(page, qhRows[0].reviewUrlRel)
    : null;
  if (!firstReviewAbs) throw new ScrapeAnomalyError(`First QHistory row has no review URL.`);

  // Bootstrap the ReviewItems shell. We try the GetPracticeNowReviewItems
  // AJAX to get authoritative ItemName/FormQuestionID for each item, but if it
  // returns the (intermittent) Data:"ERROR" payload, we fall back to iterating
  // by seq alone — vItemName from each loaded ITDReview frame still gives us
  // the stable id, just without the FormQuestionID. Anomaly errors from the
  // navigation itself still throw and abort.
  let items;
  let ajaxAvailable = false;
  try {
    const ajaxResult = await fetchReviewItemNames(page, firstReviewAbs);
    if (ajaxResult.items) {
      items = ajaxResult.items;
      ajaxAvailable = true;
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[starttest] sid=${sid}: GetPracticeNowReviewItems unavailable (${ajaxResult.reason}); ` +
        `falling back to seq-based Phase 2 iteration. q_code will be null for these rows.`
      );
    }
  } catch (e) {
    // ScrapeAnomalyError from goto MUST propagate — that's a bot-signal.
    if (e instanceof ScrapeAnomalyError) throw e;
    // eslint-disable-next-line no-console
    console.warn(`[starttest] sid=${sid}: AJAX threw non-anomaly error (${e.message}); falling back.`);
  }
  if (!items) {
    // Fallback: synthesize one stub per QHistory row. ItemName remains null
    // until we read it from the frame after navigation.
    items = qhRows.map(() => ({
      ItemName: null, FormQuestionID: null, ValidationGuid: null, ResultID: null,
    }));
  }
  const total = items.length;

  if (onProgress) onProgress({ event: 'session_start', sid, total });

  const enriched = [];
  const errors = [];
  let aborted = false;
  let abortReason = null;
  let prevItemName = null; // tracks the last successfully-read vItemName

  for (let seq = 0; seq < total; seq += 1) {
    const itemMeta = items[seq];
    const expectedName = itemMeta?.ItemName || null;

    // Acquire the current item's ITDReview frame.
    //   seq=0: already loaded by the bootstrap navigation.
    //   seq>0: click Next inside the ITDStart harness; wait for vItemName to flip.
    let frame;
    try {
      if (seq === 0) {
        frame = await waitForReviewFrame(page, expectedName, 25000);
      } else {
        frame = await clickNextAndWait(page, prevItemName, { timeoutMs: 25000 });
      }
      // Dropdown items have an extra async step: restoring the user's saved
      // answer to <select> values. Wait briefly so we don't capture defaults.
      const isDropdown = await frame.evaluate(() => {
        const selects = Array.from(document.querySelectorAll('select')).filter(
          (s) => !['sessionlist', 'difficulty', 'confidence', 'attributes', 'blueprintlist'].includes(s.id)
        );
        return selects.length > 0 && !document.querySelector('table.ITSMatrixTable');
      }).catch(() => false);
      if (isDropdown) await waitForDropdownsRestored(frame);
    } catch (e) {
      errors.push({ seq, itemName: expectedName, message: e.message });
      if (e instanceof ScrapeAnomalyError) {
        aborted = true;
        abortReason = e.message;
        break;
      }
      continue;
    }

    let frameData = null;
    try {
      frameData = await readReviewFrame(frame);
    } catch (e) {
      errors.push({ seq, itemName: expectedName, message: `read failed: ${e.message}` });
      if (e instanceof ScrapeAnomalyError) {
        aborted = true;
        abortReason = e.message;
        break;
      }
    }

    if (frameData) {
      enriched.push({
        seq,
        itemMeta, // {FormQuestionID, ValidationGuid, ItemName, ResultID}
        ...frameData,
      });
      prevItemName = frameData.vItemName || expectedName || prevItemName;
      if (onProgress) onProgress({
        event: 'item_done',
        sid, seq, total,
        itemName: prevItemName,
      });
    }

    // Pacing: jittered delay between Next clicks, but skip after the last one.
    if (seq < total - 1) await sleep(jitter(minDelay, maxDelay));
  }

  if (onProgress) onProgress({
    event: 'session_done', sid,
    enriched: enriched.length,
    errors: errors.length,
    aborted,
    abortReason,
  });

  // Cleanup: leave the user's tab on Home regardless of outcome. Best-effort —
  // failure here doesn't affect the returned data.
  await cleanupReturnToHome(page);

  return {
    sid,
    productLabel: preset.label,
    qhRows,
    labelIndexEntries: reportInfo.labelIndexEntries,
    items: enriched,
    errors,
    qhTotal: total,
    aborted,
    abortReason,
  };
}

module.exports = {
  SOURCE_PRODUCTS,
  ScrapeAnomalyError,
  runPhase1,
  runPhase2,
  normalizeProductHeading,
  // Exposed for direct testing + for Phase 2 module to reuse navigation helpers.
  _internals: {
    goto,
    navigateHome,
    navigateToProduct,
    listSessionsOnHome,
    readReport,
    readQHistoryRows,
    fetchReviewItemList,
    buildQHistoryUrl,
    parseTimeSpent,
    parseDateMDY,
    parsePctCorrect,
    mapSubjectCode,
    mapCategoryCode,
    subjectFromItemName,
    sleep,
    jitter,
    assertNotErrorPage,
    absolutize,
    resolvePageRelative,
  },
};
