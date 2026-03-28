# GMAT Site Structure Notes

Updated: 2026-03-28

This note documents the GMAT Official Practice app structure as observed from a live Chrome CDP session plus the selector contracts already encoded in [gmat_scraper.js](/Users/pletopichaiyoot/Desktop/codespace/gmat-error-log/src/scrapers/gmat_scraper.js).

Use [inspect-gmat-cdp.js](/Users/pletopichaiyoot/Desktop/codespace/gmat-error-log/scripts/inspect-gmat-cdp.js) to re-run the live inspection against an already logged-in Chrome instance on `http://127.0.0.1:9222`.

**Sources**
The current scraper targets these app roots:

- `OG Verbal Review 2024-2025`
- `OG Quantitative Review 2024-2025`
- `OG Data Insights Review 2024-2025`
- `OG Main 2024-2025`
- `GMAT Focus Quantitative Practice`
- `GMAT Focus Verbal Practice`
- `GMAT Focus Data Insights Practice`

**Live CDP Findings**
Observed from the live probe on 2026-03-28:

- `GMAT Focus Verbal Practice` and `GMAT Focus Data Insights Practice` rendered full home pages with the heading `Welcome to GMAT Official Practice Questions ...`.
- The Focus home pages expose the top-level nav and dashboard sections such as `Lessons`, `Strengths & Weaknesses`, `Top Game Scores`, and `Content`.
- The Focus home pages did not expose category/review rows at the root route.
- `OG Verbal Review 2024-2025`, `OG Quantitative Review 2024-2025`, `OG Data Insights Review 2024-2025`, `OG Main 2024-2025`, and `GMAT Focus Quantitative Practice` were still on a minimal `Loading...` shell during the short probe window.
- The current CDP pass therefore confirmed home-page structure better than in-session category/review structure.

**Route Shapes**
These route shapes are stable and are already used by the scraper:

- App root: `/app/<app-slug>`
- Session root: `#custom-quiz/<sessionId>`
- Category page: `#custom-quiz/<sessionId>/categories/<categoryId>`
- Review page: `#custom-quiz/<sessionId>/review/categories/<categoryId>/<questionId>`

The scraper normalizes these in [gmat_scraper.js](/Users/pletopichaiyoot/Desktop/codespace/gmat-error-log/src/scrapers/gmat_scraper.js) via `parseCategoryRoute`, `parseReviewRoute`, and `toAbsoluteQuestionUrl`.

**Home Page Contracts**
Live-observed on Focus sources:

- Page title is still `Home | GMAT Official Practice` even when the visible page is source-specific.
- The main visible source label lives in page text/headings, not the document title.
- Root pages can contain many generic classes like `content`, `confidence`, and `review` that are not question-review specific.
- Root-page class fragments alone are not reliable signals for scraper state.

Implication:

- Treat the URL hash and explicit route links as stronger signals than global class-fragment counts.

**Category Page Contracts**
These are the current scraper assumptions. They are code-backed and should be re-verified with CDP when a live session page is available.

- Category rows are commonly selected with `[data-id].category.content` or `[data-id][class*="category"][class*="content"]`.
- Review links are found through attributes containing `review/categories/` on `href`, `data-href`, `data-url`, `data-link`, or `onclick`.
- Category rows expose enough text to infer:
  - question preview / six-digit `q_code`
  - difficulty
  - confidence
  - correctness
  - question route target
- Sub-subject hints are inferred from category row text and route-linked elements.

Key selectors from the scraper:

- Review targets:
  - `a[href*="review/categories/"]`
  - `[data-href*="review/categories/"]`
  - `[data-url*="review/categories/"]`
  - `[data-link*="review/categories/"]`
  - `[onclick*="review/categories/"]`
- Difficulty:
  - `[class*="difficulty"][class*="li-cell"]`
  - `[class*="difficulty"]`
- Confidence:
  - `[class*="confidence"]`
- Correctness:
  - `[class*="correctness"]`
- Preview:
  - `[class*="preview"]`

**Review Page Contracts**
These are the critical selectors for the second-pass scrape:

- Answer choice containers:
  - `.question-choices-multi .multi-choice`
  - `.question-choices-multi [class*="choice"]`
  - `[class*="question-choices"] .multi-choice`
  - `[class*="question-choices"] [class*="choice"]`
- Explanation blocks:
  - `[class*="explanation"]`
  - `[id*="explanation"]`
  - `[data-testid*="explanation"]`
  - `[class*="rationale"]`
  - `[class*="analysis"]`
- Answer-state cues:
  - selected: class fragments such as `selected`, `active`, `chosen`, `incorrect`
  - correct: class fragments such as `corrected`, `is-correct`, `correct-answer`
  - incorrect: class fragments such as `incorrect`, `is-incorrect`

**Review Readiness Lessons**
Observed during DI review-page debugging on 2026-03-28:

- Review-page readiness cannot be gated only by legacy `.question-choices-multi` counts.
- DI review pages can be fully loaded while exposing:
  - stateful answer nodes
  - table/grid answer nodes
  - `Your Answer` / `Correct Answer` text
  - rich question text
  without ever rendering a classic 5-choice block.
- A reliable readiness check should combine:
  - route/hash match for `sessionId`, `categoryId`, `questionId`
  - q-code match when available
  - at least one content signal such as legacy choices, DI slot signals, stateful answer nodes, or answer-label text
- Increasing the timeout alone is not a real fix when the readiness predicate is wrong.

**Question Stem Roots**
Live-inspected on an active DI review page:

- The real question content was rooted under:
  - `#content-question-start`
  - `[id^="current-question-container-"]`
- These nodes contained the actual prompt, supporting table/chart text, and inline answer area without the full app shell.
- Larger ancestors such as:
  - `.answer-container.question-container`
  - `.questions-container`
  can include extra review/explanation content and should rank below the smaller per-question roots.
- `document.body.innerText` is too noisy for stem extraction because it pulls in global app chrome such as:
  - `Skip to main content`
  - `Notifications`
  - `Study Plan`
  - `Practice Questions`
  - `Search`

Implication:

- Stem extraction should prefer the smallest question-root container and use `document.body` only as fallback.

**Composite DI Answer Extraction Lessons**
Observed from malformed `TPA`, `TA`, and `MSR` rows in scrape run `100`:

- Broad answer-node selectors can accidentally include aggregate wrappers such as:
  - `UL.question-choices-table.results`
  - `.answer-container ... incorrect`
  - larger review/table containers that contain multiple leaf options
- When that happens, the scraper can save whole grids as synthetic options, producing broken answers like:
  - `Question: 1 2 10 13 ...`
  - `Question: Cost Miles`
  - `Yes / No / full statement block`
- Descendant-based status detection is too broad for DI composite layouts. A parent wrapper can inherit `correct` or `incorrect` semantics from a child and then be misclassified as an answer option.

Safer extraction rules:

- Treat only leaf-ish option nodes as answer candidates.
- Reject aggregate containers that:
  - are obvious structural tags such as `ul`, `table`, `tbody`, `tr`
  - look like large question/review wrappers
  - contain multiple nested leaf options
- Prefer status detection on the node itself or immediate children, not arbitrary descendants.
- Expect `TPA`, `TA`, and `MSR` to require slot-level extraction rather than a flat list of choices.

The current scraper now assumes the review page can yield:

- `question_stem`
- `answer_choices`
- `response_format` with `single_select` or `composite`
- `response_details` for DI questions that do not fit a single `A-E` answer model
- `my_answer`
- `correct_answer`
- `topic`
- `content_domain` for DI `TPA` / `MSR` questions with values `math` or `non_math`
- `question_url`

**Scraper Guidance**
For future scraper changes:

- Prefer route-driven state detection over generic page-text checks.
- Keep category-page parsing separate from review-page parsing. The root/home DOM is noisy and shares class fragments that are not question-related.
- Use category pages for indexing, session scoping, q-code lookup, and review URLs.
- Use review pages for rich question content, answer choices, DI response-slot extraction, and topic inference.
- Expect some source roots to remain on a loading shell until the app finishes booting or the product session is fully ready.

**Known Gaps**

- The short CDP probe did not capture a fresh live category page for every source.
- OG source roots may need longer waits or a direct session hash to reach scraper-relevant DOM.
- Re-run [inspect-gmat-cdp.js](/Users/pletopichaiyoot/Desktop/codespace/gmat-error-log/scripts/inspect-gmat-cdp.js) after opening an active session/review page if deeper selector validation is needed.
