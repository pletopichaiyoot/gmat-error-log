# GMAT Error Log
Local web app to scrape GMAT Official Practice sessions and analyze error patterns in SQLite.

## Essential Commands
| Task | Command |
|---|---|
| Install deps | `npm install` |
| Run full dev (API + Web) | `npm run dev` |
| Run API only | `npm run dev:api` |
| Run Web only | `npm run dev:web` |
| Build web | `npm run build:web` |
| Start server | `npm start` |

## Repository Structure
| Path | Purpose |
|---|---|
| `client/` | React + Vite frontend |
| `src/` | Express API, scraper runner, SQLite access |
| `src/scrapers/` | Browser-executed GMAT scraper scripts |
| `data/` | SQLite DB + Chrome CDP profile |
| `.codex/skills/` | Primary skills for Codex |
| `.claude/skills/` | Mirrored skills for Claude-style agents |
| `.agent/skills/` | Mirrored skills for other agent runtimes |

## Skills Index
| Skill | When to use |
|---|---|
| [ai-context](.codex/skills/ai-context/SKILL.md) | Maintain AI context docs (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, skills). |
| [documentation-lookup](.codex/skills/documentation-lookup/SKILL.md) | Library/framework docs and API lookup tasks. |
| [e2e-testing](.codex/skills/e2e-testing/SKILL.md) | Add or debug Playwright E2E tests. |
| [e2e-testing-patterns](.codex/skills/e2e-testing-patterns/SKILL.md) | Testing strategy and anti-flake E2E patterns. |
| [frontend-code-review](.codex/skills/frontend-code-review/SKILL.md) | Review frontend changes for bugs and regressions. |
| [frontend-test-workflow](.codex/skills/frontend-test-workflow/SKILL.md) | End-to-end frontend test workflow planning + implementation. |
| [frontend-testing](.codex/skills/frontend-testing/SKILL.md) | Write Vitest + React Testing Library tests. |
| [qa-test-planner](.codex/skills/qa-test-planner/SKILL.md) | Create detailed QA plans and validation checklists. |
| [skill-creator](.codex/skills/skill-creator/SKILL.md) | Create or improve reusable skills. |
| [skill-installer](.codex/skills/skill-installer/SKILL.md) | Discover and install additional Codex skills. |
| [skill-lookup](.codex/skills/skill-lookup/SKILL.md) | Find the right skill for a task. |
| [web-frontend-design](.codex/skills/web-frontend-design/SKILL.md) | Web app UI implementation and layout design. |

## Key Entry Points
| Task | File |
|---|---|
| API routes and server boot | `src/server.js` |
| DB schema + query layer | `src/db.js` |
| CDP scrape orchestration | `src/scraper-runner.js` |
| In-browser GMAT scraper logic | `src/scrapers/gmat_scraper.js` |
| Main frontend page | `client/src/App.jsx` |
| Frontend styles | `client/src/styles.css` |
