# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Temp file convention

**All scratch / test artifacts MUST go in `/tmp/` at the repo root** — never the repo root itself, never `data/`, never alongside source. This includes: screenshots from browser/Playwright/MCP runs, DOM probes, ad-hoc `.md` notes, snapshot dumps, scratch `.sql` / `.json` payloads, throwaway scripts.

- The `/tmp/` directory is gitignored (only `tmp/.gitkeep` is tracked).
- Before finishing a task, **clean up everything you created in `/tmp/`** that isn't being explicitly handed off (`HANDOFF_*.md` etc.). At a minimum, `rm -rf tmp/*` (preserving `.gitkeep`) at task end.
- If a probe artifact is worth keeping beyond the task (e.g., DOM contract for a scraper rewrite), promote it to a memory file under `~/.claude/projects/.../memory/` or document it inline in CLAUDE.md — don't leave it as a loose file.
- Do not paste screenshots/PNGs into the repo root again. The repo got polluted with 40+ stray PNGs throughout 2026 — that should not recur.

## Project Overview

Local GMAT analytics app: scrapes GMAT Official Practice, GMAT Club, and Target Test Prep sessions via Chrome CDP, stores in PostgreSQL (local Docker), provides dashboards + LLM-powered coaching. Single user, macOS-focused.

## Design Context

Strategic and visual design are documented in two root files (Stitch DESIGN.md format), maintained via the `/impeccable` skill. **Read both before building or restyling any frontend surface.**

- **[PRODUCT.md](PRODUCT.md)** — register (`product`), users, purpose, brand personality (**"The Patient Coach"**: encouraging, honest, calm-under-pressure), anti-references (no gamification, no enterprise BI), and strategic design principles.
- **[DESIGN.md](DESIGN.md)** — the visual system: warm-paper palette (forest-sage `#3d7a5e` primary, aged-brass `#c4a843` accent, cream surfaces), Manrope-titles / Space-Grotesk-body typography, flat-by-default elevation, the gold/red/green answer semantic, and forceful Do's/Don'ts. Machine-readable tokens live in its YAML frontmatter; `.impeccable/design.json` is the live-panel sidecar.

For design work run `/impeccable <command>` (e.g. `critique`, `audit`, `polish`, `live`). Live mode is pre-configured (`.impeccable/live/config.json`, injects into `client/index.html`).

## Commands

| Task | Command |
|---|---|
| Install deps | `npm install` |
| Full dev (API + Web) | `npm run dev` |
| API only (port 4310) | `npm run dev:api` |
| Web only (port 5170) | `npm run dev:web` |
| Build frontend | `npm run build:web` |
| Production start | `npm run build:web && npm start` |
| Lint (report) | `npm run lint` |
| Lint (auto-fix) | `npm run lint:fix` |
| Start Postgres | `npm run db:up` |
| Apply migrations | `npm run db:migrate` |
| One-time data import | `npm run db:etl` |
| Verify schema+data | `npm run db:verify` |
| Reset DB (drops data) | `npm run db:reset` |
| Run unit tests | `npm test` |

There are now `node:test` unit tests for the SQL helpers (`npm test`), but most coverage is still manual — there is no broad automated suite.

### Linter

ESLint 9 (flat config at [eslint.config.mjs](eslint.config.mjs)). Config is intentionally permissive — only `js.configs.recommended` plus `react-hooks/rules-of-hooks` are errors; `no-unused-vars`, `no-empty`, `react-hooks/exhaustive-deps`, and `no-console` are warnings. Current baseline: **0 errors, ~127 warnings** in legacy files; new code should not add errors.

Gotchas worth knowing before changing the config:

- **No brace globs.** The repo overrides `brace-expansion@5`, which breaks the minimatch bundled inside `@eslint/config-array`. Use `'*.js'` + `'*.jsx'` as two patterns, never `'*.{js,jsx}'`.
- **`eslint.config.mjs` is edit-protected** by the ECC `config-protection` hook (edits are blocked). For new test-file globals (e.g. node:test files needing `require`), add a file-local `/* global require */` directive rather than a config override. The `test` script uses a quoted glob (`node --test "test/unit/*.test.js"`) because Node ≥21 rejects a bare `--test <dir>/`.
- **Three classes of files need special globals:**
  1. **Page-injected scrapers** (`gmat_club_scraper.js`, `gmat_club_question_scraper.js`, `gmat_scraper.js`, `public/**`) run entirely in the browser via `evaluate()` — `sourceType: 'script'` + browser globals.
  2. **Playwright host files** (`starttest_scraper.js`, `ttp_scraper.js`, `scraper-runner.js`, every probe under `scripts/`) are Node-side but embed `page.evaluate(() => …)` callbacks that touch `document`/`window` — they get **both** node and browser globals, plus the StartTest page globals (`jsondata_reviewtable`, `vItemInformation`, `processAction`).
  3. **Root config files** (`tailwind.config.js`, `postcss.config.js`) are CJS; explicit override needed since the `src/**` pattern doesn't catch them.
- **Not yet in the config glob lists:** `gmat_club_cat_scraper.js` (Playwright host, embeds `page.evaluate`) and `gmat_club_cat_question_scraper.js` (page-injected) were added after the globs above were frozen, and `eslint.config.mjs` is edit-protected — so each carries a file-local `/* global document, window, location */` directive instead. Fold them into the arrays above when a config edit becomes possible.
- **Frontend uses ESM** (`sourceType: 'module'` + `jsx: true`); backend uses CJS (`sourceType: 'commonjs'`). Mixing requires a per-glob override.
- **`scripts/parse-lsat-pdf.js` is in `ignores`** — it embeds a vendored PDF parser with non-standard syntax that ESLint can't grok. Add new probe scripts under `scripts/` and they'll be linted automatically.

## Architecture

**Monorepo with root `package.json`** — no separate `client/package.json`.

### Backend (`src/`)
- **`server.js`** — Express API on port 4310. Defines source presets (8 total: 7 GMAT Official Practice books on `platform: 'starttest'`, plus 1 GMAT Club error log on `platform: 'gmatclub'`), date window logic (Thai timezone, Asia/Bangkok), and all REST endpoints. The `/api/sessions/:sessionId/enrich` endpoint dispatches by `preset.platform` to `runStartTestPhase2FromOpenBrowser`, `runGmatClubPhase2FromOpenBrowser`, `runGmatClubCatPhase2FromOpenBrowser`, or the OPE Phase-3 runner. List endpoints (`/api/sessions`, `/api/errors`) accept a `platform` query param (`gmatclub` | `gmatclub-cat` | `starttest` | `ttp` | `ope-mock` | `lsat`) for source filtering.
- **`db.js`** — Raw SQL over a `pg.Pool` (no ORM). Schema is **not** created imperatively; it lives in `migrations/*.sql` (e.g. `migrations/0001_init.sql`) applied by `scripts/migrate.js` and tracked in a `schema_migrations` table. `initDb()` now just runs migrations + idempotent seed backfills. The `run`/`all`/`get` wrappers call `pool.query`; the `toPg` helper in `src/sql-util.js` auto-rewrites SQLite-style `?` placeholders to Postgres `$1,$2,…`; multi-statement writers run inside `withTransaction(fn)` (one pooled client); inserts use `RETURNING id`. Global pg type parsers coerce int8/numeric back to JS numbers. Three core tables: `scrape_runs`, `sessions`, `question_attempts`. Upsert: sessions matched by `(session_external_id, source)`, question attempts deleted+reinserted per session, but user annotations (`mistake_type`, `notes`) are preserved across re-scrapes. Exposes `enrichSessionAttempts` (StartTest Phase 2 writer), `enrichGmatClubSessionAttempts` (GMAT Club Phase 2 writer, matches on `q_id`), and `listGmatClubEnrichTargets` (returns the per-question URL list for one session). Both list functions (`listSessions`, `listErrors`) and their counts accept a `platform` filter that becomes a `source LIKE '%gmat club%'` SQL clause.
- **`scraper-runner.js`** — Playwright CDP bridge. Connects to user's Chrome on port 9222. Exposes `runScrapeFromOpenBrowser` (legacy injected-script flow, used by gmatclub Phase 1), `runStartTestScrapeFromOpenBrowser` (StartTest Phase 1), `runStartTestPhase2FromOpenBrowser` (StartTest Phase 2), `runGmatClubPhase2FromOpenBrowser` (GMAT Club Phase 2 — visits each topic URL with human-like jitter, re-injects the scraper after each navigation, aborts on too-many errors), `openStartTestProductInOpenBrowser` (just navigates to a book without scraping).
- **`scrapers/starttest_scraper.js`** — **Active scraper for the 7 GMAT Official Practice sources**. Node-side module (not page-injected); navigates via Playwright and parses classic HTML. Two-phase design: Phase 1 lists sessions + question metadata via `GetQuestionHistoryPage` (one URL per session — fast, low scrape footprint, default for `/api/scrape`); Phase 2 walks each item's `ITDReview` frame to extract stems/choices/answers/correct keys (per-session opt-in via `/api/sessions/:sessionId/enrich` to avoid bot-pattern bans).
- **`scrapers/gmat_club_scraper.js`** — Page-injected scraper for the GMAT Club Error Log analytics table. Verified column map (cells 0-8: checkbox, Question, Result svg, Attempts, Category, Difficulty band, Time, Date, Mistakes/Notes). Uses `data-row="phpbb_topics_timer_history-{N}"` from the Mistakes-cell button as the stable per-attempt id (`q_id = "gc-att-{N}"`) and `data-analytics-question-id` as the per-question id (`q_code = "gc-q-{N}"`). Pagination is scoped to the `<div class="px-6">` ancestor that contains "Showing N-N of M" so it doesn't collide with row-level Attempts buttons. Bumps page size to 100 via the entries-per-page `<select>`. Sessions are synthesized one-per-day (`session_id = hash("${source}|${dateKey}")`).
- **`scrapers/gmat_club_question_scraper.js`** — Browser-injected GMAT Club Phase 2 enrichment. The Node-side runner navigates the same gmatclub.com tab to each topic URL one at a time; this module exposes `window.gmatClubEnrichCurrentPage()` which extracts: stem (first `.item.text`), choices (parsed from `<br>`-separated lines or `<ol>`), correct answer letter (from `.correctAnswerBlock` → `.statisticWrapExisting.correctAnswer`), user's pick (`.statisticWrapExisting.selectedAnswer`), and full A-E vote distribution. Falls back to `.spoiler` text for OA on pages without the stats widget.
- **`scrapers/gmat_club_cat_scraper.js`** — **Node-side** Phase 1 scraper for the GMAT Club CAT (GMAT Focus full-length practice tests at `gmatclub.com/gmat-focus-tests/`). `platform: 'gmatclub-cat'`, label `GMAT Club CAT`. Walks My Tests (`?page=tests`) → each test's score report (`report?id={id}`) → the results grid (`results-{id}.html?…&true=questionListGrid` AJAX fragment renders all rows at once) and emits one session per completed test with `scoreSummary` (Total/Q/V/DI + percentiles) + a per-question grid. Parses the Type cell `Section / Code / Topic` → `subject_code`/`category_code`/`topic`, tags every row `topic_source='gmatclub-canonical'` (no LLM). `q_id='gcc-att-{viewInstanceId}'`, `q_code='gcc-q-{qcode}'`. Phase 1 reuses the generic `saveScrapeResult`.
- **`scrapers/gmat_club_cat_question_scraper.js`** — Browser-injected GMAT Club CAT Phase 2 enrichment; exposes `window.gmatClubCatEnrichCurrentPage()` for one `view-{instanceId}.html` page. Choice letters come from each `.option`'s `<input value>`; the **correct answer is the `.correctAnswer` span** (a bare A–H letter) — the page renders TWO such spans and only one carries the letter, and only once the explanation is **expanded** (the runner clicks "Show Explanation" first). The user's pick is **not** on the page for a direct navigation (radios unchecked), so `my_answer` is inferred by the DB writer as `= correct_answer` for questions Phase 1 marked correct; wrong-question picks stay null. Non-MC DI formats (TPA/MSR/TA/GI) have no `.option`s → enriched with stem only (no choices). Explanation → `response_details`.
- **`scrapers/ttp_scraper.js`** — Node-side scraper for Target Test Prep's Error Tracker (`gmat.targettestprep.com/error_tracker/{quant|verbal|di}`). Single-pass (no Phase 1/2 split): visits the section index to enumerate mistake categories from `.failure-reason` rows (skipping `disabled` / zero-count "positive" categories like "I guessed correctly"), then walks each `/error_tracker/{section}/{categoryId}?page=N` URL with 1.5–3s jitter between page hits. Per-question extraction reads `data-exercise-id` (problem id), `attempt_id` from the remove-question form (the stable per-attempt id, format `ttp-att-{N}`), chapter heading, `data-attempt-status`, time, full stem (joined from `.notetaking-preselection` spans), choices (with `data-correct` + `.user-choice` flags), and the solution block. Sessions are synthesized one-per-mistake-category with `session_external_id = hashSessionExternalId("${section}|${categoryId}")` (53-bit hash). Each `question_attempt` carries `mistake_type` = the TTP category text, which the DB upsert lets overwrite the preserved value (TTP is authoritative).
- **`scrapers/gmat_scraper.js`** — **Legacy** 8K+ line Nuxt SPA scraper. No source preset references it anymore (post 2026-04-22 migration to StartTest 2). Kept for reference and old-data compatibility; do not use for new sources.
- **`llm-coach-agent.js`** — LangGraph state machine for AI performance review and Q&A chat. Uses LangChain + OpenAI (or Z AI as alternative provider).
- **`question-topic-classifier.js`** — Hybrid classifier. Four skip paths bypass the LLM: (1) `topic_source='starttest-report'` rows hit a deterministic StartTest-path → canonical map (`STARTTEST_PATH_TO_CANONICAL` for tier-3 codes like `Q.PS.ARI`, then `STARTTEST_LEAF_TO_CANONICAL` for leaf labels); (2) `topic_source='gmatclub-canonical'` rows are pre-mapped by the GMAT Club scraper itself (see Key Patterns); (3) `topic_source='ttp-chapter'` rows carry TTP's per-problem chapter label and are preserved as-is (TTP-authoritative, no LLM needed); (4) `topic_source='llm'` rows whose `topic` is already in `ALL_TOPIC_LABELS` are preserved (idempotency). After question-level classification, a session-level pass backfills `session.subject` from the dominant `subject_code` across questions when the scraper left it null (sets `'Mixed'` if no subject reaches 50% share). Subject-specific canonical label sets (Quant: 10, Verbal: 12, DI: 11).
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

## Single-pass Target Test Prep scrape flow

The TTP source uses a single-pass scrape (no Phase 1 / Phase 2 split) because every detail — `attempt_id`, `problem_id`, stem, choices — lives behind a per-question `?page=N` URL; there's no list endpoint that returns more than one question's worth of data:

- `/api/scrape` dispatches to `runTtpScrapeFromOpenBrowser`, which expects the user's logged-in `gmat.targettestprep.com` tab in the CDP browser. The runner navigates that tab to `/error_tracker/{section}` first.
- `ttp_scraper.js` enumerates mistake categories (`.failure-reason` rows), filters out zero-count categories whose View-Questions button is `.disabled`, and walks each category's `?page=1..N` URLs with 1.5–3s human-like jitter.
- Per-question extraction: `data-exercise-id` → `q_code = "ttp-q-{id}"`; `attempt_id` from the remove-question form → `q_id = "ttp-att-{id}"`; choices keep TTP's per-option `data-correct` + `.user-choice` flags; chapter heading becomes `topic` with `topic_source='ttp-chapter'`; TTP's mistake category text fills `mistake_type`.
- Sessions are synthesized one-per-mistake-category. `session_external_id` is a stable 53-bit hash of `${section}|${categoryId}`, so re-scrapes upsert rather than duplicate.

## Two-phase GMAT Club scrape flow

The GMAT Club source mirrors StartTest's two-phase split:

- **Phase 1 (default, fired by `/api/scrape`)** — `gmat_club_scraper.js` walks the analytics table at `gmatclub.com/forum/analytics.php#error_log`. Bumps page size to 100 (cuts 27 clicks to 6 for a typical 500+ entry log), iterates page buttons inside the pager container, dedupes on per-attempt id. Each row carries `q_id="gc-att-{timer_history_id}"`, `q_code="gc-q-{topic_id}"`, `question_url`, the raw GMAT Club category, plus a direct mapping to a category code (PS/CR/RC/DI/...) — see Key Patterns. Sessions are synthesized one-per-day with `session_id = hash("${source}|${dateKey}")`.
- **Phase 2 (opt-in, fired by `POST /api/sessions/:sessionId/enrich`)** — visits each `gmatclub.com/forum/topic{N}.html` URL on the existing tab with 1.5–3s human-like jitter. `gmat_club_question_scraper.js` extracts stem (first `.item.text`, with `<br>` → newline normalization), choices (split on `A./A)/(A)`-prefixed lines with optional `<ol>` fallback), correct answer (from the timer widget's `.correctAnswerBlock` → `.statisticWrapExisting.correctAnswer` letter; spoiler-text fallback), user's pick (`.statisticWrapExisting.selectedAnswer`), and the full A-E vote distribution. Aborts on more than `max(5, ceil(total/4))` errors so partial DB writes still apply.

## Two-phase GMAT Club CAT scrape flow

The **GMAT Club CAT** source (`platform: 'gmatclub-cat'`, label `GMAT Club CAT`) scrapes GMAT Club's own full-length adaptive practice tests at `gmatclub.com/gmat-focus-tests/` — a **separate product** from the GMAT Club Error Log (forum analytics). It maps onto the OPE-mock model (a full CAT with section scores) crossed with the Error-Log per-question grid. One session per completed test attempt.

- **Phase 1 (default, fired by `/api/scrape`)** — `gmat_club_cat_scraper.js` (Node-side, multi-navigation like TTP) opens **My Tests** (`?page=tests`), reads every `Completed` attempt, then for each (with 1.5–3s jitter): visits the **score report** (`report?id={id}`) → `scoreSummary {total, quant, verbal, di}` each `{score, percentile}` + the absolute Test Date (used for the `since` day-granularity filter), and the **results grid** (`results-{id}.html?…&page=2&true=questionListGrid&sort=date.desc`, whose AJAX fragment renders ALL rows in one request — a CAT is ≤64 Qs). Each grid row → `q_id='gcc-att-{viewInstanceId}'`, `q_code='gcc-q-{qcode}'`, correct (`.qCorrectIcon`), difficulty (`.qDiff`), time, view URL, and Type cell `Section / Code / Topic` → `subject_code`/`category_code`/`topic` with `topic_source='gmatclub-canonical'` (LLM skipped). Aborts after more than `max(2, ceil(tests/4))` test errors. Output goes through the generic `saveScrapeResult` (no Phase-1-specific writer); `subject='Mixed'`.
- **Phase 2 (opt-in, `POST /api/sessions/:sessionId/enrich`)** — reuses `listGmatClubEnrichTargets` for the per-question view URLs; `runGmatClubCatPhase2FromOpenBrowser` visits each `view-{instanceId}.html` with jitter. **Verified DOM quirk:** the official answer is a `.correctAnswer` span (bare A–H letter) that is EMPTY until the explanation is expanded, and the page renders two such spans — so the runner clicks "Show Explanation" and waits for a populated letter, and the scraper scans **all** `.correctAnswer` spans for the bare letter. Choice labels come from each `.option`'s `<input value>`. The user's pick is NOT on the page for a direct navigation; `enrichGmatClubCatSessionAttempts` (which preserves per-choice `isCorrect`/`isUserSelected` flags and writes the explanation to `response_details`) **infers `my_answer = correct_answer` for questions Phase 1 marked correct** — wrong-question picks stay null (genuinely unavailable). Non-MC DI formats (TPA/MSR/TA/GI) have no `.option`s, so they get a stem only, no choices. Never calls `browser.close()`.

## LSAT practice (PDF-extracted, separate from the scrapers)

A parallel LSAT Reading-Comprehension practice track lives alongside the GMAT scrapers: DB tables `lsat_attempts` / `lsat_sessions` (user answers only), bridge module `src/lsat-dashboard.js`, UI in `client/src/LsatPractice.jsx`, and REST under `/api/lsat/...`. Question/passage **content** is not scraped or in the DB — it's served at runtime from **`data/lsat-questions.json`** via `loadLsatData` in `server.js` (≈ line 1410). That loader **caches in-process, so restart the API after regenerating the file.** The merged JSON is **gitignored** (local-only); rollback is the `.bak-prepass-*` sibling.

Two extractors built from the source PDF (`LSAT PrepTest 1_89.pdf`, repo root, 3244 pages, mixed 612-/405-wide page eras):

- **`scripts/parse-lsat-pdf.js`** (original) — parses `pdftotext -raw` into tests → sections → questions + answer keys. Still authoritative for **questions/choices/answer-keys**. It flattens the 2-column layout, so its **passage** text has destroyed paragraphs + leaked boilerplate.
- **`scripts/extract-lsat-passages.py`** (passages, added 2026-06) — reads page **geometry** via **pdfplumber** (`pip install --user pdfplumber`; not in `package.json` since the repo is JS) and rewrites only RC `passage`/`passages[]`, leaving questions/answer-keys byte-identical. Recovers true paragraphs (first-line indentation), LSAT line numbers (gutter `(5)(10)…` markers), and bold/italic highlights. Run `python3 scripts/extract-lsat-passages.py --merge` (omit `--merge` for a dry-run report). Per-passage schema: `firstQuestion`, `text` (paragraphs joined by `\n\n` — renders via the `white-space: pre-line` CSS on `.lsat-st-passage-text`), `lines[]` (`{n, marker, para, text}`), `highlights[]` — plus a backward-compatible flat `section.passage`. Handles per-page adaptive column split, paired "comparative reading" (PT52+ "Passage A/B"), and print-timestamp watermark filtering. Known limit: LSAT line *numbers* can drift a few near a passage's end; paragraph *text* is correct.

## Key Patterns

- **Database (PostgreSQL)**: Local PostgreSQL 16 in Docker (`pgvector/pgvector:pg16`, container `gmat-pg`, `docker-compose.yml`). Connection is env-driven via `DATABASE_URL`; bring the DB up with `npm run db:up` before starting the app. Schema lives in numbered SQL migrations (`migrations/*.sql`) applied by `npm run db:migrate` and tracked in `schema_migrations`. The original SQLite data was copied over once via the `scripts/migrate-sqlite-to-pg.js` ETL (`npm run db:etl`); the old `data/gmat-error-log.db` is retained as the rollback. Types modernized: timestamps are `timestamptz`, `session_external_id` is `bigint`, `session_date` is `date`; booleans kept as integer; JSON kept as text (jsonb deferred). Deferred follow-ups (not yet done): jsonb conversion, pgvector for coach embeddings, full-text search.
- **Writing SQL on Postgres (gotchas that bit the migration)**: `toPg` (`src/sql-util.js`) blindly rewrites `?`→`$n`, so SQL strings must contain **no literal `?`** — use `{0,1}` not `?` in regexes, and avoid jsonb `?`/`?|`/`?&` operators. `GROUP BY` is strict (SQLite wasn't): every non-aggregated SELECT column must be grouped or functionally dependent on a grouped PK — wrap stragglers in `MIN()`. `LIKE` is case-sensitive — wrap both sides in `LOWER()`/`UPPER()`. Multi-statement writes use `withTransaction(async (tx) => …)` with `tx.run/all/get` (never bare `run('BEGIN')`); inserts read ids via `RETURNING id`. `int8`/`numeric` only deserialize as JS numbers because of the type parsers in `db.js` — don't remove them.
- **Schema changes**: add a new numbered `migrations/NNNN_name.sql` (never `CREATE`/`ALTER` in `initDb()`, which only runs migrations + idempotent backfills now). `npm run db:reset` rebuilds from scratch (drops data); `npm run db:verify` checks column parity vs the legacy SQLite + exercises the read paths.
- **Date handling**: All scrape timestamps use Thai timezone (Asia/Bangkok, UTC+7) and are stored as `timestamptz`. The `since` parameter format is `YYYYMMDDHHmmss`. "Today" window applies a 36-hour safety buffer (`SCRAPE_TODAY_BUFFER_HOURS`). The GMAT Club scraper compares `since` at day granularity (the analytics table only renders dates as `D MMM YYYY`).
- **DB upserts**: Sessions are matched by `(session_external_id, source)` — written via `INSERT … ON CONFLICT … DO UPDATE` (no more SQLite `INSERT OR REPLACE`). Question attempts are fully replaced (delete + reinsert) per Phase 1 scrape inside a single `withTransaction`, but user annotations (`mistake_type`, `notes`) are preserved. Phase 2 enrichment is an `UPDATE` against existing rows (matched by `q_id` / item name) so it never wipes annotations either.
- **Answer-choice storage shape**: `question_attempts.answer_choices` is a flat JSON array. StartTest single-choice/DI rows include `{label, text, value, color, isCorrect, isUserSelected}` per option; matrix/dropdown items carry a nested `options[]` (with the same flags) inside each row/blank entry. GMAT Club Phase 2 writes the simpler `{label, text}` shape (per-choice flags don't exist on the GMAT Club page; the picked/correct letters are stored on the row's `my_answer`/`correct_answer` columns).
- **Review-modal color coding**: The question-review JSX evaluates per-choice flags independently — `anyMine = choices.some(c => c.isUserSelected === true)` and `anyCorrectFlagged = choices.some(c => c.isCorrect === true)`. Each flag falls back to a label comparison against row-level `my_answer`/`correct_answer` when no option is `true`. This handles StartTest rows that capture user-pick but not correct-answer per-option, plus GMAT Club rows that have no per-choice flags at all.
- **Scraper safety**: Never call `browser.close()` in the StartTest or GMAT Club paths — the browser is the user's logged-in Chrome, and closing it kills their session. Cleanup is best-effort (console/pageerror listeners removed in `finally`). StartTest Phase 2 navigates with `processAction('Next')` rather than `seq=N+1` URLs because rotating `code` tokens are single-use; GMAT Club Phase 2 navigates by URL with jitter.
- **Subcategory display**: StartTest writes short abbreviation codes ("VEO", "ARI", "COR") to `subcategory` and the readable name to `topic`. The dashboard's `pickReadableSubcategory` (in `client/src/App.jsx`) prefers `topic` whenever `subcategory` looks abbreviation-shaped (≤5 chars, all-caps).
- **GMAT Club category → code direct mapping**: The GMAT Club scraper hard-codes a `GMATCLUB_CATEGORY_TO_CODE` map plus a keyword-fallback regex list, so each row's raw category text (e.g., "Probability", "Statistics and Sets Problems", "Strengthen") gets converted to a `subject_sub_raw` value (`PS`/`CR`/`RC`/`DI`/...) at scrape time. Mapped rows are tagged `topic_source='gmatclub-canonical'` so the LLM classifier skips them entirely; only the rare unmapped category (e.g., "Science") falls through to the LLM. Typically 95–96% of GMAT Club rows bypass the LLM.
- **Source-platform identification**: The frontend's `getSourcePlatform(label)` heuristic checks **`/gmat\s*club\s*cat/i` → `'gmatclub-cat'` BEFORE `/gmat\s*club/i` → `'gmatclub'`** (order matters — "GMAT Club CAT" contains "GMAT Club"), then `/target\s*test\s*prep/i` → `'ttp'`, else `'starttest'`. Backend SQL mirrors this via `platformWhereClause`: `'%gmat club cat%'` for gmatclub-cat, `'%gmat club%' AND NOT '%gmat club cat%'` for the Error Log gmatclub, `'%target test prep%'` for ttp, `'%practice exam%'` for ope-mock, NOT-LIKE-any for starttest. This label-substring check is the only string the badge component, the platform query param, and the SQL filter all rely on — so the CAT-before-Error-Log ordering must hold on both sides.
- **TTP mistake_type is authoritative**: The TTP scraper writes a non-empty `mistake_type` on every question, which the DB upsert prefers over the preserved value. This is the only source where the scraper overwrites user annotations — all other sources fall through to preserve whatever the user wrote in the dashboard. The reason: TTP itself prompts the user to tag each error from a fixed taxonomy, so re-scraping pulls the most-recent taxonomy answer.
- **`difficulty_theta` is OPE-only; every other source relies on the `difficulty` tag**: Only OPE mock exams (`platform: 'ope-mock'`, `source LIKE '%practice exam%'`) are IRT-scored, so they are the ONLY source that populates `difficulty_theta`, and their `difficulty` label is DERIVED from it by `recomputeIrtCutoffs()` (theta=0 = uncalibrated → `'Unknown'`). All other sources (GMAT Club, GMAT Club CAT, OG books, Focus practice, TTP) take `difficulty` from the scraper/report band and leave `difficulty_theta` NULL. Therefore `recomputeIrtCutoffs()` and the `initDb` theta-backfill are **both scoped to OPE sessions only** — they must never read from or write to non-OPE rows. (Regression history: an unscoped `SET difficulty='Unknown' WHERE difficulty_theta=0` clobbered ~1170 scraper-labeled rows to 'Unknown' because a spurious `theta=0` had always coexisted with their valid labels; fixed by the OPE scoping.)
- **LLM provider switching**: Controlled by `LLM_PROVIDER` env var (`openai` | `zai`). Coach and classifier share provider/key/base but can use different models. Classifier is skipped entirely for `topic_source !== 'llm'` rows AND for `topic_source==='llm'` rows whose topic is already in `ALL_TOPIC_LABELS` (idempotency on re-scrapes).
- **Tests**: `node:test` unit tests for the SQL helpers live under `test/unit/` (`npm test`). There is no broad automated suite — most coverage is still manual.

## Querying the error log & analyzing performance

For schema, conventions (unanswered-row filter, subject normalization, topic canonicalization), ad-hoc SQL recipes, and REST API parameter reference, see [ANALYSIS.md](ANALYSIS.md). Reach for it whenever the user asks "what did I get wrong", "where am I weakest", "show me my accuracy on X", or anything that involves running a query against the Postgres DB (`docker exec gmat-pg psql -U postgres -d gmat`, or via `DATABASE_URL`; `data/gmat-error-log.db` is now only the legacy SQLite rollback) or hitting `/api/sessions`, `/api/errors`, `/api/patterns`, or `/api/sessions/:id/analysis`.

When the user wants to **review or be coached on his practice** ("review today's/this week's practice", "how did I do", "where am I weak", "dissect my misses", "review my timing", "re-summarize my performance", "what should I drill"), read **COACHING.md** first — the personal coaching playbook (diagnostic checklist, current DI triage rule, Phase-2 enrichment workflow, "Patient Coach" voice). It lives in the **MBA2027-GMAT** study folder (`/Users/pletopichaiyoot/Desktop/mba2027/MBA2027-GMAT/COACHING.md`), **not in this public repo** — per the study-materials save convention; skip gracefully if that folder isn't mounted. ANALYSIS.md (here) is the reference; COACHING.md is how to use it for him.

## Curating AI Curated Practice sets

When the user wants a **practice set to redo** ("curate a practice set", "make me a set to redo", "practice X with the AI curated feature"), the curation happens **here, in a coding/Cowork session** — query the DB, pick questions, and write `data/ai-practice-sets/<slug>.json` (`{ slug, title, focusNote, subject, items:[q_code,…] }`, read fresh per request, gitignored). Full recipe + candidate SQL: the **"Curating an AI Practice set"** section in [ANALYSIS.md](ANALYSIS.md).

**Reference items by `q_code` (strings), not `question_attempts.id`.** Phase-1 rescrapes delete+reinsert attempts and **reassign `question_attempts.id`**, so id-based sets silently break (questions vanish) after any rescrape; `q_code` is the stable per-question id and survives. The resolver (`resolveAiPracticeSetItems`) accepts either — a JSON string is a `q_code`, a JSON number is a legacy id (still used by the `/grade` endpoint) — and for a `q_code` it picks the most-complete gradeable row. Write **strings**, including numeric-looking StartTest q_codes (e.g. `"300263"`), so they route by `q_code` and not row id. Three hard rules:

1. **Only gradeable single-answer rows** — non-empty `question_stem`, a **flat** `[{label,text}]` `answer_choices` array, and a non-empty `correct_answer`. Multi-part DI (TPA/MSR/GI/TA with nested `options[]`) is rejected by `isFlatGradeableChoices()` and silently dropped.
2. **NEVER add scraped-incorrectly "blank-choice" rows** — questions whose `answer_choices` contains entries with empty/whitespace `text` (a scrape glitch: e.g. 5 options, 3 blank). The structural gradeability check counts choices but does **not** inspect their text, so a blank-choice row still serves and renders as empty buttons. Filter it out at curation time:

```sql
AND (SELECT count(*) FROM json_array_elements(qa.answer_choices::json) e
     WHERE COALESCE(TRIM(e->>'text'),'') = '') = 0
```

(This bit us once — attempt `14839` had 5 choices, 3 of them blank.)

3. **NEVER add a question with an incomplete stem.** Scrape corruption also drops math/figures from the *stem*: an equation that came in as an image but was never captured leaves a gap the app renders as "If 4 < , which…" or "let . If the sum…"; a "the chart/table above shows…" question whose figure wasn't captured; or a row whose entire stem is just the OPE boilerplate ("This is a multiple choice question…") with no actual question. A row can be structurally "gradeable" (flat A–E choices, valid key) yet still unanswerable this way. The structural check does NOT catch it — you must eyeball what the app will render: fetch the served payload and confirm the stem reads completely and, for math, that `question_stem_html` is present (renders the equation). Prefer questions that carry `question_stem_html`; drop any stem with a mid-sentence gap, a `[math]` marker with no html, or a figure reference with no captured image. **Special case — roman-numeral answers:** if the choices are "I only / II only / I and II only / …", the stem MUST contain the three I/II/III items being tested (inline like "80 140 199", or rendered via `question_stem_html`). A scrape that dropped that list leaves a stem like "…could be the total interest earned that year?" with the amounts gone — structurally gradeable but unanswerable. Confirm the three items are actually present. (This bit us across a whole audit — e.g. `7322`, `7674`, `7595`, `14860`, `13498`, and the roman-numeral cases `13437`, `13511`.)

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

Requires Node.js 20+ and Docker (for PostgreSQL). Copy `.env.example` to `.env` and set `DATABASE_URL` (points at the local Docker Postgres) and `OPENAI_API_KEY`. Bring the DB up with `npm run db:up` and apply migrations (`npm run db:migrate`) before starting the app. See `README.md` for full env var reference.

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
