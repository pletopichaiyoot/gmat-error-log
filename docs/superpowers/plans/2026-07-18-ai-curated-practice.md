# AI Curated Practice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "AI Practice" tab where the user re-attempts real questions from his scraped error logs as a timed session, logged under source "AI Curated Practice" with the original `q_code` preserved for cross-platform redo linkage.

**Architecture:** Curation happens outside the app (Claude Cowork writes JSON set files under `data/ai-practice-sets/`). A new full-screen React route (`#ai-practice`) lists sets, serves each question live from its source `question_attempts` row (correct answer stripped), grades server-side on submit, and logs a new session + attempts via the existing `saveScrapeResult` writer. No in-app LLM calls, no DB migration.

**Tech Stack:** Node/Express (CJS) backend, React (ESM) frontend, PostgreSQL via raw SQL (`pg.Pool`), `node:test` unit tests.

## Global Constraints

- **No DB migration.** Reuse existing `sessions` / `question_attempts` columns.
- **Source label is exactly `AI Curated Practice`** (the string every filter/badge keys off). Platform key is `ai-curated`, matched on the lowercased substring `ai curated`.
- **`?` placeholders only** in SQL (the `toPg` helper rewrites `?`→`$n`); SQL strings must contain no literal `?`. `LIKE` comparisons wrap both sides in `LOWER()`.
- **Never set `difficulty_theta`** on AI-curated rows (copy the text `difficulty` verbatim; theta stays NULL — AI-curated is not OPE, and `recomputeIrtCutoffs()` must keep ignoring it).
- **v1 grades single-answer questions only.** A row is servable only if its `answer_choices` is a flat `[{label,...}]` array (non-empty). Multi-part DI (nested `options[]`) is skipped.
- **Set files are read fresh on every request** — no in-process cache (unlike `loadLsatData`).
- **`data/ai-practice-sets/` is gitignored** (like `data/lsat-questions.json`); only a `.gitkeep` is tracked.
- **Frequent commits** — one per task, conventional-commit style, end message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/ai-practice-sets.js` (new) | Pure helpers: read/parse/validate set files from a dir; the flat-choices gradeability predicate. No DB, no Express — unit-testable. |
| `src/db.js` (modify) | `listAiPracticeCandidates()` (curation query), `resolveAiPracticeSetItems()` (ids → gradeable question payloads + prior-attempt summary), `buildAiCuratedSessionData()` (pure data-object builder, unit-tested), `logAiCuratedSession()` (wraps builder + `saveScrapeResult`). Add `ai-curated` to `platformWhereClause` + exclude it from the `starttest` branch. |
| `src/server.js` (modify) | 3 endpoints under `/api/ai-practice/*`. |
| `client/src/App.jsx` (modify) | `getSourcePlatform` + `SourceBadge` + source-filter `<option>`s + `modeFromHash` + render branch + top-bar button. |
| `client/src/AiPractice.jsx` (new) | Full-screen tab: set list → runner → result. |
| `client/src/styles.css` (modify) | `.source-chip.source-ai` variant. |
| `test/unit/ai-practice-sets.test.js` (new) | Loader/validator + gradeability predicate tests. |
| `test/unit/ai-curated-session.test.js` (new) | `buildAiCuratedSessionData` shape tests. |
| `data/ai-practice-sets/.gitkeep` (new), `.gitignore` (modify) | Set-file directory. |
| `ANALYSIS.md` (modify) + memory | Curation recipe. |

---

## Task 1: Set-file loader module + gradeability predicate

**Files:**
- Create: `src/ai-practice-sets.js`
- Create: `test/unit/ai-practice-sets.test.js`
- Create: `data/ai-practice-sets/.gitkeep`
- Modify: `.gitignore`

**Interfaces:**
- Produces:
  - `isFlatGradeableChoices(answerChoicesJson: string|array): boolean` — true iff parseable as a non-empty flat array whose every element is an object with a non-empty `label` and no nested `options` key.
  - `parseSetObject(obj): { ok: true, set } | { ok: false, error }` — validates one parsed set.
  - `readSetFiles(dir: string): Array<set>` — reads `*.json` in `dir`, returns valid sets (skips malformed, never throws). Each `set` = `{ slug, title, focusNote, subject, items:number[] }`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/ai-practice-sets.test.js
/* global require */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isFlatGradeableChoices, parseSetObject, readSetFiles } = require('../../src/ai-practice-sets');

test('isFlatGradeableChoices accepts a flat labelled array', () => {
  assert.equal(isFlatGradeableChoices('[{"label":"A","text":"x"},{"label":"B","text":"y"}]'), true);
  assert.equal(isFlatGradeableChoices([{ label: 'A', text: 'x' }]), true);
});

test('isFlatGradeableChoices rejects empty, nested, and malformed', () => {
  assert.equal(isFlatGradeableChoices('[]'), false);
  assert.equal(isFlatGradeableChoices(''), false);
  assert.equal(isFlatGradeableChoices(null), false);
  assert.equal(isFlatGradeableChoices('[{"label":"A","options":[{"label":"1"}]}]'), false);
  assert.equal(isFlatGradeableChoices('[{"text":"no label"}]'), false);
  assert.equal(isFlatGradeableChoices('not json'), false);
});

test('parseSetObject validates required fields and coerces items to ints', () => {
  const ok = parseSetObject({ slug: 'redo-01', title: 'T', focusNote: 'n', subject: 'Quant', items: [1, '2', 3] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.set.items, [1, 2, 3]);
  assert.equal(parseSetObject({ slug: 'redo-01', items: [1] }).ok, true); // title/subject optional
  assert.equal(parseSetObject({ title: 'no slug', items: [1] }).ok, false);
  assert.equal(parseSetObject({ slug: 'bad slug!', items: [1] }).ok, false);
  assert.equal(parseSetObject({ slug: 'empty', items: [] }).ok, false);
});

test('readSetFiles skips malformed files and returns valid sets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipset-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ slug: 'a', title: 'A', subject: 'Quant', items: [1, 2] }));
  fs.writeFileSync(path.join(dir, 'b.json'), '{ this is not json');
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ title: 'no slug', items: [3] }));
  const sets = readSetFiles(dir);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].slug, 'a');
});

test('readSetFiles returns [] for a missing dir', () => {
  assert.deepEqual(readSetFiles('/no/such/dir/xyz'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/ai-practice-sets.test.js`
Expected: FAIL — `Cannot find module '../../src/ai-practice-sets'`.

- [ ] **Step 3: Write the module**

```js
// src/ai-practice-sets.js
'use strict';
const fs = require('fs');
const path = require('path');

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// True iff answer_choices is a non-empty flat array of {label,...} with no
// nested options[] (multi-part DI). Accepts a JSON string or an array.
function isFlatGradeableChoices(answerChoices) {
  let arr = answerChoices;
  if (typeof arr === 'string') {
    const text = arr.trim();
    if (!text) return false;
    try { arr = JSON.parse(text); } catch (_e) { return false; }
  }
  if (!Array.isArray(arr) || arr.length === 0) return false;
  return arr.every(
    (c) => c && typeof c === 'object' && !Array.isArray(c)
      && typeof c.label === 'string' && c.label.trim() !== ''
      && !('options' in c)
  );
}

// Validate + normalize one parsed set object.
function parseSetObject(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'not an object' };
  const slug = String(obj.slug || '').trim();
  if (!SLUG_RE.test(slug)) return { ok: false, error: 'missing/invalid slug' };
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items = rawItems.map((n) => Number.parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0);
  if (items.length === 0) return { ok: false, error: 'no valid items' };
  return {
    ok: true,
    set: {
      slug,
      title: String(obj.title || slug).trim(),
      focusNote: String(obj.focusNote || '').trim(),
      subject: String(obj.subject || '').trim(),
      items,
    },
  };
}

// Read every *.json in dir, return valid sets. Never throws; skips malformed.
function readSetFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_e) { return []; }
  const sets = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')); } catch (_e) { continue; }
    const res = parseSetObject(parsed);
    if (res.ok) sets.push(res.set);
  }
  return sets;
}

module.exports = { isFlatGradeableChoices, parseSetObject, readSetFiles, SLUG_RE };
```

- [ ] **Step 4: Create the data dir + gitignore entry**

```bash
mkdir -p data/ai-practice-sets && touch data/ai-practice-sets/.gitkeep
```

Add to `.gitignore` after the `/data/lsat-questions.json` line:

```
/data/ai-practice-sets/*.json
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/unit/ai-practice-sets.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/ai-practice-sets.js test/unit/ai-practice-sets.test.js data/ai-practice-sets/.gitkeep .gitignore
git commit -m "feat(ai-practice): set-file loader + flat-choices gradeability predicate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: db.js — candidate query, item resolver, session writer

**Files:**
- Modify: `src/db.js` (add functions; extend `platformWhereClause`; export new functions)
- Create: `test/unit/ai-curated-session.test.js`

**Interfaces:**
- Consumes: `withTransaction`, `saveScrapeResult`, `safeInt`, `all` (existing in `db.js`); `isFlatGradeableChoices` (Task 1).
- Produces:
  - `listAiPracticeCandidates({ subject, wrongOnly, limit }): Promise<Array<row>>` — curation helper.
  - `resolveAiPracticeSetItems(ids: number[]): Promise<{ items: Array<served>, missing: number[] }>` where `served = { itemId, qCode, source, subjectCode, categoryCode, subcategory, topic, difficulty, questionUrl, questionStem, questionStemHtml, answerChoices, responseFormat, correctAnswer, priorAttempt:{ correct, myAnswer, sessionDate, source } }`. `itemId` is the original `question_attempts.id`. Only flat-gradeable rows are returned in `items`; every id not returned is in `missing`.
  - `buildAiCuratedSessionData({ slug, title, subject, gradedItems, nowIso, sessionExternalId }): object` — pure; returns the `data` object shape `saveScrapeResult` consumes. `gradedItems[i] = { served, myAnswer, correct(0|1), timeSec, confidence }`.
  - `logAiCuratedSession({ slug, title, subject, gradedItems }): Promise<{ sessionId, sessionExternalId }>`.
  - `hash53(str): number` — 53-bit session-external-id hash.

- [ ] **Step 1: Write the failing test** (pure builder only — DB paths are manually verified in Task 6)

```js
// test/unit/ai-curated-session.test.js
/* global require */
const test = require('node:test');
const assert = require('node:assert');
const { buildAiCuratedSessionData, hash53 } = require('../../src/db');

const served = {
  itemId: 1287, qCode: 'gc-q-42', source: 'GMAT Club Error Log', subjectCode: 'Q',
  categoryCode: 'PS', subcategory: 'ARI', topic: 'Arithmetic', difficulty: 'Hard',
  questionUrl: 'https://x', questionStem: 'stem', questionStemHtml: null,
  answerChoices: '[{"label":"A","text":"1"},{"label":"B","text":"2"}]',
  responseFormat: 'single-choice', correctAnswer: 'B',
  priorAttempt: { correct: 0, myAnswer: 'A', sessionDate: '2026-07-01', source: 'GMAT Club Error Log' },
};

test('buildAiCuratedSessionData produces a saveScrapeResult-shaped object', () => {
  const data = buildAiCuratedSessionData({
    slug: 'redo-01', title: 'Redo', subject: 'Quant', nowIso: '2026-07-18T00:00:00Z',
    sessionExternalId: 999,
    gradedItems: [{ served, myAnswer: 'B', correct: 1, timeSec: 45, confidence: 'high' }],
  });
  const s = data.sessions[0];
  assert.equal(s.source, 'AI Curated Practice');
  assert.equal(s.session_id, 999);
  assert.equal(s.subject, 'Quant');
  assert.equal(s.stats.total_q_api, 1);
  assert.equal(s.stats.correct, 1);
  assert.equal(s.stats.errors, 0);
  const q = s.questions[0];
  assert.equal(q.q_code, 'gc-q-42');           // original q_code preserved (linkage)
  assert.equal(q.q_id, 'aic-att-redo-01-1');   // distinct attempt id
  assert.equal(q.topic_source, 'ai-curated');
  assert.equal(q.correct, 1);
  assert.equal(q.my_answer, 'B');
  assert.equal(q.correct_answer, 'B');
  assert.equal(q.difficulty_theta, undefined); // never set theta
});

test('hash53 is deterministic and within 2^53', () => {
  const a = hash53('ai-redo-01-123');
  assert.equal(a, hash53('ai-redo-01-123'));
  assert.ok(a >= 0 && a <= Number.MAX_SAFE_INTEGER);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/ai-curated-session.test.js`
Expected: FAIL — `buildAiCuratedSessionData is not a function`.

- [ ] **Step 3: Extend `platformWhereClause`** (in `src/db.js`, the function at ~line 1091)

Add the `ai-curated` branch and exclude it from `starttest`. Replace the function body:

```js
function platformWhereClause(platform) {
  // Heuristic match — matches the frontend's getSourcePlatform().
  if (platform === 'ai-curated') return "LOWER(COALESCE(s.source, '')) LIKE '%ai curated%'";
  if (platform === 'gmatclub-cat') return "LOWER(COALESCE(s.source, '')) LIKE '%gmat club cat%'";
  if (platform === 'gmatclub') return "LOWER(COALESCE(s.source, '')) LIKE '%gmat club%' AND LOWER(COALESCE(s.source, '')) NOT LIKE '%gmat club cat%'";
  if (platform === 'ttp') return "LOWER(COALESCE(s.source, '')) LIKE '%target test prep%'";
  if (platform === 'ope-mock') return "LOWER(COALESCE(s.source, '')) LIKE '%practice exam%'";
  if (platform === 'starttest') {
    return "LOWER(COALESCE(s.source, '')) NOT LIKE '%gmat club%' AND LOWER(COALESCE(s.source, '')) NOT LIKE '%target test prep%' AND LOWER(COALESCE(s.source, '')) NOT LIKE '%practice exam%' AND LOWER(COALESCE(s.source, '')) NOT LIKE '%ai curated%'";
  }
  return null;
}
```

- [ ] **Step 4: Add the new functions** near the other writers in `src/db.js` (e.g. just after `saveScrapeResult`)

```js
// 53-bit deterministic hash (mirrors the scrapers' hashSessionExternalId).
function hash53(input) {
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

// Curation helper: gradeable redo candidates for Claude Cowork to pick from.
// subject is a subject_code ('Q'|'V'|'DI') or falsy for all. wrongOnly defaults true.
async function listAiPracticeCandidates({ subject = '', wrongOnly = true, limit = 40 } = {}) {
  const conds = [
    "qa.question_stem IS NOT NULL AND length(qa.question_stem) > 10",
    "qa.answer_choices IS NOT NULL AND qa.answer_choices NOT IN ('', '[]')",
    "qa.correct_answer IS NOT NULL AND qa.correct_answer <> ''",
    "LOWER(COALESCE(s.source, '')) NOT LIKE '%ai curated%'",
  ];
  const params = [];
  if (wrongOnly) conds.push('qa.correct = 0');
  if (subject) { conds.push('qa.subject_code = ?'); params.push(subject); }
  params.push(safeInt(limit) || 40);
  const rows = await all(
    `SELECT qa.id, qa.q_code, s.source, qa.topic, qa.subcategory, qa.difficulty,
            qa.correct, qa.answer_choices, qa.created_at
       FROM question_attempts qa JOIN sessions s ON s.id = qa.session_id
      WHERE ${conds.join(' AND ')}
      ORDER BY qa.created_at ASC
      LIMIT ?`,
    params
  );
  // Final flat-gradeable filter (excludes multi-part DI) in JS.
  return rows.filter((r) => isFlatGradeableChoices(r.answer_choices));
}

// Resolve set item ids to servable question payloads + prior-attempt summary.
async function resolveAiPracticeSetItems(ids) {
  const clean = (Array.isArray(ids) ? ids : []).map((n) => safeInt(n)).filter((n) => Number.isInteger(n) && n > 0);
  if (clean.length === 0) return { items: [], missing: [] };
  const placeholders = clean.map(() => '?').join(', ');
  const rows = await all(
    `SELECT qa.id, qa.q_code, s.source AS source, qa.subject_code, qa.category_code,
            qa.subcategory, qa.topic, qa.difficulty, qa.question_url, qa.question_stem,
            qa.question_stem_html, qa.answer_choices, qa.response_format,
            qa.correct_answer, qa.correct AS prior_correct, qa.my_answer AS prior_my_answer,
            s.session_date AS prior_session_date
       FROM question_attempts qa JOIN sessions s ON s.id = qa.session_id
      WHERE qa.id IN (${placeholders})`,
    clean
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = [];
  const missing = [];
  for (const id of clean) {           // preserve the set's item order
    const r = byId.get(id);
    if (!r || !isFlatGradeableChoices(r.answer_choices) || !r.correct_answer) { missing.push(id); continue; }
    items.push({
      itemId: r.id, qCode: r.q_code, source: r.source, subjectCode: r.subject_code,
      categoryCode: r.category_code, subcategory: r.subcategory, topic: r.topic,
      difficulty: r.difficulty, questionUrl: r.question_url, questionStem: r.question_stem,
      questionStemHtml: r.question_stem_html, answerChoices: r.answer_choices,
      responseFormat: r.response_format, correctAnswer: r.correct_answer,
      priorAttempt: {
        correct: r.prior_correct, myAnswer: r.prior_my_answer,
        sessionDate: r.prior_session_date, source: r.source,
      },
    });
  }
  return { items, missing };
}

// Pure: build the data object saveScrapeResult() consumes for one AI-curated run.
function buildAiCuratedSessionData({ slug, title, subject, gradedItems, nowIso, sessionExternalId }) {
  const items = Array.isArray(gradedItems) ? gradedItems : [];
  const total = items.length;
  const correct = items.filter((g) => Number(g.correct) === 1).length;
  const errors = total - correct;
  const times = items.map((g) => safeInt(g.timeSec)).filter((n) => Number.isInteger(n) && n >= 0);
  const avgTime = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
  const accuracy = total ? Math.round((correct / total) * 1000) / 10 : null;
  const dateOnly = String(nowIso || new Date().toISOString()).slice(0, 10);
  return {
    extracted_at: nowIso || new Date().toISOString(),
    sessions: [{
      session_id: sessionExternalId,
      source: 'AI Curated Practice',
      subject: subject || null,
      date: dateOnly,
      title: title || slug,
      stats: { total_q_api: total, total_q_categories: total, correct, errors, accuracy_pct: accuracy, avg_time_sec: avgTime },
      questions: items.map((g, i) => ({
        q_code: g.served.qCode || null,
        q_id: `aic-att-${slug}-${i + 1}`,
        subject_code: g.served.subjectCode || null,
        category_code: g.served.categoryCode || null,
        subcategory: g.served.subcategory || null,
        topic: g.served.topic || null,
        topic_source: 'ai-curated',
        question_url: g.served.questionUrl || null,
        question_stem: g.served.questionStem || null,
        question_stem_html: g.served.questionStemHtml || null,
        answer_choices: g.served.answerChoices || null,
        response_format: g.served.responseFormat || null,
        correct: Number(g.correct) === 1 ? 1 : 0,
        my_answer: g.myAnswer || null,
        correct_answer: g.served.correctAnswer || null,
        difficulty: g.served.difficulty || null,   // copy text label; theta stays NULL
        time_sec: safeInt(g.timeSec),
        confidence: g.confidence || null,
      })),
    }],
  };
}

async function logAiCuratedSession({ slug, title, subject, gradedItems }) {
  const nowIso = new Date().toISOString();
  const sessionExternalId = hash53(`ai-${slug}-${Date.now()}`);
  const data = buildAiCuratedSessionData({ slug, title, subject, gradedItems, nowIso, sessionExternalId });
  await saveScrapeResult(data, { source: 'AI Curated Practice' });
  const row = await get(
    `SELECT id FROM sessions WHERE session_external_id = ? AND source = ? ORDER BY id DESC LIMIT 1`,
    [sessionExternalId, 'AI Curated Practice']
  );
  return { sessionId: row ? row.id : null, sessionExternalId };
}
```

- [ ] **Step 5: Wire the require + exports**

Near the top of `src/db.js` where other local modules are required, add:

```js
const { isFlatGradeableChoices } = require('./ai-practice-sets');
```

In the `module.exports = { ... }` block, add:

```js
  listAiPracticeCandidates,
  resolveAiPracticeSetItems,
  buildAiCuratedSessionData,
  logAiCuratedSession,
  hash53,
```

(Confirm `get` and `all` are defined/available in `db.js` — they are the standard wrappers used throughout.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/unit/ai-curated-session.test.js`
Expected: PASS (2 tests).

- [ ] **Step 7: Run the full unit suite + lint (no regressions)**

Run: `npm test`
Expected: all existing tests still PASS.
Run: `npm run lint`
Expected: still 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/db.js test/unit/ai-curated-session.test.js
git commit -m "feat(ai-practice): candidate query, item resolver, session writer

- platformWhereClause: add ai-curated, exclude it from starttest
- resolveAiPracticeSetItems serves flat-gradeable rows only
- logAiCuratedSession reuses saveScrapeResult; preserves original q_code

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: server.js — three REST endpoints

**Files:**
- Modify: `src/server.js` (add endpoints; require the loader + `path`/`fs` are already imported as `path`/`fsLib`)

**Interfaces:**
- Consumes: `readSetFiles` (Task 1); `resolveAiPracticeSetItems`, `logAiCuratedSession` (Task 2); `db.all` for the completed-session lookup.
- Produces (HTTP):
  - `GET /api/ai-practice/sets` → `{ sets: [{ slug, title, focusNote, subject, count, completedCount }] }`
  - `GET /api/ai-practice/sets/:slug` → `{ slug, title, focusNote, subject, questions:[{ itemId, topic, difficulty, source, question_stem, question_stem_html, answer_choices }], missing:number[] }` (no `correct_answer`, no per-choice `isCorrect`)
  - `POST /api/ai-practice/sets/:slug/submit` body `{ answers:[{ itemId, answer, timeSec, confidence }] }` → `{ sessionId, score:{ correct, total }, results:[{ itemId, correct, yourAnswer, correctAnswer, priorAttempt }] }`

- [ ] **Step 1: Add the set-dir helper + require near the top of `src/server.js`** (after the existing requires and `loadLsatData`)

```js
const { readSetFiles } = require('./ai-practice-sets');
const AI_SETS_DIR = path.join(__dirname, '..', 'data', 'ai-practice-sets');
function loadAiPracticeSets() { return readSetFiles(AI_SETS_DIR); }  // fresh every call — no cache
```

- [ ] **Step 2: Add `GET /api/ai-practice/sets`** (place beside the other `/api/...` routes)

```js
app.get('/api/ai-practice/sets', async (req, res) => {
  try {
    const sets = loadAiPracticeSets();
    // completedCount = how many logged AI-curated sessions exist per slug (q_id prefix aic-att-<slug>-).
    const counts = await db.all(
      `SELECT count(DISTINCT qa.session_id) AS n,
              substring(qa.q_id from 'aic-att-(.*)-[0-9]+$') AS slug
         FROM question_attempts qa
        WHERE qa.q_id LIKE 'aic-att-%'
        GROUP BY slug`
    );
    const bySlug = new Map(counts.map((c) => [c.slug, Number(c.n) || 0]));
    res.json({
      sets: sets.map((s) => ({
        slug: s.slug, title: s.title, focusNote: s.focusNote, subject: s.subject,
        count: s.items.length, completedCount: bySlug.get(s.slug) || 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

Note: the `substring(... from '...')` regex contains no `?`, so `toPg` is safe. If `db.all` routes through `toPg`, the literal `'aic-att-%'` LIKE pattern is a value in SQL text (no placeholder) — fine.

- [ ] **Step 3: Add `GET /api/ai-practice/sets/:slug`** (serve, correct answer stripped)

```js
app.get('/api/ai-practice/sets/:slug', async (req, res) => {
  try {
    const set = loadAiPracticeSets().find((s) => s.slug === req.params.slug);
    if (!set) return res.status(404).json({ error: 'Set not found' });
    const { items, missing } = await db.resolveAiPracticeSetItems(set.items);
    res.json({
      slug: set.slug, title: set.title, focusNote: set.focusNote, subject: set.subject,
      missing,
      questions: items.map((it) => ({
        itemId: it.itemId, topic: it.topic, difficulty: it.difficulty, source: it.source,
        question_stem: it.questionStem, question_stem_html: it.questionStemHtml,
        // Strip per-choice isCorrect/isUserSelected/value flags — send label+text only.
        answer_choices: safeParseChoices(it.answerChoices).map((c) => ({ label: c.label, text: c.text })),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function safeParseChoices(raw) {
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch (_e) { return []; }
}
```

- [ ] **Step 4: Add `POST /api/ai-practice/sets/:slug/submit`** (grade server-side + log)

```js
app.post('/api/ai-practice/sets/:slug/submit', async (req, res) => {
  try {
    const set = loadAiPracticeSets().find((s) => s.slug === req.params.slug);
    if (!set) return res.status(404).json({ error: 'Set not found' });
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (answers.length === 0) return res.status(400).json({ error: 'No answers submitted' });

    const { items } = await db.resolveAiPracticeSetItems(set.items);
    const byItem = new Map(items.map((it) => [it.itemId, it]));

    const gradedItems = [];
    const results = [];
    for (const a of answers) {
      const it = byItem.get(Number(a.itemId));
      if (!it) continue;                                   // stale/unavailable — skip
      const your = String(a.answer || '').trim();
      const key = String(it.correctAnswer || '').trim();
      const correct = gradeAnswer(your, key, it.answerChoices) ? 1 : 0;
      gradedItems.push({ served: it, myAnswer: your, correct, timeSec: a.timeSec, confidence: a.confidence });
      results.push({ itemId: it.itemId, correct, yourAnswer: your, correctAnswer: key, priorAttempt: it.priorAttempt });
    }
    if (gradedItems.length === 0) return res.status(400).json({ error: 'No gradeable answers' });

    const { sessionId } = await db.logAiCuratedSession({
      slug: set.slug, title: set.title, subject: set.subject, gradedItems,
    });
    res.json({
      sessionId,
      score: { correct: gradedItems.filter((g) => g.correct === 1).length, total: gradedItems.length },
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grade a chosen label against the stored correct_answer. Matches on label
// (case-insensitive), or on the chosen choice's text when correct_answer holds
// full text rather than a letter.
function gradeAnswer(yourLabel, correctAnswer, answerChoicesJson) {
  const y = String(yourLabel || '').trim().toUpperCase();
  const k = String(correctAnswer || '').trim().toUpperCase();
  if (!y || !k) return false;
  if (y === k) return true;
  const choices = safeParseChoices(answerChoicesJson);
  const chosen = choices.find((c) => String(c.label || '').trim().toUpperCase() === y);
  if (chosen && String(chosen.text || '').trim().toUpperCase() === k) return true;
  return false;
}
```

- [ ] **Step 5: Manual smoke of the endpoints** (server must be running: `npm run dev:api`)

Write a tiny set referencing two real gradeable ids (find them first):

```bash
docker exec gmat-pg psql -U postgres -d gmat -t -c "SELECT qa.id FROM question_attempts qa JOIN sessions s ON s.id=qa.session_id WHERE qa.correct=0 AND qa.answer_choices NOT IN ('','[]') AND qa.correct_answer<>'' AND qa.question_stem IS NOT NULL LIMIT 2;"
```

Create `data/ai-practice-sets/smoke-01.json` with those two ids, then:

```bash
curl -s localhost:4310/api/ai-practice/sets | head
curl -s localhost:4310/api/ai-practice/sets/smoke-01 | head
```

Expected: the set lists with `count: 2`; the serve response contains `question_stem` and `answer_choices` but **no** `correct_answer`.

- [ ] **Step 6: Commit**

```bash
git add src/server.js
git commit -m "feat(ai-practice): sets list/serve/submit endpoints (server-side grading)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Frontend plumbing — badge, filters, route, button

**Files:**
- Modify: `client/src/App.jsx` (`getSourcePlatform`, `SourceBadge`, two source-filter `<Select>`s, `modeFromHash`, the render branch, top-bar button)
- Modify: `client/src/styles.css` (`.source-ai`)

**Interfaces:**
- Consumes: `AiPractice` default export (Task 5) — imported lazily like `LsatPractice`.
- Produces: `#ai-practice` hash route renders the tab; `ai-curated` recognized everywhere `getSourcePlatform`/platform filters are used.

- [ ] **Step 1: `getSourcePlatform`** — add the `ai-curated` rule (before the `starttest` fallback), function at ~line 789:

```js
function getSourcePlatform(sourceLabel) {
  const raw = String(sourceLabel || '').trim();
  if (!raw) return null;
  if (/lsat/i.test(raw)) return 'lsat';
  if (/ai\s*curated/i.test(raw)) return 'ai-curated';
  if (/gmat\s*club\s*cat/i.test(raw)) return 'gmatclub-cat';
  if (/gmat\s*club/i.test(raw)) return 'gmatclub';
  if (/target\s*test\s*prep/i.test(raw)) return 'ttp';
  if (/official\s*practice\s*exam/i.test(raw)) return 'ope-mock';
  return 'starttest';
}
```

- [ ] **Step 2: `SourceBadge`** — add the label (function at ~line 800):

```js
  const label =
    platform === 'lsat' ? 'LSAT' :
    platform === 'ai-curated' ? 'AI Curated' :
    platform === 'gmatclub-cat' ? 'GMAT Club CAT' :
    platform === 'gmatclub' ? 'GMAT Club' :
    platform === 'ttp' ? 'Target Test Prep' :
    platform === 'ope-mock' ? 'Practice Exam' :
    'Official Guide';
```

- [ ] **Step 3: Source-filter `<option>`s** — add to BOTH selects (sessions table ~line 3312, error-log ~line 3512). In each `<Select>` add after the LSAT option:

```jsx
              <option value="ai-curated">AI Curated</option>
```

- [ ] **Step 4: `.source-ai` badge CSS** — after `.source-chip.source-lsat` in `client/src/styles.css`, mirroring the existing variants' shape (use the forest-sage primary from DESIGN.md):

```css
.source-chip.source-ai {
  background: rgba(61, 122, 94, 0.14);
  color: #2f5f49;
  border-color: rgba(61, 122, 94, 0.30);
}
```

(Match the exact property set the sibling `.source-*` rules use — open one to confirm the properties before writing.)

- [ ] **Step 5: Lazy import + route + render branch + top-bar button**

Near the `LsatPractice` lazy import (~line 12):

```js
const AiPractice = lazy(() => import('./AiPractice'));
```

`modeFromHash` (~line 1062) — add:

```js
function modeFromHash(hash) {
  if (hash === '#lsat') return 'lsat';
  if (hash === '#ai-practice') return 'ai-practice';
  if (hash === '#study-plan' || hash === '#plan') return 'study-plan';
  return 'gmat';
}
```

Render branch — beside the `appMode === 'lsat'` block (~line 2804):

```jsx
  if (appMode === 'ai-practice') {
    return (
      <Suspense fallback={<RouteFallback />}>
        <AiPractice onExit={() => { window.location.hash = ''; }} />
      </Suspense>
    );
  }
```

Top-bar button — after the "LSAT Practice" button (~line 2842):

```jsx
          <Button variant="outline" size="sm" type="button" onClick={() => { window.location.hash = '#ai-practice'; }}>
            AI Practice
          </Button>
```

- [ ] **Step 6: Verify build + lint**

Run: `npm run build:web`
Expected: build succeeds (AiPractice import will fail if Task 5 not done yet — do Step 6 AFTER Task 5, or stub the file first with `export default function AiPractice(){return null}`).
Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 7: Commit** (commit together with Task 5, or stub-first). If stubbing:

```bash
git add client/src/App.jsx client/src/styles.css
git commit -m "feat(ai-practice): source badge, filters, hash route + top-bar button

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: AiPractice.jsx — set list → runner → result

**Files:**
- Create: `client/src/AiPractice.jsx`

**Interfaces:**
- Consumes: the three `/api/ai-practice/*` endpoints (Task 3); `onExit: () => void` prop.
- Produces: `export default function AiPractice({ onExit })`.

- [ ] **Step 1: Write the component**

```jsx
// client/src/AiPractice.jsx
import React, { useEffect, useState, useCallback, useRef } from 'react';

const API = '/api/ai-practice';

export default function AiPractice({ onExit }) {
  const [screen, setScreen] = useState('list');      // 'list' | 'runner' | 'result'
  const [activeSet, setActiveSet] = useState(null);  // { slug, title, focusNote, questions[] }
  const [feedbackMode, setFeedbackMode] = useState('end'); // 'end' | 'immediate'
  const [result, setResult] = useState(null);        // submit response

  const startSet = useCallback(async (slug, mode) => {
    const r = await fetch(`${API}/sets/${slug}`);
    if (!r.ok) { alert('Could not load set'); return; }
    const data = await r.json();
    if (!data.questions?.length) { alert('This set has no gradeable questions.'); return; }
    setActiveSet(data);
    setFeedbackMode(mode);
    setScreen('runner');
  }, []);

  const finish = useCallback(async (answers) => {
    const r = await fetch(`${API}/sets/${activeSet.slug}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    const data = await r.json();
    if (!r.ok) { alert(data.error || 'Submit failed'); return; }
    setResult(data);
    setScreen('result');
  }, [activeSet]);

  return (
    <div className="lsat-st-root">
      <div className="lsat-st-topnav">
        <button type="button" className="lsat-st-icon-btn" onClick={onExit} title="Exit">← Dashboard</button>
        <span className="lsat-st-tab-label">AI Curated Practice</span>
      </div>
      {screen === 'list' && <SetList onStart={startSet} />}
      {screen === 'runner' && (
        <Runner set={activeSet} feedbackMode={feedbackMode} onFinish={finish} onQuit={() => setScreen('list')} />
      )}
      {screen === 'result' && (
        <Result set={activeSet} result={result} onBack={() => { setScreen('list'); setActiveSet(null); setResult(null); }} />
      )}
    </div>
  );
}

function SetList({ onStart }) {
  const [sets, setSets] = useState(null);
  const [mode, setMode] = useState('end');
  useEffect(() => {
    fetch(`${API}/sets`).then((r) => r.json()).then((d) => setSets(d.sets || [])).catch(() => setSets([]));
  }, []);
  if (sets === null) return <div className="lsat-st-body">Loading…</div>;
  if (sets.length === 0) {
    return (
      <div className="lsat-st-body">
        <h2>No practice sets yet</h2>
        <p className="muted">Curate a set with Claude Cowork — it writes a JSON file to
          <code> data/ai-practice-sets/</code>. See the recipe in ANALYSIS.md.</p>
      </div>
    );
  }
  return (
    <div className="lsat-st-body">
      <div className="ai-feedback-toggle">
        Feedback:
        <label><input type="radio" checked={mode === 'end'} onChange={() => setMode('end')} /> End of session</label>
        <label><input type="radio" checked={mode === 'immediate'} onChange={() => setMode('immediate')} /> After each question</label>
      </div>
      <div className="ai-set-grid">
        {sets.map((s) => (
          <div key={s.slug} className="ai-set-card">
            <h3>{s.title}</h3>
            {s.subject && <span className="ai-set-subject">{s.subject}</span>}
            {s.focusNote && <p className="ai-set-note">{s.focusNote}</p>}
            <p className="muted">{s.count} question{s.count === 1 ? '' : 's'}
              {s.completedCount ? ` · practiced ${s.completedCount}×` : ''}</p>
            <button type="button" className="ai-btn-primary" onClick={() => onStart(s.slug, mode)}>
              {s.completedCount ? 'Practice again' : 'Start'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Runner({ set, feedbackMode, onFinish, onQuit }) {
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({});        // itemId -> { answer, timeSec, confidence }
  const [revealed, setRevealed] = useState(false);   // immediate mode: reveal current
  const startRef = useRef(Date.now());
  const q = set.questions[idx];
  const last = idx === set.questions.length - 1;

  useEffect(() => { startRef.current = Date.now(); setRevealed(false); }, [idx]);

  const pick = (label) => {
    const timeSec = Math.round((Date.now() - startRef.current) / 1000);
    setAnswers((a) => ({ ...a, [q.itemId]: { answer: label, timeSec, confidence: a[q.itemId]?.confidence || null } }));
  };
  const chosen = answers[q.itemId]?.answer || null;

  const next = () => {
    if (feedbackMode === 'immediate' && !revealed) { setRevealed(true); return; }
    if (last) {
      const payload = set.questions
        .filter((it) => answers[it.itemId])
        .map((it) => ({ itemId: it.itemId, ...answers[it.itemId] }));
      onFinish(payload);
    } else {
      setIdx((i) => i + 1);
    }
  };

  return (
    <div className="lsat-st-body ai-runner">
      <div className="ai-runner-head">
        <span>Question {idx + 1} / {set.questions.length}</span>
        <button type="button" className="ai-btn-ghost" onClick={onQuit}>Quit</button>
      </div>
      <div className="ai-stem">
        {q.question_stem_html
          ? <div dangerouslySetInnerHTML={{ __html: q.question_stem_html }} />
          : <div style={{ whiteSpace: 'pre-line' }}>{q.question_stem}</div>}
      </div>
      <ul className="ai-choices">
        {q.answer_choices.map((c) => (
          <li key={c.label}>
            <button
              type="button"
              className={`ai-choice${chosen === c.label ? ' selected' : ''}`}
              onClick={() => pick(c.label)}
              disabled={feedbackMode === 'immediate' && revealed}
            >
              <b>{c.label}.</b> <span dangerouslySetInnerHTML={{ __html: c.text || '' }} />
            </button>
          </li>
        ))}
      </ul>
      {feedbackMode === 'immediate' && revealed && (
        <p className="muted">Answer recorded — correctness shown on the results screen.</p>
      )}
      <div className="ai-runner-foot">
        <button type="button" className="ai-btn-primary" onClick={next} disabled={!chosen}>
          {feedbackMode === 'immediate' && !revealed ? 'Check' : last ? 'Finish' : 'Next'}
        </button>
      </div>
    </div>
  );
}

function Result({ set, result, onBack }) {
  const byId = new Map((set.questions || []).map((q) => [q.itemId, q]));
  return (
    <div className="lsat-st-body ai-result">
      <h2>Score: {result.score.correct} / {result.score.total}</h2>
      {set.focusNote && <p className="ai-set-note">{set.focusNote}</p>}
      <ol className="ai-review-list">
        {result.results.map((r, i) => {
          const q = byId.get(r.itemId);
          const prior = r.priorAttempt || {};
          return (
            <li key={r.itemId} className={r.correct ? 'ok' : 'bad'}>
              <div className="ai-review-q">{i + 1}. {q?.question_stem?.slice(0, 120) || `Item ${r.itemId}`}…</div>
              <div className="ai-review-meta">
                You: <b>{r.yourAnswer}</b> · Correct: <b>{r.correctAnswer}</b> · {r.correct ? '✓' : '✗'}
                {prior.source && (
                  <span className="muted"> · originally on {prior.source}: {prior.correct ? 'correct' : 'wrong'}</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <button type="button" className="ai-btn-primary" onClick={onBack}>Back to sets</button>
    </div>
  );
}
```

- [ ] **Step 2: Add minimal styles** to `client/src/styles.css` (below the source-chip block):

```css
.ai-set-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.ai-set-card { border: 1px solid var(--border, #e5e0d5); border-radius: 12px; padding: 16px; background: var(--surface, #fbf9f4); }
.ai-set-note { font-size: 0.9rem; opacity: 0.85; }
.ai-choices { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ai-choice { width: 100%; text-align: left; padding: 12px 14px; border: 1px solid var(--border, #e5e0d5); border-radius: 10px; background: transparent; cursor: pointer; }
.ai-choice.selected { border-color: #3d7a5e; background: rgba(61,122,94,0.10); }
.ai-runner-head, .ai-runner-foot, .ai-feedback-toggle { display: flex; gap: 16px; align-items: center; justify-content: space-between; margin: 12px 0; }
.ai-btn-primary { background: #3d7a5e; color: #fff; border: none; border-radius: 8px; padding: 10px 18px; cursor: pointer; }
.ai-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.ai-review-list li.ok { border-left: 3px solid #3d7a5e; padding-left: 10px; margin: 8px 0; }
.ai-review-list li.bad { border-left: 3px solid #b4483c; padding-left: 10px; margin: 8px 0; }
```

(Reuse existing `.lsat-st-*` shell classes for the top nav / body so the tab visually matches LSAT Practice — confirm those class names exist in `styles.css`; if the exact names differ, use the ones `LsatPractice.jsx` actually renders.)

- [ ] **Step 3: Build**

Run: `npm run build:web`
Expected: succeeds.
Run: `npm run lint`
Expected: 0 errors (component is ESM/JSX — matches the frontend glob).

- [ ] **Step 4: Commit**

```bash
git add client/src/AiPractice.jsx client/src/styles.css client/src/App.jsx
git commit -m "feat(ai-practice): AiPractice tab (set list, runner, result)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Curation recipe doc + end-to-end verification

**Files:**
- Modify: `ANALYSIS.md` (add a "Curating an AI Practice set" section)
- Create: memory `~/.claude/projects/.../memory/project_ai_curated_practice.md` + MEMORY.md pointer

- [ ] **Step 1: Document the curation recipe** in `ANALYSIS.md`

Add a section describing: how to find redo candidates (the `listAiPracticeCandidates` SQL, reproduced), the set-file schema, where files live (`data/ai-practice-sets/<slug>.json`), that they're read fresh (no restart), and that items are `question_attempts.id` values. Example set file included.

- [ ] **Step 2: End-to-end manual verification** (app running via `npm run dev`)

1. Curate a real set: run the candidate SQL, pick 3 ids, write `data/ai-practice-sets/verify-quant-01.json`.
2. In the browser, click **AI Practice** → the set appears → Start.
3. Answer all 3, Finish → results screen shows score + per-question correct/your/prior.
4. Verify the log:

```bash
docker exec gmat-pg psql -U postgres -d gmat -c "SELECT s.source, s.subject, count(qa.id) FROM sessions s JOIN question_attempts qa ON qa.session_id=s.id WHERE s.source='AI Curated Practice' GROUP BY s.id, s.source, s.subject ORDER BY s.id DESC LIMIT 3;"
```

Expected: a session with source `AI Curated Practice`.

5. Verify cross-platform linkage (pick one q_code from the set's source):

```bash
docker exec gmat-pg psql -U postgres -d gmat -c "SELECT s.source, qa.q_id, qa.correct, qa.my_answer, qa.created_at FROM question_attempts qa JOIN sessions s ON s.id=qa.session_id WHERE qa.q_code='<original-q_code>' ORDER BY qa.created_at;"
```

Expected: BOTH the original attempt (e.g. GMAT Club) and the `aic-att-…` redo, same `q_code`.

6. In the dashboard, open the sessions table, filter Source → **AI Curated**: the new session shows with the AI Curated badge and appears in performance-by-session.

- [ ] **Step 3: Clean up scratch** (per CLAUDE.md `/tmp` convention) and remove the verify set file if not keeping it.

- [ ] **Step 4: Commit docs**

```bash
git add ANALYSIS.md
git commit -m "docs(ai-practice): curation recipe for AI Practice sets

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review (completed)

- **Spec coverage:** tab/route (T4,T5) · set files read fresh (T1,T3) · serve strips answer (T3) · server-side grading (T3) · session logged as "AI Curated Practice" with original q_code (T2) · new session per run via `hash53(slug|now)` (T2) · source badge/filters/platformWhereClause incl. starttest exclusion (T2,T4) · v1 flat-choices only / multi-part skipped (T1 predicate, used in T2/T3) · difficulty copied, theta never set (T2) · empty-state + missing-item handling (T3,T5) · curation recipe (T6) · unit tests (T1,T2) + manual E2E (T3,T6). No gaps.
- **Placeholder scan:** all code steps carry real code; SQL uses `?` only; no TBD/TODO.
- **Type consistency:** `served`/`gradedItems` shapes match between `resolveAiPracticeSetItems` → `buildAiCuratedSessionData` → `logAiCuratedSession`; endpoint payload field names (`itemId`, `answer`, `answer_choices`, `question_stem_html`) match between T3 serve/submit and T5 component.
