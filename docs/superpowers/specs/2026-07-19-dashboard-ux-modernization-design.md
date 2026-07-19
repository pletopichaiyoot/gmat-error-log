# Design: Signal-first Dashboard Modernization

**Date:** 2026-07-19
**Status:** Approved (design) — pending spec review
**Scope:** Frontend-only restyle/restructure of 5 dashboard surfaces, staying inside the "Patient Coach" brand (PRODUCT.md / DESIGN.md). No backend, schema, API, or scraper changes.

## 1. Context & Motivation

The GMAT Error Log is a single-user local analytics workspace. Its brand — **"The Patient Coach"** — is documented in PRODUCT.md and DESIGN.md: warm-paper palette (forest-sage `#3d7a5e` primary, aged-brass `#c4a843` accent, cream surfaces), Manrope titles / Space-Grotesk body, flat-by-default depth, a load-bearing gold/red/green answer semantic, and a relentless uppercase micro-label idiom.

The current dashboard is clean and functional but reads like an *unfinished admin panel*: a weak hero stat ("OVERALL 65.6%" as a tiny tile), flat subject tiles with no trend signal, plain nav with no active state, uniform full-width stacking with no visual rhythm, and dense-but-plain tables. The trigger request asked for a "modern SaaS analytics dashboard with clarity and professional feel." We keep the **intent** (clarity + professional feel) and **reject the template** (glassmorphism, pricing table, trust badges — all explicitly banned by DESIGN.md and meaningless for a single-user tool with no customers).

This is **Approach B — Signal-first restructure**: polish plus a reworked information hierarchy that surfaces *signal* (how am I trending, where am I weakest, what to drill) rather than just tabulating data.

## 2. Goals

- Make the overview answer "how did I do / where next" at a glance, not after reading a table.
- Add honest trend signal (sparklines, deltas) computed from data already on hand.
- Modernize the dense tables (Category Breakdown, Error Log) for scannability without enterprise-BI chrome.
- Pay down the **Study Plan indigo/violet inline-styled drift** (DESIGN.md §6 Don'ts, line 266) by bringing it onto the sage/gold token system.
- Unify the redundant top zone (Today's Plan band vs. a new hero band) into one cohesive header.
- Close the `prefers-reduced-motion` gap DESIGN.md flags for new motion.

## 3. Non-Goals (out of scope)

- AI coach panel, LSAT practice player, AI Curated Practice, Score Calculator.
- Any backend / `server.js` / `db.js` / scraper / migration change.
- New color tokens, glassmorphism, gradient text, big-number metric-tile template, identical icon+heading+text card grids (all banned by DESIGN.md).
- Broad refactor of App.jsx beyond extracting the presentational components this work needs.

## 4. Brand Guardrails (hard constraints — every surface)

These are lifted directly from DESIGN.md and are non-negotiable:

- **Two-Voice Rule:** green = the user's success + the system's own voice; gold/brass = attention / the missed thing. Never swap. Trend rising = sage green; trend/score declining = brass-ink (attention), never red.
- **Answer semantic untouched:** gold = correct-missed, red = wrong-pick, green = right-pick, via the 3px left-border + tint. The review modal keeps this exactly.
- **Flat-by-default:** depth from 1px `warm-border` + the three tonal cream steps (`warm-limestone` → `oat-surface` → `oat-recessed`). Shadow only for things that truly float (modal, dropdown, FAB). Never nest a card in a card.
- **Micro-label idiom:** every caption / eyebrow / table header / chip = uppercase ~0.7rem, weight 600–700, tracked. Every number = `tabular-nums`.
- **Two families:** Manrope titles, Space Grotesk everything else.
- **WCAG 2.2 AA:** no `stone-muted` (`#7a807c`) on cream for text a reader reads — use `pine-ink-soft` (`#4a524e`). Visible focus, keyboard operability preserved.
- **No decorative thick left-borders** beyond the sanctioned answer/status semantic.

## 5. Shared Components (new)

Extracted into `client/src/components/` to keep the diff reviewable and shrink the 5197-line App.jsx. All presentational, prop-driven, independently testable.

- **`Sparkline.jsx`** — tiny inline SVG line chart. Props: `points: number[]`, `stroke` (default sage), `width`, `height`, `ariaLabel`. Flat, no fill glare. Draw-in animation guarded by `prefers-reduced-motion`. Renders nothing / an em-dash for <2 points.
- **`MiniBar.jsx`** — thin horizontal accuracy bar for table cells. Props: `value` (0–100), `color`. Sage fill on `oat-recessed` track, `tabular-nums` label optional.
- **`ProgressRing.jsx`** — small circular progress (SVG) for "done today" / per-day plan progress. Props: `value`, `total`, `size`. Sage arc.
- **`HeroBand.jsx`** — the at-a-glance overview header (composed of the above). Props: overall accuracy, delta, trend series, weakness `{label, accuracy}`, days-to-test, drill handler.
- **Sortable-header helper** — a small hook/util (`useSortableColumns`) or `<SortHeader>` for click-to-sort table headers with an arrow indicator. Reused by Category Breakdown (and available to Error Log).

Data note: all trend/delta/weakness values are derived **client-side** from data the dashboard already fetches (`/api/sessions` rows carry date + accuracy; `/api/patterns` and the category rows carry per-category accuracy). No new endpoints.

## 6. Per-Surface Design

### 6.1 Overview — top zone (`#dashboard`, `TodayPlan.jsx`)

Today the dashboard stacks: Today's Plan band → Performance by Subject (4 tiles) → Category Breakdown. The redesign unifies the header and strengthens signal.

- **Cohesive top zone.** Today's Plan and the new hero share one header zone rather than two competing full-width bands. `days-to-test` appears **once**. Today's focus (e.g. "MOCK #2 — ≥600 with clean timing") + a **ProgressRing** for "done today" + the days-to-test countdown read as one unit. Task rows keep their CRUD but get the same affordance polish as the Study Plan board.
- **HeroBand.** Big **overall accuracy** (Display type, `tabular-nums`) + **window delta** (rising = sage, declining = brass-ink) + **trend Sparkline** (recent-session accuracy) + **top-weakness callout** ("Weakest: DI · MSR 49%") with a **Drill** action that jumps to the error log filtered to that subject/category. This is a *sanctioned scoreboard moment* (the DESIGN.md Display type is explicitly for accuracy scoreboards), not a decorative metric tile.
- **Subject cards** (Verbal / Quant / Data Insights / Other): keep the accuracy figure + bar; add a small per-subject **Sparkline** of recent accuracy. Flat, no card-in-card.

### 6.2 Category Breakdown (`#categories`)

- **Inline MiniBar** in the ACCURACY cell (width = accuracy, sage fill) so weak categories are visible without reading numbers.
- **Real sortable headers** (SUBJECT already shows an arrow) via the sortable-header helper — click to sort by total / accuracy / avg time / status, arrow indicator.
- Keep all columns, the STATUS pills (`IMPROVING` / `NEEDS FOCUS`), and the per-row `View N` drilldown. `tabular-nums` throughout.

### 6.3 Error Log (`#errors`) + Review Modal

- **Sticky filter bar.** Source / subject / search / "More filters" pin under the section nav while the long table scrolls (today they scroll out of reach). Table body scrolls beneath.
- **Row rhythm polish.** Clearer hover via a tonal step (`oat-recessed`), preserve the existing result-driven row tint. No column or semantic change; Note / History / Review actions unchanged.
- **Review modal (centerpiece) — polish only.** Reading measure capped 65–75ch on stem/passage; a tighter result header (correct answer vs. your pick + time); cleaner annotation block. The **gold/red/green 3px-left-border answer-choice semantic is untouched** (including the `anyMine` / `anyCorrectFlagged` independent-flag logic and matrix/dropdown variants).

### 6.4 Pattern Analysis (`analysis-block` ×2 + drilldown modal)

- Reframe around "where am I weakest / what to drill": a **ranked list with inline MiniBars** and a single **headline insight line** ("Your biggest leak this window: DI timing on MSR") above the detail. Consistent micro-labels.
- **Drilldown modal**: spacing/type polish; the **"Apply to Error Log"** CTA is kept and wired as-is.

### 6.5 Study Plan (`#study-plan`, `StudyPlan.jsx` — drift paydown)

- **Token migration.** Replace inline styles with the sage/gold token system + micro-label idiom so it stops being an "indigo/violet island." This directly satisfies DESIGN.md §6 Don'ts line 266.
- **Mock Results table.** Humanize ISO dates (`2026-08-02`, not `2026-08-02T17:00:00.000Z`). Deltas follow the **Two-Voice Rule**: score **rise = sage green**, score **drop = brass-ink** (attention), **not** brick-red. *(Decision locked 2026-07-19: brass-ink.)*
- **Day-board.** Make it scannable instead of a uniform wall: **today-highlight**, a per-day **progress bar/ring** consistent with the dashboard, **collapse/dim completed days**, an optional **"jump to today"** control, and subject-tag chips on tasks. **Drag-to-reorder and all task CRUD stay intact** (`studyPlanReorder.mjs` logic unchanged).

## 7. Cross-Cutting

- **Nav:** real active-tab state via scroll-spy (highlight the section currently in view). Keeps the existing sticky segmented pill-tab strip.
- **Motion:** load rise/fade + sparkline draw-in, **all guarded by `prefers-reduced-motion`** (closes the gap DESIGN.md notes for the main dashboard's existing `rise`/`pulse` animations — close it, don't widen it).
- **Loading / empty:** shimmer for async blocks; specific empty copy ("No sessions in this window" over "No data") that points at the next action.

## 8. Delivery Plan (phased — review each in the live browser)

Ship surface-by-surface; each phase is reviewed via Playwright screenshot against the running app (localhost:5170) before starting the next. Order chosen for payoff-first and to build the shared components early:

1. **Shared components** (`Sparkline`, `MiniBar`, `ProgressRing`, sort helper) + **Overview top zone** (HeroBand + Today's Plan unification + subject sparklines).
2. **Category Breakdown** (inline bars + sortable headers).
3. **Error Log** (sticky filters) **+ Review modal** (polish).
4. **Pattern Analysis** (ranked insight + drilldown polish).
5. **Study Plan** (token migration + Mock Results + day-board).

Each phase = its own implementation-plan step with a browser-verified checkpoint. A phase that regresses is rolled back before proceeding.

## 9. Testing & Verification

- **Visual:** Playwright screenshot each surface at 1440px (and one mobile pass at ≤480px for the coach/bottom-sheet + top zone) against the running app; compare to the pre-change baselines captured 2026-07-19.
- **Lint:** `npm run lint` must stay at 0 errors (new frontend code adds no errors; warnings baseline ~127).
- **Unit:** any pure helper extracted (e.g. trend-bucketing, sort comparator) gets a `node:test` unit under `test/unit/`.
- **Manual smoke:** filters, sort, drill actions, drag-reorder, task CRUD, modal open/close, keyboard focus + `prefers-reduced-motion` all still work.

## 10. Risks & Mitigations

- **Breaking the answer semantic** → hard guardrail; modal touched for layout/type only, flags logic left alone.
- **Study Plan regression** (large inline-styled file, drag logic) → token migration only; `studyPlanReorder.mjs` untouched; phased last with its own review.
- **App.jsx bloat** → extract presentational components rather than inline.
- **Drift past flat-by-default** while "modernizing" → every new surface reviewed against the Brand Guardrails checklist (§4) before its checkpoint passes.
- **Sparkline with sparse data** → renders an em-dash / nothing under 2 points; never a misleading flat line.

## 11. Files Touched

- `client/src/App.jsx` — overview top zone, Category Breakdown, Error Log, Pattern Analysis, review modal, nav scroll-spy.
- `client/src/TodayPlan.jsx` — fold into unified top zone.
- `client/src/StudyPlan.jsx` — token migration, Mock Results, day-board.
- `client/src/styles.css` — new component styles, sticky filter bar, motion guards, sparkline/mini-bar/ring styles.
- `client/src/components/Sparkline.jsx`, `MiniBar.jsx`, `ProgressRing.jsx`, `HeroBand.jsx` (+ sort helper) — new.
- `test/unit/*.test.js` — for any extracted pure helper.
