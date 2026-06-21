// src/scrapers/gmat_club_cat_scraper.js
// GMAT Club CAT (GMAT Focus full-length practice tests) scraper — Phase 1.
// Node-side, multi-navigation (mirrors ttp_scraper.js). Called with an
// already-navigated Playwright `page` connected to the user's logged-in Chrome
// via CDP. Walks My Tests -> score report -> results grid and emits one session
// per completed test. Phase 2 enrichment lives in gmat_club_cat_question_scraper.js.
//
// DOM contract (verified 2026-06-21) — see
// docs/superpowers/specs/2026-06-21-gmatclub-cat-scraper-design.md.

'use strict';

/* global document, location */ // browser globals referenced inside page.evaluate() callbacks

const GMATCLUB_HOST_RE = /gmatclub\.com/i;
const TESTS_URL = 'https://gmatclub.com/gmat-focus-tests/?page=tests';

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

class ScrapeAnomalyError extends Error {
  constructor(message, { url, snippet } = {}) {
    super(message);
    this.name = 'ScrapeAnomalyError';
    this.url = url || null;
    this.snippet = snippet || null;
  }
}

function jitter(minMs, maxMs) {
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || lo);
  return Math.round(lo + Math.random() * (hi - lo));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms | 0))); }

function mapSectionToSubject(section) {
  const s = String(section || '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('quant')) return 'Q';
  if (s.startsWith('verbal')) return 'V';
  if (s.startsWith('data insight') || s === 'di') return 'DI';
  return null;
}

function parseTypeCell(text) {
  // Type cell shape: "Section / Code / Topic" delimited by " / ". The TOPIC
  // frequently contains the same delimiter ("Distance / Rate Problems",
  // "Fractions / Ratios / Decimals", "Work / Rate problems") and sometimes an
  // unspaced slash ("Properties of Sets/Statistics"). So split ONLY on the
  // spaced delimiter and rejoin everything after the code back into the topic —
  // section/code are always single slash-free tokens, so parts[0]/parts[1] are
  // safe and the remainder reconstructs the full topic losslessly.
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { subjectCode: null, categoryCode: null, topic: null };
  const parts = raw.split(/\s+\/\s+/);
  const subjectCode = mapSectionToSubject(parts[0]);
  const categoryCode = parts[1] ? parts[1].toUpperCase() : null;
  const topic = parts.length > 2 ? parts.slice(2).join(' / ') : null;
  return { subjectCode, categoryCode, topic };
}

function parseTimeSec(raw) {
  if (!raw) return null;
  const parts = String(raw).trim().split(':').map((x) => parseInt(x, 10));
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function parseGridTimestamp(raw) {
  // "Jun 21, 2026 12:05 AM" -> { dateKey:'2026-06-21', iso }
  const m = String(raw || '').match(/([A-Za-z]{3,})\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return { dateKey: null, iso: null };
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (month === undefined || !Number.isFinite(day) || !Number.isFinite(year)) return { dateKey: null, iso: null };
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return { dateKey: `${year}-${mm}-${dd}`, iso: new Date(year, month, day).toISOString() };
}

function firstIntInRange(str, lo, hi) {
  const nums = String(str || '').match(/\d+(?:\.\d+)?/g) || [];
  for (const n of nums) {
    const v = Math.round(parseFloat(n));
    if (v >= lo && v <= hi) return v;
  }
  return null;
}

function parseScoreReport(rows) {
  // rows: array of [sectionLabel, percentileText, valuesText]. The valuesText is
  // "min mean score max" (e.g. "205 554.67 565 805" or "60 78.06 81 90").
  const out = { total: { score: null, percentile: null }, quant: { score: null, percentile: null },
    verbal: { score: null, percentile: null }, di: { score: null, percentile: null } };
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const label = String(row?.[0] || '').toLowerCase();
    const pctText = String(row?.[1] || '');
    const valsText = String(row?.[2] || '');
    const percentile = firstIntInRange(pctText.match(/\d+/)?.[0] || pctText, 0, 100);
    let bucket = null; let lo; let hi;
    if (/total/.test(label)) { bucket = 'total'; lo = 205; hi = 805; }
    else if (/quant/.test(label)) { bucket = 'quant'; lo = 60; hi = 90; }
    else if (/verbal/.test(label)) { bucket = 'verbal'; lo = 60; hi = 90; }
    else if (/data insight/.test(label)) { bucket = 'di'; lo = 60; hi = 90; }
    if (!bucket) continue;
    // Values text is "min mean score max" where mean is the only float.
    // Keep only pure-integer tokens; the score is the middle one (ints[1]).
    const ints = (valsText.match(/\d+(?:\.\d+)?/g) || [])
      .filter((t) => /^\d+$/.test(t))
      .map(Number);
    let score;
    if (ints.length === 3) {
      score = ints[1];
    } else {
      const inRange = ints.filter((n) => n >= lo && n <= hi);
      score = inRange.length ? inRange[inRange.length - 1] : null;
    }
    out[bucket] = { score, percentile };
  }
  return out;
}

function parseSinceDateKey(since) {
  const s = String(since || '');
  if (s.length < 8) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function buildSession({ testId, source, scoreSummary, gridRows }) {
  const rows = Array.isArray(gridRows) ? gridRows : [];
  const questions = rows.map((r) => {
    const t = parseTypeCell(r.typeText);
    return {
      q_id: r.instanceId ? `gcc-att-${r.instanceId}` : null,
      q_code: r.qcode ? `gcc-q-${r.qcode}` : null,
      cat_id: null,
      correct: !!r.correct,
      difficulty: r.difficulty || null,
      confidence: null,
      time_sec: parseTimeSec(r.timeRaw),
      my_answer: null,
      correct_answer: null,
      topic: t.topic,
      subcategory: t.topic,
      topic_source: 'gmatclub-canonical',
      question_url: r.viewUrl || null,
      question_stem: null,
      answer_choices: null,
      subject_sub: null,
      subject_sub_raw: t.categoryCode,
      subject_code: t.subjectCode,
      content_domain: null,
      response_format: null,
      response_details: null,
      notes: null,
      mistake_type: null,
    };
  });

  const dateKeys = rows.map((r) => parseGridTimestamp(r.dateRaw).dateKey).filter(Boolean).sort();
  const dateKey = dateKeys.length ? dateKeys[0] : null;

  const correctCount = questions.filter((q) => q.correct).length;
  const errorCount = questions.length - correctCount;
  const times = questions.map((q) => q.time_sec).filter((t) => t !== null);
  const correctTimes = questions.filter((q) => q.correct).map((q) => q.time_sec).filter((t) => t !== null);
  const errorTimes = questions.filter((q) => !q.correct).map((q) => q.time_sec).filter((t) => t !== null);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

  return {
    session_id: parseInt(testId, 10) || testId,
    date: dateKey,
    source,
    subject: 'Mixed',
    review_category_id: null,
    scoreSummary,
    stats: {
      total_q_api: questions.length,
      total_q_categories: questions.length,
      correct: correctCount,
      errors: errorCount,
      accuracy_pct: questions.length ? Math.round((correctCount / questions.length) * 1000) / 10 : 0,
      avg_time_sec: avg(times),
      avg_correct_time_sec: avg(correctTimes),
      avg_incorrect_time_sec: avg(errorTimes),
    },
    questions,
    wrong_q_ids: questions.filter((q) => !q.correct).map((q) => ({ q_id: q.q_id, cat_id: null })),
  };
}

// Reads the My Tests table. Returns [{ testId, name, status, resultsUrl, reportUrl }].
async function extractTestList(page) {
  return page.evaluate(() => {
    const out = [];
    const tbl = document.querySelector('table.w-full') || document.querySelector('table');
    if (!tbl) return out;
    for (const tr of Array.from(tbl.querySelectorAll('tr'))) {
      const reportA = tr.querySelector('a[href*="report?id="]');
      const resultsA = tr.querySelector('a[href*="results-"]');
      if (!reportA && !resultsA) continue;
      const href = (reportA || resultsA).getAttribute('href') || '';
      const idm = href.match(/(?:report\?id=|results-)(\d+)/);
      if (!idm) continue;
      const text = (tr.textContent || '').replace(/\s+/g, ' ').trim();
      out.push({
        testId: idm[1],
        name: text.slice(0, 120),
        status: /completed/i.test(text) ? 'Completed' : (/in progress|continue/i.test(text) ? 'InProgress' : 'Unknown'),
        resultsUrl: resultsA ? new URL(resultsA.getAttribute('href'), location.href).href
          : `https://gmatclub.com/gmat-focus-tests/results-${idm[1]}.html`,
        reportUrl: `https://gmatclub.com/gmat-focus-tests/report?id=${idm[1]}`,
      });
    }
    // De-dupe by testId (each row carries multiple links).
    const seen = new Set();
    return out.filter((t) => (seen.has(t.testId) ? false : (seen.add(t.testId), true)));
  });
}

// Reads the score-report tables. Returns { rows, testDate } where rows feed parseScoreReport.
async function extractScoreReportRows(page) {
  return page.evaluate(() => {
    const pickTable = () => document.querySelector('table.chart-table')
      || Array.from(document.querySelectorAll('table')).find((t) => /total score|quantitative reasoning/i.test(t.textContent || ''));
    const tbl = pickTable();
    const rows = [];
    if (tbl) {
      for (const tr of Array.from(tbl.querySelectorAll('tr'))) {
        const cells = Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim());
        if (cells.length >= 3 && /total score|quantitative reasoning|verbal reasoning|data insights/i.test(cells[0])) {
          rows.push(cells);
        }
      }
    }
    const dm = (document.body.innerText || '').match(/Test Date:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    const testDate = dm ? `${dm[3]}-${String(dm[1]).padStart(2, '0')}-${String(dm[2]).padStart(2, '0')}` : null;
    return { rows, testDate };
  });
}

// Reads ALL grid rows from a results page (the AJAX fragment renders the full set).
async function extractGridRows(page) {
  return page.evaluate(() => {
    const tbl = document.querySelector('table.items');
    if (!tbl) return [];
    const out = [];
    for (const tr of Array.from(tbl.querySelectorAll('tr'))) {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (tds.length < 10) continue;
      const num = parseInt((tds[0].textContent || '').trim(), 10);
      if (!Number.isFinite(num)) continue;
      const a = tds[1].querySelector('a[href*="view-"]');
      const href = a ? a.getAttribute('href') : '';
      const idm = href.match(/view-(\d+)\.html/);
      out.push({
        num,
        qcode: a ? (a.textContent || '').replace(/\s+/g, ' ').trim() : null,
        instanceId: idm ? idm[1] : null,
        viewUrl: href ? new URL(href, location.href).href : null,
        typeText: (tds[2].textContent || '').replace(/\s+/g, ' ').trim(),
        correct: !!tds[3].querySelector('.qCorrectIcon'),
        difficulty: (tds[4].querySelector('.qDiff')?.textContent || tds[4].textContent || '').replace(/\s+/g, ' ').trim() || null,
        timeRaw: (tds[8].textContent || '').replace(/\s+/g, ' ').trim(),
        dateRaw: (tds[9].textContent || '').replace(/\s+/g, ' ').trim(),
      });
    }
    return out;
  });
}

function gridFragmentUrl(testId) {
  const p = 'TestAnswerExtendedVersion';
  return `https://gmatclub.com/gmat-focus-tests/results-${testId}.html`
    + `?${p}%5Bquestion_type%5D=&${p}%5Bis_correct%5D=&${p}%5Bquestion_weight%5D=`
    + `&${p}%5Btime%5D=&page=2&true=questionListGrid&sort=date.desc#questionsTable`;
}

async function runScrape({ page, options = {} }) {
  const source = options.source || 'GMAT Club CAT';
  const sinceKey = parseSinceDateKey(options.since);
  const minDelayMs = Number.isFinite(Number(options.minDelayMs)) ? Number(options.minDelayMs) : 1500;
  const maxDelayMs = Number.isFinite(Number(options.maxDelayMs)) ? Number(options.maxDelayMs) : 3000;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const warnings = [];

  await page.goto(TESTS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('table', { timeout: 15000 }).catch(() => null);
  const tests = (await extractTestList(page)).filter((t) => t.status === 'Completed');
  onProgress({ kind: 'test-list', total: tests.length });

  const sessions = [];
  let errorCount = 0;
  const maxErrors = Math.max(2, Math.ceil(tests.length / 4));

  for (let i = 0; i < tests.length; i += 1) {
    const t = tests[i];
    try {
      await sleep(jitter(minDelayMs, maxDelayMs));
      await page.goto(t.reportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('table', { timeout: 15000 }).catch(() => null);
      const { rows, testDate } = await extractScoreReportRows(page);
      const scoreSummary = parseScoreReport(rows);

      if (sinceKey && testDate && testDate < sinceKey) {
        onProgress({ kind: 'skip-since', testId: t.testId, testDate });
        continue;
      }

      await sleep(jitter(minDelayMs, maxDelayMs));
      await page.goto(gridFragmentUrl(t.testId), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('table.items', { timeout: 15000 }).catch(() => null);
      const gridRows = await extractGridRows(page);
      if (!gridRows.length) { warnings.push({ testId: t.testId, reason: 'empty-grid' }); }

      const session = buildSession({ testId: t.testId, source, scoreSummary, gridRows });
      if (testDate && !session.date) session.date = testDate;
      sessions.push(session);
      onProgress({ kind: 'test-done', testId: t.testId, questions: gridRows.length, score: scoreSummary.total.score });
    } catch (err) {
      errorCount += 1;
      warnings.push({ testId: t.testId, reason: err.message });
      onProgress({ kind: 'test-error', testId: t.testId, reason: err.message });
      if (errorCount > maxErrors) {
        throw new ScrapeAnomalyError(`Too many test errors (${errorCount}/${tests.length}); aborting.`, { url: page.url() });
      }
    }
  }

  return {
    extracted_at: new Date().toISOString(),
    config: { since: options.since, source, sinceTimezone: 'Asia/Bangkok' },
    sessions,
    warnings,
  };
}

module.exports = {
  ScrapeAnomalyError,
  GMATCLUB_HOST_RE,
  TESTS_URL,
  runScrape,
  _internals: {
    parseTypeCell, mapSectionToSubject, parseTimeSec, parseGridTimestamp,
    parseScoreReport, parseSinceDateKey, firstIntInRange, jitter, sleep,
    buildSession, extractTestList, extractScoreReportRows, extractGridRows, gridFragmentUrl,
  },
};
