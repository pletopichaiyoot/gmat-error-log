# GMAT Club CAT Practice Test Scraper — Design

**Date:** 2026-06-21
**Status:** Approved (design); pending implementation plan
**Author:** pletopichaiyoot + Claude

## Goal

Add the **GMAT Club CAT** (GMAT Focus full-length practice tests, `gmatclub.com/gmat-focus-tests/`)
as a new scrape source, alongside the existing GMAT Club Error Log, the seven
StartTest Official Practice books, Target Test Prep, and the Official Practice
Exams (OPE). Each completed CAT attempt becomes one session with section scores
(Total / Quant / Verbal / Data Insights + percentiles) and a per-question grid,
matching the model already used for OPE mocks crossed with the Error Log grid.

This is a **separate product** from the GMAT Club Error Log (forum analytics
table) — it lives under `/gmat-focus-tests/`, not `/forum/analytics.php`.

## Decisions (locked)

- **Scrape depth:** Full two-phase. Phase 1 = session + scores + per-question
  grid metadata; Phase 2 (opt-in per session) = per-question stem/choices/
  correct/pick/explanation.
- **Discovery:** Auto-enumerate the user's "My Tests" page on each Phase 1 sync.
- **Source label:** `GMAT Club CAT`. New platform key: `gmatclub-cat`.

## Verified DOM contract (probed live 2026-06-21)

Base path: `https://gmatclub.com/gmat-focus-tests/`

### 1. My Tests list — `?page=tests` (title "My GMAT Practice Tests")
- `table.w-full` — header: `Test Name | Section | Date | Status | Score | Time | Actions`.
- Per row links: `/gmat-focus-tests/results-{id}.html` ("Review Test"),
  `/gmat-focus-tests/report?id={id}` ("Score Report"). `{id}` = attempt id (e.g. 2347043).
- Only scrape rows with `Status = Completed`.

### 2. Score Report — `report?id={id}`
- `table.userInfoTable`: Test Date `MM/DD/YYYY`, Candidate, Exam Name, Total Score.
- `table.chart-table` rows (also mirrored in a cleaner `table.table-table`):
  - `Total Score | 51st | 205 554.67 565 805` → percentile 51, scale 205–805, score 565, mean 554.67
  - `Quantitative Reasoning | 70th | 60 78.06 81 90` → Q score 81, pct 70
  - `Verbal Reasoning | 47th | 60 79.34 79 90` → V score 79, pct 47
  - `Data Insights | 41st | 60 75.03 74 90` → DI score 74, pct 41
- Score numbers carry classes `.sectionScoreScoreValue` and `.score`.

### 3. Results grid — `results-{id}.html`
- Title `h1`: "Free Full Test - Jun 21, 2026"; overall score `span.text-7xl` = "565".
- `table.items` (Yii CGridView). The default-rendered page shows only 20 rows.
- **Full grid in one request:** GET
  `results-{id}.html?TestAnswerExtendedVersion[question_type]=&[is_correct]=&[question_weight]=&[time]=&page=2&true=questionListGrid&sort=date.desc`
  returns **all** rows (verified 64 rows, № 64→1). `true=questionListGrid` is the
  Yii `renderPartial` AJAX fragment that emits the whole grid.
- Row `<td>` order: `№ | ID+view | Type | Answer | Difficulty | Guessed | Bookmark | Noted | Time | Date | Reviewed`
  - **ID** cell: `<a href="/gmat-focus-tests/view-43972530.html">I02-10</a>` → `qcode = "I02-10"`, `instanceId = 43972530`.
  - **Type** cell: `<span>Data Insights / TPA / <i>Two-Part Analysis</i></span>` = `Section / CategoryCode / Topic`.
  - **Answer**: `.qCorrectIcon` (correct) vs `.qUncorrectIcon` (wrong).
  - **Difficulty**: `.qDiff` → Easy / Medium / Hard.
  - **Guessed**: `.emptyIcon` (not guessed) vs a filled icon.
  - **Bookmark**: `.qBookmarkIcon` (filled) vs `.qBookmarkUnfilledIcon`.
  - **Time**: `<div class="qTimeDown">2:15</div>` (slower than avg) / `.qTimeUp` (faster).
  - **Date**: `<b>Jun 21, 2026</b> 12:05 AM` (full timestamp → session_date + per-q time).

### 4. Question view — `view-{instanceId}.html` (title "GMAT Club Full Test")
- **Not** a forum-topic DOM — there is no `.item.text` / `.correctAnswerBlock`.
- Header lines (innerText): "GMAT Club Test Center …" / "62 of 64" / Section
  ("Data Insights") / Type ("GMAT Data Sufficiency") / Category ("Overlapping
  Sets") / qcode ("M27-04") / "Bookmark" / stem…
- Choices: `.option` elements (`class="option uniform valid disabled"`).
  - **Correct** option carries the `valid` class.
  - **User's pick** = the `.option` whose `input[type=radio]` is `:checked`.
- Explanation toggled by "HIDE EXPLANATION" / "SHOW EXPLANATION".

## Architecture

Mirror the **TTP / Error-Log two-phase** pattern. Because the CAT scrape spans
multiple URLs per test (My Tests → score report → results grid → per-question
views), Phase 1 is a **Node-side multi-navigation scraper** (like
`ttp_scraper.js`), not a page-injected single-page scraper.

### New files
- `src/scrapers/gmat_club_cat_scraper.js` — **Phase 1** (Node-side). Exposes
  `runScrape({ page, since, source, log })` returning `{ extracted_at, config, sessions }`.
- `src/scrapers/gmat_club_cat_question_scraper.js` — **Phase 2** (browser-injected).
  Exposes `window.gmatClubCatEnrichCurrentPage()`.

### Changed files
- `src/scraper-runner.js` — add `runGmatClubCatScrapeFromOpenBrowser` (Phase 1)
  and `runGmatClubCatPhase2FromOpenBrowser` (Phase 2).
- `src/db.js` — add `enrichGmatClubCatSessionAttempts` and
  `listGmatClubCatEnrichTargets`. Phase 1 reuses `saveScrapeResult` unchanged.
- `src/server.js` — new preset; dispatch `gmatclub-cat` in `/api/scrape` and
  `/api/sessions/:id/enrich`; extend the `platform` query allowlist; fix
  `platformWhereClause`.
- `client/src/App.jsx` — `getSourcePlatform`, SourceBadge, source filter Select.
- `client/src/styles.css` — `.source-gmatclub-cat` badge variant.

## Phase 1 detail

1. Navigate to `?page=tests`; parse `table.w-full` →
   `{ testId, name, dateRaw, status, score, resultsUrl, reportUrl }`. Skip rows
   whose Status ≠ `Completed`.
2. Filter by `since` at **day granularity** (the list shows only dates), same
   convention as the Error Log scraper.
3. For each kept test, with 1.5–3 s human-like jitter between navigations:
   - GET `report?id={testId}` → `scoreSummary = { total:{score,percentile},
     quant:{…}, verbal:{…}, di:{…} }`.
   - GET the `…&true=questionListGrid&sort=date.desc` grid URL → all rows.
   - Emit one **session** per test.
4. Abort if more than `max(2, ceil(tests/4))` tests error, so partial writes
   still land (mirrors the Error-Log / TTP guard rails).

### Session shape (consumed by `saveScrapeResult`)
```
{
  session_id: testId,                 // session_external_id
  date: 'YYYY-MM-DD',                 // from the latest grid timestamp / test date
  source: 'GMAT Club CAT',
  subject: 'Mixed',                   // full CAT mixes Q/V/DI
  scoreSummary: { total, quant, verbal, di },   // each {score, percentile}
  stats: { total_q_api, total_q_categories, correct, errors, accuracy_pct,
           avg_time_sec, avg_correct_time_sec, avg_incorrect_time_sec },
  questions: [ … ],
  wrong_q_ids: [ … ],
}
```

### Per-question shape
```
{
  q_id: `gcc-att-${instanceId}`,      // stable per-attempt id
  q_code: `gcc-q-${qcode}`,           // canonical question id (reused across tests)
  correct: bool,                      // .qCorrectIcon
  difficulty: 'Easy'|'Medium'|'Hard', // .qDiff
  time_sec: int,                      // mm:ss
  question_url: 'https://…/view-{instanceId}.html',
  topic: '<3rd Type token>',          // e.g. 'Two-Part Analysis'
  subcategory: '<3rd Type token>',
  topic_source: 'gmatclub-canonical', // skip LLM classifier
  subject_sub_raw: '<categoryCode>',  // PS/DS/CR/RC/TPA/MSR/TA/GI → deriveQuestionMetadata
  my_answer: null,                    // Phase 2 fills
  correct_answer: null,               // Phase 2 fills
  answer_choices: null,               // Phase 2 fills
}
```

### Type → code mapping (`GMATCLUB_CAT_*`)
- Section token → `subject_code`: `Quant → Q`, `Verbal → V`, `Data Insights → DI`.
- Middle token → `category_code`: `PS`, `DS`, `CR`, `RC`, `TPA`, `MSR`, `TA`, `GI`
  (e.g. "GMAT Data Sufficiency" / "DS" → `DS`; "TPA" → `TPA`). A small explicit
  map keyed on the middle token; fall back to the section if absent.
- 3rd token → `topic` (free text). `topic_source='gmatclub-canonical'` so the LLM
  classifier is skipped entirely.

## Phase 2 detail

`runGmatClubCatPhase2FromOpenBrowser` (server `/api/sessions/:id/enrich`):
1. `listGmatClubCatEnrichTargets(sessionId)` → per-question `{ q_id, question_url }`.
2. Reuse the open gmatclub.com tab; navigate to each `view-{instanceId}.html`
   with 1.5–3 s jitter; re-inject `gmat_club_cat_question_scraper.js` after each
   navigation (same pattern as the Error-Log Phase 2 runner).
3. `window.gmatClubCatEnrichCurrentPage()` returns:
   `{ ok, url, stem, choices:[{label,text,isCorrect,isUserSelected}],
      correct_answer, my_answer, explanation }`.
   - `isCorrect` = option has `valid` class; `isUserSelected` = its radio `:checked`.
   - `correct_answer` / `my_answer` = the A–E letters derived by option position.
   - `explanation` → stored on `response_details`.
4. `enrichGmatClubCatSessionAttempts` UPDATEs rows matched by `q_id`, writing
   `question_stem`, `answer_choices`, `my_answer`, `correct_answer`,
   `response_details`. Never wipes `mistake_type`/`notes` (preserve-on-rescrape).
5. Abort after more than `max(5, ceil(total/4))` per-question errors so partial
   writes still apply.

Answer-choice storage shape: flat JSON array `{label, text, isCorrect,
isUserSelected}` — same per-choice flags as StartTest, so the review-modal
color-coding (`anyMine`/`anyCorrectFlagged`) works without changes.

## Platform disambiguation (important)

The existing discriminator treats any source matching `/gmat club/i` as
`gmatclub`. `"GMAT Club CAT"` matches that too, so both sides must check the
CAT-specific substring **first**:

- **Frontend** `getSourcePlatform(label)`: if `/gmat\s*club\s*cat/i` → `gmatclub-cat`;
  else if `/gmat\s*club/i` → `gmatclub`; (then ttp; else starttest).
- **Backend** `platformWhereClause`:
  - `gmatclub-cat` → `LOWER(source) LIKE '%gmat club cat%'`.
  - `gmatclub` (Error Log) → `LOWER(source) LIKE '%gmat club%' AND LOWER(source) NOT LIKE '%gmat club cat%'`.
- Add `gmatclub-cat` to the `platform` query-param allowlist on `/api/sessions`
  and `/api/errors`.
- Badge: new `.source-gmatclub-cat` variant (distinct color, e.g. teal/emerald,
  to separate from the amber Error Log).

## Safety / conventions

- **Never** call `browser.close()` — the runner attaches to the user's logged-in
  Chrome via CDP. Cleanup of console/pageerror listeners in `finally` only.
- Phase 2 navigates by URL with jitter (no single-use token concerns).
- Thai timezone (Asia/Bangkok) for the `since` window; day-granularity compare.
- DB upsert preserves user `mistake_type` / `notes` across re-scrapes.

## Testing

- **Unit (`node:test`, pure functions):** Type→code mapping; grid-row parser
  (correct/difficulty/time/date/qcode/instanceId extraction); score-report
  parser. No live page required.
- **Live end-to-end:** Phase 1 against the user's open completed attempt
  (test 2347043, 64 Qs, score 565 / Q81 / V79 / DI74) via the CDP runner; verify
  one session + 64 question rows with correct counts and scoreSummary. Then a
  Phase 2 pass on that session; spot-check stems/choices/correct/pick on a few.
- **Lint:** new Node-side scraper gets node+browser globals (it embeds
  `page.evaluate` callbacks); the browser-injected Phase 2 file gets
  `sourceType: 'script'` + browser globals — per the eslint conventions in
  CLAUDE.md. (`eslint.config.mjs` is edit-protected; new probe scripts under
  `scripts/` are auto-linted, but these live under `src/scrapers/` which the
  existing `src/**` globs already cover — confirm the page-injected globals
  override pattern matches the new filenames.)

## Out of scope / YAGNI

- No IRT theta capture (CAT view pages don't expose a b-parameter like OPE).
- No re-scoring or analytics beyond what the existing session/score UI renders.
- No handling of in-progress ("switch back") tests — only `Completed`.
- Paid multi-test accounts work automatically via My-Tests enumeration; no
  special-casing.
