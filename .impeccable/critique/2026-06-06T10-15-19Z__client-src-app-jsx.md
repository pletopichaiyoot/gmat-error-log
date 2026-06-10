---
target: client/src/App.jsx — first-run onboarding + empty states
total_score: 34
p0_count: 0
p1_count: 2
timestamp: 2026-06-06T10-15-19Z
slug: client-src-app-jsx
---
# Critique — First-run onboarding + filter-aware empty states (`client/src/App.jsx`)

Scope: the `FirstRunWelcome` panel, its gating (`isFirstRun`), the section/nav suppression on empty DB, and the two filter-aware table empty states (Sessions, Error Log), plus their CSS in `styles.css`.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Welcome→Sync modal is a hard cut; no indication of which of the 3 steps you're on once inside the modal. |
| 2 | Match System / Real World | 4 | Plain language ("whichever you just finished"); only unavoidable term ("port 9222") is framed by its purpose. |
| 3 | User Control and Freedom | 3 | Empty states have a clean escape (Clear filters); first-run offers one path and no "skip / explore" dismissal. |
| 4 | Consistency and Standards | 3 | `.first-run-title` 1.5rem is off the DESIGN.md type scale; the 44px tinted glyph chip has no sibling in the system. |
| 5 | Error Prevention | 3 | The CDP-not-running failure is taught but not prevented; CTA can march into the modal and hit a wall. |
| 6 | Recognition Rather Than Recall | 4 | Steps are visible not memorized; empty-state buttons name the exact next action. |
| 7 | Flexibility and Efficiency | 3 | No keyboard accelerator, but first-run is a one-time linear moment, so cost is low. |
| 8 | Aesthetic and Minimalist Design | 4 | Genuinely restrained: one card, one CTA, one hint. Only the glyph is non-load-bearing. |
| 9 | Error Recovery | 4 | The filtered-vs-no-data empty-state split with verb-correct buttons is textbook; loading/bootError branches degrade gracefully. |
| 10 | Help and Documentation | 3 | The 3 steps are the docs (right), but a first-timer can't verify the "steps live in the Sync panel" promise from here. |
| **Total** | | **34/40** | **Good (strong, ship-worthy with targeted fixes)** |

## Anti-Patterns Verdict

**Does this look AI-generated? No.**

**LLM assessment:** Clears the project's DON'T list. No gamification, no enterprise-BI chrome, no side-stripe borders, no gradient text, no glassmorphism, no hero-metric template, no identical card grids. The numbered 3-step sequence is the one trope to interrogate, and it's legitimate here: opening CDP Chrome → logging in → scraping is a genuine causal order the user cannot reorder or guess, and `<ol>` is the correct element. It is gated to a genuinely empty DB and self-destructs after the first scrape, so it doesn't violate Principle #4 (recognition over scaffolding) for returning users. The single faint tell is the decorative speech-bubble glyph sitting in a tinted `--primary-lt` "meaning" slot.

**Deterministic scan:** `detect.mjs --json client/src/App.jsx` returned `[]` (exit 0) — clean, zero findings. Confirms there are no mechanical slop tells in the markup. The detector cannot see the judgment-level issues below (color-by-intent, focus order, off-scale tokens), which is where the real work is.

**Visual overlays:** Not available. Browser automation was blocked (the Playwright Chrome profile is in use by the user's CDP session, which must not be commandeered). No user-visible overlay was injected; this is the reported fallback. The Vite production build and ESLint both passed, so the surface is known to render and is structurally valid.

## Overall Impression

This is careful, on-brand work. The empty-state engineering (distinguishing "filtered to nothing" from "no data yet") is more mature than most shipping dashboards, and the copy holds the Patient Coach voice without slipping into cheerleading. The biggest opportunity is **hierarchy and continuity at the single moment the panel exists for**: the primary CTA doesn't visually out-rank the decorative step numerals, and clicking it hands the warmest screen in the app straight to its most fragile operation (CDP on 9222) with no bridge.

## What's Working

1. **Filter-aware empty states (App.jsx Sessions + Error Log).** Splitting "filtered to nothing → Clear filters" from "no data yet → Sync a session," with verb-correct buttons and loading/bootError branches above them, means every reachable empty state is tailored and recoverable. This is the DESIGN.md empty-state guidance executed verbatim.
2. **Copy discipline.** Buttons are all verb+object ("Sync your first session," "Clear filters"). No em dashes, no buzzwords. The register ("It takes about a minute," "whichever you just finished") is warm-direct, not a game.
3. **Correct gating = respect for the long-grind user.** `hasEverScraped` keys off `runs.length` (never filtered) and `isFirstRun` suppresses on loading/bootError, so a returning user never flashes the welcome; the `{!isFirstRun}` wrapper removes the four empty sections AND the nav so the empty-DB screen isn't a graveyard of empty cards.

## Priority Issues

**[P1] Primary CTA does not out-rank the step numerals.**
- Why it matters: `.first-run-step-num` and the primary Button are both solid `forest-sage` at similar size, stacked vertically (three green circles above a green pill). On a screen whose entire job is one click, that click must be unmistakably the loudest element; here the eye has to parse rather than be led.
- Fix: demote the numerals to `--primary-lt` fill + `--primary` text (or `oat-recessed` + ink numeral), reserving solid sage exclusively for the CTA.
- Suggested command: /impeccable layout

**[P1] No bridge from welcome → Sync modal → likely CDP failure (peak-end valley).**
- Why it matters: the warmest moment in the app hands off to its most technically fragile operation with no precondition check and no continuity of voice if the scrape can't connect. A first-timer who hasn't launched debug-Chrome hits a cold error in a different surface, killing the encouraging arc.
- Fix: make the CTA execute step 1 (open debug-Chrome) and advance the panel in place as a live checklist, OR carry the Patient-Coach framing + a visible CDP-status indicator into the Sync modal's first-run state.
- Suggested command: /impeccable onboard

**[P2] Load-bearing instruction set in sub-4.5:1 stone-muted, all-caps.**
- Why it matters: `.first-run-hint` ("All three steps live in the Sync panel") uses `--muted` (#7a807c, ~3.7:1 on oat) at 0.72rem uppercase. It is technically the sanctioned micro-label exception, but it carries an actual instruction, not a caption. The one sentence explaining where the steps went may be unreadable in bright light or to low-vision users.
- Fix: promote to `--ink-2` and drop the all-caps so it reads as the sentence it is.
- Suggested command: /impeccable typeset

**[P2] No first-run focus management (screen-reader/keyboard).**
- Why it matters: when `isFirstRun` flips true, nothing moves focus to the welcome card or its heading. A keyboard/SR user has no programmatic cue that the primary content is a single activation panel.
- Fix: move focus to `#first-run-title` (already has an id) or the CTA on mount; pair with the existing reduced-motion hygiene.
- Suggested command: /impeccable harden

**[P2] Off-scale title token + decorative glyph in a meaning slot.**
- Why it matters: `.first-run-title` is a bespoke 1.5rem (DESIGN.md defines headline 1.22rem / display clamp 2.2–3rem); one-off sizes are exactly the drift the system's consistency rules guard against. The generic speech-bubble glyph (reused from the coach FAB) sits in a tinted `--primary-lt` chip, where the Earned-Saturation Rule reserves color for meaning.
- Fix: use the headline token (or step to display deliberately); drop the glyph chip's tint or the glyph entirely.
- Suggested command: /impeccable polish

## Persona Red Flags

**Jordan (confused first-timer):** Highest-risk drop-off is the gap between the CTA and the unverified hint — the button promises a "session" but step 1 mentions "port 9222" and "the scraper," and Jordan can't confirm the Sync panel handles step 1 until after committing. The lede's "where you're strong" describes a state Jordan has no data to see yet.

**Alex (impatient power user):** Only sees this on an empty DB, so the forced 3-step read is a one-time tax. Real annoyance: the panel CTA and the top-bar "Sync Practice" button do the same thing — Alex will wonder if they differ.

**Sam (accessibility-dependent):** Glyph is correctly `aria-hidden`; `<section aria-labelledby="first-run-title">` is well-formed. Two flags: (1) no focus is moved to the panel on first-run; (2) the load-bearing `.first-run-hint` sits below the 4.5:1 contrast floor. Body/secondary text correctly uses `--ink-2` (compliant).

## Minor Observations

- `.first-run-lede` `max-width: 60ch` is inert inside a ~576px content width; the constraint was likely set by reflex.
- Step titles (`<strong>`, weight 600) scan a little flat against their `--ink-2` descriptions; slightly more presence would help them read as headers.
- Two empty-state idioms now coexist (`.metric-empty` italic-centered vs `.table-empty` titled-buttoned) — intentional (metrics vs tables), but don't let a third appear.
- The first-run top bar still shows 4 buttons (incl. a "Sync Practice" twin of the panel CTA); the panel's careful reduction to one choice is diluted to ~5 by surrounding chrome.

## Questions to Consider

1. Should the CTA open the Sync modal at all, or *be* step 1 — advancing the panel in place as a live checklist and eliminating the peak-end cliff?
2. Does the AI-coach promise in the lede belong on a screen with an empty record it can't read yet?
3. Is a 44px tinted glyph chip the right first impression for "good notebook paper under a warm desk lamp," or a habit from generic onboarding templates?
4. The empty-state Sync buttons are `size="sm"`; the first-run CTA is default size. Intentional hierarchy, or drift?
