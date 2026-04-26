# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Local GMAT analytics app: scrapes GMAT Official Practice and GMAT Club sessions via Chrome CDP, stores in SQLite, provides dashboards + LLM-powered coaching. Single user, macOS-focused.

## Commands

| Task | Command |
|---|---|
| Install deps | `npm install` |
| Full dev (API + Web) | `npm run dev` |
| API only (port 4310) | `npm run dev:api` |
| Web only (port 5173) | `npm run dev:web` |
| Build frontend | `npm run build:web` |
| Production start | `npm run build:web && npm start` |

No test suite is configured. No linter is configured.

## Architecture

**Monorepo with root `package.json`** — no separate `client/package.json`.

### Backend (`src/`)
- **`server.js`** — Express API on port 4310. Defines source presets (8 total: 7 GMAT Official Practice books on `platform: 'starttest'`, plus 1 GMAT Club error log on `platform: 'gmatclub'`), date window logic (Thai timezone, Asia/Bangkok), and all REST endpoints. The `/api/sessions/:sessionId/enrich` endpoint dispatches by `preset.platform` to either `runStartTestPhase2FromOpenBrowser` or `runGmatClubPhase2FromOpenBrowser`. List endpoints (`/api/sessions`, `/api/errors`) accept a `platform` query param (`gmatclub` | `starttest`) for source filtering.
- **`db.js`** — Raw SQLite3 queries (no ORM). Three core tables: `scrape_runs`, `sessions`, `question_attempts`. Schema migrations via `ALTER TABLE ADD COLUMN` with existence checks. Upsert: sessions matched by `(session_external_id, source)`, question attempts deleted+reinserted per session, but user annotations (`mistake_type`, `notes`) are preserved across re-scrapes. Exposes `enrichSessionAttempts` (StartTest Phase 2 writer), `enrichGmatClubSessionAttempts` (GMAT Club Phase 2 writer, matches on `q_id`), and `listGmatClubEnrichTargets` (returns the per-question URL list for one session). Both list functions (`listSessions`, `listErrors`) and their counts accept a `platform` filter that becomes a `source LIKE '%gmat club%'` SQL clause.
- **`scraper-runner.js`** — Playwright CDP bridge. Connects to user's Chrome on port 9222. Exposes `runScrapeFromOpenBrowser` (legacy injected-script flow, used by gmatclub Phase 1), `runStartTestScrapeFromOpenBrowser` (StartTest Phase 1), `runStartTestPhase2FromOpenBrowser` (StartTest Phase 2), `runGmatClubPhase2FromOpenBrowser` (GMAT Club Phase 2 — visits each topic URL with human-like jitter, re-injects the scraper after each navigation, aborts on too-many errors), `openStartTestProductInOpenBrowser` (just navigates to a book without scraping).
- **`scrapers/starttest_scraper.js`** — **Active scraper for the 7 GMAT Official Practice sources**. Node-side module (not page-injected); navigates via Playwright and parses classic HTML. Two-phase design: Phase 1 lists sessions + question metadata via `GetQuestionHistoryPage` (one URL per session — fast, low scrape footprint, default for `/api/scrape`); Phase 2 walks each item's `ITDReview` frame to extract stems/choices/answers/correct keys (per-session opt-in via `/api/sessions/:sessionId/enrich` to avoid bot-pattern bans).
- **`scrapers/gmat_club_scraper.js`** — Page-injected scraper for the GMAT Club Error Log analytics table. Verified column map (cells 0-8: checkbox, Question, Result svg, Attempts, Category, Difficulty band, Time, Date, Mistakes/Notes). Uses `data-row="phpbb_topics_timer_history-{N}"` from the Mistakes-cell button as the stable per-attempt id (`q_id = "gc-att-{N}"`) and `data-analytics-question-id` as the per-question id (`q_code = "gc-q-{N}"`). Pagination is scoped to the `<div class="px-6">` ancestor that contains "Showing N-N of M" so it doesn't collide with row-level Attempts buttons. Bumps page size to 100 via the entries-per-page `<select>`. Sessions are synthesized one-per-day (`session_id = hash("${source}|${dateKey}")`).
- **`scrapers/gmat_club_question_scraper.js`** — Browser-injected GMAT Club Phase 2 enrichment. The Node-side runner navigates the same gmatclub.com tab to each topic URL one at a time; this module exposes `window.gmatClubEnrichCurrentPage()` which extracts: stem (first `.item.text`), choices (parsed from `<br>`-separated lines or `<ol>`), correct answer letter (from `.correctAnswerBlock` → `.statisticWrapExisting.correctAnswer`), user's pick (`.statisticWrapExisting.selectedAnswer`), and full A-E vote distribution. Falls back to `.spoiler` text for OA on pages without the stats widget.
- **`scrapers/gmat_scraper.js`** — **Legacy** 8K+ line Nuxt SPA scraper. No source preset references it anymore (post 2026-04-22 migration to StartTest 2). Kept for reference and old-data compatibility; do not use for new sources.
- **`llm-coach-agent.js`** — LangGraph state machine for AI performance review and Q&A chat. Uses LangChain + OpenAI (or Z AI as alternative provider).
- **`question-topic-classifier.js`** — Hybrid classifier. Three skip paths bypass the LLM: (1) `topic_source='starttest-report'` rows hit a deterministic StartTest-path → canonical map (`STARTTEST_PATH_TO_CANONICAL` for tier-3 codes like `Q.PS.ARI`, then `STARTTEST_LEAF_TO_CANONICAL` for leaf labels); (2) `topic_source='gmatclub-canonical'` rows are pre-mapped by the GMAT Club scraper itself (see Key Patterns); (3) `topic_source='llm'` rows whose `topic` is already in `ALL_TOPIC_LABELS` are preserved (idempotency). After question-level classification, a session-level pass backfills `session.subject` from the dominant `subject_code` across questions when the scraper left it null (sets `'Mixed'` if no subject reaches 50% share). Subject-specific canonical label sets (Quant: 10, Verbal: 12, DI: 11).
- **`question-metadata.js`** — Enriches question records with derived fields (subject family, category code normalization). `inferCategoryCodeFromTopic` maps the canonical PS labels (e.g., "Counting & Probability", "Number Properties") to `'PS'` so GMAT Club rows without an explicit `category_code` still get one. `'Unclear Topic'` maps to `'DS'`.

### Frontend (`client/src/`)
- **`App.jsx`** — Single 3K+ line file containing the entire dashboard: performance view, error log, pattern analysis, session deep-dive modal, AI coach panel, sync controls, "Open in GMAT" launcher and "Enrich Phase 2" button (now enabled for both StartTest and GMAT Club sessions). The sessions and error-log tables both render a `<SourceBadge>` (indigo "Official Guide" / amber "GMAT Club") and expose a Source filter Select that hits the API's `platform` query param. The Session ID column is hidden in the sessions table; the Session column is hidden in the error log. The question-review modal's color-coding logic uses two independent flag checks (`anyMine`/`anyCorrectFlagged`) so partial per-choice flag data falls back to label comparison against row-level `my_answer`/`correct_answer`. All state via React hooks.
- **`styles.css`** — Tailwind + custom CSS. Source badges live under `.source-chip` with `.source-starttest` (indigo) and `.source-gmatclub` (amber) variants.
- **`components/ui/`** — shadcn-style Radix primitives (dialog, button, input, textarea, select, badge, card).
- Fonts: Space Grotesk + Manrope via Google Fonts.

### Dev Proxy
Vite proxies `/api/*` to Express (127.0.0.1:4310) with 2-hour timeout for long scrapes. In production, Express serves `client/dist` statically.

## Two-phase StartTest scrape flow

The seven GMAT Official Practice books run on **StartTest 2 / ITD** at `www.starttest.com/starttest2/13.0/router`. Scraping is split in two to minimize bot-like patterns and the risk of getting banned:

- **Phase 1 (default, fired by `/api/scrape`)** — fast pass via `GetQuestionHistoryPage` (one URL per session). Captures session list, per-question topic, correctness, time, difficulty, content area. Cheap and low-footprint.
- **Phase 2 (opt-in, fired by `POST /api/sessions/:sessionId/enrich`)** — deep enrichment of one session. Walks `ReviewItems → ITDReview` frame per item and uses the in-harness `processAction('Next')` button to navigate (rotating `code` token). Captures the question stem, all choices, the user's pick (color-coded: yellow=correct, red=wrong pick, green=right pick), the correct answer (authoritative `Key1` hidden form field), `vItemInformation[1].Key` (stable numeric content id used as `q_code`), `vPreviousTimeSpent`, etc. Handles three question types: single-choice MC, matrix (DI MSR / Two-Part Analysis), dropdown (DI Graphics Interpretation).

Source → `OrderProductID` map (used by both phases for navigation):

| Source | OrderProductID |
|---|---|
| OG 2024-2025 Main | 1373434 |
| OG Verbal Review | 1554373 |
| OG Quant Review | 1519887 |
| OG DI Review | 1452568 |
| Focus Quant Practice | 1213806 |
| Focus Verbal Practice | 1213807 |
| Focus DI Practice | 1213805 |

Full DOM contracts, command URL forms, and ITDReview globals reference live in the `memory/project_starttest_platform.md` memory and DOM samples in `/tmp/gmat-dom-probe/` (not committed).

## Two-phase GMAT Club scrape flow

The GMAT Club source mirrors StartTest's two-phase split:

- **Phase 1 (default, fired by `/api/scrape`)** — `gmat_club_scraper.js` walks the analytics table at `gmatclub.com/forum/analytics.php#error_log`. Bumps page size to 100 (cuts 27 clicks to 6 for a typical 500+ entry log), iterates page buttons inside the pager container, dedupes on per-attempt id. Each row carries `q_id="gc-att-{timer_history_id}"`, `q_code="gc-q-{topic_id}"`, `question_url`, the raw GMAT Club category, plus a direct mapping to a category code (PS/CR/RC/DI/...) — see Key Patterns. Sessions are synthesized one-per-day with `session_id = hash("${source}|${dateKey}")`.
- **Phase 2 (opt-in, fired by `POST /api/sessions/:sessionId/enrich`)** — visits each `gmatclub.com/forum/topic{N}.html` URL on the existing tab with 1.5–3s human-like jitter. `gmat_club_question_scraper.js` extracts stem (first `.item.text`, with `<br>` → newline normalization), choices (split on `A./A)/(A)`-prefixed lines with optional `<ol>` fallback), correct answer (from the timer widget's `.correctAnswerBlock` → `.statisticWrapExisting.correctAnswer` letter; spoiler-text fallback), user's pick (`.statisticWrapExisting.selectedAnswer`), and the full A-E vote distribution. Aborts on more than `max(5, ceil(total/4))` errors so partial DB writes still apply.

## Key Patterns

- **Date handling**: All scrape timestamps use Thai timezone (Asia/Bangkok, UTC+7). The `since` parameter format is `YYYYMMDDHHmmss`. "Today" window applies a 36-hour safety buffer (`SCRAPE_TODAY_BUFFER_HOURS`). The GMAT Club scraper compares `since` at day granularity (the analytics table only renders dates as `D MMM YYYY`).
- **DB upserts**: Sessions are matched by `(session_external_id, source)`. Question attempts are fully replaced (delete + reinsert) per Phase 1 scrape, but user annotations (`mistake_type`, `notes`) are preserved. Phase 2 enrichment is an `UPDATE` against existing rows (matched by `q_id` / item name) so it never wipes annotations either.
- **Answer-choice storage shape**: `question_attempts.answer_choices` is a flat JSON array. StartTest single-choice/DI rows include `{label, text, value, color, isCorrect, isUserSelected}` per option; matrix/dropdown items carry a nested `options[]` (with the same flags) inside each row/blank entry. GMAT Club Phase 2 writes the simpler `{label, text}` shape (per-choice flags don't exist on the GMAT Club page; the picked/correct letters are stored on the row's `my_answer`/`correct_answer` columns).
- **Review-modal color coding**: The question-review JSX evaluates per-choice flags independently — `anyMine = choices.some(c => c.isUserSelected === true)` and `anyCorrectFlagged = choices.some(c => c.isCorrect === true)`. Each flag falls back to a label comparison against row-level `my_answer`/`correct_answer` when no option is `true`. This handles StartTest rows that capture user-pick but not correct-answer per-option, plus GMAT Club rows that have no per-choice flags at all.
- **Scraper safety**: Never call `browser.close()` in the StartTest or GMAT Club paths — the browser is the user's logged-in Chrome, and closing it kills their session. Cleanup is best-effort (console/pageerror listeners removed in `finally`). StartTest Phase 2 navigates with `processAction('Next')` rather than `seq=N+1` URLs because rotating `code` tokens are single-use; GMAT Club Phase 2 navigates by URL with jitter.
- **Subcategory display**: StartTest writes short abbreviation codes ("VEO", "ARI", "COR") to `subcategory` and the readable name to `topic`. The dashboard's `pickReadableSubcategory` (in `client/src/App.jsx`) prefers `topic` whenever `subcategory` looks abbreviation-shaped (≤5 chars, all-caps).
- **GMAT Club category → code direct mapping**: The GMAT Club scraper hard-codes a `GMATCLUB_CATEGORY_TO_CODE` map plus a keyword-fallback regex list, so each row's raw category text (e.g., "Probability", "Statistics and Sets Problems", "Strengthen") gets converted to a `subject_sub_raw` value (`PS`/`CR`/`RC`/`DI`/...) at scrape time. Mapped rows are tagged `topic_source='gmatclub-canonical'` so the LLM classifier skips them entirely; only the rare unmapped category (e.g., "Science") falls through to the LLM. Typically 95–96% of GMAT Club rows bypass the LLM.
- **Source-platform identification**: The frontend's `getSourcePlatform(label)` heuristic is `if (/gmat\s*club/i.test(label)) return 'gmatclub'; else return 'starttest'`. Backend SQL uses the same shape: `LOWER(source) LIKE '%gmat club%'`. This is the only string the badge component, the platform query param, and the SQL filter all rely on.
- **LLM provider switching**: Controlled by `LLM_PROVIDER` env var (`openai` | `zai`). Coach and classifier share provider/key/base but can use different models. Classifier is skipped entirely for `topic_source !== 'llm'` rows AND for `topic_source==='llm'` rows whose topic is already in `ALL_TOPIC_LABELS` (idempotency on re-scrapes).
- **No tests**: The project has no automated test suite.

## REST endpoints (selected)

- `POST /api/scrape` — Phase 1 scrape, dispatched by `preset.platform` (StartTest or GMAT Club).
- `POST /api/sessions/:sessionId/enrich` — Phase 2 deep enrichment. Dispatches by platform: StartTest sessions hit `runStartTestPhase2FromOpenBrowser` + `enrichSessionAttempts`; GMAT Club sessions hit `runGmatClubPhase2FromOpenBrowser` + `enrichGmatClubSessionAttempts`. Returns 400 if the session has no enrichable URLs.
- `POST /api/open-product` — Navigate the user's Chrome to a StartTest book (no scrape).
- `POST /api/open-chrome` — Launch a Chrome profile with CDP enabled on port 9222.
- `POST /api/open-question` — Open a single question in the browser.
- `GET /api/sources` — List source presets including `platform` field.
- `GET /api/sessions`, `GET /api/errors` — Both accept an optional `platform` query param (`gmatclub` | `starttest`) for source filtering. The error-log SQL also accepts `source` as a sort key.
- `GET /api/sessions/:id/analysis`, `GET /api/patterns`, `GET /api/runs`.
- `POST /api/ai/review`, `POST /api/ai/chat`, plus AI session/memory CRUD under `/api/ai/...`.

## Environment

Requires Node.js 20+. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`. See `README.md` for full env var reference.

## Skills

Load these for detailed context on specific topics:

| Skill | When to use |
|---|---|
| [ai-context](.claude/skills/ai-context/SKILL.md) | Maintain AGENTS/Claude/Gemini docs and skills. |
| [documentation-lookup](.claude/skills/documentation-lookup/SKILL.md) | Library/framework docs and API lookup tasks. |
| [e2e-testing](.claude/skills/e2e-testing/SKILL.md) | Add or debug Playwright E2E tests. |
| [e2e-testing-patterns](.claude/skills/e2e-testing-patterns/SKILL.md) | E2E strategy and anti-flake patterns. |
| [frontend-code-review](.claude/skills/frontend-code-review/SKILL.md) | Review frontend changes for bugs/regressions. |
| [frontend-test-workflow](.claude/skills/frontend-test-workflow/SKILL.md) | End-to-end frontend testing workflow. |
| [frontend-testing](.claude/skills/frontend-testing/SKILL.md) | Write Vitest + React Testing Library tests. |
| [qa-test-planner](.claude/skills/qa-test-planner/SKILL.md) | Build QA plans and test scenarios. |
| [skill-creator](.claude/skills/skill-creator/SKILL.md) | Create or improve reusable skills. |
| [skill-installer](.claude/skills/skill-installer/SKILL.md) | Install or update skills from curated sources. |
| [skill-lookup](.claude/skills/skill-lookup/SKILL.md) | Find the best skill for the task. |
| [web-frontend-design](.claude/skills/web-frontend-design/SKILL.md) | UI implementation for web app screens/components. |
