# GMAT Error Log App (Local)

A local web app that:

1. Connects to your already logged-in GMAT Official Practice browser tab.
2. Runs your existing `gmat_scraper.js` directly in that session.
3. Saves results to a local SQLite database.
4. Shows session performance, error logs, and error patterns.

## Stack

- Backend: Node.js + Express
- Scraping bridge: Playwright (CDP connect to open Chrome)
- Database: SQLite (`gmat-error-log/data/gmat-error-log.db`)
- Frontend: Vite + React (`client/`)

## 1) Install

```bash
cd gmat-error-log
npm install
```

## 2) Launch Chrome with remote debugging

Two options:

1. Use the app button: **Open Chrome (CDP)** in the UI.
2. Or run manually on macOS:

```bash
open -na "Google Chrome" --args --remote-debugging-port=9222
```

Then in that Chrome window:

1. Log in to `https://gmatofficialpractice.mba.com`
2. Open the OG question bank tab you want to scrape

## 3) Run app (development)

```bash
npm run dev
```

Open:

```text
http://localhost:5173
```

API runs on `http://localhost:4310` and Vite proxies `/api` calls automatically.

## 4) Scrape and save (simple mode)

In the UI:

1. Pick `Source`.
2. Pick `Scrape Period`:
   - `Today (default)`
   - `Last 3 days`
   - `Last 7 days`
   - `Full update`
   - `Specific period` (custom date/time)
3. Click **Open Chrome (CDP)**.
4. Log in to GMAT in that Chrome window.
5. Click **Run Scrape + Save to DB**.

The app automatically:

- Computes `since` from the selected scrape period.
- Uses source presets for `clientId` and `reviewCategoryId`.
- Upserts sessions/questions so already logged practice is updated instead of duplicated.
- Adds per-error one-click question links (`Open` button) when GMAT review URL is available.

Current source presets include:

- OG Verbal Review 2024-2025
- OG Quant Review 2024-2025
- OG Data Insights Review 2024-2025
- OG Main 2024-2025

## Data model

- `scrape_runs`: one row per scrape execution
- `sessions`: one row per GMAT quiz session in that run
- `question_attempts`: one row per question attempt (includes wrong-answer details when available)

## Notes

- This app uses a bundled scraper at `src/scrapers/gmat_scraper.js` (copied from your original script) and keeps the same architecture described in `../SCRAPER_DESIGN.md`.
- If scrape fails with "No open GMAT tab found", make sure GMAT is open in the same Chrome instance launched with remote debugging.

## Optional production build

```bash
npm run build:web
npm start
```

Then open `http://localhost:4310`.
