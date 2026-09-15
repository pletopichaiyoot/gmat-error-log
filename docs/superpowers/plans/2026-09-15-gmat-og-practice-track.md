# GMAT OG Practice Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 377 extracted GMAT Official Guide CR/RC questions into a working practice surface — filter-based set builder, runner, review — whose results land in the main dashboard's session list and error log under `platform=og`.

**Architecture:** Question content stays in `data/gmat-og-questions.json` and is served from an in-process cache (`src/og-data.js`); only user answers hit Postgres (`og_attempts` / `og_sessions`, migration `0010`). A pure set-builder module (`src/og-set-builder.js`) resolves filters to a question list so it can be unit-tested without a database. `src/og-dashboard.js` maps OG rows into the dashboard's existing session/question row shapes, exactly as `src/lsat-dashboard.js` does for LSAT. The UI is one new lazy-loaded screen at `#og` reusing the `.lsat-st-*` test chrome and the shared `PassageLines` component.

**Tech Stack:** Node 20 + Express (CJS), PostgreSQL 16 via raw SQL in `src/db.js`, React 18 + Vite (ESM), `node:test` unit tests.

**Spec:** `docs/superpowers/specs/2026-09-14-gmat-og-verbal-extraction-design.md` (sections "Database", "Backend module and API", "Set builder", "Frontend", "Testing"). The extraction half of that spec is already built and recorded complete in `docs/superpowers/plans/2026-09-14-gmat-og-verbal-extraction.md`.

## Global Constraints

- **Backend is CommonJS** (`require`/`module.exports`); **frontend is ESM + JSX**. Do not mix within a file.
- **`src/db.js` SQL must contain no literal `?` other than a placeholder** — `toPg` (`src/sql-util.js`) rewrites every `?` to `$n`. No jsonb `?` operators, no `?` inside a regex in SQL.
- **Multi-statement writes use `withTransaction(async (tx) => …)`** with `tx.run/all/get`; inserts read their id with `RETURNING id`.
- **`mistake_type` must round-trip through `canonicalizeMistakeTypeValue`** (`src/mistake-tags.js`) on every write path. It stores a JSON array string in canonical dimension order, or NULL.
- **Schema changes are new numbered files in `migrations/`** — never `CREATE`/`ALTER` inside `initDb()`.
- **Only `usable === true` questions are ever served.** A question with a defective passage, stem, choices or key is excluded; a missing explanation is not a defect.
- **`loadOgData()` caches in-process — restart the API after regenerating `data/gmat-og-questions.json`.**
- **`data/gmat-og-questions.json` and `docs/*.pdf` are gitignored and must never be committed.** The repo is public and the books are copyrighted.
- ESLint: `npm run lint` must add **zero new errors** (warnings are tolerated; the baseline is 0 errors / ~127 warnings).
- Every task ends with `npm test` passing and a commit.

## File Structure

| File | Responsibility |
|---|---|
| `migrations/0010_gmat_og_practice.sql` | `og_attempts`, `og_sessions`, indexes |
| `src/db.js` (modify) | OG CRUD: attempts, sessions, errors, annotation, stats |
| `src/og-data.js` (new) | Cached reader + index over `data/gmat-og-questions.json`; library facets |
| `src/og-set-builder.js` (new) | Pure filter → question-list resolution (RC draws whole passages) |
| `src/og-dashboard.js` (new) | OG rows → dashboard session/question row shapes; analysis; annotation |
| `src/server.js` (modify) | `/api/og/*` routes; merge OG into `/api/sessions`, `/api/errors`, analysis, PATCH |
| `client/src/GmatOgPractice.jsx` (new) | Builder screen, runner, summary |
| `client/src/App.jsx` (modify) | Lazy import, `#og` route, nav button, `getSourcePlatform` |
| `client/src/styles.css` (modify) | `.source-chip.source-og` |
| `scripts/og/assemble.js` (modify) | New `boldface-unmarked` usability rule |
| `test/unit/og-set-builder.test.js` (new) | Builder behaviour |
| `test/unit/og-data.test.js` (new) | Index + facets over a fixture pool |
| `test/unit/og-dashboard.test.js` (new) | Row-shape mapping |
| `test/unit/og-assemble.test.js` (modify) | Boldface rule |

---

### Task 1: Drop boldface CR questions that carry no bold markup

**Why:** 17 CR stems ask "the portion in **boldface** plays which of the following roles"; 9 of them are currently marked `usable`. The extraction never produced a `stemHtml` field (`stemHtml` count in the pool is 0), so the boldface spans are gone and the question cannot be answered as rendered. Under the project's usability rule — a defect in the stem drops the question — these 9 must go before anything serves them. Usable count goes 377 → 368.

**Files:**
- Modify: `scripts/og/assemble.js:203-215` (`unusableReason`)
- Test: `test/unit/og-assemble.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `data/gmat-og-questions.json` where every `usable` question is answerable as rendered. Later tasks assume this.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/og-assemble.test.js`:

```js
const { unusableReason } = require('../../scripts/og/assemble');

// 17 CR stems ask what role "the portion in boldface" plays. The extraction
// never recovered the bold spans (no question in the pool carries stemHtml), so
// the stem is unanswerable as rendered — a stem defect, which drops the
// question.
test('a boldface question with no bold markup is unusable', () => {
  const boldStem = {
    stem: 'In the hunter’s argument, the portion in boldface plays which of the following roles?',
    choices,
  };
  assert.strictEqual(unusableReason(boldStem, 'A', false, 'CR'), 'boldface-unmarked');
});

test('a boldface question keeps its markup when stemHtml recovered the spans', () => {
  const marked = {
    stem: 'The portion in boldface plays which of the following roles?',
    stemHtml: 'The portion in <b>boldface</b> plays which of the following roles?',
    choices,
  };
  assert.strictEqual(unusableReason(marked, 'A', false, 'CR'), null);
});

test('an ordinary stem that merely contains the word bold is untouched', () => {
  const ordinary = { stem: 'The bold claim above depends on which assumption?', choices };
  assert.strictEqual(unusableReason(ordinary, 'A', false, 'CR'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/og-assemble.test.js`
Expected: FAIL — `unusableReason` returns `null` where `'boldface-unmarked'` is expected.

- [ ] **Step 3: Add the rule**

In `scripts/og/assemble.js`, above `function unusableReason`:

```js
// "In the argument above, the portion in boldface plays which of the following
// roles?" is unanswerable unless the bold span survived extraction. It did not:
// pdftotext drops font weight and the pdfplumber pass never emitted stemHtml,
// so every one of these stems reads as undifferentiated prose. A stem defect
// drops the question. `\bbold` with the words that follow, rather than a bare
// "bold", so "the bold claim above" is not caught.
const BOLDFACE_STEM = /\bbold\s?face\b|\bportions?\s+in\s+bold\b|\bboldfaced\b/i;
```

and inside `unusableReason`, immediately after the `stem` emptiness check:

```js
  if (BOLDFACE_STEM.test(q.stem) && !/<b[\s>]/i.test(q.stemHtml || '')) return 'boldface-unmarked';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/og-assemble.test.js`
Expected: PASS.

- [ ] **Step 5: Re-run the pipeline and confirm the new count**

The source PDFs and the re-OCR'd copies are present locally, and pdfplumber is installed in the user's pyenv Python 3.11, so the full pipeline is re-runnable. Run it in order — `og:parse` overwrites the pool, and `scripts/og/carry-ratings.js` carries the paid difficulty ratings across the re-parse by question id:

```bash
npm run og:parse
npm run og:passages
npm run og:dedup
npm run og:verify
```

Then check the count:

```bash
node -e "
const d=JSON.parse(require('fs').readFileSync('data/gmat-og-questions.json','utf8'));
let u=0,b=0,rated=0;
for(const bk of d.books)for(const s of bk.sections)for(const q of s.questions){
  if(q.usable){u++;if(q.difficulty)rated++;}
  if(q.unusable==='boldface-unmarked')b++;
}
console.log({usable:u,boldfaceUnmarked:b,rated});
"
```

Expected: `{ usable: 368, boldfaceUnmarked: 9, rated: 368 }`. If `rated` is short of `usable`, the difficulty carry-over failed — stop and investigate rather than paying for the LLM pass again.

- [ ] **Step 6: Commit**

```bash
git add scripts/og/assemble.js test/unit/og-assemble.test.js
git commit -m "fix(og): drop boldface questions whose bold spans never survived extraction"
```

(The data file is gitignored; nothing to add for it.)

---

### Task 2: Migration 0010 and the OG database layer

**Files:**
- Create: `migrations/0010_gmat_og_practice.sql`
- Modify: `src/db.js` (new functions near the LSAT block, `src/db.js:145-325`; exports at `src/db.js:5302`)
- Test: `test/unit/og-sql.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `src/db.js`:
  - `saveOgAttempt({ questionId, bookCode, kind, userAnswer, correctAnswer, confidence, timeMs, sessionId }) -> { isCorrect }`
  - `createOgSession({ setLabel, mode, filters, questionIds }) -> { id }`
  - `completeOgSession(id) -> { answeredCount }`
  - `listOgSessions() -> row[]` (each with `filters` and `question_ids` parsed back to objects/arrays)
  - `getOgSession(id) -> row | null`
  - `listOgAttempts({ sessionId, latestOnly }) -> row[]`
  - `listOgErrors({ limit }) -> row[]`
  - `updateOgAttemptAnnotation(attemptId, { mistakeType, notes }) -> { id, mistake_type, notes } | null`
  - `ogStats() -> { totals, byKind, byBook }`
  - `_sqlInternals.parseOgSessionRow(row)` for the test

- [ ] **Step 1: Write the migration**

Create `migrations/0010_gmat_og_practice.sql`:

```sql
-- GMAT Official Guide book practice. Question CONTENT is not stored here: it is
-- served at runtime from data/gmat-og-questions.json (gitignored, regenerated by
-- the extraction pipeline). These tables hold the user's answers only, exactly
-- as lsat_attempts / lsat_sessions do for the LSAT track.
--
-- question_id is the pool's stable id ('OG13-CR-56' = book, subject, printed
-- question number). It survives regeneration of the JSON as long as the book and
-- printed number are unchanged, which is what makes it safe as a foreign key to
-- a file rather than a table.
CREATE TABLE IF NOT EXISTS og_attempts (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_id     text NOT NULL,
  book_code       text NOT NULL,
  kind            text NOT NULL,
  user_answer     text NOT NULL,
  correct_answer  text,
  is_correct      integer,
  confidence      text,
  time_ms         integer,
  session_id      integer,
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  mistake_type    text,
  notes           text
);

-- An OG session is built from FILTERS, not from a question range, so it stores
-- the resolved id list and the builder payload instead of first/last question.
CREATE TABLE IF NOT EXISTS og_sessions (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  set_label     text,
  mode          text,
  filters       text,
  question_ids  text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_og_attempts_question ON og_attempts(question_id);
CREATE INDEX IF NOT EXISTS idx_og_attempts_session  ON og_attempts(session_id);
CREATE INDEX IF NOT EXISTS idx_og_sessions_started  ON og_sessions(started_at DESC);

-- Redoing a question is the point of the seen/wrong filter, so the uniqueness is
-- per (question, SESSION) — a new session always creates a fresh history row.
-- Within one session the builder guarantees each question appears once, and this
-- index is what makes re-submitting an answer in that session idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_og_attempts_session_q
  ON og_attempts(question_id, session_id);
```

- [ ] **Step 2: Apply it**

Run: `npm run db:up && npm run db:migrate`
Expected: `applied 0010_gmat_og_practice.sql`.

Verify: `docker exec gmat-pg psql -U postgres -d gmat -c '\d og_attempts'` lists the 13 columns above.

- [ ] **Step 3: Write the failing test**

Create `test/unit/og-sql.test.js`:

```js
'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { _sqlInternals } = require('../../src/db.js');

// og_sessions stores the builder payload and the resolved id list as JSON text
// (the schema keeps JSON as text throughout this codebase; jsonb is deferred).
// Callers get objects back, and malformed text degrades to null rather than
// throwing a session list out of the dashboard.
test('parses the stored filters and question id list back into values', () => {
  const row = _sqlInternals.parseOgSessionRow({
    id: 3,
    filters: '{"kind":"CR","count":10}',
    question_ids: '["OG12-CR-1","OG12-CR-2"]',
  });
  assert.deepStrictEqual(row.filters, { kind: 'CR', count: 10 });
  assert.deepStrictEqual(row.question_ids, ['OG12-CR-1', 'OG12-CR-2']);
});

test('degrades malformed JSON to null instead of throwing', () => {
  const row = _sqlInternals.parseOgSessionRow({ id: 4, filters: 'not json', question_ids: null });
  assert.strictEqual(row.filters, null);
  assert.strictEqual(row.question_ids, null);
});

test('a null row passes through untouched', () => {
  assert.strictEqual(_sqlInternals.parseOgSessionRow(null), null);
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `node --test test/unit/og-sql.test.js`
Expected: FAIL — `_sqlInternals.parseOgSessionRow is not a function`.

- [ ] **Step 5: Add the OG functions to `src/db.js`**

Insert immediately after `async function lsatStats() { … }` (ends around `src/db.js:325`):

```js
// ---------- GMAT OG book practice ----------
// Mirrors the LSAT pair above. The question content lives in
// data/gmat-og-questions.json, not in the database; question_id ('OG13-CR-56')
// is the join key into that file.

async function saveOgAttempt({ questionId, bookCode, kind, userAnswer, correctAnswer, confidence, timeMs, sessionId }) {
  const corr = correctAnswer ? String(correctAnswer).toUpperCase() : null;
  const isCorrect = corr == null ? null : (String(userAnswer).toUpperCase() === corr ? 1 : 0);
  const conf = confidence ? String(confidence).toLowerCase() : null;
  const tMs = Number.isFinite(Number(timeMs)) ? Math.max(0, Math.round(Number(timeMs))) : null;
  const sId = Number.isFinite(Number(sessionId)) ? Number(sessionId) : null;
  await run(
    `INSERT INTO og_attempts (question_id, book_code, kind, user_answer, correct_answer, is_correct, confidence, time_ms, session_id, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now())
     ON CONFLICT(question_id, session_id) DO UPDATE SET
       user_answer = excluded.user_answer,
       correct_answer = excluded.correct_answer,
       is_correct = excluded.is_correct,
       confidence = excluded.confidence,
       time_ms = excluded.time_ms,
       attempted_at = now()`,
    [String(questionId), String(bookCode), String(kind), String(userAnswer).toUpperCase(), corr, isCorrect, conf, tMs, sId]
  );
  return { isCorrect };
}

async function createOgSession({ setLabel, mode, filters, questionIds }) {
  const ids = Array.isArray(questionIds) && questionIds.length ? JSON.stringify(questionIds) : null;
  const payload = filters && typeof filters === 'object' ? JSON.stringify(filters) : null;
  const result = await all(
    `INSERT INTO og_sessions (set_label, mode, filters, question_ids)
     VALUES (?, ?, ?, ?) RETURNING id`,
    [setLabel || null, mode || null, payload, ids]
  );
  return { id: result[0].id };
}

async function completeOgSession(id) {
  // Freeze the actually-answered questions as the session's contents, so History
  // replays what was worked rather than what was planned.
  const rows = await all(
    'SELECT DISTINCT question_id FROM og_attempts WHERE session_id = ? ORDER BY question_id',
    [id]
  );
  const ids = rows.map((r) => r.question_id);
  await run('UPDATE og_sessions SET completed_at = now(), question_ids = ? WHERE id = ?', [JSON.stringify(ids), id]);
  return { answeredCount: ids.length };
}

// og_sessions.filters and .question_ids are JSON stored as text. Parse both back
// for callers; malformed text degrades to null rather than throwing the whole
// session list out of the dashboard.
function parseOgSessionRow(row) {
  if (!row) return row;
  const parse = (value) => {
    if (!value) return null;
    try { return JSON.parse(value); } catch (e) { return null; }
  };
  return { ...row, filters: parse(row.filters), question_ids: parse(row.question_ids) };
}

async function listOgSessions() {
  const rows = await all('SELECT * FROM og_sessions ORDER BY started_at DESC');
  return rows.map(parseOgSessionRow);
}

async function getOgSession(id) {
  return parseOgSessionRow(await get('SELECT * FROM og_sessions WHERE id = ?', [id]));
}

async function listOgAttempts({ sessionId, latestOnly } = {}) {
  if (latestOnly) {
    // One row per question: the user's most recent answer. Feeds the builder's
    // seen / previously-wrong filters.
    return await all(`
      SELECT a.* FROM og_attempts a
      INNER JOIN (
        SELECT question_id, MAX(attempted_at) AS latest_at
        FROM og_attempts GROUP BY question_id
      ) m ON a.question_id = m.question_id AND a.attempted_at = m.latest_at
      ORDER BY a.question_id
    `);
  }
  if (sessionId != null) {
    return await all('SELECT * FROM og_attempts WHERE session_id = ? ORDER BY id', [sessionId]);
  }
  return await all('SELECT * FROM og_attempts ORDER BY attempted_at DESC');
}

async function listOgErrors({ limit = 200 } = {}) {
  return await all(
    'SELECT * FROM og_attempts WHERE is_correct = 0 ORDER BY attempted_at DESC LIMIT ?',
    [limit]
  );
}

// Same normalization as updateLsatAttemptAnnotation: mistakeType through the
// shared canonicalizer, empty notes stored as NULL.
async function updateOgAttemptAnnotation(attemptId, { mistakeType, notes }) {
  const id = Number(attemptId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid error id.');
  const nextNotes = String(notes || '').trim();
  const storedMistakeType = canonicalizeMistakeTypeValue(mistakeType);
  await run('UPDATE og_attempts SET mistake_type = ?, notes = ? WHERE id = ?', [storedMistakeType, nextNotes || null, id]);
  return get('SELECT id, mistake_type, notes FROM og_attempts WHERE id = ? LIMIT 1', [id]);
}

async function ogStats() {
  const totals = await get('SELECT COUNT(*) AS n, SUM(is_correct) AS c FROM og_attempts');
  const byKind = await all('SELECT kind, COUNT(*) AS n, SUM(is_correct) AS c FROM og_attempts GROUP BY kind');
  const byBook = await all('SELECT book_code AS "bookCode", COUNT(*) AS n, SUM(is_correct) AS c FROM og_attempts GROUP BY book_code ORDER BY book_code');
  return { totals, byKind, byBook };
}
```

- [ ] **Step 6: Export them**

In the `module.exports` block (around `src/db.js:5302`, right after the `getLsatSession,` line) add:

```js
  saveOgAttempt,
  createOgSession,
  completeOgSession,
  listOgSessions,
  getOgSession,
  listOgAttempts,
  listOgErrors,
  updateOgAttemptAnnotation,
  ogStats,
```

and extend the existing `_sqlInternals` object (around `src/db.js:5339`) with `parseOgSessionRow`:

```js
  _sqlInternals: { platformWhereClause, normalizeAnswerChoicesForStorage, normalizeStimulusForStorage, parseOgSessionRow },
```

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: PASS, including the three new `og-sql` tests.

- [ ] **Step 8: Smoke-test the writers against the real database**

```bash
node -e "
require('dotenv').config();
const db=require('./src/db.js');
(async()=>{
  const s=await db.createOgSession({setLabel:'smoke',mode:'practice',filters:{kind:'CR'},questionIds:['OG12-CR-1']});
  await db.saveOgAttempt({questionId:'OG12-CR-1',bookCode:'OG12',kind:'CR',userAnswer:'a',correctAnswer:'A',timeMs:1234,sessionId:s.id});
  await db.saveOgAttempt({questionId:'OG12-CR-1',bookCode:'OG12',kind:'CR',userAnswer:'b',correctAnswer:'A',timeMs:99,sessionId:s.id});
  console.log('attempts in session (expect 1):',(await db.listOgAttempts({sessionId:s.id})).length);
  console.log(await db.completeOgSession(s.id));
  console.log('errors (expect >=1):',(await db.listOgErrors({})).length);
  process.exit(0);
})();
"
```

Expected: one attempt (the re-submit updated in place), `{ answeredCount: 1 }`, at least one error row. Then clean up:

```bash
docker exec gmat-pg psql -U postgres -d gmat -c "DELETE FROM og_attempts WHERE question_id='OG12-CR-1'; DELETE FROM og_sessions WHERE set_label='smoke';"
```

- [ ] **Step 9: Commit**

```bash
git add migrations/0010_gmat_og_practice.sql src/db.js test/unit/og-sql.test.js
git commit -m "feat(og): add og_attempts / og_sessions and their SQL layer"
```

---

### Task 3: `src/og-data.js` — cached pool reader, index, and library facets

**Files:**
- Create: `src/og-data.js`
- Test: `test/unit/og-data.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadOgData() -> { books: [...] }` — raw parsed JSON, cached in-process
  - `ogPool() -> { questions: EnrichedQuestion[], byId: Map<string, EnrichedQuestion>, passages: Map<string, Passage>, books: [{ code, title }] }` — **usable questions only**, cached
  - `ogQuestion(id) -> EnrichedQuestion | null`
  - `ogLibrary() -> { books, typeLabels, difficulties, totals }`
  - `buildOgPool(data) -> pool` — the uncached builder, exported for tests
  - `buildOgLibrary(pool) -> library` — likewise

  `EnrichedQuestion` = every field from the pool JSON plus `bookCode`, `bookTitle`, `kind`, and `passage` (the resolved passage object, or `null` for CR).

- [ ] **Step 1: Write the failing test**

Create `test/unit/og-data.test.js`:

```js
'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { buildOgPool, buildOgLibrary } = require('../../src/og-data.js');

// A miniature pool in the real file's shape: two books, CR and RC, one unusable
// question that must never reach the pool, and a passage shared by two RC
// questions.
const choices = 'ABCDE'.split('').map((l) => ({ label: l, text: `option ${l}` }));
const DATA = {
  books: [
    {
      code: 'OG12',
      title: 'The Official Guide for GMAT Review, 12th Edition',
      sections: [
        {
          kind: 'CR',
          passages: [],
          questions: [
            { id: 'OG12-CR-1', number: 1, stem: 'cr one', choices, correct: 'A', typeLabel: 'Argument Construction', difficulty: 'Easy', usable: true },
            { id: 'OG12-CR-2', number: 2, stem: 'cr two', choices, correct: 'B', typeLabel: null, difficulty: 'Hard', usable: true },
            { id: 'OG12-CR-3', number: 3, stem: 'cr three', choices, correct: null, usable: false, unusable: 'no-key' },
          ],
        },
        {
          kind: 'RC',
          passages: [{ id: 'OG12-RC-p358', page: 358, text: 'passage text', lines: [{ n: 1, marker: null, para: 0, text: 'passage text' }] }],
          questions: [
            { id: 'OG12-RC-1', number: 1, stem: 'rc one', choices, correct: 'C', typeLabel: 'Main idea', difficulty: 'Medium', passageId: 'OG12-RC-p358', usable: true },
            { id: 'OG12-RC-2', number: 2, stem: 'rc two', choices, correct: 'D', typeLabel: 'Inference', difficulty: 'Medium', passageId: 'OG12-RC-p358', usable: true },
          ],
        },
      ],
    },
  ],
};

test('the pool carries only usable questions', () => {
  const pool = buildOgPool(DATA);
  assert.deepStrictEqual(pool.questions.map((q) => q.id), ['OG12-CR-1', 'OG12-CR-2', 'OG12-RC-1', 'OG12-RC-2']);
  assert.strictEqual(pool.byId.has('OG12-CR-3'), false);
});

test('each question carries its book, kind and resolved passage', () => {
  const pool = buildOgPool(DATA);
  const cr = pool.byId.get('OG12-CR-1');
  assert.strictEqual(cr.bookCode, 'OG12');
  assert.strictEqual(cr.kind, 'CR');
  assert.strictEqual(cr.passage, null);
  const rc = pool.byId.get('OG12-RC-1');
  assert.strictEqual(rc.kind, 'RC');
  assert.strictEqual(rc.passage.id, 'OG12-RC-p358');
  assert.strictEqual(rc.passage.text, 'passage text');
});

test('the library reports per-subject facets with counts', () => {
  const lib = buildOgLibrary(buildOgPool(DATA));
  assert.deepStrictEqual(lib.totals, { CR: 2, RC: 2, passages: 1 });
  assert.deepStrictEqual(lib.books, [
    { code: 'OG12', title: 'The Official Guide for GMAT Review, 12th Edition', counts: { CR: 2, RC: 2 } },
  ]);
  assert.deepStrictEqual(lib.typeLabels.RC, [
    { label: 'Inference', count: 1 },
    { label: 'Main idea', count: 1 },
  ]);
  assert.deepStrictEqual(lib.difficulties.CR, [
    { label: 'Easy', count: 1 },
    { label: 'Hard', count: 1 },
  ]);
});

// 100 of the 368 usable questions carry no type label (the explanation that
// would have supplied it was dropped). They must stay selectable, so the facet
// list exposes them under an explicit bucket rather than hiding them.
test('unlabeled questions get their own facet entry', () => {
  const lib = buildOgLibrary(buildOgPool(DATA));
  assert.deepStrictEqual(lib.typeLabels.CR, [
    { label: 'Argument Construction', count: 1 },
    { label: '(unlabeled)', count: 1 },
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/unit/og-data.test.js`
Expected: FAIL — `Cannot find module '../../src/og-data.js'`.

- [ ] **Step 3: Write `src/og-data.js`**

```js
// Reader and index over data/gmat-og-questions.json — the GMAT Official Guide
// CR/RC question pool extracted from the three OG PDFs.
//
// The file is gitignored and regenerated by the extraction pipeline (see
// CLAUDE.md, "GMAT OG verbal practice"). It is read ONCE and cached in-process,
// so the API must be restarted after regenerating it — the same gotcha the LSAT
// track has.
//
// Only questions flagged `usable` are exposed. A question is usable when it is
// answerable as rendered: a complete stem, five non-empty choices, an undisputed
// key, and for RC a passage. A missing explanation is not a defect — 100 of the
// pool's questions are keyed but unenriched, and they practice fine.

const fs = require('fs');
const path = require('path');

const POOL_PATH = path.join(__dirname, '..', 'data', 'gmat-og-questions.json');

// Questions whose explanation was dropped carry no type label. They stay
// selectable in the builder under this bucket rather than disappearing from it.
const UNLABELED = '(unlabeled)';

let _dataCache = null;
let _poolCache = null;
let _libraryCache = null;

function loadOgData() {
  if (_dataCache) return _dataCache;
  try {
    _dataCache = JSON.parse(fs.readFileSync(POOL_PATH, 'utf-8'));
  } catch (e) {
    _dataCache = { books: [] };
  }
  return _dataCache;
}

// Flatten the book/section nesting into one list of usable questions, each
// carrying the context the builder and the runner need: which book it came
// from, whether it is CR or RC, and for RC the passage object itself (text plus
// the structured `lines[]` the pdfplumber pass writes for gutter numbering).
function buildOgPool(data) {
  const questions = [];
  const byId = new Map();
  const passages = new Map();
  const books = [];

  for (const book of (data && data.books) || []) {
    books.push({ code: book.code, title: book.title });
    for (const section of book.sections || []) {
      for (const p of section.passages || []) passages.set(p.id, p);
      for (const q of section.questions || []) {
        if (!q.usable) continue;
        const enriched = {
          ...q,
          bookCode: book.code,
          bookTitle: book.title,
          kind: section.kind,
          passage: q.passageId ? (passages.get(q.passageId) || null) : null,
        };
        questions.push(enriched);
        byId.set(q.id, enriched);
      }
    }
  }
  return { questions, byId, passages, books };
}

// Facets for the set builder's dropdowns. Counts are over usable questions only,
// so a label showing 0 never appears.
function buildOgLibrary(pool) {
  const kinds = ['CR', 'RC'];
  // Difficulty reads as a scale, not a word list, so it keeps its own order.
  const DIFFICULTY_ORDER = ['Easy', 'Medium', 'Hard'];
  const tally = (pred, pick, order = null) => {
    const counts = new Map();
    for (const q of pool.questions) {
      if (!pred(q)) continue;
      const key = pick(q);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const rank = (label) => {
      if (label === UNLABELED) return Number.MAX_SAFE_INTEGER; // the residue sorts last
      const i = order ? order.indexOf(label) : -1;
      return i >= 0 ? i : Number.MAX_SAFE_INTEGER - 1;
    };
    return [...counts.entries()]
      .sort((a, b) => (rank(a[0]) - rank(b[0])) || a[0].localeCompare(b[0]))
      .map(([label, count]) => ({ label, count }));
  };

  const typeLabels = {};
  const difficulties = {};
  const totals = { CR: 0, RC: 0, passages: 0 };
  const usedPassages = new Set();

  for (const kind of kinds) {
    const inKind = (q) => q.kind === kind;
    typeLabels[kind] = tally(inKind, (q) => q.typeLabel || UNLABELED);
    difficulties[kind] = tally(inKind, (q) => q.difficulty || UNLABELED, DIFFICULTY_ORDER);
    totals[kind] = pool.questions.filter(inKind).length;
  }
  for (const q of pool.questions) if (q.passageId) usedPassages.add(q.passageId);
  totals.passages = usedPassages.size;

  const books = pool.books
    .map((b) => ({
      code: b.code,
      title: b.title,
      counts: {
        CR: pool.questions.filter((q) => q.bookCode === b.code && q.kind === 'CR').length,
        RC: pool.questions.filter((q) => q.bookCode === b.code && q.kind === 'RC').length,
      },
    }))
    .filter((b) => b.counts.CR + b.counts.RC > 0);

  return { books, typeLabels, difficulties, totals };
}

function ogPool() {
  if (!_poolCache) _poolCache = buildOgPool(loadOgData());
  return _poolCache;
}

function ogQuestion(id) {
  return ogPool().byId.get(String(id)) || null;
}

function ogLibrary() {
  if (!_libraryCache) _libraryCache = buildOgLibrary(ogPool());
  return _libraryCache;
}

module.exports = { loadOgData, ogPool, ogQuestion, ogLibrary, buildOgPool, buildOgLibrary, UNLABELED };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/og-data.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Check it against the real pool**

```bash
node -e "
const { ogPool, ogLibrary } = require('./src/og-data.js');
const p = ogPool();
console.log('usable', p.questions.length, 'passages indexed', p.passages.size);
console.log(JSON.stringify(ogLibrary(), null, 1));
console.log('RC without a resolved passage (expect 0):', p.questions.filter(q => q.kind==='RC' && !q.passage).length);
"
```

Expected: 368 usable, `totals` of CR 173 / RC 195, zero RC questions missing a passage.

- [ ] **Step 6: Commit**

```bash
git add src/og-data.js test/unit/og-data.test.js
git commit -m "feat(og): add the cached question-pool reader and library facets"
```

---

### Task 4: `src/og-set-builder.js` — resolve filters to a question list

**Files:**
- Create: `src/og-set-builder.js`
- Test: `test/unit/og-set-builder.test.js`

**Interfaces:**
- Consumes: `ogPool()`'s shape from Task 3 (`{ questions, byId, passages }`).
- Produces:

```js
buildOgSet({ pool, filters, history, rng }) -> {
  questionIds: string[],   // in delivery order
  passageIds: string[],    // RC only; [] for CR
  requested: number,
  actual: number,          // questionIds.length
  passageCount: number,
  shortfall: boolean,      // actual < requested
}
```

  `filters` = `{ books: string[], kind: 'CR'|'RC', typeLabels: string[], difficulties: string[], historyMode: 'all'|'unseen'|'wrong', count: number }`. An empty array on an axis means "no constraint". `history` = `{ attempted: Set<string>, wrong: Set<string> }`. `rng` defaults to `Math.random` and is injected by the tests.

- [ ] **Step 1: Write the failing test**

Create `test/unit/og-set-builder.test.js`:

```js
'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { buildOgSet } = require('../../src/og-set-builder.js');

// A deterministic stand-in for Math.random: walks a fixed cycle so shuffles are
// reproducible. Real randomness would make "which passages were drawn" untestable.
const seqRng = (values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const q = (id, over = {}) => ({
  id, kind: 'CR', bookCode: 'OG12', typeLabel: 'Argument Construction',
  difficulty: 'Medium', number: Number(id.split('-').pop()), ...over,
});

const crPool = {
  questions: [
    q('OG12-CR-1'),
    q('OG12-CR-2', { difficulty: 'Hard' }),
    q('OG12-CR-3', { typeLabel: 'Argument Evaluation' }),
    q('OG13-CR-4', { bookCode: 'OG13' }),
  ],
};

// Three passages: 2, 3 and 6 questions.
const rcQuestions = [];
for (const [pid, n] of [['p1', 2], ['p2', 3], ['p3', 6]]) {
  for (let i = 1; i <= n; i += 1) {
    rcQuestions.push(q(`OG12-RC-${pid}-${i}`, {
      kind: 'RC', passageId: pid, number: i,
      typeLabel: i === 1 ? 'Main idea' : 'Inference',
    }));
  }
}
const rcPool = { questions: rcQuestions };

const noHistory = { attempted: new Set(), wrong: new Set() };
const base = { books: [], kind: 'CR', typeLabels: [], difficulties: [], historyMode: 'all', count: 2 };

test('an empty axis means no constraint, not nothing', () => {
  const set = buildOgSet({ pool: crPool, filters: { ...base, count: 10 }, history: noHistory, rng: () => 0 });
  assert.strictEqual(set.actual, 4);
  assert.strictEqual(set.shortfall, true);
});

test('filters AND across axes and OR within one', () => {
  const set = buildOgSet({
    pool: crPool,
    filters: { ...base, count: 10, books: ['OG12'], difficulties: ['Medium', 'Hard'] },
    history: noHistory,
    rng: () => 0,
  });
  assert.deepStrictEqual(set.questionIds.slice().sort(), ['OG12-CR-1', 'OG12-CR-2', 'OG12-CR-3']);
});

test('the unseen filter excludes every question already attempted', () => {
  const history = { attempted: new Set(['OG12-CR-1', 'OG12-CR-2']), wrong: new Set(['OG12-CR-1']) };
  const set = buildOgSet({ pool: crPool, filters: { ...base, count: 10, historyMode: 'unseen' }, history, rng: () => 0 });
  assert.deepStrictEqual(set.questionIds.slice().sort(), ['OG12-CR-3', 'OG13-CR-4']);
});

test('the wrong filter keeps only questions missed before', () => {
  const history = { attempted: new Set(['OG12-CR-1', 'OG12-CR-2']), wrong: new Set(['OG12-CR-1']) };
  const set = buildOgSet({ pool: crPool, filters: { ...base, count: 10, historyMode: 'wrong' }, history, rng: () => 0 });
  assert.deepStrictEqual(set.questionIds, ['OG12-CR-1']);
});

test('an over-constrained filter returns a short set rather than relaxing', () => {
  const set = buildOgSet({
    pool: crPool,
    filters: { ...base, count: 10, typeLabels: ['Argument Evaluation'] },
    history: noHistory,
    rng: () => 0,
  });
  assert.strictEqual(set.actual, 1);
  assert.strictEqual(set.requested, 10);
  assert.strictEqual(set.shortfall, true);
});

// RC is practiced a passage at a time. A count-based draw that split a group
// would leave questions referring to a passage the set never shows.
test('RC delivers whole passages and never splits a group', () => {
  const set = buildOgSet({ pool: rcPool, filters: { ...base, kind: 'RC', count: 6 }, history: noHistory, rng: seqRng([0.1, 0.5, 0.9]) });
  const byPassage = {};
  for (const id of set.questionIds) {
    const pid = rcPool.questions.find((x) => x.id === id).passageId;
    byPassage[pid] = (byPassage[pid] || 0) + 1;
  }
  for (const [pid, n] of Object.entries(byPassage)) {
    const full = rcPool.questions.filter((x) => x.passageId === pid).length;
    assert.strictEqual(n, full, `passage ${pid} was split: ${n} of ${full}`);
  }
  assert.ok(set.actual <= 6, `overshot: ${set.actual}`);
  assert.strictEqual(set.passageCount, set.passageIds.length);
});

test('RC questions arrive grouped by passage and ordered within a group', () => {
  const set = buildOgSet({ pool: rcPool, filters: { ...base, kind: 'RC', count: 6 }, history: noHistory, rng: seqRng([0.1, 0.5, 0.9]) });
  const passageOf = (id) => rcPool.questions.find((x) => x.id === id).passageId;
  const order = set.questionIds.map(passageOf);
  // Every passage's questions are contiguous.
  assert.deepStrictEqual([...new Set(order)].length, set.passageIds.length);
  let seen = [];
  for (const pid of set.passageIds) {
    assert.ok(!seen.includes(pid));
    seen = seen.concat(pid);
  }
  const numbers = set.questionIds
    .filter((id) => passageOf(id) === set.passageIds[0])
    .map((id) => rcPool.questions.find((x) => x.id === id).number);
  assert.deepStrictEqual(numbers, numbers.slice().sort((a, b) => a - b));
});

// The type filter selects PASSAGES containing a match; the whole group still
// comes, because reading a passage for one question is not how RC is practiced.
test('an RC type filter selects passages, and the group arrives whole', () => {
  const set = buildOgSet({
    pool: rcPool,
    filters: { ...base, kind: 'RC', count: 20, typeLabels: ['Main idea'] },
    history: noHistory,
    rng: () => 0,
  });
  assert.strictEqual(set.actual, 11); // every passage has a "Main idea" Q1: 2+3+6
  assert.strictEqual(set.passageCount, 3);
});

test('a passage too large for the remaining count is skipped, not truncated', () => {
  const set = buildOgSet({ pool: rcPool, filters: { ...base, kind: 'RC', count: 3 }, history: noHistory, rng: seqRng([0.9, 0.5, 0.1]) });
  assert.ok(set.actual <= 3);
  assert.ok(set.passageIds.every((pid) => rcPool.questions.filter((x) => x.passageId === pid).length <= 3));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/unit/og-set-builder.test.js`
Expected: FAIL — `Cannot find module '../../src/og-set-builder.js'`.

- [ ] **Step 3: Write `src/og-set-builder.js`**

```js
// Resolve a set-builder filter payload to an ordered list of question ids.
//
// Pure: it takes the pool, the filters and the user's attempt history as plain
// values and returns ids. No database, no file reads — which is what makes the
// RC grouping rules testable.
//
// Two rules carry the design:
//
//  * Filters AND across axes and OR within an axis. An empty selection on an
//    axis means "no constraint", never "nothing".
//  * RC draws WHOLE PASSAGES. A count-based draw that split a group would hand
//    the user three questions about a passage whose other three they never see,
//    which is not practiceable. The delivered count is therefore approximate and
//    the caller reports the real one.

const UNLABELED = '(unlabeled)';

// Fisher-Yates against an injectable rng, so a test can fix the order.
function shuffle(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function matchesAxis(selected, value) {
  if (!Array.isArray(selected) || selected.length === 0) return true;
  return selected.includes(value);
}

function matchesHistory(mode, id, history) {
  if (mode === 'unseen') return !history.attempted.has(id);
  if (mode === 'wrong') return history.wrong.has(id);
  return true;
}

// Everything except the book/kind axes, which gate a whole RC group rather than
// one question.
function matchesQuestion(q, filters, history) {
  return matchesAxis(filters.typeLabels, q.typeLabel || UNLABELED)
    && matchesAxis(filters.difficulties, q.difficulty || UNLABELED)
    && matchesHistory(filters.historyMode, q.id, history);
}

function buildOgSet({ pool, filters, history, rng = Math.random }) {
  const count = Math.max(1, Number(filters.count) || 10);
  const kind = filters.kind === 'RC' ? 'RC' : 'CR';
  const hist = {
    attempted: history?.attempted || new Set(),
    wrong: history?.wrong || new Set(),
  };

  const inScope = pool.questions.filter(
    (q) => q.kind === kind && matchesAxis(filters.books, q.bookCode)
  );

  if (kind === 'CR') {
    const picked = shuffle(inScope.filter((q) => matchesQuestion(q, filters, hist)), rng).slice(0, count);
    return {
      questionIds: picked.map((q) => q.id),
      passageIds: [],
      requested: count,
      actual: picked.length,
      passageCount: 0,
      shortfall: picked.length < count,
    };
  }

  // RC: group by passage, qualify a group on ANY member matching, deliver the
  // group whole and in printed order.
  const groups = new Map();
  for (const q of inScope) {
    const pid = q.passageId || `__no-passage__${q.id}`;
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(q);
  }

  const qualified = [];
  for (const [pid, members] of groups.entries()) {
    if (!members.some((q) => matchesQuestion(q, filters, hist))) continue;
    qualified.push({ pid, members: members.slice().sort((a, b) => (a.number || 0) - (b.number || 0)) });
  }

  // Greedy fit: a group that would overshoot the remaining count is skipped, not
  // truncated. Skipping rather than stopping lets a smaller passage later in the
  // shuffle fill the tail.
  const questionIds = [];
  const passageIds = [];
  for (const group of shuffle(qualified, rng)) {
    if (questionIds.length + group.members.length > count) continue;
    passageIds.push(group.pid);
    for (const q of group.members) questionIds.push(q.id);
    if (questionIds.length >= count) break;
  }

  return {
    questionIds,
    passageIds,
    requested: count,
    actual: questionIds.length,
    passageCount: passageIds.length,
    shortfall: questionIds.length < count,
  };
}

module.exports = { buildOgSet, UNLABELED };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/og-set-builder.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Sanity-check against the real pool**

```bash
node -e "
const { ogPool } = require('./src/og-data.js');
const { buildOgSet } = require('./src/og-set-builder.js');
const pool = ogPool();
const empty = { attempted: new Set(), wrong: new Set() };
const base = { books: [], typeLabels: [], difficulties: [], historyMode: 'all' };
const cr = buildOgSet({ pool, filters: { ...base, kind: 'CR', count: 12 }, history: empty });
const rc = buildOgSet({ pool, filters: { ...base, kind: 'RC', count: 12 }, history: empty });
console.log('CR', cr.actual, 'requested', cr.requested);
console.log('RC', rc.actual, 'across', rc.passageCount, 'passages, shortfall', rc.shortfall);
const byId = pool.byId;
for (const pid of rc.passageIds) {
  const inSet = rc.questionIds.filter(id => byId.get(id).passageId === pid).length;
  const inPool = pool.questions.filter(q => q.passageId === pid).length;
  if (inSet !== inPool) throw new Error('split group on ' + pid);
}
console.log('no group was split');
"
```

Expected: CR 12; RC at most 12 across whole passages; "no group was split".

- [ ] **Step 6: Commit**

```bash
git add src/og-set-builder.js test/unit/og-set-builder.test.js
git commit -m "feat(og): add the filter-based set builder"
```

---

### Task 5: `/api/og/*` endpoints

**Files:**
- Modify: `src/server.js` — imports at `src/server.js:25-62`, routes appended after the LSAT block (which ends at `app.get('/api/lsat/stats'…)`, around `src/server.js:1898-1905`)

**Interfaces:**
- Consumes: `src/og-data.js` (`ogPool`, `ogQuestion`, `ogLibrary`), `src/og-set-builder.js` (`buildOgSet`), and the Task-2 `src/db.js` exports.
- Produces these HTTP endpoints, consumed by Task 7:
  - `GET  /api/og/library` → `{ library, history: { attempted, wrong } }` (counts, not id lists)
  - `POST /api/og/build-set` → `{ set: { questionIds, passageIds, requested, actual, passageCount, shortfall }, questions, passages }` — creates nothing
  - `POST /api/og/sessions` → `{ id }`
  - `POST /api/og/sessions/:id/complete` → `{ ok, answeredCount }`
  - `GET  /api/og/sessions` → `{ sessions }`
  - `GET  /api/og/sessions/:id` → `{ session, questions, passages, attempts }`
  - `POST /api/og/attempts` → `{ isCorrect, correctAnswer, explanation }`
  - `GET  /api/og/attempts` → `{ attempts }`
  - `GET  /api/og/errors` → `{ errors }` (each hydrated with its question)
  - `GET  /api/og/stats` → `{ totals, byKind, byBook }`

  `questions` in every payload is the **served shape**: `{ id, number, bookCode, bookTitle, kind, stem, stemHtml, choices, typeLabel, difficulty, passageId }` — it carries **neither `correct` nor `explanation`**. Both come back from `POST /api/og/attempts`, one question at a time, so a Timed-mode set cannot leak its answers into the browser before the review screen. (One rationale in every explanation opens with "Correct.", so shipping explanations early would leak the whole key list.)

- [ ] **Step 1: Wire the imports**

In the `require('./db')` destructuring block (`src/server.js:25-62`), after `getLsatSession,` add:

```js
  saveOgAttempt,
  createOgSession,
  completeOgSession,
  listOgSessions,
  getOgSession,
  listOgAttempts,
  listOgErrors,
  ogStats,
```

After the `require('./lsat-dashboard')` block (`src/server.js:64-70`) add:

```js
const { ogPool, ogQuestion, ogLibrary } = require('./og-data');
const { buildOgSet } = require('./og-set-builder');
```

- [ ] **Step 2: Add the shared helpers and the library / build-set routes**

Append immediately after the `app.get('/api/lsat/stats', …)` handler:

```js
// ---------- GMAT OG book practice endpoints ----------
// Question content comes from data/gmat-og-questions.json through the cached
// reader in src/og-data.js; only answers touch Postgres. Restart the API after
// regenerating that file.

// The shape sent to the browser. It deliberately omits BOTH `correct` and
// `explanation`: the key and the book's rationale are handed back one question
// at a time by POST /api/og/attempts, when they have been earned. Sending the
// explanation with the question would undo Timed mode — one of its per-choice
// rationales opens with "Correct.", so the whole key list would sit in the
// network tab before the first answer.
function ogQuestionPayload(q) {
  return {
    id: q.id,
    number: q.number,
    bookCode: q.bookCode,
    bookTitle: q.bookTitle,
    kind: q.kind,
    stem: q.stem,
    stemHtml: q.stemHtml || null,
    choices: q.choices || [],
    typeLabel: q.typeLabel || null,
    difficulty: q.difficulty || null,
    passageId: q.passageId || null,
  };
}

// The user's attempt history as two id sets, for the unseen / previously-wrong
// filters. Latest attempt per question: answering it right on a redo should take
// it out of "previously wrong".
async function ogHistory() {
  const rows = await listOgAttempts({ latestOnly: true });
  const attempted = new Set();
  const wrong = new Set();
  for (const r of rows) {
    attempted.add(r.question_id);
    if (r.is_correct === 0) wrong.add(r.question_id);
  }
  return { attempted, wrong };
}

app.get('/api/og/library', async (req, res) => {
  try {
    const history = await ogHistory();
    res.json({
      library: ogLibrary(),
      history: { attempted: history.attempted.size, wrong: history.wrong.size },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolve filters to a question list for PREVIEW. Writes nothing — the builder
// can say "18 questions across 5 passages" before the user commits.
app.post('/api/og/build-set', async (req, res) => {
  try {
    const f = req.body?.filters || {};
    const filters = {
      books: Array.isArray(f.books) ? f.books : [],
      kind: f.kind === 'RC' ? 'RC' : 'CR',
      typeLabels: Array.isArray(f.typeLabels) ? f.typeLabels : [],
      difficulties: Array.isArray(f.difficulties) ? f.difficulties : [],
      historyMode: ['unseen', 'wrong'].includes(f.historyMode) ? f.historyMode : 'all',
      count: Math.min(50, Math.max(1, Number(f.count) || 10)),
    };
    const pool = ogPool();
    const set = buildOgSet({ pool, filters, history: await ogHistory() });
    const questions = set.questionIds.map((id) => ogQuestionPayload(pool.byId.get(id)));
    const passages = set.passageIds.map((pid) => pool.passages.get(pid)).filter(Boolean);
    res.json({ set, filters, questions, passages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Add the session, attempt, error and stats routes**

Continue appending:

```js
app.post('/api/og/sessions', async (req, res) => {
  try {
    const questionIds = Array.isArray(req.body?.questionIds) ? req.body.questionIds.map(String) : [];
    if (questionIds.length === 0) return res.status(400).json({ error: 'A session needs at least one question.' });
    const pool = ogPool();
    const unknown = questionIds.filter((id) => !pool.byId.has(id));
    if (unknown.length) return res.status(400).json({ error: `Unknown question ids: ${unknown.slice(0, 3).join(', ')}` });
    const result = await createOgSession({
      setLabel: req.body?.setLabel || null,
      mode: req.body?.mode === 'timed' ? 'timed' : 'practice',
      filters: req.body?.filters || null,
      questionIds,
    });
    res.json({ id: result.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/og/sessions/:id/complete', async (req, res) => {
  try {
    const result = await completeOgSession(Number(req.params.id));
    res.json({ ok: true, answeredCount: result?.answeredCount ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/og/sessions', async (req, res) => {
  try {
    res.json({ sessions: await listOgSessions() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One session, rehydrated: the questions it holds (in stored order), their
// passages, and what was answered. This is what "resume" and the review screen
// both read.
app.get('/api/og/sessions/:id', async (req, res) => {
  try {
    const session = await getOgSession(Number(req.params.id));
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const pool = ogPool();
    const ids = Array.isArray(session.question_ids) ? session.question_ids : [];
    const questions = ids.map((id) => pool.byId.get(id)).filter(Boolean).map(ogQuestionPayload);
    const passageIds = [...new Set(questions.map((q) => q.passageId).filter(Boolean))];
    res.json({
      session,
      questions,
      passages: passageIds.map((pid) => pool.passages.get(pid)).filter(Boolean),
      attempts: await listOgAttempts({ sessionId: Number(req.params.id) }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grade one answer. The correct letter comes from the pool here, never from the
// client, and this response is the only place it — and the book's explanation —
// is revealed.
app.post('/api/og/attempts', async (req, res) => {
  try {
    const { questionId, userAnswer, confidence, timeMs, sessionId } = req.body || {};
    if (!questionId || !userAnswer) return res.status(400).json({ error: 'Missing required fields' });
    const q = ogQuestion(questionId);
    if (!q) return res.status(404).json({ error: 'Question not found' });
    const result = await saveOgAttempt({
      questionId: q.id,
      bookCode: q.bookCode,
      kind: q.kind,
      userAnswer: String(userAnswer).toUpperCase(),
      correctAnswer: q.correct,
      confidence: confidence || null,
      timeMs: timeMs != null ? Number(timeMs) : null,
      sessionId: sessionId != null ? Number(sessionId) : null,
    });
    res.json({ ...result, correctAnswer: q.correct, explanation: q.explanation || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/og/attempts', async (req, res) => {
  try {
    const sessionId = req.query.sessionId != null ? Number(req.query.sessionId) : null;
    const latestOnly = req.query.latestOnly === 'true' || req.query.latestOnly === '1';
    res.json({ attempts: await listOgAttempts({ sessionId, latestOnly }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/og/errors', async (req, res) => {
  try {
    const limit = req.query.limit != null ? Math.min(500, Number(req.query.limit)) : 200;
    const rows = await listOgErrors({ limit });
    // The error log reviews questions already answered, so the explanation is
    // no longer withheld here.
    const enriched = rows.map((r) => {
      const q = ogQuestion(r.question_id);
      return { ...r, question: q ? { ...ogQuestionPayload(q), explanation: q.explanation || null } : null };
    });
    res.json({ errors: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/og/stats', async (req, res) => {
  try {
    res.json(await ogStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Exercise every endpoint against the running API**

Start it (`npm run dev:api`) in another terminal, then:

```bash
curl -s localhost:4310/api/og/library | head -c 600; echo
curl -s -X POST localhost:4310/api/og/build-set -H 'Content-Type: application/json' \
  -d '{"filters":{"kind":"RC","count":8}}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.set);console.log('leaks a key:',j.questions.some(q=>'correct' in q || 'explanation' in q));console.log('passages:',j.passages.length);});"
```

Expected: a library with `totals` CR 173 / RC 195; a build-set result whose `actual` is at most 8, `leaks a key: false`, and one passage object per `passageIds` entry.

Then a full round trip:

```bash
SET=$(curl -s -X POST localhost:4310/api/og/build-set -H 'Content-Type: application/json' -d '{"filters":{"kind":"CR","count":2}}')
IDS=$(echo "$SET" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).set.questionIds)))")
SID=$(curl -s -X POST localhost:4310/api/og/sessions -H 'Content-Type: application/json' -d "{\"questionIds\":$IDS,\"mode\":\"practice\",\"setLabel\":\"curl smoke\"}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")
QID=$(echo "$IDS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0]))")
curl -s -X POST localhost:4310/api/og/attempts -H 'Content-Type: application/json' -d "{\"questionId\":\"$QID\",\"userAnswer\":\"A\",\"timeMs\":30000,\"sessionId\":$SID}"; echo
curl -s -X POST localhost:4310/api/og/sessions/$SID/complete; echo
curl -s localhost:4310/api/og/sessions/$SID | head -c 300; echo
curl -s localhost:4310/api/og/stats; echo
echo "session id was $SID — keep it for Task 6"
```

Expected: the attempt returns `{"isCorrect":0|1,"correctAnswer":"…"}`, complete returns `answeredCount 1`, the session rehydrates with its questions, stats counts the attempt.

- [ ] **Step 5: Lint and test**

Run: `npm run lint 2>&1 | tail -3 && npm test`
Expected: 0 errors; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/server.js
git commit -m "feat(og): add the /api/og practice endpoints"
```

---

### Task 6: `src/og-dashboard.js` and the merge into the main dashboard

**Files:**
- Create: `src/og-dashboard.js`
- Modify: `src/server.js` — imports; `/api/sessions` (`src/server.js:560-608`); `/api/sessions/:sessionId/analysis` (`:611-641`); `/api/errors` (`:643-720`); `PATCH /api/errors/:errorId` (`:960-999`)
- Test: `test/unit/og-dashboard.test.js`

**Interfaces:**
- Consumes: Task 2's `src/db.js` exports and Task 3's `ogPool`.
- Produces:
  - `listOgDashboardSessions({ subject, startDate, endDate }) -> sessionRow[]`
  - `listOgDashboardErrors({ subject, search }) -> questionRow[]`
  - `getOgDashboardAnalysis(id) -> analysis | null`
  - `isOgDashboardId(id) -> boolean` (`true` for a string starting `og-`)
  - `updateOgDashboardAnnotation(id, { mistakeType, notes }) -> { id, mistake_type, notes } | null`
  - `ogSourceLabel(bookCode) -> string` and `buildOgQuestionRow(...)`, exported for the test

  Row shapes are the dashboard's existing ones — the same fields `buildSessionRow` / `buildQuestionRow` produce in `src/lsat-dashboard.js`. Namespaced ids are `og-<sessionId>` and `og-<attemptId>`.

**Source labels — read this before writing them.** `getSourcePlatform` in `client/src/App.jsx:1235` classifies by substring, and the existing StartTest presets are already named "OG 2024-2025 Main", "OG Verbal Review", "OG Quant Review". A label containing a bare "OG" would be misread as StartTest. Use the distinctive prefix **`GMAT OG Book`**, which nothing else matches, and detect it ahead of the StartTest fallback.

- [ ] **Step 1: Write the failing test**

Create `test/unit/og-dashboard.test.js`:

```js
'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { ogSourceLabel, buildOgQuestionRow } = require('../../src/og-dashboard.js');

// The dashboard classifies a row's platform by matching substrings of its source
// label (getSourcePlatform, client/src/App.jsx). Three StartTest presets are
// already called "OG ..." — "OG Verbal Review", "OG Quant Review", "OG 2024-2025
// Main" — so a bare "OG" in this label would put book practice on the StartTest
// chip. The "GMAT OG Book" prefix is what keeps them apart.
test('the source label carries the prefix the platform check keys on', () => {
  assert.strictEqual(ogSourceLabel('OG13'), 'GMAT OG Book · OG13');
  assert.match(ogSourceLabel('VR2'), /^GMAT OG Book/);
  assert.doesNotMatch(ogSourceLabel('OG12'), /Verbal Review|Quant Review/);
});

test('an error row maps to the dashboard question shape', () => {
  const question = {
    id: 'OG12-CR-7', number: 7, bookCode: 'OG12', kind: 'CR',
    stem: 'the stem', choices: [{ label: 'A', text: 'a' }], correct: 'B',
    typeLabel: 'Argument Construction', difficulty: 'Hard', passage: null,
  };
  const attempt = {
    id: 42, question_id: 'OG12-CR-7', book_code: 'OG12', kind: 'CR',
    user_answer: 'C', correct_answer: 'B', is_correct: 0, time_ms: 96000,
    confidence: 'low', session_id: 5, attempted_at: '2026-09-15T04:00:00Z',
    mistake_type: null, notes: null,
  };
  const row = buildOgQuestionRow({ id: 5, started_at: '2026-09-15T03:00:00Z' }, attempt, question, new Map());

  assert.strictEqual(row.id, 'og-42');
  assert.strictEqual(row.session_id, 'og-5');
  assert.strictEqual(row.subject, 'CR');
  assert.strictEqual(row.category_code, 'CR');
  assert.strictEqual(row.q_code, 'og-OG12-CR-7');
  assert.strictEqual(row.q_id, 'og-att-42');
  assert.strictEqual(row.my_answer, 'C');
  assert.strictEqual(row.correct_answer, 'B');
  assert.strictEqual(row.correct, 0);
  assert.strictEqual(row.time_sec, 96);
  assert.strictEqual(row.topic, 'Argument Construction');
  assert.strictEqual(row.difficulty, 'Hard');
  assert.strictEqual(row.answer_choices, JSON.stringify(question.choices));
});

// 100 of the pool's questions carry no type label. The error log still has to
// say what kind of question it was, so the subject name stands in.
test('a question with no type label falls back to its subject name', () => {
  const question = { id: 'OG12-RC-3', number: 3, bookCode: 'OG12', kind: 'RC', stem: 's', choices: [], correct: 'A', typeLabel: null, passage: { text: 'p', lines: [{ n: 1 }] } };
  const attempt = { id: 1, question_id: 'OG12-RC-3', kind: 'RC', user_answer: 'A', correct_answer: 'A', is_correct: 1, attempted_at: 'x' };
  const row = buildOgQuestionRow(null, attempt, question, new Map());
  assert.strictEqual(row.topic, 'Reading Comprehension');
  assert.strictEqual(row.passage_text, 'p');
  assert.deepStrictEqual(row.passage_lines, [{ n: 1 }]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/unit/og-dashboard.test.js`
Expected: FAIL — `Cannot find module '../../src/og-dashboard.js'`.

- [ ] **Step 3: Write `src/og-dashboard.js`**

```js
// Bridges GMAT OG book practice (og_sessions / og_attempts + the cached question
// pool) into the main dashboard's row shapes, so OG shows up in Performance by
// Session, the Error Log, and the Session Analysis modal as its own source.
// db.js stays pure SQL; the JSON join and the shape mapping live here, exactly
// as src/lsat-dashboard.js does for the LSAT track.
//
// Subjects are RC and CR — the same two the LSAT bridge emits, and distinct from
// GMAT's Q/V/DI, which is what lets the merged endpoints route a subject filter
// to the right readers.

const {
  listOgSessions,
  listOgAttempts,
  getOgSession,
  updateOgAttemptAnnotation,
} = require('./db');
const { ogPool } = require('./og-data');

// "GMAT OG Book" and nothing shorter: three StartTest presets are already named
// "OG Verbal Review" / "OG Quant Review" / "OG 2024-2025 Main", and the
// frontend's getSourcePlatform classifies by substring.
function ogSourceLabel(bookCode) {
  return `GMAT OG Book · ${bookCode || 'OG'}`;
}

function subjectForKind(kind) {
  return String(kind || '').toUpperCase() === 'RC' ? 'RC' : 'CR';
}
function topicForQuestion(question, kind) {
  if (question && question.typeLabel) return question.typeLabel;
  return subjectForKind(kind) === 'RC' ? 'Reading Comprehension' : 'Critical Reasoning';
}

// A session can mix books (the builder filters across editions), so the session
// row's source names the track and the per-question rows name the book.
function sessionSourceLabel(atts) {
  const books = [...new Set(atts.map((a) => a.book_code).filter(Boolean))];
  return books.length === 1 ? ogSourceLabel(books[0]) : 'GMAT OG Book · Mixed';
}

function attemptStats(atts) {
  const answered = atts.length;
  const correct = atts.filter((a) => a.is_correct).length;
  const avg = (pred) => {
    let t = 0;
    let n = 0;
    for (const a of atts) {
      if (a.time_ms == null) continue;
      if (pred(a)) { t += a.time_ms; n += 1; }
    }
    return n ? Math.round(t / n / 1000) : null;
  };
  return {
    answered,
    correct,
    wrong: answered - correct,
    accuracy_pct: answered ? Number(((correct * 100) / answered).toFixed(1)) : null,
    avg_time_sec: avg(() => true),
    avg_correct_time_sec: avg((a) => a.is_correct),
    avg_incorrect_time_sec: avg((a) => !a.is_correct),
  };
}

function buildSessionRow(s, atts) {
  const st = attemptStats(atts);
  const kinds = [...new Set(atts.map((a) => subjectForKind(a.kind)))];
  return {
    id: `og-${s.id}`,
    run_id: 'og',
    session_external_id: `og-${s.id}`,
    session_date: s.started_at,
    created_at: s.started_at,
    source: sessionSourceLabel(atts),
    subject: kinds.length === 1 ? kinds[0] : 'Mixed',
    subject_code: null,
    total_q_api: st.answered,
    total_q_categories: st.answered,
    correct_count: st.correct,
    error_count: st.wrong,
    total_score: null, total_percentile: null,
    quant_score: null, quant_percentile: null,
    verbal_score: null, verbal_percentile: null,
    di_score: null, di_percentile: null,
    attempt_total: st.answered,
    attempt_correct: st.correct,
    attempt_wrong: st.wrong,
    accuracy_pct: st.accuracy_pct,
    avg_time_sec: st.avg_time_sec,
    avg_correct_time_sec: st.avg_correct_time_sec,
    avg_incorrect_time_sec: st.avg_incorrect_time_sec,
    hard_total: null, hard_accuracy_pct: null, hard_avg_time_sec: null,
    medium_total: null, medium_accuracy_pct: null, medium_avg_time_sec: null,
    easy_total: null, easy_accuracy_pct: null, easy_avg_time_sec: null,
  };
}

// `tallies` carries the lifetime attempt count per question id, matching the
// attempt_count / attempt_accuracy_pct the GMAT reader computes in SQL; without
// it a row reports only itself.
function buildOgQuestionRow(s, a, question, tallies) {
  const q = question || {};
  const tally = (tallies && tallies.get(a.question_id)) || { n: 1, ok: a.is_correct ? 1 : 0 };
  const sessionDbId = s ? s.id : a.session_id;
  return {
    id: `og-${a.id}`,
    run_id: 'og',
    session_id: sessionDbId != null ? `og-${sessionDbId}` : null,
    session_external_id: sessionDbId != null ? `og-${sessionDbId}` : null,
    session_date: s ? s.started_at : a.attempted_at,
    source: ogSourceLabel(a.book_code || q.bookCode),
    subject: subjectForKind(a.kind),
    subject_code: null,
    category_code: subjectForKind(a.kind),
    subcategory: null,
    q_code: `og-${a.question_id}`,
    q_id: `og-att-${a.id}`,
    cat_id: null,
    question_url: null,
    question_stem: q.stem || '',
    question_stem_html: q.stemHtml || null,
    passage_text: q.passage ? q.passage.text : null,
    passage_lines: q.passage && Array.isArray(q.passage.lines) ? q.passage.lines : null,
    answer_choices: JSON.stringify(q.choices || []),
    response_format: 'mcq',
    // The book's own answer explanation, where the extraction recovered one.
    response_details: q.explanation ? JSON.stringify(q.explanation) : null,
    difficulty: q.difficulty || null,
    difficulty_theta: null,
    confidence: a.confidence || null,
    topic: topicForQuestion(q, a.kind),
    topic_source: 'og-book',
    content_domain: null,
    time_sec: a.time_ms != null ? Math.round(a.time_ms / 1000) : null,
    my_answer: a.user_answer || null,
    correct_answer: a.correct_answer || q.correct || null,
    correct: a.is_correct ? 1 : 0,
    corrected_later: 0,
    mistake_type: a.mistake_type || null,
    notes: a.notes || null,
    question_number: a.question_number ?? q.number ?? null,
    attempt_count: tally.n,
    attempt_accuracy_pct: Math.round((100 * tally.ok) / tally.n),
  };
}

async function loadAll() {
  const [sessions, attempts] = await Promise.all([listOgSessions(), listOgAttempts({})]);
  const bySession = new Map();
  const tallies = new Map();
  for (const a of attempts) {
    if (!tallies.has(a.question_id)) tallies.set(a.question_id, { n: 0, ok: 0 });
    const tally = tallies.get(a.question_id);
    tally.n += 1;
    if (a.is_correct) tally.ok += 1;
    if (a.session_id == null) continue;
    if (!bySession.has(a.session_id)) bySession.set(a.session_id, []);
    bySession.get(a.session_id).push(a);
  }
  return { sessions, bySession, tallies };
}

function subjectMatches(subject, kind) {
  if (!subject) return true;
  return subjectForKind(kind) === String(subject).toUpperCase();
}
function dateInRange(iso, startDate, endDate) {
  if (!iso) return true;
  const day = String(iso).slice(0, 10);
  if (startDate && day < startDate) return false;
  if (endDate && day > endDate) return false;
  return true;
}

async function listOgDashboardSessions({ subject, startDate, endDate } = {}) {
  const { sessions, bySession } = await loadAll();
  const out = [];
  for (const s of sessions) {
    const atts = bySession.get(s.id) || [];
    if (atts.length === 0) continue; // nothing answered -> nothing to review
    if (subject && !atts.some((a) => subjectMatches(subject, a.kind))) continue;
    if (!dateInRange(s.started_at, startDate, endDate)) continue;
    out.push(buildSessionRow(s, atts));
  }
  return out;
}

async function listOgDashboardErrors({ subject, search } = {}) {
  const { sessions, bySession, tallies } = await loadAll();
  const pool = ogPool();
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const out = [];
  for (const [sessionId, atts] of bySession.entries()) {
    const s = sessionById.get(sessionId);
    for (const a of atts) {
      if (a.is_correct) continue;
      if (!subjectMatches(subject, a.kind)) continue;
      const row = buildOgQuestionRow(s, a, pool.byId.get(a.question_id), tallies);
      if (search) {
        const hay = `${row.question_stem} ${row.topic} ${row.q_code}`.toLowerCase();
        if (!hay.includes(String(search).toLowerCase())) continue;
      }
      out.push(row);
    }
  }
  return out;
}

async function getOgDashboardAnalysis(ogId) {
  const numericId = Number(String(ogId).replace(/^og-/, ''));
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const s = await getOgSession(numericId);
  if (!s) return null;
  const atts = await listOgAttempts({ sessionId: numericId });
  const pool = ogPool();
  const st = attemptStats(atts);

  const questions = atts
    .map((a) => buildOgQuestionRow(s, a, pool.byId.get(a.question_id)))
    .sort((x, y) => (x.correct - y.correct) || ((y.time_sec || 0) - (x.time_sec || 0)));

  // The OG books print no difficulty, so these bands come from the LLM pass and
  // are a rough RELATIVE ranking (tertiles of an estimated percent-correct), not
  // a calibrated measure. See CLAUDE.md.
  const diffMap = new Map();
  for (const row of questions) {
    const key = row.difficulty || 'Unknown';
    if (!diffMap.has(key)) diffMap.set(key, { difficulty: key, total: 0, wrong: 0, correctN: 0 });
    const e = diffMap.get(key);
    e.total += 1;
    if (row.correct) e.correctN += 1; else e.wrong += 1;
  }

  const topicMap = new Map();
  for (const row of questions) {
    if (row.correct) continue;
    topicMap.set(row.topic, (topicMap.get(row.topic) || 0) + 1);
  }

  const confMap = new Map();
  for (const a of atts) {
    const key = a.confidence || 'not selected';
    if (!confMap.has(key)) confMap.set(key, { confidence: key, total: 0, wrong: 0, correctN: 0 });
    const e = confMap.get(key);
    e.total += 1;
    if (a.is_correct) e.correctN += 1; else e.wrong += 1;
  }

  const pct = (e) => (e.total ? Number(((e.correctN * 100) / e.total).toFixed(1)) : null);

  return {
    session: { ...buildSessionRow(s, atts), accuracy_pct: st.accuracy_pct },
    byDifficulty: [...diffMap.values()].map((e) => ({ difficulty: e.difficulty, total: e.total, wrong: e.wrong, accuracy_pct: pct(e) })),
    topWrongTopics: [...topicMap.entries()].map(([topic, wrong]) => ({ topic, wrong })).sort((a, b) => b.wrong - a.wrong),
    confidencePerformance: [...confMap.values()].map((e) => ({ confidence: e.confidence, total: e.total, wrong: e.wrong, accuracy_pct: pct(e) })).sort((a, b) => b.total - a.total),
    slowWrongQuestions: questions,
  };
}

function isOgDashboardId(id) {
  return typeof id === 'string' && id.startsWith('og-');
}

async function updateOgDashboardAnnotation(ogId, { mistakeType, notes }) {
  const numericId = Number(String(ogId).replace(/^og-/, ''));
  if (!Number.isInteger(numericId) || numericId <= 0) throw new Error('Invalid error id.');
  const updated = await updateOgAttemptAnnotation(numericId, { mistakeType, notes });
  if (!updated) return null;
  return { id: `og-${updated.id}`, mistake_type: updated.mistake_type, notes: updated.notes };
}

module.exports = {
  listOgDashboardSessions,
  listOgDashboardErrors,
  getOgDashboardAnalysis,
  isOgDashboardId,
  updateOgDashboardAnnotation,
  ogSourceLabel,
  buildOgQuestionRow,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/og-dashboard.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Merge OG into `/api/sessions`**

Import the bridge in `src/server.js`, right after the `require('./lsat-dashboard')` block:

```js
const {
  listOgDashboardSessions,
  listOgDashboardErrors,
  getOgDashboardAnalysis,
  isOgDashboardId,
  updateOgDashboardAnnotation,
} = require('./og-dashboard');
```

In `app.get('/api/sessions'…)` (`src/server.js:566-594`) replace the platform whitelist, the two include flags, and the merge with:

```js
    const platform = ['gmatclub', 'gmatclub-cat', 'starttest', 'ttp', 'ope-mock', 'lsat', 'og'].includes(req.query.platform) ? req.query.platform : null;
```

```js
    // LSAT and OG book practice live in separate tables and are merged in here
    // as their own sources. GMAT subjects are Q/V/DI; both practice tracks use
    // RC/CR — so a Q/V/DI subject filter excludes them, and an RC/CR filter
    // excludes GMAT.
    const isPractice = ['lsat', 'og'].includes(platform);
    const includeGmat = !isPractice && !['RC', 'CR'].includes(subject);
    const includeLsat = (platform === null || platform === 'lsat') && !['Q', 'V', 'DI'].includes(subject);
    const includeOg = (platform === null || platform === 'og') && !['Q', 'V', 'DI'].includes(subject);

    const gmatRows = includeGmat
      ? await listSessions(runId, {
          limit: 1000000,
          offset: 0,
          platform: isPractice ? null : platform,
          subject: ['Q', 'V', 'DI'].includes(subject) ? subject : null,
          startDate,
          endDate,
          includeExcluded: wantsExcluded(req),
        })
      : [];
    const lsatRows = includeLsat
      ? await listLsatDashboardSessions({ subject: ['RC', 'CR'].includes(subject) ? subject : null, startDate, endDate })
      : [];
    const ogRows = includeOg
      ? await listOgDashboardSessions({ subject: ['RC', 'CR'].includes(subject) ? subject : null, startDate, endDate })
      : [];

    const merged = [...gmatRows, ...lsatRows, ...ogRows].sort(
      (a, b) => new Date(b.session_date || 0) - new Date(a.session_date || 0)
    );
```

- [ ] **Step 6: Dispatch the analysis route**

In `app.get('/api/sessions/:sessionId/analysis'…)`, directly after the LSAT `if (isLsatDashboardId(rawId)) { … }` block, add:

```js
    // OG book practice sessions carry a namespaced "og-<n>" id.
    if (isOgDashboardId(rawId)) {
      const ogAnalysis = await getOgDashboardAnalysis(rawId);
      if (!ogAnalysis) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }
      res.json({ analysis: ogAnalysis });
      return;
    }
```

- [ ] **Step 7: Merge OG into `/api/errors`**

In `app.get('/api/errors'…)`, update the whitelist the same way:

```js
    const platform = ['gmatclub', 'gmatclub-cat', 'starttest', 'ttp', 'ope-mock', 'lsat', 'og'].includes(req.query.platform) ? req.query.platform : null;
```

set `filterOptions.platform` to `['lsat', 'og'].includes(platform) ? null : platform`, and replace the include flags and the row gathering (`src/server.js:673-692`) with:

```js
    // GMAT subjects are Q/V/DI; the LSAT and OG practice tracks use RC/CR.
    // Neither practice track has rows in question_attempts, so neither can be
    // bookmarked-filtered — the flag narrows the merge to the GMAT side.
    const isPractice = ['lsat', 'og'].includes(platform);
    const includeGmat = !isPractice && !['RC', 'CR'].includes(subjectRaw);
    const practiceSubject = ['RC', 'CR'].includes(subjectRaw) ? subjectRaw : null;
    const includeLsat = (platform === null || platform === 'lsat')
      && !['Q', 'V', 'DI'].includes(subjectRaw)
      && !filterOptions.bookmarked;
    const includeOg = (platform === null || platform === 'og')
      && !['Q', 'V', 'DI'].includes(subjectRaw)
      && !filterOptions.bookmarked;

    const gmatRows = includeGmat
      ? await listErrors({ ...filterOptions, limit: 1000000, offset: 0 })
      : [];
    // The practice readers know nothing about the GMAT category/subcategory
    // taxonomy, so apply those two filters here rather than letting their rows
    // through unfiltered.
    const byCategoryAndTopic = (row) =>
      (!categoryRaw || String(row.category_code || '').toUpperCase() === categoryRaw)
      && (!topicRaw || String(row.topic || '') === topicRaw);
    const lsatRows = includeLsat
      ? (await listLsatDashboardErrors({ subject: practiceSubject, search })).filter(byCategoryAndTopic)
      : [];
    const ogRows = includeOg
      ? (await listOgDashboardErrors({ subject: practiceSubject, search })).filter(byCategoryAndTopic)
      : [];
```

and change the merge to `const merged = [...gmatRows, ...lsatRows, ...ogRows].sort(…)` (the comparator is unchanged).

- [ ] **Step 8: Dispatch the annotation write**

In `app.patch('/api/errors/:errorId'…)`, after the LSAT `if (isLsatDashboardId(rawId)) { … }` block:

```js
    // OG practice errors carry a namespaced "og-<attemptId>" id and live in
    // og_attempts, so they need their own writer too.
    if (isOgDashboardId(rawId)) {
      const updatedOg = await updateOgDashboardAnnotation(rawId, annotation);
      if (!updatedOg) {
        res.status(404).json({ error: 'Question attempt not found.' });
        return;
      }
      res.json({ ok: true, error: updatedOg });
      return;
    }
```

- [ ] **Step 9: Verify the merge end to end**

Restart the API. Using the session id from Task 5 step 4 (or a fresh set worked through the endpoints):

```bash
curl -s 'localhost:4310/api/sessions?platform=og' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.total, j.sessions.map(x=>[x.id,x.source,x.subject,x.accuracy_pct]));});"
curl -s 'localhost:4310/api/errors?platform=og' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.total);console.log(j.errors.slice(0,1).map(e=>({id:e.id,source:e.source,topic:e.topic,my:e.my_answer,key:e.correct_answer,stem:(e.question_stem||'').slice(0,60)})));});"
curl -s 'localhost:4310/api/sessions/og-1/analysis' | head -c 400; echo
curl -s -X PATCH localhost:4310/api/errors/og-1 -H 'Content-Type: application/json' -d '{"mistakeType":"[\"Trap: Extreme\"]","notes":"What happened: test"}'; echo
```

Expected: the session row carries `source: "GMAT OG Book · …"` and subject RC or CR; the error row carries a real stem and both letters; the analysis returns `session` + `slowWrongQuestions`; the PATCH echoes `{"ok":true,"error":{"id":"og-1",…}}`.

Also confirm the unfiltered list still merges all three: `curl -s 'localhost:4310/api/sessions' | node -e "…"` should show GMAT, LSAT and OG rows interleaved by date, and `?platform=starttest` should show **no** OG rows.

- [ ] **Step 10: Lint, test, commit**

```bash
npm run lint 2>&1 | tail -3 && npm test
git add src/og-dashboard.js src/server.js test/unit/og-dashboard.test.js
git commit -m "feat(og): merge OG practice into the session list, error log and analysis"
```

---

### Task 7: `client/src/GmatOgPractice.jsx` — builder, runner, summary

**Files:**
- Create: `client/src/GmatOgPractice.jsx`
- Modify: `client/src/App.jsx` — lazy import (`client/src/App.jsx:11-12`), `modeFromHash` (`:1672-1676`), the render branch (`:3738-3752`), the nav buttons (`:3787-3793`), `getSourcePlatform` (`:1235-1245`), `shortSourceLabel` (`:1249-1282`)
- Modify: `client/src/styles.css` — one new chip rule beside `.source-chip.source-lsat` (`client/src/styles.css:1403`)

**Interfaces:**
- Consumes: every `/api/og/*` endpoint from Task 5.
- Produces: a default-exported `GmatOgPractice({ onExit })` component mounted at `#og`.

**Reuse, don't re-create.** The `.lsat-st-*` CSS class family is the shared test chrome — `client/src/AiPractice.jsx` already uses it for a set-based runner, and that file (510 lines) is the model to follow, not the 1,318-line `LsatPractice.jsx`. `client/src/PassageLines.jsx` already renders a passage with its gutter numbering and is skin-neutral. Do not refactor `LsatPractice.jsx`.

- [ ] **Step 1: Write the component**

Create `client/src/GmatOgPractice.jsx`:

```jsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import PassageLines from './PassageLines';

// GMAT Official Guide book practice (#og). Questions come from
// data/gmat-og-questions.json through /api/og/*; only the answers are stored.
//
// Three screens: a filter-based Builder, a Runner, and a Summary. The test
// chrome (.lsat-st-*) is shared with the LSAT and AI-curated surfaces.
//
// Practice mode reveals the key and the book's explanation right after each
// answer; Timed mode holds both back until the summary. The server hands both
// back one answer at a time either way — the question payload carries neither —
// so Timed cannot be read out of the network tab in advance.

const API = '/api/og';
const CONFIDENCE = ['low', 'medium', 'high'];
const PER_Q_BUDGET_MS = 120000; // GMAT Focus pace ≈ 2 min / question

const pad2 = (n) => String(n).padStart(2, '0');
function formatMs(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}
const postJson = (url, body) =>
  fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ---- icons (match the LSAT/AI test surface) ----
const IconBack = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
);
const IconClock = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8" /><line x1="12" y1="13" x2="12" y2="9" /><line x1="12" y1="13" x2="15" y2="13" /><line x1="9" y1="2" x2="15" y2="2" /></svg>
);
const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><polyline points="9 12 12 15 16 10" /></svg>
);
const IconNext = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
);

// A multi-select chip row. An empty selection means "no constraint", which is
// what the label says so the user is not left guessing.
function ChipMulti({ label, options, selected, onToggle }) {
  return (
    <div className="og-filter">
      <div className="og-filter-label">{label}<span className="og-filter-hint">{selected.length ? '' : ' · any'}</span></div>
      <div className="og-chip-row">
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            className={`og-chip${selected.includes(o.label) ? ' is-on' : ''}`}
            onClick={() => onToggle(o.label)}
          >
            {o.label}<span className="og-chip-count">{o.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Builder({ onStart, onExit }) {
  const [library, setLibrary] = useState(null);
  const [error, setError] = useState(null);
  const [kind, setKind] = useState('CR');
  const [books, setBooks] = useState([]);
  const [typeLabels, setTypeLabels] = useState([]);
  const [difficulties, setDifficulties] = useState([]);
  const [historyMode, setHistoryMode] = useState('all');
  const [count, setCount] = useState(10);
  const [mode, setMode] = useState('practice');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchJson(`${API}/library`).then(setLibrary).catch((e) => setError(e.message));
  }, []);

  // Switching subject invalidates the type-label selection: the two subjects'
  // label vocabularies do not overlap.
  useEffect(() => { setTypeLabels([]); setPreview(null); }, [kind]);

  const filters = { books, kind, typeLabels, difficulties, historyMode, count: Number(count) || 10 };

  const runPreview = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await postJson(`${API}/build-set`, { filters }));
    } catch (e) {
      setError(e.message);
      setPreview(null);
    }
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [books, kind, typeLabels, difficulties, historyMode, count]);

  const toggle = (setter, list) => (value) =>
    setter(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  async function start() {
    if (!preview || preview.set.actual === 0) return;
    setBusy(true);
    try {
      const label = `${kind} · ${preview.set.actual} questions`;
      const { id } = await postJson(`${API}/sessions`, {
        questionIds: preview.set.questionIds, mode, setLabel: label, filters,
      });
      onStart({ sessionId: id, mode, questions: preview.questions, passages: preview.passages, label });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  if (error && !library) return <div className="lsat-st-shell"><main className="lsat-st-body"><p className="og-error">{error}</p></main></div>;
  if (!library) return <div className="lsat-st-shell"><main className="lsat-st-body"><p className="muted">Loading the question pool…</p></main></div>;

  const lib = library.library;
  return (
    <div className="lsat-st-shell">
      <header className="lsat-st-topbar">
        <div className="lsat-st-topbar-left">
          <button type="button" className="lsat-st-icon-btn" onClick={onExit} aria-label="Exit to GMAT Dashboard" title="Exit"><IconBack /></button>
          <span className="lsat-st-section-label">GMAT OG Book Practice</span>
        </div>
        <div className="lsat-st-topbar-right">
          <span className="lsat-st-set-meta">{lib.totals.CR} CR · {lib.totals.RC} RC across {lib.totals.passages} passages · {library.history.attempted} seen, {library.history.wrong} missed</span>
        </div>
      </header>

      <main className="lsat-st-body og-builder">
        <div className="og-filter">
          <div className="og-filter-label">Subject</div>
          <div className="og-chip-row">
            {['CR', 'RC'].map((k) => (
              <button key={k} type="button" className={`og-chip${kind === k ? ' is-on' : ''}`} onClick={() => setKind(k)}>
                {k === 'CR' ? 'Critical Reasoning' : 'Reading Comprehension'}<span className="og-chip-count">{lib.totals[k]}</span>
              </button>
            ))}
          </div>
        </div>

        <ChipMulti
          label="Book"
          options={lib.books.map((b) => ({ label: b.code, count: b.counts[kind] }))}
          selected={books}
          onToggle={toggle(setBooks, books)}
        />
        <ChipMulti label="Question type" options={lib.typeLabels[kind]} selected={typeLabels} onToggle={toggle(setTypeLabels, typeLabels)} />
        <ChipMulti label="Difficulty" options={lib.difficulties[kind]} selected={difficulties} onToggle={toggle(setDifficulties, difficulties)} />

        <div className="og-filter">
          <div className="og-filter-label">History</div>
          <div className="og-chip-row">
            {[['all', 'All questions'], ['unseen', 'Unseen only'], ['wrong', 'Previously wrong']].map(([v, l]) => (
              <button key={v} type="button" className={`og-chip${historyMode === v ? ' is-on' : ''}`} onClick={() => setHistoryMode(v)}>{l}</button>
            ))}
          </div>
        </div>

        <div className="og-filter og-filter-row">
          <label className="og-filter-label" htmlFor="og-count">Questions</label>
          <input id="og-count" type="number" min="1" max="50" value={count} onChange={(e) => setCount(e.target.value)} className="og-count-input" />
          <div className="og-chip-row">
            {[['practice', 'Practice · explain as I go'], ['timed', 'Timed · explain at the end']].map(([v, l]) => (
              <button key={v} type="button" className={`og-chip${mode === v ? ' is-on' : ''}`} onClick={() => setMode(v)}>{l}</button>
            ))}
          </div>
        </div>

        <div className="og-builder-actions">
          <button type="button" className="lsat-st-submit" onClick={runPreview} disabled={busy}>Preview set</button>
          {preview && (
            <>
              <span className="og-preview-note">
                {preview.set.actual === 0
                  ? 'No questions match those filters.'
                  : kind === 'RC'
                    ? `${preview.set.actual} questions across ${preview.set.passageCount} whole passages${preview.set.shortfall ? ` — fewer than the ${preview.set.requested} requested; RC is drawn a whole passage at a time.` : ''}`
                    : `${preview.set.actual} questions${preview.set.shortfall ? ` — fewer than the ${preview.set.requested} requested. No filter was relaxed.` : ''}`}
              </span>
              <button type="button" className="lsat-st-submit is-next" onClick={start} disabled={busy || preview.set.actual === 0}>Start<IconNext /></button>
            </>
          )}
        </div>
        {error && <p className="og-error">{error}</p>}
      </main>
    </div>
  );
}

// One passage rendered beside its questions, plus the book's explanation when
// the mode allows it.
function Explanation({ explanation, correct, picked }) {
  if (!explanation) return <p className="og-explanation-missing">This question is keyed but the book&rsquo;s explanation was not recovered for it.</p>;
  const letters = Object.keys(explanation.choices || {}).sort();
  return (
    <div className="og-explanation">
      {explanation.situation && <p><b>Situation.</b> {explanation.situation}</p>}
      {explanation.reasoning && <p><b>Reasoning.</b> {explanation.reasoning}</p>}
      {letters.map((l) => (
        <p key={l} className={`og-exp-choice${l === correct ? ' is-correct' : ''}${l === picked && l !== correct ? ' is-picked' : ''}`}>
          <b>{l}.</b> {explanation.choices[l]}
        </p>
      ))}
    </div>
  );
}

function Runner({ session, onFinish, onExit }) {
  const { questions, passages, mode, sessionId, label } = session;
  const isTimed = mode === 'timed';
  const passageById = new Map((passages || []).map((p) => [p.id, p]));

  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({}); // id -> { answer, timeSec, confidence, submitted }
  const [feedback, setFeedback] = useState({}); // id -> { isCorrect, correctAnswer, explanation }
  const [paused, setPaused] = useState(false);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState(null);

  const qStartRef = useRef(Date.now());
  const qAccRef = useRef(0);
  const sessStartRef = useRef(Date.now());
  const sessAccRef = useRef(0);

  const q = questions[idx];
  const cur = answers[q.id] || null;
  const submitted = !!cur?.submitted;
  const chosen = cur?.answer || null;
  const fb = feedback[q.id] || null;
  const revealed = !isTimed && submitted && fb;

  // Practice mode holds both clocks while the explanation is on screen; Timed
  // stays continuously timed like the real test.
  const clockStopped = paused || !!revealed;

  const budget = PER_Q_BUDGET_MS * questions.length;
  const elapsed = clockStopped ? sessAccRef.current : (now - sessStartRef.current + sessAccRef.current);
  const remaining = budget - elapsed;
  const over = remaining < 0;
  const absR = Math.abs(remaining);

  const qElapsed = submitted ? (cur.timeSec || 0) * 1000 : (paused ? qAccRef.current : now - qStartRef.current + qAccRef.current);
  const answeredCount = questions.filter((x) => answers[x.id]?.submitted).length;

  useEffect(() => {
    if (clockStopped) return undefined;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [clockStopped]);

  useEffect(() => {
    if (paused) return;
    if (revealed) sessAccRef.current += Date.now() - sessStartRef.current;
    else sessStartRef.current = Date.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed]);

  useEffect(() => {
    qStartRef.current = Date.now();
    qAccRef.current = (answers[questions[idx].id]?.timeSec || 0) * 1000;
    setNow(Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  useEffect(() => {
    function onKey(e) {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.key === 'ArrowLeft' && idx > 0) setIdx(idx - 1);
      else if (e.key === 'ArrowRight' && idx < questions.length - 1) setIdx(idx + 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [idx, questions.length]);

  const pick = (label2) => {
    if (submitted) return;
    setAnswers((a) => ({ ...a, [q.id]: { ...(a[q.id] || {}), answer: label2 } }));
  };
  const toggleConfidence = (lv) => {
    if (submitted) return;
    setAnswers((a) => ({ ...a, [q.id]: { ...(a[q.id] || {}), confidence: a[q.id]?.confidence === lv ? null : lv } }));
  };

  function togglePause() {
    if (paused) {
      qStartRef.current = Date.now();
      sessStartRef.current = Date.now();
      setPaused(false);
    } else {
      qAccRef.current += Date.now() - qStartRef.current;
      sessAccRef.current += Date.now() - sessStartRef.current;
      setPaused(true);
    }
  }

  async function submit() {
    if (!chosen || checking) return;
    const ms = paused ? qAccRef.current : Date.now() - qStartRef.current + qAccRef.current;
    const timeSec = Math.round(ms / 1000);
    setChecking(true);
    try {
      const r = await postJson(`${API}/attempts`, {
        questionId: q.id, userAnswer: chosen, timeMs: ms,
        confidence: answers[q.id]?.confidence || null, sessionId,
      });
      setAnswers((a) => ({ ...a, [q.id]: { ...(a[q.id] || {}), answer: chosen, timeSec, submitted: true } }));
      setFeedback((f) => ({ ...f, [q.id]: { isCorrect: r.isCorrect, correctAnswer: r.correctAnswer, explanation: r.explanation } }));
    } catch (e) {
      setError(e.message); // leave the question unsubmitted so it can be retried
    }
    setChecking(false);
  }

  async function finish() {
    try { await postJson(`${API}/sessions/${sessionId}/complete`, {}); } catch (e) { /* the attempts are already saved */ }
    onFinish({ questions, answers, feedback });
  }

  const goNext = () => { if (idx < questions.length - 1) setIdx(idx + 1); else finish(); };
  const passage = q.passageId ? passageById.get(q.passageId) : null;

  return (
    <div className="lsat-st-shell">
      <header className="lsat-st-topbar">
        <div className="lsat-st-topbar-left">
          <button type="button" className="lsat-st-icon-btn" onClick={onExit} aria-label="Back to the set builder" title="Back to the set builder"><IconBack /></button>
          <span className="lsat-st-section-label">{label}</span>
        </div>
        <div className="lsat-st-topbar-right">
          <span className="lsat-st-set-meta">{q.bookCode} · {q.typeLabel || q.kind} · {q.difficulty || 'Unrated'} · {isTimed ? 'Timed' : 'Practice'}</span>
          <button type="button" className="lsat-st-finish-btn" onClick={finish} title="End now and save answered questions">End Session</button>
        </div>
      </header>

      <div className="lsat-st-subbar">
        <div className="lsat-st-subbar-left">
          <span className="lsat-st-confidence-label">Confidence:</span>
          {CONFIDENCE.map((lv) => (
            <button key={lv} type="button" className={`lsat-st-confidence-btn${answers[q.id]?.confidence === lv ? ' is-on' : ''}`} onClick={() => toggleConfidence(lv)} disabled={submitted}>{lv}</button>
          ))}
        </div>
        <div className="lsat-st-subbar-right">
          <button type="button" className="lsat-st-icon-btn" onClick={togglePause} title={paused ? 'Resume' : 'Pause'}>{paused ? 'Resume' : 'Pause'}</button>
          <span className={`lsat-st-timer${over ? ' is-over' : ''}`}>
            <IconClock />{over ? '+' : ''}{pad2(Math.floor(absR / 60000))}:{pad2(Math.floor((absR % 60000) / 1000))}
            {over && <span className="lsat-st-overtime-tag">OVER</span>}
          </span>
          <span className="lsat-st-score">{answeredCount}<span className="lsat-st-score-of">/{questions.length}</span></span>
          {!submitted
            ? <button type="button" className="lsat-st-submit" onClick={submit} disabled={!chosen || checking || paused}>{checking ? 'Checking…' : 'Submit'}<IconCheck /></button>
            : <button type="button" className="lsat-st-submit is-next" onClick={goNext}>{idx >= questions.length - 1 ? 'Finish' : 'Next'}<IconNext /></button>}
        </div>
      </div>

      <main className={`lsat-st-body${passage ? ' has-passage' : ''}`}>
        {passage && (
          <section className="lsat-st-passage" aria-label="Passage">
            <div className="lsat-st-passage-marker">{q.bookCode} · page {passage.page}</div>
            <PassageLines lines={passage.lines} text={passage.text} className="lsat-st-passage-body" />
          </section>
        )}
        <section className="lsat-st-question">
          <div className="lsat-st-q-meta">
            <span>Question {idx + 1} of {questions.length}</span>
            <span>{formatMs(qElapsed)}</span>
          </div>
          {q.stemHtml
            ? <div className="lsat-st-stem" dangerouslySetInnerHTML={{ __html: q.stemHtml }} />
            : <div className="lsat-st-stem">{q.stem}</div>}
          <div className="lsat-st-choices" role="radiogroup" aria-label="Answer choices">
            {q.choices.map((c) => {
              const isPick = chosen === c.label;
              const isKey = revealed && fb.correctAnswer === c.label;
              const isWrongPick = revealed && isPick && !fb.isCorrect;
              return (
                <button
                  key={c.label}
                  type="button"
                  role="radio"
                  aria-checked={isPick}
                  className={`lsat-st-choice${isPick ? ' is-picked' : ''}${isKey ? ' is-correct' : ''}${isWrongPick ? ' is-wrong' : ''}`}
                  onClick={() => pick(c.label)}
                  disabled={submitted}
                >
                  <span className="lsat-st-choice-text"><b>{c.label}.</b> {c.text}</span>
                </button>
              );
            })}
          </div>
          {submitted && isTimed && <p className="og-timed-note">Answer saved. Explanations come at the end of the set.</p>}
          {revealed && (
            <>
              <p className={`og-verdict${fb.isCorrect ? ' is-correct' : ' is-wrong'}`}>
                {fb.isCorrect ? 'Correct.' : `Incorrect — the answer is ${fb.correctAnswer}.`}
              </p>
              <Explanation explanation={fb.explanation} correct={fb.correctAnswer} picked={chosen} />
            </>
          )}
          {error && <p className="og-error">{error}</p>}
          <div className="lsat-st-actions">
            <button type="button" onClick={() => setIdx(Math.max(0, idx - 1))} disabled={idx === 0} className="lsat-st-link-btn">Previous</button>
            <button type="button" onClick={() => setIdx(Math.min(questions.length - 1, idx + 1))} disabled={idx >= questions.length - 1} className="lsat-st-link-btn">Next</button>
          </div>
        </section>
      </main>
    </div>
  );
}

// End-of-set review. In Timed mode this is the first place the keys and the
// book's explanations appear.
function Summary({ result, onAgain, onExit }) {
  const { questions, answers, feedback } = result;
  const answered = questions.filter((q) => answers[q.id]?.submitted);
  const correct = answered.filter((q) => feedback[q.id]?.isCorrect).length;
  const [openId, setOpenId] = useState(null);

  return (
    <div className="lsat-st-shell">
      <header className="lsat-st-topbar">
        <div className="lsat-st-topbar-left">
          <button type="button" className="lsat-st-icon-btn" onClick={onExit} aria-label="Exit" title="Exit"><IconBack /></button>
          <span className="lsat-st-section-label">Set review</span>
        </div>
        <div className="lsat-st-topbar-right">
          <span className="lsat-st-set-meta">{correct}/{answered.length} correct{answered.length < questions.length ? ` · ${questions.length - answered.length} unanswered` : ''}</span>
          <button type="button" className="lsat-st-finish-btn" onClick={onAgain}>Build another set</button>
        </div>
      </header>
      <main className="lsat-st-body og-summary">
        {questions.map((q, i) => {
          const a = answers[q.id];
          const f = feedback[q.id];
          const open = openId === q.id;
          return (
            <div key={q.id} className={`og-summary-row${f ? (f.isCorrect ? ' is-correct' : ' is-wrong') : ''}`}>
              <button type="button" className="og-summary-head" onClick={() => setOpenId(open ? null : q.id)}>
                <span className="og-summary-n">{i + 1}</span>
                <span className="og-summary-stem">{(q.stem || '').slice(0, 110)}…</span>
                <span className="og-summary-verdict">
                  {!a?.submitted ? 'skipped' : f ? `${a.answer} / ${f.correctAnswer}` : a.answer}
                </span>
                <span className="og-summary-time">{formatMs((a?.timeSec || 0) * 1000)}</span>
              </button>
              {open && (
                <div className="og-summary-detail">
                  <div className="lsat-st-stem">{q.stem}</div>
                  {q.choices.map((c) => (
                    <p key={c.label} className={`og-exp-choice${f && c.label === f.correctAnswer ? ' is-correct' : ''}${a?.answer === c.label && f && !f.isCorrect ? ' is-picked' : ''}`}>
                      <b>{c.label}.</b> {c.text}
                    </p>
                  ))}
                  {f && <Explanation explanation={f.explanation} correct={f.correctAnswer} picked={a?.answer} />}
                </div>
              )}
            </div>
          );
        })}
      </main>
    </div>
  );
}

export default function GmatOgPractice({ onExit }) {
  const [session, setSession] = useState(null);
  const [result, setResult] = useState(null);

  if (result) {
    return <Summary result={result} onAgain={() => { setResult(null); setSession(null); }} onExit={onExit} />;
  }
  if (session) {
    return <Runner session={session} onFinish={setResult} onExit={() => setSession(null)} />;
  }
  return <Builder onStart={setSession} onExit={onExit} />;
}
```

- [ ] **Step 2: Add the styles**

Append to `client/src/styles.css`, after the `.source-chip.source-ai-curated` rule:

```css
/* GMAT OG book practice — its own chip so book practice is not read as one of
   the seven StartTest "OG ..." products. Warm-paper tokens only. */
.source-chip.source-og {
  background: rgba(196, 168, 67, 0.16);
  color: #7a6420;
  border: 1px solid rgba(196, 168, 67, 0.38);
}

/* Set builder. The runner and summary reuse the shared .lsat-st-* test chrome. */
.og-builder { display: block; padding: 20px 24px; overflow-y: auto; }
.og-filter { margin-bottom: 18px; }
.og-filter-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.og-filter-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.7; margin-bottom: 6px; }
.og-filter-hint { text-transform: none; letter-spacing: 0; opacity: 0.6; }
.og-chip-row { display: flex; flex-wrap: wrap; gap: 8px; }
.og-chip {
  border: 1px solid var(--st-divider, rgba(0, 0, 0, 0.16));
  background: transparent; color: inherit;
  border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer;
}
.og-chip.is-on { background: rgba(61, 122, 94, 0.16); border-color: rgba(61, 122, 94, 0.5); }
.og-chip-count { opacity: 0.55; margin-left: 6px; font-size: 11px; }
.og-count-input { width: 70px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--st-divider, rgba(0, 0, 0, 0.16)); background: transparent; color: inherit; }
.og-builder-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
.og-preview-note { font-size: 13px; opacity: 0.85; }
.og-error { color: #b3261e; font-size: 13px; }

/* Explanation + review */
.og-explanation { margin-top: 14px; font-size: 14px; line-height: 1.55; }
.og-explanation-missing { margin-top: 14px; font-size: 13px; opacity: 0.7; }
.og-exp-choice { margin: 6px 0; padding-left: 10px; border-left: 3px solid transparent; }
.og-exp-choice.is-correct { border-left-color: #3d7a5e; }
.og-exp-choice.is-picked { border-left-color: #b3261e; }
.og-verdict { margin-top: 14px; font-weight: 600; }
.og-verdict.is-correct { color: #3d7a5e; }
.og-verdict.is-wrong { color: #b3261e; }
.og-timed-note { margin-top: 14px; font-size: 13px; opacity: 0.75; }
.og-summary { display: block; padding: 16px 24px; overflow-y: auto; }
.og-summary-row { border-bottom: 1px solid var(--st-divider, rgba(0, 0, 0, 0.12)); }
.og-summary-head { display: flex; gap: 12px; align-items: baseline; width: 100%; text-align: left; background: none; border: 0; color: inherit; font: inherit; padding: 10px 0; cursor: pointer; }
.og-summary-n { width: 24px; opacity: 0.6; }
.og-summary-stem { flex: 1; }
.og-summary-verdict { font-variant-numeric: tabular-nums; }
.og-summary-row.is-correct .og-summary-verdict { color: #3d7a5e; }
.og-summary-row.is-wrong .og-summary-verdict { color: #b3261e; }
.og-summary-time { width: 56px; text-align: right; opacity: 0.6; font-variant-numeric: tabular-nums; }
.og-summary-detail { padding: 6px 0 16px 36px; }
```

- [ ] **Step 3: Wire it into `App.jsx`**

Beside the existing lazy import (`client/src/App.jsx:12`):

```js
const GmatOgPractice = lazy(() => import('./GmatOgPractice'));
```

In `modeFromHash` (`client/src/App.jsx:1672`), above the `#lsat` line:

```js
  if (hash === '#og') return 'og';
```

Beside the `LsatPractice` render branch (`client/src/App.jsx:3735-3741`) — same `RouteFallback` wrapper the three existing branches use:

```jsx
  if (appMode === 'og') {
    return (
      <Suspense fallback={<RouteFallback />}>
        <GmatOgPractice onExit={() => { window.location.hash = ''; }} />
      </Suspense>
    );
  }
```

Beside the nav buttons (`client/src/App.jsx:3787-3795`), after the LSAT one:

```jsx
          <Button variant="outline" size="sm" type="button" onClick={() => { window.location.hash = '#og'; }}>
            OG Book Practice
          </Button>
```

In `getSourcePlatform` (`client/src/App.jsx:1235`), **directly after the `lsat` line** — it must precede the StartTest fallback, and the prefix is specific enough not to collide with the "OG Verbal Review" / "OG Quant Review" / "OG 2024-2025 Main" StartTest presets:

```js
  if (/gmat\s*og\s*book/i.test(raw)) return 'og';
```

In `shortSourceLabel` (`client/src/App.jsx:1249`), beside `if (platform === 'lsat') return 'LSAT';`:

```js
  if (platform === 'og') return raw.replace(/^GMAT\s*OG\s*Book\s*·\s*/i, 'OG Book ').trim() || 'OG Book';
```

- [ ] **Step 4: Check the platform classification did not break StartTest**

```bash
node --input-type=module -e "
const getSourcePlatform = (sourceLabel) => {
  const raw = String(sourceLabel || '').trim();
  if (!raw) return null;
  if (/lsat/i.test(raw)) return 'lsat';
  if (/gmat\s*og\s*book/i.test(raw)) return 'og';
  if (/ai\s*curated/i.test(raw)) return 'ai-curated';
  if (/gmat\s*club\s*cat/i.test(raw)) return 'gmatclub-cat';
  if (/gmat\s*club/i.test(raw)) return 'gmatclub';
  if (/target\s*test\s*prep/i.test(raw)) return 'ttp';
  if (/official\s*practice\s*exam/i.test(raw)) return 'ope-mock';
  return 'starttest';
};
const cases = [
  ['GMAT OG Book · OG13', 'og'],
  ['GMAT OG Book · Mixed', 'og'],
  ['OG Verbal Review', 'starttest'],
  ['OG Quant Review', 'starttest'],
  ['OG 2024-2025 Main', 'starttest'],
  ['GMAT Club CAT', 'gmatclub-cat'],
  ['LSAT PrepTest 52 · Section III', 'lsat'],
];
for (const [label, want] of cases) {
  const got = getSourcePlatform(label);
  if (got !== want) throw new Error(\`\${label}: got \${got}, want \${want}\`);
}
console.log('all platform classifications correct');
"
```

Expected: `all platform classifications correct`. (Keep this snippet identical to the edited function — if it diverges, the check is worthless.)

- [ ] **Step 5: Build and work a set by hand**

Run `npm run dev` and open `http://localhost:5170/#og`. Verify, in order:

1. The builder shows CR 173 / RC 195 and a passage total; chips carry counts.
2. Selecting **RC**, count 10, previewing states a passage count and warns when the set is short.
3. Starting a **Practice** set reveals the key and the book's explanation right after Submit, and both clocks stop while it is on screen.
4. A question with no explanation shows the "keyed but the explanation was not recovered" line rather than an empty panel.
5. The RC passage renders beside the questions with gutter line numbers, and the same passage persists across its whole group.
6. A **Timed** set reveals nothing until Finish; the summary then shows every key and explanation. Confirm in DevTools that the `build-set` response carries neither a `correct` nor an `explanation` field on any question.
7. `#` (the dashboard) then shows the session in Performance by Session with an "OG Book" chip, and the misses in the Error Log with working annotation.

- [ ] **Step 6: Lint, test, commit**

```bash
npm run lint 2>&1 | tail -3 && npm test && npm run build:web
git add client/src/GmatOgPractice.jsx client/src/App.jsx client/src/styles.css
git commit -m "feat(og): add the OG book practice screen at #og"
```

---

### Task 8: Documentation and the end-to-end acceptance pass

**Files:**
- Modify: `CLAUDE.md` — the "GMAT OG verbal practice (PDF-extracted)" section
- Modify: `docs/superpowers/plans/2026-09-14-gmat-og-verbal-extraction.md` — its "Next phase — not started" section
- Modify: `ANALYSIS.md` — the endpoint reference, if it enumerates platforms

- [ ] **Step 1: Run the whole acceptance list**

With the API and web dev servers running, confirm each of these and note the result:

| Check | How |
|---|---|
| A set builds from filters in both subjects | `#og` builder, CR and RC |
| RC never splits a passage group | the Task-4 step-5 script, plus eyeballing one RC set |
| An over-constrained filter returns a short set with a notice | select one rare type label with count 50 |
| Practice mode explains after each answer; Timed withholds until the summary | work two 3-question sets |
| Misses appear in the main error log under `platform=og` | `curl -s 'localhost:4310/api/errors?platform=og'` |
| Annotation round-trips (mistake tag + the three review-note prompts) | annotate from the dashboard, reload, confirm it persisted |
| The session appears in Performance by Session with the OG chip | `#` dashboard |
| Session deep-dive opens for an `og-<n>` id | click the session row |
| A subject filter of RC or CR returns LSAT **and** OG rows | `curl -s 'localhost:4310/api/sessions?subject=RC'` |
| `platform=starttest` returns no OG rows | `curl -s 'localhost:4310/api/sessions?platform=starttest'` |

- [ ] **Step 2: Document the track in `CLAUDE.md`**

Append to the "GMAT OG verbal practice (PDF-extracted)" section, after the pipeline table:

```markdown
### The practice track

The pool is served at `#og` (`client/src/GmatOgPractice.jsx`) through
`/api/og/*`. Answers live in `og_attempts` / `og_sessions` (migration `0010`);
question content never enters the database — `question_id` (`'OG13-CR-56'`) is
the join key into the JSON file.

| Module | Responsibility |
|---|---|
| `src/og-data.js` | cached reader + index over the pool; library facets. **Restart the API after regenerating the JSON.** |
| `src/og-set-builder.js` | pure filter → question list. RC draws whole passages |
| `src/og-dashboard.js` | OG rows → dashboard session/question shapes, `og-<id>` namespaced |

Three things to know before changing any of it:

- **The question payload the browser receives carries neither `correct` nor
  `explanation`.** Both come back one answer at a time from
  `POST /api/og/attempts`, which is what makes Timed mode's withheld
  explanations actually withheld — one rationale in every explanation opens with
  "Correct.", so shipping them with the questions would leak the whole key list.
- **RC draws whole passages, so the delivered count is approximate.** A group
  that would overshoot the requested count is skipped, not truncated; the
  preview states the real count and the passage total. A type-label filter in RC
  selects *passages containing* a match and still delivers the full group.
- **Source labels must start `GMAT OG Book`.** `getSourcePlatform`
  (`client/src/App.jsx`) classifies by substring and three StartTest presets are
  already named "OG Verbal Review", "OG Quant Review" and "OG 2024-2025 Main" —
  a bare "OG" in the label puts book practice on the StartTest chip.
```

Also update the usable count in that section's opening paragraph from **377** to **368**, and add `boldface-unmarked` to the exclusion reasons: the 9 CR questions asking what "the portion in boldface" does, whose bold spans never survived extraction, are unanswerable as rendered and are excluded.

- [ ] **Step 3: Close out the extraction plan's "next phase" section**

In `docs/superpowers/plans/2026-09-14-gmat-og-verbal-extraction.md`, replace the "Next phase — not started" section with a pointer to this plan and its outcome (built / date / what shipped).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/plans/2026-09-14-gmat-og-verbal-extraction.md ANALYSIS.md
git commit -m "docs: document the OG book practice track"
```

- [ ] **Step 5: Finish the branch**

Announce: "I'm using the finishing-a-development-branch skill to complete this work."
**REQUIRED SUB-SKILL:** `superpowers:finishing-a-development-branch`. `feat/og-verbal-extraction` carries the extraction work and is unpushed; that skill decides whether this ships as one branch or two.

---

## Notes for the implementer

- **The pool is gitignored.** Nothing under `data/gmat-og-questions.json*` or `docs/*.pdf` is ever committed — the repo is public and the books are copyrighted.
- **Difficulty is a rough relative ranking**, not a calibrated measure: tertiles of an LLM's estimated percent-correct, correlating only ~0.15-0.22 with printed question order. Present it as a filter, never as a claim about the question.
- **100 of the 368 usable questions carry no type label and no explanation.** Both surfaces must degrade gracefully — the builder exposes an `(unlabeled)` bucket, the runner says the explanation was not recovered.
- **OG13's CR section is withheld entirely** (`unverifiable-key`): no printed key survived OCR and its numbering is mostly inferred, so nothing cross-checks the explanation pairing. Do not "fix" the builder to include it.
