# GMAT Club CAT Practice Test Scraper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the GMAT Club CAT (GMAT Focus full-length practice tests at `gmatclub.com/gmat-focus-tests/`) as a new two-phase scrape source.

**Architecture:** Mirror the TTP / Error-Log two-phase pattern. Phase 1 is a Node-side multi-navigation scraper (`gmat_club_cat_scraper.js`) that walks My Tests → score report → results grid and emits one session per completed test (with `scoreSummary` + per-question grid), persisted via the existing `saveScrapeResult`. Phase 2 (opt-in per session) is a browser-injected enrichment (`gmat_club_cat_question_scraper.js`) that visits each `view-{id}.html` for stem/choices/correct/pick/explanation, written by a new `enrichGmatClubCatSessionAttempts`.

**Tech Stack:** Node.js (CommonJS), Playwright over CDP (`connectOverCDP`), PostgreSQL via raw SQL (`pg.Pool`), React/Vite frontend, `node:test` unit tests, ESLint 9 flat config.

## Global Constraints

- **Source label:** `GMAT Club CAT`. **Platform key:** `gmatclub-cat`. **Preset id:** `gmat-club-cat`.
- **Never call `browser.close()`** — the runner attaches to the user's logged-in Chrome via CDP; closing tears down their tabs. Cleanup is best-effort (`page.off(...)` in `finally`).
- **q_id / q_code prefixes:** per-attempt id `gcc-att-${instanceId}` (the `view-` numeric id); per-question id `gcc-q-${qcode}` (e.g. `gcc-q-M27-16`).
- **Phase 1 reuses `saveScrapeResult`** unchanged — no new Phase 1 DB writer.
- **`topic_source = 'gmatclub-canonical'`** on every question so the LLM classifier is skipped; `subject_sub_raw` carries the category code (`PS/DS/CR/RC/TPA/MSR/TA/GI`).
- **Human-like jitter** 1500–3000 ms between navigations; abort guard so partial writes still land.
- **Thai timezone (Asia/Bangkok)**; `since` is `YYYYMMDDHHmmss`, compared at **day** granularity.
- **Answer-choice storage:** flat JSON array `{label, text, isCorrect, isUserSelected}` (per-choice flags drive the review-modal color coding).
- **ESLint:** `gmat_club_cat_scraper.js` is a Playwright host file (Node + embeds `page.evaluate` browser callbacks) → needs node+browser globals; `gmat_club_cat_question_scraper.js` is page-injected → `sourceType: 'script'` + browser globals. Both live under `src/scrapers/` (covered by existing `src/**` globs). **`eslint.config.mjs` is edit-protected** — do not edit it; if a new glob entry is genuinely required, use a file-local `/* global ... */` directive instead. Run `npm run lint` and confirm **0 new errors**.

---

### Task 1: Phase 1 pure parsers + unit tests

The deterministic, page-free logic: parse the Type cell, map sections, parse the score report rows, parse one grid row, parse times/timestamps. TDD these in isolation; the orchestration (Task 2) calls them inside `page.evaluate`/Node.

**Files:**
- Create: `src/scrapers/gmat_club_cat_scraper.js` (parsers + `_internals` export only for now)
- Test: `test/unit/gmatclub-cat-parse.test.js`

**Interfaces:**
- Produces (all on `module.exports._internals`):
  - `parseTypeCell(text: string) -> { subjectCode: 'Q'|'V'|'DI'|null, categoryCode: string|null, topic: string|null }`
  - `mapSectionToSubject(section: string) -> 'Q'|'V'|'DI'|null`
  - `parseTimeSec(raw: string) -> number|null`
  - `parseGridTimestamp(raw: string) -> { dateKey: string|null, iso: string|null }` (dateKey = `YYYY-MM-DD`)
  - `parseScoreReport(rows: string[][]) -> { total, quant, verbal, di }` where each is `{ score: number|null, percentile: number|null }`
  - `parseSinceDateKey(since: string) -> string` (`YYYY-MM-DD` or `''`)

- [ ] **Step 1: Write the failing test**

```js
// test/unit/gmatclub-cat-parse.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseTypeCell, mapSectionToSubject, parseTimeSec, parseGridTimestamp,
  parseScoreReport, parseSinceDateKey,
} = require('../../src/scrapers/gmat_club_cat_scraper')._internals;

test('parseTypeCell splits Section / Code / Topic', () => {
  assert.deepEqual(parseTypeCell('Data Insights / TPA / Two-Part Analysis'),
    { subjectCode: 'DI', categoryCode: 'TPA', topic: 'Two-Part Analysis' });
  assert.deepEqual(parseTypeCell('Quant / PS / Algebra'),
    { subjectCode: 'Q', categoryCode: 'PS', topic: 'Algebra' });
  assert.deepEqual(parseTypeCell('Verbal / CR / Strengthen'),
    { subjectCode: 'V', categoryCode: 'CR', topic: 'Strengthen' });
  assert.deepEqual(parseTypeCell('Data Insights / DS / Word problems'),
    { subjectCode: 'DI', categoryCode: 'DS', topic: 'Word problems' });
});

test('parseTypeCell tolerates missing topic / blank', () => {
  assert.deepEqual(parseTypeCell('Quant / PS'),
    { subjectCode: 'Q', categoryCode: 'PS', topic: null });
  assert.deepEqual(parseTypeCell(''),
    { subjectCode: null, categoryCode: null, topic: null });
});

test('mapSectionToSubject', () => {
  assert.equal(mapSectionToSubject('Quant'), 'Q');
  assert.equal(mapSectionToSubject('Quantitative Reasoning'), 'Q');
  assert.equal(mapSectionToSubject('Verbal'), 'V');
  assert.equal(mapSectionToSubject('Data Insights'), 'DI');
  assert.equal(mapSectionToSubject('nonsense'), null);
});

test('parseTimeSec mm:ss and h:mm:ss', () => {
  assert.equal(parseTimeSec('2:15'), 135);
  assert.equal(parseTimeSec('0:45'), 45);
  assert.equal(parseTimeSec('1:02:03'), 3723);
  assert.equal(parseTimeSec(''), null);
});

test('parseGridTimestamp', () => {
  assert.deepEqual(parseGridTimestamp('Jun 21, 2026 12:05 AM').dateKey, '2026-06-21');
  assert.equal(parseGridTimestamp('garbage').dateKey, null);
});

test('parseScoreReport extracts section scores + percentiles', () => {
  const rows = [
    ['Total Score', '51st', '205 554.67 565 805'],
    ['Quantitative Reasoning', '70th', '60 78.06 81 90'],
    ['Verbal Reasoning', '47th', '60 79.34 79 90'],
    ['Data Insights', '41st', '60 75.03 74 90'],
  ];
  const got = parseScoreReport(rows);
  assert.deepEqual(got.total, { score: 565, percentile: 51 });
  assert.deepEqual(got.quant, { score: 81, percentile: 70 });
  assert.deepEqual(got.verbal, { score: 79, percentile: 47 });
  assert.deepEqual(got.di, { score: 74, percentile: 41 });
});

test('parseSinceDateKey', () => {
  assert.equal(parseSinceDateKey('20250101000000'), '2025-01-01');
  assert.equal(parseSinceDateKey(''), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/gmatclub-cat-parse.test.js`
Expected: FAIL — `Cannot find module '../../src/scrapers/gmat_club_cat_scraper'`.

- [ ] **Step 3: Write minimal implementation**

```js
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
  const parts = String(text || '').split('/').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!parts.length) return { subjectCode: null, categoryCode: null, topic: null };
  const subjectCode = mapSectionToSubject(parts[0]);
  const categoryCode = parts[1] ? parts[1].toUpperCase() : null;
  const topic = parts[2] || null;
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
    // The score is the last in-range integer that is NOT the min/max bound.
    const nums = (valsText.match(/\d+(?:\.\d+)?/g) || []).map((n) => parseFloat(n));
    const candidates = nums.filter((n) => Number.isInteger(n) && n >= lo && n <= hi && n !== lo && n !== hi);
    out[bucket] = { score: candidates.length ? candidates[candidates.length - 1] : firstIntInRange(valsText, lo, hi), percentile };
  }
  return out;
}

function parseSinceDateKey(since) {
  const s = String(since || '');
  if (s.length < 8) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

module.exports = {
  ScrapeAnomalyError,
  GMATCLUB_HOST_RE,
  TESTS_URL,
  _internals: {
    parseTypeCell, mapSectionToSubject, parseTimeSec, parseGridTimestamp,
    parseScoreReport, parseSinceDateKey, firstIntInRange, jitter, sleep,
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/gmatclub-cat-parse.test.js`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add src/scrapers/gmat_club_cat_scraper.js test/unit/gmatclub-cat-parse.test.js
git commit -m "feat(gmatclub-cat): Phase 1 pure parsers + unit tests"
```
Expected lint: 0 new errors.

---

### Task 2: Phase 1 orchestration (`runScrape`)

Add the page-driving `runScrape` that enumerates completed tests, visits each test's score report + grid, and builds sessions. Extraction inside `page.evaluate` returns raw arrays; the Node side maps them through Task 1's parsers.

**Files:**
- Modify: `src/scrapers/gmat_club_cat_scraper.js` (append `extractTestList`, `extractScoreReportRows`, `extractGridRows`, `buildSession`, `runScrape`; extend exports)
- Test: `test/unit/gmatclub-cat-build.test.js`

**Interfaces:**
- Consumes (Task 1): all `_internals` parsers.
- Produces:
  - `runScrape({ page, options }) -> Promise<{ extracted_at, config, sessions, warnings }>` where `options = { since, source, minDelayMs, maxDelayMs, onProgress }`.
  - `buildSession({ testId, source, scoreSummary, gridRows }) -> session` (pure; unit-tested). `gridRows` are raw `{ num, qcode, instanceId, viewUrl, typeText, correct, difficulty, timeRaw, dateRaw }`.
  - Session matches the `saveScrapeResult` shape (`session_id`, `date`, `source`, `subject`, `scoreSummary`, `stats`, `questions[]`, `wrong_q_ids[]`).

- [ ] **Step 1: Write the failing test (pure `buildSession`)**

```js
// test/unit/gmatclub-cat-build.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSession } = require('../../src/scrapers/gmat_club_cat_scraper')._internals;

const gridRows = [
  { num: 1, qcode: 'I02-10', instanceId: '43972530', viewUrl: 'https://gmatclub.com/gmat-focus-tests/view-43972530.html',
    typeText: 'Data Insights / TPA / Two-Part Analysis', correct: false, difficulty: 'Hard', timeRaw: '2:15', dateRaw: 'Jun 21, 2026 12:05 AM' },
  { num: 2, qcode: 'M40-66', instanceId: '43972631', viewUrl: 'https://gmatclub.com/gmat-focus-tests/view-43972631.html',
    typeText: 'Quant / PS / Algebra', correct: true, difficulty: 'Medium', timeRaw: '1:00', dateRaw: 'Jun 21, 2026 12:10 AM' },
];
const scoreSummary = { total: { score: 565, percentile: 51 }, quant: { score: 81, percentile: 70 },
  verbal: { score: 79, percentile: 47 }, di: { score: 74, percentile: 41 } };

test('buildSession builds a Mixed session with scoreSummary + questions', () => {
  const s = buildSession({ testId: '2347043', source: 'GMAT Club CAT', scoreSummary, gridRows });
  assert.equal(s.session_id, 2347043);
  assert.equal(s.source, 'GMAT Club CAT');
  assert.equal(s.subject, 'Mixed');
  assert.equal(s.date, '2026-06-21');
  assert.deepEqual(s.scoreSummary, scoreSummary);
  assert.equal(s.stats.total_q_api, 2);
  assert.equal(s.stats.correct, 1);
  assert.equal(s.stats.errors, 1);
  assert.equal(s.questions.length, 2);
  const q1 = s.questions[0];
  assert.equal(q1.q_id, 'gcc-att-43972530');
  assert.equal(q1.q_code, 'gcc-q-I02-10');
  assert.equal(q1.correct, false);
  assert.equal(q1.difficulty, 'Hard');
  assert.equal(q1.time_sec, 135);
  assert.equal(q1.topic, 'Two-Part Analysis');
  assert.equal(q1.subject_sub_raw, 'TPA');
  assert.equal(q1.topic_source, 'gmatclub-canonical');
  assert.equal(q1.question_url, 'https://gmatclub.com/gmat-focus-tests/view-43972530.html');
  assert.equal(s.wrong_q_ids.length, 1);
  assert.equal(s.wrong_q_ids[0].q_id, 'gcc-att-43972530');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/gmatclub-cat-build.test.js`
Expected: FAIL — `buildSession is not a function`.

- [ ] **Step 3: Implement `buildSession`, the extractors, and `runScrape`**

Append to `src/scrapers/gmat_club_cat_scraper.js` (before `module.exports`):

```js
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
```

Then extend the `module.exports` block: add `runScrape` at top level and `buildSession`, `extractTestList`, `extractScoreReportRows`, `extractGridRows`, `gridFragmentUrl` into `_internals`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/gmatclub-cat-build.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full unit suite + lint**

Run: `npm test` then `npm run lint`
Expected: all tests pass; 0 new lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/scrapers/gmat_club_cat_scraper.js test/unit/gmatclub-cat-build.test.js
git commit -m "feat(gmatclub-cat): Phase 1 orchestration (runScrape + session builder)"
```

---

### Task 3: Phase 1 runner (`runGmatClubCatScrapeFromOpenBrowser`)

CDP bridge that finds the gmatclub.com tab and drives `runScrape`. Mirrors `runTtpScrapeFromOpenBrowser` (scraper-runner.js:1118).

**Files:**
- Modify: `src/scraper-runner.js` (add runner near the TTP runner; require the scraper module; extend `module.exports`)

**Interfaces:**
- Consumes: `runScrape` from `gmat_club_cat_scraper.js`; existing `connectBrowserOverCdp`, `clipText`.
- Produces: `runGmatClubCatScrapeFromOpenBrowser({ cdpUrl, since, source, minDelayMs, maxDelayMs }) -> { data, tabUrl, debug }` (`data` = the `runScrape` return).

- [ ] **Step 1: Add the require near the TTP require (scraper-runner.js ~line 510)**

```js
const {
  runScrape: runGmatClubCatScrape,
  ScrapeAnomalyError: GmatClubCatAnomalyError,
} = require('./scrapers/gmat_club_cat_scraper');
```

- [ ] **Step 2: Add the runner function (after `runTtpScrapeFromOpenBrowser`, ~line 1238)**

```js
async function runGmatClubCatScrapeFromOpenBrowser(options = {}) {
  const requestedCdpUrl = options.cdpUrl || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const source = options.source || 'GMAT Club CAT';
  const startedAt = new Date().toISOString();
  const consoleLogs = [];
  const pageErrors = [];
  const progressEvents = [];
  const pushLog = (target, entry, limit = 800) => { target.push(entry); if (target.length > limit) target.shift(); };

  let browser = null;
  let connectedCdpUrl = requestedCdpUrl;
  let attemptedCdpUrls = [requestedCdpUrl];
  let cdpFallbackUsed = false;
  let page = null;
  let onConsole = null;
  let onPageError = null;
  try {
    const cdpConnection = await connectBrowserOverCdp(requestedCdpUrl);
    browser = cdpConnection.browser;
    connectedCdpUrl = cdpConnection.connectedUrl;
    attemptedCdpUrls = cdpConnection.attemptedUrls;
    cdpFallbackUsed = cdpConnection.fallbackUsed;

    const pages = browser.contexts().flatMap((ctx) => ctx.pages());
    page = pages.find((p) => /gmatclub\.com/i.test(p.url())) || pages.find((p) => p.url() === 'about:blank') || pages[0];
    if (!page) {
      throw new Error('No gmatclub.com tab found. Open https://gmatclub.com/gmat-focus-tests/?page=tests in your logged-in tab first.');
    }
    page.setDefaultTimeout(0);
    await page.bringToFront();

    onConsole = (msg) => pushLog(consoleLogs, { at: new Date().toISOString(), type: msg.type(), text: clipText(msg.text(), 1200) });
    onPageError = (error) => pushLog(pageErrors, { at: new Date().toISOString(), text: clipText(error?.stack || error?.message || String(error), 2000) }, 50);
    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    const data = await runGmatClubCatScrape({
      page,
      options: {
        since: options.since,
        source,
        minDelayMs: Number(options.minDelayMs) || 1500,
        maxDelayMs: Number(options.maxDelayMs) || 3000,
        onProgress: (evt) => pushLog(progressEvents, { at: new Date().toISOString(), ...evt }, 800),
      },
    });

    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    return {
      data,
      tabUrl: page.url(),
      debug: {
        startedAt, finishedAt: new Date().toISOString(),
        cdpUrl: connectedCdpUrl, requestedCdpUrl, attemptedCdpUrls, cdpFallbackUsed,
        source,
        diagnostics: {
          sessions: sessions.length,
          questions: sessions.reduce((sum, s) => sum + (s.stats?.total_q_api || 0), 0),
          warnings: Array.isArray(data?.warnings) ? data.warnings.length : 0,
        },
        progressEvents, consoleLogs, pageErrors,
      },
    };
  } catch (error) {
    error.scrapeDebug = {
      startedAt, finishedAt: new Date().toISOString(),
      cdpUrl: connectedCdpUrl, requestedCdpUrl, attemptedCdpUrls, cdpFallbackUsed,
      source, tabUrl: page?.url?.() || null,
      progressEvents, consoleLogs, pageErrors,
      anomaly: error instanceof GmatClubCatAnomalyError ? { name: error.name, url: error.url, snippet: error.snippet } : null,
    };
    throw error;
  } finally {
    if (page && onConsole) page.off('console', onConsole);
    if (page && onPageError) page.off('pageerror', onPageError);
    // No browser.close() — preserve the user's logged-in GMAT Club session.
  }
}
```

- [ ] **Step 3: Export it (scraper-runner.js module.exports, ~line 1579)**

Add `runGmatClubCatScrapeFromOpenBrowser,` to the `module.exports` object.

- [ ] **Step 4: Smoke-check the module loads**

Run: `node -e "const r=require('./src/scraper-runner'); console.log(typeof r.runGmatClubCatScrapeFromOpenBrowser)"`
Expected: `function`

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add src/scraper-runner.js
git commit -m "feat(gmatclub-cat): CDP runner for Phase 1 scrape"
```

---

### Task 4: Server preset, scrape dispatch, platform filters

Register the source, route `/api/scrape` to the new runner, and fix the platform discriminator so "GMAT Club CAT" doesn't collide with the Error Log.

**Files:**
- Modify: `src/server.js` (preset in `SOURCE_PRESETS` ~line 219; `/api/scrape` dispatch ~line 1294; two `platform` query allowlists ~lines 534 & 618)
- Modify: `src/db.js` (`platformWhereClause` ~line 1060)
- Test: `test/unit/platform-where.test.js`

**Interfaces:**
- Consumes: `runGmatClubCatScrapeFromOpenBrowser` (Task 3).
- Produces: a `gmat-club-cat` preset (`platform: 'gmatclub-cat'`); `platformWhereClause('gmatclub-cat')`.

- [ ] **Step 1: Write the failing test for `platformWhereClause`**

```js
// test/unit/platform-where.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { _sqlInternals } = require('../../src/db');

test('platformWhereClause separates gmatclub-cat from gmatclub error log', () => {
  const cat = _sqlInternals.platformWhereClause('gmatclub-cat');
  const log = _sqlInternals.platformWhereClause('gmatclub');
  assert.match(cat, /gmat club cat/);
  // The plain gmatclub (Error Log) clause must EXCLUDE the CAT source.
  assert.match(log, /not like '%gmat club cat%'/i);
});
```

> Note: if `db.js` does not already export `platformWhereClause`, add it to a `_sqlInternals` object on `module.exports` (alongside the existing exports) in this step — it is a pure string function and safe to expose.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/platform-where.test.js`
Expected: FAIL (either no `_sqlInternals` export, or the gmatclub clause lacks the CAT exclusion).

- [ ] **Step 3: Update `platformWhereClause` in `src/db.js`**

Replace the `gmatclub` branch and add a `gmatclub-cat` branch:

```js
function platformWhereClause(platform) {
  // Heuristic match — matches the frontend's getSourcePlatform().
  if (platform === 'gmatclub-cat') return "LOWER(COALESCE(s.source, '')) LIKE '%gmat club cat%'";
  if (platform === 'gmatclub') return "LOWER(COALESCE(s.source, '')) LIKE '%gmat club%' AND LOWER(COALESCE(s.source, '')) NOT LIKE '%gmat club cat%'";
  if (platform === 'ttp') return "LOWER(COALESCE(s.source, '')) LIKE '%target test prep%'";
  if (platform === 'ope-mock') return "LOWER(COALESCE(s.source, '')) LIKE '%practice exam%'";
  if (platform === 'starttest') {
    return "LOWER(COALESCE(s.source, '')) NOT LIKE '%gmat club%' AND LOWER(COALESCE(s.source, '')) NOT LIKE '%target test prep%' AND LOWER(COALESCE(s.source, '')) NOT LIKE '%practice exam%'";
  }
  return null;
}
```

Ensure `module.exports` exposes it for the test, e.g. add/extend:
```js
  _sqlInternals: { platformWhereClause },
```
(Place inside the existing `module.exports = { ... }` object in db.js.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/platform-where.test.js`
Expected: PASS.

- [ ] **Step 5: Add the source preset in `src/server.js`**

Insert into `SOURCE_PRESETS` immediately after the `gmat-club-error-log` preset (after line ~219):

```js
  {
    id: 'gmat-club-cat',
    label: 'GMAT Club CAT',
    platform: 'gmatclub-cat',
    appUrl: 'https://gmatclub.com/gmat-focus-tests/?page=tests',
    clientId: null,
    reviewCategoryId: null,
    defaultSince: '20250101000000',
    scraperFile: 'gmat_club_cat_scraper.js',
    tabPattern: 'gmatclub\\.com',
  },
```

- [ ] **Step 6: Import the runner + add the `/api/scrape` dispatch branch**

At the top of `server.js` where `runTtpScrapeFromOpenBrowser` is imported from `./scraper-runner`, add `runGmatClubCatScrapeFromOpenBrowser` to that destructure.

Then in the `/api/scrape` dispatch (after the `ttp` branch, ~line 1311), add:

```js
    } else if (preset.platform === 'gmatclub-cat') {
      const result = await runGmatClubCatScrapeFromOpenBrowser({
        cdpUrl: validatedCdpUrl,
        since: sinceValue,
        source: preset.label,
      });
      data = result.data;
      tabUrl = result.tabUrl;
      debug = result.debug;
```

- [ ] **Step 7: Add `gmatclub-cat` to the two platform query allowlists**

In `src/server.js` at lines ~534 and ~618, update both allowlist arrays:

```js
const platform = ['gmatclub', 'gmatclub-cat', 'starttest', 'ttp', 'ope-mock', 'lsat'].includes(req.query.platform) ? req.query.platform : null;
```

- [ ] **Step 8: Verify server boots + endpoints respond**

Run: `npm run dev:api` (in a background shell), then:
`curl -s localhost:4310/api/sources | python3 -c "import sys,json; print([s['id'] for s in json.load(sys.stdin)['sources'] if 'cat' in s['id']])"`
Expected: `['gmat-club-cat']`
`curl -s "localhost:4310/api/sessions?platform=gmatclub-cat" | head -c 80`
Expected: a JSON response (likely empty list pre-scrape), HTTP 200, no crash.

- [ ] **Step 9: Lint + commit**

```bash
npm run lint
git add src/server.js src/db.js test/unit/platform-where.test.js
git commit -m "feat(gmatclub-cat): register source + scrape dispatch + platform filter"
```

---

### Task 5: Frontend platform wiring + badge

Teach the dashboard about the new platform so it renders a distinct badge and filters correctly.

**Files:**
- Modify: `client/src/App.jsx` (`getSourcePlatform` ~line 743; `SourceBadge` label map ~line 757; the enrich-button source guard ~line 4033)
- Modify: `client/src/styles.css` (add `.source-gmatclub-cat` after `.source-gmatclub` ~line 1361)

**Interfaces:**
- Consumes: `getSourcePlatform(label) -> platform string`.
- Produces: `'gmatclub-cat'` platform recognized in badge + filters.

- [ ] **Step 1: Update `getSourcePlatform` (check CAT before generic gmatclub)**

```js
function getSourcePlatform(sourceLabel) {
  const raw = String(sourceLabel || '');
  if (/lsat/i.test(raw)) return 'lsat';
  if (/gmat\s*club\s*cat/i.test(raw)) return 'gmatclub-cat';
  if (/gmat\s*club/i.test(raw)) return 'gmatclub';
  if (/target\s*test\s*prep/i.test(raw)) return 'ttp';
  // (keep the remaining existing lines unchanged)
```

> Read the existing function body first; only insert the `gmatclub-cat` line above the `gmatclub` line and keep the rest verbatim (the lsat/ope-mock/starttest logic already present).

- [ ] **Step 2: Update the `SourceBadge` label map (~line 757)**

Add a branch so the badge text and class differ from the Error Log:

```js
    platform === 'lsat' ? 'LSAT' :
    platform === 'gmatclub-cat' ? 'GMAT Club CAT' :
    platform === 'gmatclub' ? 'GMAT Club' :
    platform === 'ttp' ? 'Target Test Prep' :
    platform === 'ope-mock' ? 'Practice Exam' :
```

Confirm the badge className uses `source-${platform}` (so it becomes `source-gmatclub-cat`). If the component hardcodes class names, add the `gmatclub-cat` case mirroring `gmatclub`.

- [ ] **Step 3: Enable the Phase-2 "Enrich" button for `gmatclub-cat` (~line 4033)**

Extend the platform guard that currently allows `'starttest' || 'gmatclub'`:

```js
                {sessionAnalysis.data?.session && sources.some((s) => s.label === sessionAnalysis.data.session.source && (s.platform === 'starttest' || s.platform === 'gmatclub' || s.platform === 'gmatclub-cat')) && (
```

- [ ] **Step 4: Add the badge CSS variant in `client/src/styles.css` (after `.source-gmatclub`)**

```css
.source-chip.source-gmatclub-cat {
  background: rgba(13, 148, 136, 0.12);
  color: #0f766e;
  border-color: rgba(13, 148, 136, 0.30);
}
```

- [ ] **Step 5: Build the frontend to verify no errors**

Run: `npm run build:web`
Expected: build succeeds, no JSX/import errors.

- [ ] **Step 6: Lint + commit**

```bash
npm run lint
git add client/src/App.jsx client/src/styles.css
git commit -m "feat(gmatclub-cat): dashboard badge, platform filter, enrich button"
```

---

### Task 6: Phase 2 browser scraper (`gmat_club_cat_question_scraper.js`)

Browser-injected extraction for a single `view-{id}.html` page. Expose pure letter/parse helpers for unit tests; the DOM read itself is verified live in Task 8.

**Files:**
- Create: `src/scrapers/gmat_club_cat_question_scraper.js`
- Test: `test/unit/gmatclub-cat-enrich-helpers.test.js`

**Interfaces:**
- Produces: `window.gmatClubCatEnrichCurrentPage() -> { ok, url, stem, choices:[{label,text,isCorrect,isUserSelected}], correct_answer, my_answer, explanation }`.
- Also exports (CommonJS, for the unit test) `_internals.letterForIndex(i)` and `_internals.deriveAnswerLetters(choices)`.

- [ ] **Step 1: Write the failing test (pure helpers)**

```js
// test/unit/gmatclub-cat-enrich-helpers.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { letterForIndex, deriveAnswerLetters } = require('../../src/scrapers/gmat_club_cat_question_scraper')._internals;

test('letterForIndex', () => {
  assert.equal(letterForIndex(0), 'A');
  assert.equal(letterForIndex(4), 'E');
});

test('deriveAnswerLetters maps correct + selected to letters', () => {
  const choices = [
    { text: 'opt1', isCorrect: true, isUserSelected: false },
    { text: 'opt2', isCorrect: false, isUserSelected: false },
    { text: 'opt3', isCorrect: false, isUserSelected: true },
  ];
  const { labeled, correct_answer, my_answer } = deriveAnswerLetters(choices);
  assert.equal(labeled[0].label, 'A');
  assert.equal(correct_answer, 'A');
  assert.equal(my_answer, 'C');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/gmatclub-cat-enrich-helpers.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the scraper**

```js
// src/scrapers/gmat_club_cat_question_scraper.js
// GMAT Club CAT Phase-2 enrichment — runs in the browser via CDP. The Node-side
// runner navigates the same gmatclub.com tab to each /gmat-focus-tests/view-{id}.html
// page; this module exposes window.gmatClubCatEnrichCurrentPage().
//
// DOM contract (verified 2026-06-21): the Test Center view page renders choices
// as `.option` elements. The CORRECT option carries the `valid` class; the
// USER'S pick is the `.option` whose `input[type=radio]` is :checked. The stem
// precedes the options; the explanation toggles via "HIDE/SHOW EXPLANATION".

(function () {
  'use strict';

  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  function letterForIndex(i) { return LETTERS[i] || String(i + 1); }

  function deriveAnswerLetters(choices) {
    const labeled = (Array.isArray(choices) ? choices : []).map((c, i) => ({
      label: letterForIndex(i),
      text: c.text || '',
      isCorrect: !!c.isCorrect,
      isUserSelected: !!c.isUserSelected,
    }));
    const correct = labeled.find((c) => c.isCorrect);
    const mine = labeled.find((c) => c.isUserSelected);
    return { labeled, correct_answer: correct ? correct.label : null, my_answer: mine ? mine.label : null };
  }

  function tidy(text) { return String(text || '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(); }

  function extractCurrentPage() {
    const optionEls = Array.from(document.querySelectorAll('.option'));
    if (!optionEls.length) return { ok: false, reason: 'no-options', url: location.href };

    const rawChoices = optionEls.map((el) => ({
      text: tidy(el.textContent).replace(/\n/g, ' '),
      isCorrect: /\bvalid\b/.test(el.className || ''),
      isUserSelected: !!el.querySelector('input[type=radio]:checked'),
    }));
    const { labeled, correct_answer, my_answer } = deriveAnswerLetters(rawChoices);

    // Stem: text content of the question block up to the first option. The view
    // page renders the stem inside a question container; fall back to body text
    // sliced before the first option's text.
    const container = optionEls[0].closest('.question, .questionBox, .item, form') || document.body;
    let stem = '';
    const firstOptText = rawChoices[0] ? rawChoices[0].text.slice(0, 24) : '';
    const full = tidy(container.innerText || '');
    if (firstOptText && full.includes(firstOptText)) {
      stem = full.slice(0, full.indexOf(firstOptText)).trim();
    } else {
      stem = full.slice(0, 1200);
    }
    // Trim the leading Test-Center header lines (section/type/category/qcode/Bookmark).
    stem = stem.replace(/^[\s\S]*?Bookmark\s*/i, '').trim() || stem;

    // Explanation: text after a "HIDE EXPLANATION" / "SHOW EXPLANATION" marker.
    const bodyText = tidy(document.body.innerText || '');
    let explanation = null;
    const expM = bodyText.match(/(?:HIDE|SHOW) EXPLANATION([\s\S]*)$/i);
    if (expM) explanation = expM[1].replace(/I like the solution[\s\S]*$/i, '').trim().slice(0, 8000) || null;

    return { ok: true, url: location.href, stem, choices: labeled, correct_answer, my_answer, explanation };
  }

  if (typeof window !== 'undefined') {
    window.gmatClubCatEnrichCurrentPage = extractCurrentPage;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { _internals: { letterForIndex, deriveAnswerLetters } };
  }
})();
```

> ESLint: this is a page-injected file. Mirror how `gmat_club_question_scraper.js` is handled (browser globals, `sourceType: 'script'`). The trailing `module.exports` guard lets the unit test require it under Node without a browser. Confirm `npm run lint` stays at 0 new errors; the file is under `src/scrapers/` which the existing config covers.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/unit/gmatclub-cat-enrich-helpers.test.js`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add src/scrapers/gmat_club_cat_question_scraper.js test/unit/gmatclub-cat-enrich-helpers.test.js
git commit -m "feat(gmatclub-cat): Phase 2 browser scraper + helpers"
```

---

### Task 7: Phase 2 runner + DB writer + enrich dispatch

Wire the opt-in `/api/sessions/:id/enrich` path for `gmatclub-cat`: a CDP runner that visits each view URL, a DB writer that stores stems/choices (with flags)/answers/explanation matched by `q_id`, and the server dispatch.

**Files:**
- Modify: `src/scraper-runner.js` (add `runGmatClubCatPhase2FromOpenBrowser`; export it)
- Modify: `src/db.js` (add `enrichGmatClubCatSessionAttempts`; export it)
- Modify: `src/server.js` (enrich dispatch ~line 1109; import the writer + runner)

**Interfaces:**
- Consumes: `gmat_club_cat_question_scraper.js` (browser fn `window.gmatClubCatEnrichCurrentPage`); existing `listGmatClubEnrichTargets(sessionDbId)` (reused — returns `{ id, q_id, q_code, question_url, question_stem }`); `connectBrowserOverCdp`, `loadScraperSource`, `withTransaction`, `refreshSessionTimingAggregates`.
- Produces:
  - `runGmatClubCatPhase2FromOpenBrowser({ cdpUrl, targets, minDelayMs, maxDelayMs }) -> { result: { items: [...] }, debug }` where each item = `{ q_id, stem, choices:[{label,text,isCorrect,isUserSelected}], correct_answer, my_answer, explanation, final_url }`.
  - `enrichGmatClubCatSessionAttempts({ sessionExternalId, source, enrichedItems }) -> { sessionDbId, matched, updated, skipped, errors }`.

- [ ] **Step 1: Add the Phase 2 runner in `src/scraper-runner.js`**

Add after `runGmatClubCatScrapeFromOpenBrowser`. It mirrors `runGmatClubPhase2FromOpenBrowser` (scraper-runner.js:870) but injects the CAT scraper and visits one URL per question (no RC grouping):

```js
async function runGmatClubCatPhase2FromOpenBrowser(options = {}) {
  const requestedCdpUrl = options.cdpUrl || process.env.CHROME_CDP_URL || 'http://localhost:9222';
  const targets = Array.isArray(options.targets) ? options.targets : [];
  if (!targets.length) {
    const err = new Error('Phase 2 requires at least one target { url, q_id }.');
    err.statusCode = 400; throw err;
  }
  const minDelayMs = Number.isFinite(Number(options.minDelayMs)) ? Number(options.minDelayMs) : 1500;
  const maxDelayMs = Number.isFinite(Number(options.maxDelayMs)) ? Number(options.maxDelayMs) : 3000;
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));
  const jit = () => Math.round(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));

  const startedAt = new Date().toISOString();
  const consoleLogs = []; const pageErrors = []; const progressEvents = [];
  const pushLog = (t, e, limit = 800) => { t.push(e); if (t.length > limit) t.shift(); };

  let browser = null; let page = null; let onConsole = null; let onPageError = null;
  const scraperSource = await loadScraperSource(path.resolve(__dirname, 'scrapers', 'gmat_club_cat_question_scraper.js'));
  try {
    const cdp = await connectBrowserOverCdp(requestedCdpUrl);
    browser = cdp.browser;
    const pages = browser.contexts().flatMap((ctx) => ctx.pages());
    page = pages.find((p) => /gmatclub\.com/i.test(p.url())) || pages.find((p) => p.url() === 'about:blank') || pages[0];
    if (!page) throw new Error('No gmatclub.com tab found. Open GMAT Club in your logged-in tab first.');
    page.setDefaultTimeout(0);
    await page.bringToFront();
    onConsole = (msg) => pushLog(consoleLogs, { at: new Date().toISOString(), type: msg.type(), text: clipText(msg.text(), 1200) });
    onPageError = (e) => pushLog(pageErrors, { at: new Date().toISOString(), text: clipText(e?.stack || e?.message || String(e), 2000) }, 50);
    page.on('console', onConsole); page.on('pageerror', onPageError);

    const items = []; const errors = [];
    const maxErrors = Math.max(5, Math.ceil(targets.length / 4));
    for (let i = 0; i < targets.length; i += 1) {
      const t = targets[i];
      const url = String(t?.url || '').trim();
      if (!/^https?:\/\/(?:www\.)?gmatclub\.com\//i.test(url)) { errors.push({ q_id: t?.q_id || null, url, reason: 'invalid-url' }); continue; }
      pushLog(progressEvents, { at: new Date().toISOString(), kind: 'navigate', i, total: targets.length, url });
      try {
        await sleepMs(jit());
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('.option', { timeout: 10000 }).catch(() => null);
        await page.addScriptTag({ content: scraperSource });
        const result = await page.evaluate(() => (typeof window.gmatClubCatEnrichCurrentPage === 'function'
          ? window.gmatClubCatEnrichCurrentPage() : { ok: false, reason: 'scraper-not-loaded' }));
        if (!result?.ok) { errors.push({ q_id: t.q_id || null, url, reason: result?.reason || 'unknown' }); 
          if (errors.length > maxErrors) throw new Error(`Too many Phase 2 errors (${errors.length}); aborting.`);
          continue; }
        items.push({
          q_id: t.q_id || null,
          stem: result.stem || '',
          choices: Array.isArray(result.choices) ? result.choices : [],
          correct_answer: result.correct_answer || '',
          my_answer: result.my_answer || '',
          explanation: result.explanation || '',
          final_url: result.url || page.url(),
        });
      } catch (err) {
        errors.push({ q_id: t.q_id || null, url, reason: err.message });
        if (errors.length > maxErrors) throw err;
      }
    }
    return {
      result: { items, errors },
      debug: { startedAt, finishedAt: new Date().toISOString(), cdpUrl: cdp.connectedUrl, targets: targets.length, progressEvents, consoleLogs, pageErrors },
    };
  } finally {
    if (page && onConsole) page.off('console', onConsole);
    if (page && onPageError) page.off('pageerror', onPageError);
    // No browser.close().
  }
}
```

Add `runGmatClubCatPhase2FromOpenBrowser,` to `module.exports`.

- [ ] **Step 2: Add the DB writer in `src/db.js` (after `enrichGmatClubSessionAttempts`, ~line 3121)**

```js
// GMAT Club CAT Phase 2 writer. Matches rows by q_id ("gcc-att-{instanceId}").
// Unlike enrichGmatClubSessionAttempts, this PRESERVES per-choice flags
// (isCorrect/isUserSelected) so the review-modal color coding works, and stores
// the explanation in response_details.
async function enrichGmatClubCatSessionAttempts({ sessionExternalId, source, enrichedItems }) {
  const sessionRow = await get(
    `SELECT id FROM sessions WHERE session_external_id = ? AND COALESCE(source, '') = COALESCE(?, '') ORDER BY id DESC LIMIT 1`,
    [Number(sessionExternalId) || sessionExternalId, source || null]
  );
  if (!sessionRow?.id) {
    return { matched: 0, updated: 0, skipped: 0, errors: [{ message: 'session-not-found', sessionExternalId, source }] };
  }
  const sessionDbId = sessionRow.id;
  let updated = 0; let skipped = 0; const errors = [];

  await withTransaction(async (tx) => {
    for (const item of (Array.isArray(enrichedItems) ? enrichedItems : [])) {
      const qId = String(item?.q_id || '').trim();
      if (!qId) { errors.push({ message: 'item missing q_id', url: item?.final_url }); continue; }
      const targetRow = await tx.get(
        `SELECT id FROM question_attempts WHERE session_id = ? AND q_id = ? LIMIT 1`,
        [sessionDbId, qId]
      );
      if (!targetRow) { skipped += 1; continue; }

      const choices = Array.isArray(item.choices) ? item.choices : [];
      const answerChoicesArr = choices
        .map((c) => ({
          label: String(c?.label || '').trim() || null,
          text: String(c?.text || '').trim() || null,
          isCorrect: !!c?.isCorrect,
          isUserSelected: !!c?.isUserSelected,
        }))
        .filter((c) => c.label || c.text);

      try {
        await tx.run(
          `UPDATE question_attempts
             SET question_stem = COALESCE(NULLIF(?, ''), question_stem),
                 answer_choices = CASE WHEN ? > 0 THEN ? ELSE answer_choices END,
                 correct_answer = COALESCE(NULLIF(?, ''), correct_answer),
                 my_answer = COALESCE(NULLIF(?, ''), my_answer),
                 question_url = COALESCE(NULLIF(?, ''), question_url),
                 response_details = COALESCE(NULLIF(?, ''), response_details)
           WHERE id = ?`,
          [
            item.stem || '',
            answerChoicesArr.length,
            answerChoicesArr.length ? JSON.stringify(answerChoicesArr) : null,
            item.correct_answer || '',
            item.my_answer || '',
            item.final_url || '',
            item.explanation || '',
            targetRow.id,
          ]
        );
        updated += 1;
      } catch (err) {
        errors.push({ q_id: qId, message: err.message });
      }
    }
    await refreshSessionTimingAggregates(sessionDbId, tx.run);
  });

  return { sessionDbId, matched: (enrichedItems || []).length, updated, skipped, errors };
}
```

Add `enrichGmatClubCatSessionAttempts,` to db.js `module.exports`.

- [ ] **Step 3: Add the enrich dispatch in `src/server.js`**

Import `runGmatClubCatPhase2FromOpenBrowser` (from `./scraper-runner`) and `enrichGmatClubCatSessionAttempts` (from `./db`) in the existing destructures. Then add a branch after the `gmatclub` branch (~line 1108):

```js
    } else if (preset.platform === 'gmatclub-cat') {
      const targets = await listGmatClubEnrichTargets(sessionRow.id);
      if (!targets.length) {
        res.status(400).json({ ok: false, error: 'No questions in this session have a question_url to enrich.' });
        return;
      }
      phase2 = await runGmatClubCatPhase2FromOpenBrowser({
        cdpUrl: validatedCdpUrl,
        targets: targets.map((t) => ({ q_id: t.q_id, q_code: t.q_code, url: t.question_url })),
      });
      dbResult = await enrichGmatClubCatSessionAttempts({
        sessionExternalId: sessionRow.session_external_id,
        source: sessionRow.source,
        enrichedItems: phase2.result?.items || [],
      });
```

- [ ] **Step 4: Smoke-check both modules load**

Run:
```bash
node -e "console.log(typeof require('./src/scraper-runner').runGmatClubCatPhase2FromOpenBrowser, typeof require('./src/db').enrichGmatClubCatSessionAttempts)"
```
Expected: `function function`

- [ ] **Step 5: Lint + commit**

```bash
npm run lint
git add src/scraper-runner.js src/db.js src/server.js
git commit -m "feat(gmatclub-cat): Phase 2 runner, DB writer, enrich dispatch"
```

---

### Task 8: Live end-to-end verification + docs

Run the real scrape against the user's open completed attempt, confirm the data lands, then enrich it. Document the source in CLAUDE.md.

**Files:**
- Modify: `CLAUDE.md` (add the GMAT Club CAT source to the scraper inventory + a "Scrape flow" subsection)
- (No new code — verification + docs)

**Preconditions:** the user's Chrome is running with CDP on port 9222 and a logged-in `gmatclub.com` tab open; Postgres is up (`npm run db:up`); the API can reach the DB.

- [ ] **Step 1: Run Phase 1 against the live account**

Use a throwaway script in `tmp/` (gitignored) to drive the runner directly (no need to round-trip the HTTP API):

```bash
cat > tmp/run-cat-phase1.js <<'EOF'
const { runGmatClubCatScrapeFromOpenBrowser } = require('../src/scraper-runner');
(async () => {
  const r = await runGmatClubCatScrapeFromOpenBrowser({ since: '20250101000000', source: 'GMAT Club CAT' });
  console.log('sessions:', r.data.sessions.length, 'warnings:', r.data.warnings.length);
  const s = r.data.sessions[0];
  console.log(JSON.stringify({ id: s?.session_id, date: s?.date, subject: s?.subject, score: s?.scoreSummary, stats: s?.stats, q0: s?.questions[0] }, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
EOF
node tmp/run-cat-phase1.js
```
Expected: `sessions: 1`, score `{ total: { score: 565, ... }, quant: { score: 81 }, ... }`, `stats.total_q_api: 64`, `stats.correct: 32`, and `q0` with `q_id` like `gcc-att-…`, `subject_sub_raw` a code, `topic_source: 'gmatclub-canonical'`.

- [ ] **Step 2: Persist via the HTTP API and verify in the DB**

```bash
curl -s -X POST localhost:4310/api/scrape -H 'Content-Type: application/json' -d '{"source":"GMAT Club CAT"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok', d.get('ok'), 'sessions', d.get('summary'))"
docker exec gmat-pg psql -U postgres -d gmat -c "SELECT session_external_id, subject, total_score, quant_score, verbal_score, di_score, correct_count, error_count FROM sessions WHERE source='GMAT Club CAT';"
docker exec gmat-pg psql -U postgres -d gmat -c "SELECT count(*), count(*) FILTER (WHERE topic_source='gmatclub-canonical') canon, count(*) FILTER (WHERE correct=1) correct FROM question_attempts q JOIN sessions s ON s.id=q.session_id WHERE s.source='GMAT Club CAT';"
```
Expected: one session row with `total_score=565, quant_score=81, verbal_score=79, di_score=74`; question count 64, all `gmatclub-canonical`, 32 correct.

- [ ] **Step 3: Run Phase 2 enrichment on that session**

Find the session id, then hit the enrich endpoint:
```bash
SID=$(docker exec gmat-pg psql -U postgres -d gmat -tAc "SELECT id FROM sessions WHERE source='GMAT Club CAT' ORDER BY id DESC LIMIT 1")
curl -s -X POST "localhost:4310/api/sessions/$SID/enrich" -H 'Content-Type: application/json' -d '{}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok', d.get('ok'), d.get('dbResult') or d.get('summary'))"
docker exec gmat-pg psql -U postgres -d gmat -c "SELECT count(*) FILTER (WHERE question_stem IS NOT NULL) stems, count(*) FILTER (WHERE answer_choices IS NOT NULL) choices, count(*) FILTER (WHERE correct_answer IS NOT NULL) oa FROM question_attempts q JOIN sessions s ON s.id=q.session_id WHERE s.source='GMAT Club CAT';"
```
Expected: most/all 64 rows now have `question_stem`, `answer_choices`, and `correct_answer` populated. Spot-check one row's `answer_choices` JSON contains `isCorrect`/`isUserSelected` flags.

- [ ] **Step 4: Verify the dashboard renders the source**

Confirm the React app (`npm run dev:web`) shows the "GMAT Club CAT" badge (teal) in the sessions table, the Source filter lists it, the session opens with the score, and the review modal color-codes a few enriched questions correctly. (Quick visual check; can use the existing CDP browser.)

- [ ] **Step 5: Clean up tmp + update CLAUDE.md**

```bash
rm -f tmp/run-cat-phase1.js
```
Add to `CLAUDE.md`:
- In the scraper inventory (Backend `src/` bullets): a `scrapers/gmat_club_cat_scraper.js` line and a `scrapers/gmat_club_cat_question_scraper.js` line, describing the two-phase CAT flow.
- A short "## Two-phase GMAT Club CAT scrape flow" section mirroring the existing GMAT Club Error Log section: My Tests enumeration → score report → results-grid AJAX fragment (`true=questionListGrid`) → `view-{id}.html` Phase 2; note `platform: 'gmatclub-cat'`, `q_id` `gcc-att-{instanceId}`, the `valid`-class correct marker, and the platform-disambiguation rule (`'gmat club cat'` checked before `'gmat club'`).
- Update the source-count line ("8 total" / preset list) to include GMAT Club CAT.

- [ ] **Step 6: Final full test + lint + commit**

```bash
npm test && npm run lint
git add CLAUDE.md
git commit -m "docs(gmatclub-cat): document the CAT scrape flow + source inventory"
```

---

## Self-Review

**1. Spec coverage:**
- New source/platform/badge → Tasks 4, 5. ✔
- Phase 1 (My Tests → report → grid, one session/test, scoreSummary, per-Q grid) → Tasks 1, 2, 3. ✔
- Phase 2 (view page stem/choices/correct/pick/explanation) → Tasks 6, 7. ✔
- Type→code mapping, `topic_source='gmatclub-canonical'` → Task 2 (`buildSession`/`parseTypeCell`). ✔
- Platform disambiguation (frontend + SQL) → Tasks 4, 5. ✔
- Reuse `saveScrapeResult` (no new Phase 1 writer) → Task 4 dispatch persists `data` via the existing handler path. ✔
- Per-choice flags + explanation storage → Task 7 writer. ✔
- Safety (no `browser.close()`, jitter, abort guard) → Tasks 3, 7, 2. ✔
- Testing (unit + live) → Tasks 1, 2, 6, 8. ✔
- **Deviation from spec:** `listGmatClubCatEnrichTargets` is NOT created — the existing source-agnostic `listGmatClubEnrichTargets(sessionDbId)` is reused (it already filters by non-empty `q_id` + `question_url`). Documented in Task 7 interfaces.

**2. Placeholder scan:** No "TBD/TODO/handle edge cases" — every code step carries full code; every command has expected output. The one soft spot (stem boundary heuristic on the view page) ships concrete code and is validated live in Task 8 Step 3; if the header-trim regex misfires there, adjust the `Bookmark`/option-boundary slice — but the choices/correct/pick (the answer-bearing data) do not depend on it.

**3. Type consistency:** `q_id` = `gcc-att-${instanceId}` and `q_code` = `gcc-q-${qcode}` used identically in Tasks 2, 7, 8. `buildSession` field names match `saveScrapeResult`'s reads (`scoreSummary.total.score`, `stats.*`, `questions[].subject_sub_raw/topic_source/question_url`). Phase 2 item shape `{ q_id, stem, choices, correct_answer, my_answer, explanation, final_url }` is produced by the runner (Task 7 Step 1) and consumed by the writer (Task 7 Step 2) — names match. `runScrape({ page, options })` signature matches the runner's call (Task 3) and the TTP convention.
