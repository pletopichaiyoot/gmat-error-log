---
target: client/src/App.jsx — first-run live checklist + empty states (re-run)
total_score: 38
p0_count: 0
p1_count: 0
timestamp: 2026-06-06T13-45-36Z
slug: client-src-app-jsx
---
# Critique (re-run) — First-run live checklist + filter-aware empty states (`client/src/App.jsx`)

Re-score after rebuilding the welcome into a live checklist (CDP-status backend, polled step dots, inline scrape) and applying the layout/typeset/harden/clarify/polish fixes. **This round is a self-assessment, not an independent sub-agent review, so the score is directional vs the prior independent 34.**

## Design Health Score

| # | Heuristic | Was | Now | Note |
|---|-----------|-----|-----|------|
| 1 | Visibility of System Status | 3 | 4 | Live CDP dots, per-step states, inline status line with role=alert/status. |
| 2 | Match System / Real World | 4 | 4 | Plain language; "port 9222" framed by purpose. |
| 3 | User Control and Freedom | 3 | 4 | Source picker, "Reopen Chrome", "Use the full Sync panel" escape, empty-state Clear filters. |
| 4 | Consistency and Standards | 3 | 3 | Title now on-token, numerals system-tinted; minor: panel status uses a full-border treatment vs global `.status` left-stripe, source select is 36px not 34/40. |
| 5 | Error Prevention | 3 | 4 | Scrape/Open-in-GMAT gated on `cdpUp`, so the CDP-not-running wall is prevented; OPE routed to full panel. |
| 6 | Recognition Rather Than Recall | 4 | 4 | Interactive steps; nothing memorized. |
| 7 | Flexibility and Efficiency | 3 | 3 | Still no keyboard accelerator; one-time moment, low cost. |
| 8 | Aesthetic and Minimalist Design | 4 | 4 | Denser than the old card (selects/dots/buttons) but purposeful, not clutter. |
| 9 | Error Recovery | 4 | 4 | Empty states + inline alert; gated actions. |
| 10 | Help and Documentation | 3 | 4 | Steps are interactive docs; live dots confirm state. |
| **Total** | | **34** | **38/40** | **Strong** |

## Anti-Patterns Verdict
`detect.mjs --json client/src/App.jsx` → `[]` (exit 0), clean. No mechanical slop tells. Numbered steps remain a legitimate ordered flow; the rebuild made them interactive, reinforcing that. No new bans introduced (no side-stripes, gradient text, glass, hero-metric).

## Prior issues — resolution
- **[P1] CTA vs numeral hierarchy** — RESOLVED. Numerals quiet by state (neutral/tinted/solid-only-when-done); solid sage reserved for action buttons.
- **[P1] Welcome→modal peak-end valley** — RESOLVED. Scrape runs inline in the panel; status surfaces in-panel; no cold hand-off. Actions gated on live CDP status.
- **[P2] Load-bearing hint in sub-4.5:1 stone-muted** — RESOLVED. Removed; replaced by an `--ink-2` inline status line.
- **[P2] No first-run focus management** — RESOLVED. Heading `tabIndex=-1` + focus on mount + gold `:focus-visible`.
- **[P2] Off-scale 1.5rem title** — RESOLVED. Now the 1.22rem headline token.
- **[P2] Decorative glyph in a meaning slot** — RESOLVED. Removed.
- **Copy (clarify)** — RESOLVED. Lede no longer promises "where you're strong"/coach on an empty record; buttons verb+object.

## Remaining / new (minor)
- **[P3] Status duplication.** The shared `status` shows in both the top bar and the panel during first-run. Suppress the top-bar status while `isFirstRun`.
- **[P3] Practice-tab detection is best-effort.** starttest practice is on starttest.com but login is gmac.com, so step-2's "Practice tab open" dot won't light during login. No false positives; just an incomplete confirm.
- **[P3] Source select height 36px** is off the 34/40 control rhythm.
- **[P3] Two solid-sage buttons** (Open Chrome active + Run scrape) can co-exist; Run scrape is disabled-muted until `cdpUp`, so acceptable, but only one should read as the live action at a time.

## Questions
1. Should the top-bar status be suppressed during first-run to avoid the double message?
2. Is best-effort tab detection worth keeping, or should step 2 just be a manual "I'm logged in" confirm?
