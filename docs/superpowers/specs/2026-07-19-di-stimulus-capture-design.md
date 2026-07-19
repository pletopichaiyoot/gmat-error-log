# DI Stimulus Capture (graphs, tables, MSR sources) — Design

**Date:** 2026-07-19
**Status:** Approved (design), pending implementation plan
**Scope:** StartTest Phase 2 enrichment only (the 7 GMAT Official Practice books)

## Problem

StartTest Phase 2 (`readReviewFrame` in `src/scrapers/starttest_scraper.js`) captures a
DI question's stem **as flattened `innerText`** and drops the visual/structured
stimulus:

- **GI (Graphics Interpretation):** the chart is never captured — only the stem text
  ("the graph shows…"). Confirmed: every DI row (442) has `question_stem_html = NULL`.
- **TA / Two-Part Analysis:** the data table is captured only as mangled innerText
  (`"Hopping 5 2.0"`) — columns, headers, alignment lost.
- **MSR (Multi-Source Reasoning):** the multiple source passages are not reliably
  captured as distinct, readable sources.

Goal: capture the stimulus so the user can **view** a past DI question faithfully in
the review modal AND the **AI coach** can read the underlying data.

## Live DOM findings (StartTest ITDReview, review mode — probed 2026-07-19)

Probed sessions 314 (161160) and 316 (161326) via CDP, navigating directly to each
item's per-seq review URL.

- **Review mode flattens everything into the DOM.** MSR sources render as titled
  reference sections (`h2.ItemReferenceTitleText` inside `.ItemRationaleText` /
  `.rationale.passage-block`), **not clickable tabs.** => No tab-walking needed.
- **Charts** are `<svg>` elements (self-contained vector) plus `<img src="itdmedia.aspx?data=…">`.
  The `itdmedia` URL is **auth-scoped and expires** — cannot be stored as a live URL
  (same class of problem as OPE math images, handled today by screenshotting / `[figure]`).
- **Tables** are `<table class="table">` inside the stem / passage region.
- **Item type** is exposed as `window.vItemType` (`Matrix`, `Interlinear`, `MultipleChoice`).
- **Key containers:** `.its-item-table.ITSStem`, `.its-item-td.ITSStemText` (prompt),
  `.options-container`/`.options-container-inner` (answers), `.illustration-container`,
  and `.ItemRationaleText` / `.rationale.passage-block` (rationale **and** MSR reference
  sources — these are intermingled and must be separated by the `ItemReferenceTitleText`
  headers so the solution is not leaked into the stimulus).

## Architecture

One **unified capture pipeline** over the rendered stimulus region — because review mode
already flattens GI/TA/TPA/MSR, a single approach handles all four:

### Capture (`readReviewFrame` + runner)
1. In the frame `evaluate`, collect the stimulus region:
   - `<svg>` charts → serialize `outerHTML` inline.
   - `<table class="table">` → sanitized HTML (keep `thead/tbody/tr/th/td`).
   - MSR reference sections → the `ItemReferenceTitleText`-headed blocks, kept as
     ordered `sources[] = [{ title, html, text }]`, **excluding** the solution rationale.
   - Return placeholders/markers for each `<img src="itdmedia…">` element (index + bounding
     selector) so the runner can screenshot it.
2. In the runner (Playwright, has the frame handle): for each `itdmedia` `<img>`,
   element-screenshot → base64 `data:image/png` URI, splice back into the html.
3. Derive `dataText`: readable flattening for the coach (table → rows of `col: value`,
   svg → its text labels, sources → concatenated titled text).

### Storage (`db.js` + migration)
- New migration adds `stimulus` (text holding JSON) on `question_attempts`:
  ```json
  {
    "kind": "graph" | "table" | "msr" | "mixed",
    "html": "<sanitized, self-contained stimulus html>",
    "dataText": "coach-readable flattening",
    "sources": [ { "title": "...", "html": "...", "text": "..." } ]
  }
  ```
- `question_stem_html` stays for inline math (unchanged).
- **Clobber-proof:** add `stimulus` to `buildAttemptSnapshotIndex` + the insert fallback
  in `saveScrapeResult` (`q.stimulus || preservedSnapshot?.stimulus || null`), same pattern
  as `question_stem_html` / `answer_choices`. Regression test required.
- Writer `enrichSessionAttempts` persists the JSON.

### Rendering (`client/src/App.jsx` + `styles.css`)
- New **Stimulus block** above the choices in the question-review modal, rendering
  `stimulus.html` through a sanitizer (reuse/extend `sanitizeStemHtml`: allow `svg`,
  `table`, `data:` images; strip `script`, event handlers, external `src`).
- MSR `sources[]` render as stacked titled sections (their natural flattened form).
- Null `stimulus` → render nothing (all existing rows unaffected; non-breaking).

### Coach
- `stimulus.dataText` is included in the per-question context passed to the LLM coach.

## Non-goals (YAGNI)
- Sources other than StartTest (GMAT Club CAT / Error Log DOM is different — separate spec).
- Tab-clicking / test-mode navigation (review mode is already flattened).
- `<canvas>` charts (none observed — all charts are `<svg>` or `itdmedia` `<img>`).
- Re-architecting the Phase 2 walker (it already reaches matrix/dropdown items).

## Testing
- Unit: (a) `stimulus` preserved across a Phase-1 rescrape; (b) sanitizer keeps
  svg/table/`data:` img and strips scripts/handlers/external src; (c) source-vs-rationale
  separation via `ItemReferenceTitleText`.
- Integration/manual: live re-enrich one DI session (e.g. 316 / 161326, which has MSR
  items) and verify the modal renders the chart/table/sources and `dataText` is populated.

## Risks / open items
- **itdmedia screenshot fidelity/size:** element screenshots add bytes per row; cap
  dimensions and use PNG. Confirm the `<img>` is laid out (visible) at capture time.
- **Rationale/source separation** is heuristic (`ItemReferenceTitleText`); verify across a
  few MSR items during implementation.
- **svg serialization** must inline any referenced styles/defs to stay self-contained.

## As-built status (2026-07-19) — what shipped vs. known gap

Verified live by enriching sessions 316 (MSR) and 314 (GI + TPA):

- **GI charts — WORKS.** The chart is an `<img src="itdmedia…">`; the runner screenshots
  it to a `data:` PNG and it renders in the stimulus block. (svgs on these pages are
  toolbar icons, not the chart.)
- **MSR source passages — WORKS.** Text passages render during the Phase-2 walk and are
  captured as `sources[]`.
- **TA / TPA data tables — KNOWN GAP, not captured.** The data table renders in the
  ITDReview DOM only on **direct per-item navigation** (a `page.goto` of the item's review
  URL), **not during the Phase-2 walk** (`processAction('Next')`) — in the walked flow the
  `.passageContainer`/`.passage` stays empty. A `waitForReferenceContent` timing fix was
  tried and reverted (the table is genuinely absent in the walk, so it only added latency).
  **Capturing TA tables would require Phase-2 to direct-nav each item instead of the
  Next-walk** — a larger change with more scrape footprint. Deferred by decision.
