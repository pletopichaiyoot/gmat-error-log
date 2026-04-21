# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Local GMAT analytics app: scrapes GMAT Official Practice sessions via Chrome CDP, stores in SQLite, provides dashboards + LLM-powered coaching. Single user, macOS-focused.

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
- **`server.js`** — Express API on port 4310. Defines source presets (7 GMAT books), date window logic (Thai timezone, Asia/Bangkok), and all REST endpoints.
- **`db.js`** — Raw SQLite3 queries (no ORM). Three tables: `scrape_runs`, `sessions`, `question_attempts`. Schema migrations via `ALTER TABLE ADD COLUMN` with existence checks. Upsert: sessions matched by `(session_external_id, source)`, question attempts deleted+reinserted per session.
- **`scraper-runner.js`** — Playwright CDP bridge. Connects to user's Chrome on port 9222, injects scraper script into page context.
- **`scrapers/gmat_scraper.js`** — 8K+ line script injected as a string into the GMAT page via `page.evaluate()`. Runs as `window.runScraper(config)`. Not a standalone Node module.
- **`llm-coach-agent.js`** — LangGraph state machine for AI performance review and Q&A chat. Uses LangChain + OpenAI (or Z AI as alternative provider).
- **`question-topic-classifier.js`** — LLM-based topic classification. Runs on every scrape batch. Subject-specific label sets (Quant: 10 topics, Verbal: 12, DI: 11).
- **`question-metadata.js`** — Enriches question records with derived fields.

### Frontend (`client/src/`)
- **`App.jsx`** — Single 3K+ line file containing the entire dashboard: performance view, error log, pattern analysis, session deep-dive modal, AI coach panel, sync controls. All state via React hooks.
- **`styles.css`** — Tailwind + custom CSS.
- **`components/ui/`** — shadcn-style Radix primitives (dialog, button, input, textarea, select, badge, card).
- Fonts: Space Grotesk + Manrope via Google Fonts.

### Dev Proxy
Vite proxies `/api/*` to Express (127.0.0.1:4310) with 2-hour timeout for long scrapes. In production, Express serves `client/dist` statically.

## Key Patterns

- **Date handling**: All scrape timestamps use Thai timezone (Asia/Bangkok, UTC+7). The `since` parameter format is `YYYYMMDDHHmmss`. "Today" window applies a 36-hour safety buffer (`SCRAPE_TODAY_BUFFER_HOURS`).
- **DB upserts**: Sessions are matched by `(session_external_id, source)` — the latest record is updated. Question attempts are fully replaced (delete + reinsert) per session, but user annotations (`mistake_type`, `notes`) are preserved across re-scrapes.
- **Scraper injection**: The backend reads `gmat_scraper.js` as a string and executes it inside the browser page context. Changes to the scraper must work in a browser environment, not Node.
- **LLM provider switching**: Controlled by `LLM_PROVIDER` env var (`openai` | `zai`). Coach and classifier share provider/key/base but can use different models.
- **No tests**: The project has no automated test suite.

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
