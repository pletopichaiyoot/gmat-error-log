# AI Curated Practice — Design

**Date:** 2026-07-18
**Status:** Approved (brainstorming)
**Author:** pletopichaiyoot + Claude

## Purpose

Add a new full-screen tab beside **LSAT Practice** where the user re-attempts real GMAT
questions pulled from his own scraped error logs, as a timed practice session. Every answer
is logged as a normal `question_attempt` under a new source, **"AI Curated Practice"**, so
the redo shows up in performance-by-session and the error log — and the redo row carries the
**original question's `q_code`**, so the redo attempt links back to the prior attempt even
when that prior attempt lives on a different platform (GMAT Club, OG, TTP, …).

The "AI curation" is done **outside the app** by Claude Cowork: Claude queries the DB,
selects which error-log questions to redo, and writes a practice-set file. The app is the
delivery + grading + logging vehicle — it makes **no in-app LLM calls**.

## Non-goals

- No generation of *new* questions. Only re-serving existing enriched (Phase-2) questions.
- No in-app LLM/OpenAI/Z AI dependency. `buildModel()` is not used.
- **v1 grades single-answer questions only** (single-choice MC, and DI single-answer). Multi-part
  DI formats with a nested `options[]` shape (matrix / Two-Part Analysis / MSR / Graphics
  Interpretation) are **excluded from serving in v1**: the serve endpoint treats a row whose
  `answer_choices` is not a flat `{label,text,…}[]` as non-gradeable and skips it (with a note),
  and the curation recipe filters them out. Multi-part grading is a follow-up.
- No universal cross-platform GMAT-question identity. Linkage is per source-of-origin
  (the same real question scraped from two platforms has two different `q_code`s). This is
  acceptable: the use case is "redo this specific error-log question, see both attempts".

## Architecture overview

```
Claude Cowork (SQL over DB)                     User in browser
        │ curates                                       │
        ▼                                               ▼
data/ai-practice-sets/<slug>.json  ──served──►  AiPractice.jsx (#ai-practice tab)
   { slug, title, focusNote, subject, items:[attemptId,…] }   Set list → Runner → Result
        │                                               │ submit answers
        └───────────── source rows read live ───────────┤
                                                         ▼
                          server grades vs source correct_answer
                                                         │
                                                         ▼
                    sessions(source="AI Curated Practice") + question_attempts
                    (q_code = original q_code, q_id = aic-att-<slug>-<n>)
```

## Practice sets — file format

Mirrors the LSAT precedent (content served from a `data/` file, attempts stored in DB).

- Location: `data/ai-practice-sets/<slug>.json`, **gitignored** (local-only, like
  `data/lsat-questions.json`).
- **Read fresh on every request — no in-process cache** (deliberately avoids the LSAT
  loader's restart-to-refresh friction). The directory is tiny (single-user, a handful of
  sets), so re-reading per request is cheap.
- Schema:

```json
{
  "slug": "quant-algebra-redo-01",
  "title": "Algebra redo — ratios & rates",
  "focusNote": "You missed 4 ratio setups last week. Redo these before moving on.",
  "subject": "Quant",
  "items": [1287, 1290, 1305]
}
```

- `slug` — stable id, also the filename stem. `[a-z0-9-]+`.
- `items` — array of **`question_attempts.id`** (the DB row id of the original enriched
  question). Content is read live from that row at serve time — the set file stores no stems.
- Each referenced row MUST be *gradeable*: non-empty `question_stem`, `answer_choices` not
  `[]`/empty, non-empty `correct_answer`. The serve endpoint validates and skips/reports
  non-gradeable items.

### Curation recipe (Claude Cowork)

Documented in a memory file + ANALYSIS.md so curation is reproducible across sessions. Baseline
"redo candidates" query — wrong, gradeable, least-recently-attempted first:

```sql
SELECT qa.id, qa.q_code, s.source, qa.topic, qa.subcategory, qa.difficulty,
       qa.correct, qa.created_at
FROM question_attempts qa JOIN sessions s ON s.id = qa.session_id
WHERE qa.correct = 0
  AND qa.question_stem IS NOT NULL AND length(qa.question_stem) > 10
  AND qa.answer_choices IS NOT NULL AND qa.answer_choices NOT IN ('', '[]')
  AND qa.correct_answer IS NOT NULL AND qa.correct_answer <> ''
  AND qa.subject_code = 'Q'          -- filter by subject as needed
ORDER BY qa.created_at ASC
LIMIT 30;
```

Claude picks from the result, writes the set file with the chosen `id`s.

## REST endpoints (new, in `server.js`)

- `GET /api/ai-practice/sets` — list all set files. For each: slug, title, focusNote,
  subject, item count, and whether a logged session already exists (completed history).
  Returns pending + completed. Reads the dir fresh.
- `GET /api/ai-practice/sets/:slug` — serve one set for the runner: title, focusNote, and
  per-item question payload read live from the source row — `{ itemId, q_code, source,
  topic, difficulty, question_stem, question_stem_html, answer_choices }` with
  **`correct_answer` and per-choice `isCorrect` flags stripped** (anti-peek). Also returns
  a compact prior-attempt summary per item (original correct/incorrect, date, source) for
  the result screen.
- `POST /api/ai-practice/sets/:slug/submit` — body
  `{ feedbackMode, answers: [{ itemId, answer, timeSec, confidence }] }`. Server grades each
  answer against the source row's `correct_answer`, writes the session + attempts (see
  below), and returns `{ sessionId, score, results: [{ itemId, correct, correctAnswer,
  yourAnswer, priorAttempt }] }`.

`answer` is the chosen choice label (e.g. "C"). `feedbackMode` ∈ `immediate | end` is stored
only for UX; grading is identical.

## DB writer — `logAiCuratedSession` (in `db.js`)

New writer (does not go through any scraper). Inside one `withTransaction`:

1. Insert/create a `scrape_runs` row for provenance (source label "AI Curated Practice"),
   or reuse the generic run-creation path.
2. Insert one `sessions` row:
   - `source = "AI Curated Practice"`
   - `session_external_id` = 53-bit hash of `<slug>|<timestamp>` — **new session per practice
     run** (re-practicing a set piles up history, never overwrites).
   - `session_date` = today in Asia/Bangkok.
   - `subject` = set's subject (or dominant across items).
3. Insert one `question_attempts` row per answered item:
   - `q_code` = **original row's `q_code`** (linkage key).
   - `q_id` = `aic-att-<slug>-<n>`.
   - Copy from source row: `question_stem`, `question_stem_html`, `answer_choices`,
     `correct_answer`, `difficulty`, `difficulty_theta` (leave NULL — non-OPE), `topic`,
     `subject_code`, `category_code`, `subcategory`, `question_url`, `response_format`.
   - `topic_source = 'ai-curated'` (classifier skips it — topic copied from source).
   - Graded fields: `correct` (0/1 vs source `correct_answer`), `my_answer`, `time_sec`,
     `confidence`.
   - `mistake_type`, `notes` left blank (user annotates later in the dashboard).

Because `q_code` is the original's, `SELECT * FROM question_attempts WHERE q_code = X ORDER BY
created_at` returns the original attempt (GMAT Club / OG / …) **and** the AI-curated redo.

**difficulty caveat (respect the OPE-only rule):** `difficulty` is copied verbatim from the
source row; `difficulty_theta` stays NULL. AI-curated sessions are **not** OPE, so
`recomputeIrtCutoffs()` and the theta backfill must continue to ignore them (they are already
scoped to `source LIKE '%practice exam%'`). No change needed there — just do not set
`difficulty_theta`.

## Source / platform plumbing

New platform key `'ai-curated'`, matched on the source label substring `ai curated`.

- **Frontend `getSourcePlatform(label)`** — add `/ai\s*curated/i → 'ai-curated'`. Order it
  so it can't be shadowed by another rule (no overlap with existing keys, so any position
  before the `starttest` fallback works).
- **Backend `platformWhereClause`** — add `'%ai curated%'` → `'ai-curated'`.
- **`<SourceBadge>`** — new variant, label "AI Curated", `.source-ai` class (a distinct
  color from indigo/amber — e.g. forest-sage per DESIGN.md, since this is the app's own
  first-party practice).
- **Source filter `<Select>`** in the sessions table, error-log table, and the platform
  `<option>` lists — add an "AI Curated" option wired to `platform=ai-curated`.

## Frontend — `AiPractice.jsx`

Full-screen component, hash route `#ai-practice`, mounted exactly like `LsatPractice`:

- `App.jsx` `modeFromHash`: `#ai-practice → 'ai-practice'`.
- `App.jsx` render: `if (appMode === 'ai-practice') return <AiPractice onExit={…}/>`.
- Top-bar button "AI Practice" next to "LSAT Practice".

Three internal screens (local component state, no router):

1. **Set list** — cards from `GET /api/ai-practice/sets`. Pending sets have a Start button;
   completed sets show score + link to the logged session. Empty state when no set files
   exist ("Curate a set with Claude Cowork — see the recipe").
2. **Runner** — after Start: a small setup row (feedback-timing toggle: *immediate* vs
   *end-review*) then question-by-question. Reuse the review-modal's stem/choice rendering
   (including `question_stem_html` math-image rendering) — extract the minimal renderer into
   a shared helper if it's currently trapped inside `App.jsx`. Per-question timer, choice
   selection, optional confidence, Next. In *immediate* mode, submit each answer's result is
   revealed inline after pick; in *end* mode, answers are held and revealed only on Result.
3. **Result** — overall score, per-question review (your pick / correct / your original
   attempt from the prior platform), focus note. "Back to sets" and "Retry set".

## Grading & anti-peek

Grading is **server-side**. The serve endpoint strips `correct_answer` and per-choice
`isCorrect` flags from the payload, so the answer is not in the DOM/devtools. The submit
endpoint compares the user's choice label against the source row's `correct_answer`.

## Error handling / edge cases

- **No set files** → set-list empty state with the curation recipe pointer.
- **Set references a non-gradeable / deleted row** → serve endpoint skips it and flags it in
  the response; runner shows a small "1 question unavailable, skipped" note.
- **Malformed set JSON** → skip that file, log a warning, keep listing the rest.
- **User quits mid-session** → "End & Save" logs only answered items; "Abandon" logs nothing.
- **Re-practice** → always a new session (history), never overwrite.

## Testing

- **Unit (`node:test`, `test/unit/`)**: the gradeable-candidate SQL helper and the
  set-file loader/validator (well-formed, malformed, missing-item cases). Follow the existing
  SQL-helper test style.
- **Manual E2E**: write a small set file, start it in the tab, answer, submit, then verify
  (a) it appears in performance-by-session with the "AI Curated" badge, (b)
  `SELECT * FROM question_attempts WHERE q_code = <original>` shows both the original and the
  redo, (c) the source filter dropdowns filter to it.

## Files touched

| File | Change |
|---|---|
| `client/src/AiPractice.jsx` | **new** — full-screen tab (set list → runner → result) |
| `client/src/App.jsx` | hash route, top-bar button, `getSourcePlatform`, SourceBadge, source-filter options; extract shared stem/choice renderer |
| `client/src/styles.css` | `.source-ai` badge variant |
| `src/server.js` | 3 endpoints (`sets` list / `sets/:slug` serve / `sets/:slug/submit`), `platformWhereClause` |
| `src/db.js` | gradeable-candidate query helper, `logAiCuratedSession` writer |
| `data/ai-practice-sets/` | new gitignored dir (+ `.gitkeep`); `.gitignore` entry |
| `ANALYSIS.md` / memory | curation recipe |
| `test/unit/*.test.js` | set-loader + candidate-query tests |

**No DB migration** — reuses existing `sessions` / `question_attempts` columns.
