---
target: client/src/App.jsx
total_score: 27
p0_count: 0
p1_count: 1
timestamp: 2026-06-06T09-13-43Z
slug: client-src-app-jsx
---
# Critique — client/src/App.jsx (GMAT dashboard)

Method: 3 independent reviewer lenses (brand-fit, usability+cognitive-load, accessibility+states+personas) over the full source, DESIGN.md/PRODUCT.md, a live structural a11y snapshot, console errors, and three renders (desktop, coach panel, mobile), followed by adversarial verification of every consequential finding. Note: the local API (4310) was down this session, so the dashboard rendered in its 500/empty state; populated-state design was assessed from source + DESIGN.md.

## Design Health Score — consensus 27 / 40 (Acceptable, top edge)

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 2 | No loading skeleton on boot; outage shown only as a clipped 0.78rem "Request failed (500)"; empty tables can't be told apart from loading/outage. |
| 2 | Match system / real world | 3 | Strong domain language; but raw "(500)" is dev jargon and the coach is named 3 ways. |
| 3 | User control & freedom | 3 | Escape + scroll-lock + sortable/collapsible everywhere; no Retry on failure, no "Clear filters", no confirm on delete. |
| 4 | Consistency & standards | 3 | Excellent token discipline; documented drift (Study Plan indigo island, Tutor/Coach, 0.4 vs 0.5 disabled opacity). |
| 5 | Error prevention | 3 | Good disabled-state guards; no start≤end date validation; destructive/long-running actions unguarded. |
| 6 | Recognition vs recall | 3 | Sticky nav, persistent filters, inline answer legend; the "Hard (Q/Acc/Avg)" header encoding leans on recall. |
| 7 | Flexibility & efficiency | 3 | Sort, debounced search, collapsible sections; no shortcuts beyond Escape, no saved filter presets. |
| 8 | Aesthetic & minimalist | 4 | The standout. Flat warm-paper calm, rationed color, chrome recedes; dodges both anti-references. |
| 9 | Error recovery | 1 | Weakest. Raw "Request failed (500)", no diagnosis, no retry, no aria-live — the rich error.hint/details are captured then discarded. |
| 10 | Help & documentation | 2 | Good inline microcopy (tag descriptions, empty-state nudges); no first-run guidance, no key for dense columns. |
| **Total** | | **27/40** | **Acceptable** (reviewer range 26–28) |

## Anti-Patterns Verdict — this does NOT read as AI-generated (unanimous)

**LLM assessment (3/3 reviewers):** A genuine, opinionated system. The warm-paper sage/brass palette, the two-voice green/gold semantic, the relentless uppercase micro-label idiom, flat-by-default green-ink shadows, and the faithfully-implemented gold/red/green answer-choice code add up to a real point of view. Every named anti-reference (gradient metric tiles, glassmorphism, identical icon+heading+text grids, the hero-number template, gamification, enterprise-BI chrome) is actively avoided. The only generic-assistant whiff is the coach greeting/quick-prompt copy and the raw "(500)" string — under-design, not slop.

**Deterministic scan:** `detect.mjs --json client/src/App.jsx` → **0 findings** (static JSX scan; limited — it can't see rendered DOM or Tailwind classes). Console at load: every `/api/*` request 500 (proxy → dead 4310 API) plus a `favicon.ico` 404.

**Visual overlay:** not injected this session — the data backend was down, so review was grounded in the structural a11y snapshot + source + three renders rather than a live detector overlay.

## Overall Impression

The design *system* nails "The Patient Coach"; the *resilience and entry states* don't. When populated, this is genuinely on-brand — calm, warm, data-first, honest. But brand personality is judged hardest at moments of friction, and there the app goes quiet and clinical: a total backend outage is communicated as a tiny clipped developer status code with no diagnosis and no retry, and the AI coach (the loudest possible brand surface) speaks in stock-assistant copy under three different names. The single biggest opportunity is cheap: bring the failure / first-paint / empty surfaces up to the same bar as the populated ones, and the personality stops being load-bearing on data being present.

## What's Working

1. **The color-coded answer-choice review is the best brand moment.** A 3px left-border + tint encodes gold = the correct answer you missed, red = your wrong pick, green = your right pick, with an inline legend and an independent two-flag fallback (`anyMine`/`anyCorrectFlagged`) so partial-flag sources still color correctly. Carried consistently into the DI matrix grid and dropdown blanks. This is exactly "a wrong answer understood."
2. **Disciplined, committed design system** (aesthetic heuristic scored 4 by 2 of 3 reviewers): rationed saturation on a three-step cream ramp, shadow reserved for things that float, the micro-label idiom applied everywhere, a per-source color key kept outside the brand tokens. The chrome genuinely recedes; no BI thicket, no gamification.
3. **Humane empty-state copy + solid interaction hygiene:** "No sessions yet. Use Sync GMAT Practice above…" points at the next action; Escape closes every modal, body scroll locks, the coach panel goes `inert` when closed, search is debounced, heavy routes lazy-load. And DESIGN.md self-flags its own contrast + motion gaps — rare governance that makes the fixes cheap.

## Priority Issues

### [P1] The failure & first-paint states betray "calm under pressure"
- **What:** On boot-fetch failure the UI shows a clipped 0.78rem muted-red "Request failed (500)" beside the title (the only catch of ~8 that bypasses `formatRequestError`, so the `error.hint`/`details` that `fetchJson` captured are discarded), with no diagnosis, no Retry, and no `aria-live`. There's no loading skeleton, so "loading", "no data yet", and "server down" look identical — the four panels all render their "sync your first session" empties even during an outage.
- **Why it matters:** PRODUCT.md names "calm under pressure" as one of three brand words. This is the lowest-scoring heuristic (error recovery 1/40) and the clearest gap between the committed brand and the code — and it's where a tired user lands when they're most raw.
- **Fix:** Route `boot()`'s catch through the existing `formatRequestError`; render the design system's already-implemented status callout (`.status.error`, styles.css L330-344 — full-width, 3px brick-danger left edge, tint) with a plain-language cause and a **Retry** button that re-runs `loadDashboard`/`loadSources`; add `role="status"`/`aria-live`; introduce an `isDashboardLoading` flag that shows main-token shimmer skeletons and gates the empty-state copy on `!loading && !error`. (Verifiers calibrated this to P2 for a single technical owner, but the fix is cheap and high-leverage — elevated here.)
- **Suggested command:** `/impeccable harden`

### [P2] Muted `#7a807c` text on cream fails AA (~3.7:1) for real content
- **What:** Verified contrast 3.66–3.93:1 — below the 4.5:1 floor. Used not just for micro-labels but for readable content: the primary section-nav idle links, empty-state guidance, and the catch-all `.muted` utility class.
- **Why it matters:** DESIGN.md *itself* forbids this exact use. It's the project's own stated WCAG AA target being missed on navigation + guidance text.
- **Fix:** Point `.muted` (styles.css L221) and the specific body rules (`.metric-empty`, `.ai-message.typing p`, `.section-nav-link` idle) at `--ink-2` (#4a524e, 7.3:1). **Keep** genuine bold-uppercase micro-labels on `--muted`. (Verification corrections: the coach-scope subtitle is white-on-green — not in scope; the "placeholders use --muted" claim is unverified — no `::placeholder` rule exists.)
- **Suggested command:** `/impeccable colorize`

### [P2] The coach has three names and a stock-assistant voice
- **What:** The same feature is "Tutor" (FAB aria-label, panel badge, dialog), "Coach" (greeting + speaker tag), framed under "GMAT Analytics"; the greeting + four canned quick-prompt chips read like a template, and "All runs" is internal scope jargon.
- **Why it matters:** The AI surface is where the brand should be loudest; instead it's the most generic. PRODUCT.md/DESIGN.md both resolve the name to "Coach."
- **Fix:** Standardize on **Coach** (FAB aria-label, dialog aria-label, badge); rewrite the greeting + chips in the earned-encouragement voice; humanize "All runs" → e.g. "Across all your practice." Leave the app title and the (on-spec) uppercase speaker-tag styling alone.
- **Suggested command:** `/impeccable clarify`

### [P2] The 11-column Sessions table trends toward the enterprise-BI density the brand rejects
- **What:** Each row carries ~17 data points — Hard/Medium/Easy each triple-encode "Q / Acc / Avg" into one header, and "Show Difficulty" expands to 12 columns. The parenthetical key lives only in the header (recall burden).
- **Why it matters:** PRODUCT.md names "charts that bury the one insight under ten controls" as an anti-reference; this is the surface closest to that line.
- **Fix:** Extend the "Show Difficulty" toggle pattern to the Sessions table (default the three difficulty triplets off), or collapse each band to a single primary number with Q/Acc/Avg in a tooltip; add an info-icon key so the encoding isn't pure recall.
- **Suggested command:** `/impeccable distill`

### [P2] The resting / empty state reads flat and clinical
- **What:** With no data, the page collapses to a vertical stack of equal-weight bold section headers + one italic gray sentence each — no eyebrow overlines (the design system's signature green micro-label, defined but unused here), no scale contrast, no warmth.
- **Why it matters:** "Data is the hero" means that with no data, the least on-brand surface is the first thing a new or returning-after-reset user sees — the opposite of "warm notebook paper under a desk lamp."
- **Fix:** Add the defined `.eyebrow` overlines to the section heads and a single warm "Sync your first practice session to begin" focal panel above the fold, instead of four equally-weighted empty tables.
- **Suggested command:** `/impeccable onboard`

## Also worth fixing (verified, P2–P3)

- **[P2] No "Clear filters" control** though the empty-state copy tells users to "clear the filters" — reset is one select at a time. → `/impeccable clarify`
- **[P2] Destructive / long-running actions fire without confirmation:** coach "Delete session" is immediate (no undo); Phase-2 enrich (3–5 min, ban-risky) starts from one button with only a post-hoc prose warning. → `/impeccable harden`
- **[P2] Mobile 390px breakage** (lower priority — desktop-first): "Score Calculator" clips off the top bar, the session-filter selects collapse to unreadable chevron stubs, table/empty text clips mid-word. → `/impeccable adapt`
- **[P3] Dialogs lack a focus trap, initial focus, and focus restoration** (all 6 overlays); the coach panel is `aria-modal` but isn't in the Escape handler. (Note: Prev/Next *is* keyboard-operable via the arrow-key handler; Escape + scroll-lock are already present, so this is polish, not a block.) → `/impeccable harden`
- **[P3] Main-dashboard motion isn't globally `prefers-reduced-motion`-guarded** (only LSAT/OPE are); date inputs are placeholder-only (no label) with no start≤end validation. → `/impeccable animate`

## Persona Red Flags

**Tired test-taker arriving raw (the primary PRODUCT.md user):** lands on a cold "Request failed (500)" with no reassurance or path forward — the opposite of an encouraging coach at the moment they're most discouraged; the coach greeting feels like a generic chatbot, not someone who's read their record.

**Daily-returning user over weeks (the long-grind persona):** no saved filter presets or shortcuts, so the same multi-select filter dance repeats every visit; the Tutor/Coach/"All runs" naming erodes the sense of a single familiar companion; Phase-2 enrich reports progress as a one-line string, not a determinate indicator.

**Sam (keyboard / screen-reader; WCAG 2.2 AA is a stated target):** status/error changes aren't announced (no `aria-live`); modals never move focus in or restore it out; muted nav/empty-state text and unlabelled date inputs miss AA; main-dashboard motion ignores reduced-motion.

## Minor Observations
- Header radius (`.top-bar` 8px) differs from cards (12–14px).
- "Score Calculator" is an external link styled identically to internal nav.
- "Show Difficulty" is a button with no on/off affordance.
- Truncated note-preview cells have no `title` so hover gives no full text.
- Disabled-opacity split (0.4 hand-rolled vs 0.5 shadcn) is documented; prefer 0.5.

## Questions to Consider
- Is the API-down (500) state an expected, recoverable condition for you (you start `:4310` yourself), or purely a dev artifact? It's the difference between a first-class error-state redesign and a one-line `formatRequestError` fix.
- Is "Coach" the canonical name? (Both docs say so; the UI leads with "Tutor.")
- Should the resting/first-run state get a dedicated welcome, or do you always arrive with data already synced?
