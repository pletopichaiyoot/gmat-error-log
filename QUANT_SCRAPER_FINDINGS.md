# Quant Review Scraper — Verification Findings

**Date tested:** 2026-03-14
**Scraper version:** `gmat_scraper.js` (two-part, enhanced with auto-detect)
**App URL:** `https://gmatofficialpractice.mba.com/app/gmat-official-guide-2024-2025-quantitative-review-online-question-bank`

---

## Config Required for Quant Review

```javascript
await runScraper({
  clientId:         640835702,        // ← Different from Verbal (789329902)
  since:            '20260207000000', // YYYYMMDDHHmmss — adjust as needed
  reviewCategoryId: null,             // auto-detect finds 1337063
  source:           'OG Quant Review 2024-2025',
  pageWaitMs:       2200,
  nextPageWaitMs:   1800,
});
```

Key difference from Verbal: `clientId = 640835702` (found via `window.client_id` on the Quant Review app page).

---

## What Passed ✅

### 1. `reviewCategoryId` auto-detect
The enhanced scraper successfully detected category ID **`1337063`** for Quant Review without any hardcoded value. The fallback logic works as designed:
- Navigate to `#custom-quiz/{sid}` → extract category links from DOM → try each candidate

### 2. Subject detection
All 12 sessions correctly output `"subject": "Quant"`.

### 3. Part 2 (review pages)
- Scraped **47 wrong answers** across all sessions
- Each entry has: `q_code`, `my_answer`, `correct_answer`, `question_url`, `cat_id`
- Navigation using the auto-detected `1337063` worked on every review page
- No skipped pages due to navigation failure

### 4. `question_url` format
Fully qualified URLs are correct, e.g.:
```
https://gmatofficialpractice.mba.com/app/gmat-official-guide-2024-2025-quantitative-review-online-question-bank#custom-quiz/84579332/review/categories/1337063/16753603
```

---

## What Needs Attention ⚠️

### 1. Categories page shows CUMULATIVE data, not session-specific

**For Verbal Review**, `#custom-quiz/{sid}/categories/{catId}` shows only that session's questions (e.g. 20 questions for a 20-question session). The `total_q_categories` matches `total_q_api`.

**For Quant Review**, the same URL shows your *entire practice history* for the Quant bank, regardless of `{sid}`. The session ID in the URL controls the header stats (accuracy %, avg time) but the question list below is cumulative.

Observed data (Feb–Mar 2026):

| Date | API Q | Cat Q | API Errors | Cat Errors | Acc % |
|---|---|---|---|---|---|
| 2026-01-29 | 3 | 15 | 3 | 3 | 80% |
| 2026-02-02 | 5 | 15 | 5 | 5 | 67% |
| 2026-02-08 | 5 | 20 | 5 | 5 | 75% |
| 2026-02-18 | 1 | 10 | 5 | 5 | 50% |
| 2026-02-21 | 1 | 16 | 5 | 5 | 69% |

The 1-question sessions (Feb 18, Feb 21) clearly cannot have 5 errors — those are cumulative totals from the full Quant history.

**Implication:** For Quant sessions, the `questions` array in Part 1 output is NOT session-specific. It contains all historically practiced questions in the Quant bank. Do not use it for session-level difficulty breakdown.

**What to use instead for the Practice Log:**
- `stats.total_q_api` → `# Questions` column
- `stats.accuracy_pct` from the header (session-level header, likely correct — but verify manually for 1-question sessions)
- Compute errors from API: `total_q_api - (total_q_api × accuracy_pct/100)`
- For difficulty breakdown (M/N columns): cannot reliably derive from categories page for Quant — leave blank or skip

### 2. `topic` field is meaningless for Quant PS/DS questions

The `detectTopic` function was built for CR/RC question types (Weaken, Strengthen, Inference, etc.). Every single Quant wrong answer came back with `topic: "Explain"` because PS/DS questions often contain phrasing like "which of the following *explains*…" or "what *explains* the discrepancy…"

**Result:** All 47 wrong answers had `topic: "Explain"` — which is noise, not signal.

**Fix:** When writing Quant wrong answers to the error log, leave the `topic` column blank, or implement a separate Quant topic taxonomy (e.g. Algebra, Arithmetic, Geometry, Word Problems, etc.) based on OG question codes if available.

---

## Category IDs Discovered

| App | client_id | Parent Category | Notes |
|---|---|---|---|
| Verbal Review 2024-2025 | 789329902 | 1337003 | CR=1337013, RC=1337023 |
| Quant Review 2024-2025 | 640835702 | 1337063 | Auto-detected |

---

## Recommended Workflow for Quant Sessions

1. Navigate to the Quant Review app URL
2. Paste `gmat_scraper.js` into DevTools
3. Run with Quant config (see above)
4. Use `window._gmatData` for:
   - **Session-level stats** (from API): `total_q_api`, `stats.accuracy_pct`, `stats.avg_time_sec`
   - **Wrong answer details** (from Part 2): `q_code`, `my_answer`, `correct_answer`
   - **Subject**: always `"Quant"` for this bank
5. Do NOT use the `questions` array difficulty distribution for Quant — it reflects the cumulative pool, not the individual session
6. Leave `topic` blank for Quant error log rows

---

## Files Updated

- `CLAUDE.md` — should be updated to add `clientId = 640835702` for Quant Review and note the cumulative categories-page caveat
- `SCRAPER_DESIGN.md` — should note the Verbal vs Quant categories-page behaviour difference
