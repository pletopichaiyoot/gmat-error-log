---
name: GMAT Error Log
description: Warm-paper analytics workspace for a single GMAT test-taker — a coach that has read your whole record.
colors:
  forest-sage: "#3d7a5e"
  sage-deep: "#35705a"
  aged-brass: "#c4a843"
  brass-ink: "#8f7c35"
  warm-limestone: "#f5f4ef"
  oat-surface: "#fdfcf8"
  oat-recessed: "#f2f0ea"
  deep-pine-ink: "#2a302c"
  pine-ink-soft: "#4a524e"
  stone-muted: "#7a807c"
  warm-border: "#dcd8d0"
  warm-border-strong: "#c8c3ba"
  brick-danger: "#b54a44"
  slate-info: "#4a7fa5"
  on-primary: "#ffffff"
typography:
  display:
    fontFamily: "Space Grotesk, Manrope, system-ui, sans-serif"
    fontSize: "clamp(2.2rem, 4vw, 3rem)"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Manrope, Trebuchet MS, sans-serif"
    fontSize: "1.22rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Manrope, Trebuchet MS, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Space Grotesk, Avenir Next, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: "Space Grotesk, Avenir Next, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.07em"
rounded:
  xs: "5px"
  sm: "8px"
  control: "10px"
  md: "12px"
  lg: "14px"
  pill: "9999px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "20px"
  s6: "24px"
  s8: "32px"
  s10: "40px"
components:
  button-primary:
    backgroundColor: "{colors.forest-sage}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.sage-deep}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.forest-sage}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    height: "40px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.deep-pine-ink}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    height: "40px"
  button-destructive:
    backgroundColor: "{colors.brick-danger}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
    height: "40px"
  card:
    backgroundColor: "{colors.oat-surface}"
    textColor: "{colors.deep-pine-ink}"
    rounded: "{rounded.lg}"
    padding: "16px"
  input:
    backgroundColor: "{colors.warm-limestone}"
    textColor: "{colors.deep-pine-ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "40px"
  badge-default:
    backgroundColor: "{colors.forest-sage}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  source-chip:
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  dialog:
    backgroundColor: "{colors.oat-surface}"
    textColor: "{colors.deep-pine-ink}"
    rounded: "{rounded.md}"
---

# Design System: GMAT Error Log

## 1. Overview

**Creative North Star: "The Patient Coach"**

This is the interface of a coach who has read your entire practice record and tells you the truth, kindly. It is warm without being soft, honest without being harsh, and calm under the pressure of a high-stakes exam. The whole system reads like good notebook paper under a warm desk lamp: a muted forest green carries the work you got right and the system's own voice, a brass gold marks the answer you reached for and missed, and everything sits on warm off-white surfaces that never glare. Motivation here is *earned* — a shrinking error count and a climbing accuracy bar are the reward, not confetti.

Density is deliberately two-speed. Reading surfaces (question stems, passages, notes, stat heroes) breathe — 15px body at line-height 1.6, generous 16–24px card padding. Analytics surfaces (the error log, the wide review tables, chip clusters) are compact and information-dense — 8–12px cell padding, 22px pills, 34px filter controls — because the data is the hero and the chrome should disappear. Depth is near-flat: 1px warm borders and three steps of tonal off-white (`warm-limestone` → `oat-surface` → `oat-recessed`) do the structural work, and shadow is dialed down to a whisper, reserved for the few things that literally float (the AI coach dock, the modal).

What this system explicitly rejects: **gamification** (no mascots, no confetti, no XP bars, no streak-slot-machines — this is a serious tool for an adult under real pressure) and **enterprise BI** (no dense chrome, no nested config panels, no toolbar thickets, no charts that bury the insight under ten controls). Two sub-skins live deliberately outside the main system and should stay quarantined: the LSAT practice player (`.lsat-st-shell`, a teal + Open Sans skin that emulates the real StartTest exam UI) and the Study Plan board (an indigo/violet, inline-styled island — a known drift, not a sanctioned second palette).

**Key Characteristics:**
- Warm-paper light theme: forest-sage green primary + aged-brass gold accent on cream off-whites.
- Flat-by-default depth — borders and tonal surface steps, not shadows.
- A relentless uppercase micro-label idiom (0.7rem, tracked, weight 600–700) for every caption, eyebrow, table header, and chip.
- A load-bearing three-color answer semantic: gold = the right answer you missed, red = your wrong pick, green = your right pick.
- All numerics set `tabular-nums` so columns and metrics align.

## 2. Colors

A warm, quiet, paper-like palette: two brand voices (sage green, brass gold) and a restrained semantic trio (brick red, slate blue, plus green-for-success), all on a three-step cream neutral ramp. Saturated color is rationed — most of any screen is off-white, ink, and border.

### Primary
- **Forest Sage** (`#3d7a5e`): The brand voice and the color of *your correct work*. Primary buttons, focus borders on bare inputs, links/open actions, the eyebrow overline, accuracy figures, subject-progress bars, active filter state, the "Strong" status pill, the right-answer-you-picked choice. Hover deepens to **Sage Deep** (`#35705a`). Tints: `--primary-lt` (8%) for hover washes and expanded rows, `--primary-md` (13%) for sortable-header hover.

### Secondary
- **Aged Brass** (`#c4a843`): The attention voice and the color of *the answer you missed*. The gold focus-visible outline, the question-stem card's left edge, the correct-but-unpicked answer choice, selected mistake-tag pills. Because brass-on-cream is too light to read as text, prose and chip labels use **Brass Ink** (`#8f7c35`) instead — the "improving" pill, the medium-difficulty band, gold stat figures.

### Neutral
- **Warm Limestone** (`#f5f4ef`): Page background, and the recessed background of form inputs (so fields read as wells sunk into cards).
- **Oat Surface** (`#fdfcf8`): Cards, panels, the top bar, modal bodies — the lightest cream, one step up from the page.
- **Oat Recessed** (`#f2f0ea`): Table headers, filter bars, stat heroes, subject cards, expanded rows — a step *down* for grouped/secondary surfaces.
- **Deep Pine Ink** (`#2a302c`): Primary text and headings (a near-black with a green cast). **Pine Ink Soft** (`#4a524e`): secondary text, table cells, field labels. **Stone Muted** (`#7a807c`): tertiary text and micro-labels only.
- **Warm Border** (`#dcd8d0`): the default 1px border on everything. **Warm Border Strong** (`#c8c3ba`): input hover, table-header underline, stronger dividers.

### Tertiary (semantic)
- **Brick Danger** (`#b54a44`): Errors, the wrong-answer choice, the "Needs Focus" pill, mistake chips. Tint at 8% for backgrounds.
- **Slate Info** (`#4a7fa5`): Status callouts, the notes marker, info stat figures, and the user's chat bubble (solid slate with off-white text).
- Data tables also use a brighter green/red *result* family distinct from the brand greens — `#166534` on a green tint for CORRECT, `#991b1b` on a red tint for WRONG — to drive per-row tinting.

### Named Rules

**The Two-Voice Rule.** Green and gold are not interchangeable accents. Green speaks for *the user's success and the system's own voice*; gold speaks for *attention — the thing to look at, the answer missed*. Never swap them for visual variety. A green "needs work" state or a gold "you're doing great" state breaks the entire semantic.

**The Earned-Saturation Rule.** Saturated color appears only where it carries meaning — a metric, a status, a correctness flag, a data source. Decorative color washes are forbidden; the warmth comes from the cream surfaces and the type, not from painting panels.

**The Source-Color Rule.** Each data source owns one fixed hue family that lives *outside* the brand tokens, used only on its pill and dot: StartTest/Official Guide = indigo (`#1e3a8a`), GMAT Club = amber (`#92400e`), Target Test Prep = emerald (`#065f46`), OPE mock = purple (`#6b21a8`), LSAT = rose (`#9f1239`). These are a color *key*, not theme accents — never reuse a source hue for unrelated UI.

## 3. Typography

**Display / Heading Font:** Manrope (with Trebuchet MS fallback)
**Body / UI Font:** Space Grotesk (with Avenir Next, Segoe UI fallback)
**Sub-skin Font:** Open Sans — LSAT practice player only

**Character:** Two geometric-humanist sans pulling in opposite directions. Manrope sets titles tight (negative tracking, −0.01 to −0.03em) so headings read compact and confident. Space Grotesk does all the work below — body, labels, table cells, every pill and number — with a slightly mechanical warmth that suits dense data. Only two faces are loaded; richness comes from weight and tracking, not font count.

### Hierarchy
- **Display** (Space Grotesk, 700, `clamp(2.2rem, 4vw, 3rem)`, lh 1, −0.03em): the only true fluid display type — OPE exam numbers and per-section accuracy. A rare scoreboard moment, `tabular-nums`.
- **Headline** (Manrope, 700, 1.22rem ≈ 19.5px, −0.02em): primary section titles (Error Log, Sessions, Pattern Analysis).
- **Title** (Manrope, 600, 1.05rem top-bar / 0.95rem card-head, −0.01 to −0.02em): the app title and card/subsection heads.
- **Body** (Space Grotesk, 400, 15px, lh 1.6): all running UI text. Long-form prose (stems, passages, notes) relaxes to lh 1.55–1.7 with `white-space: pre-wrap`. Cap reading measures at 65–75ch.
- **Label / micro-label** (Space Grotesk, 600–700, 0.68–0.73rem, +0.06–0.08em, UPPERCASE, color `stone-muted` or `forest-sage`): eyebrows, stat captions, table headers, chip text, field meta, chat speaker tags. The single most repeated typographic move in the app.

### Named Rules

**The Micro-Label Rule.** Captions, eyebrows, table headers, and chip text are *always* the same atom: uppercase, ~0.7rem, weight 600–700, letter-spacing ~0.07em. One idiom, reused everywhere, so the eye learns it once. Never set a caption as sentence-case lowercase gray.

**The Two-Family Rule.** Manrope is for titles and only titles (plus the editorial OPE overlines). Everything else is Space Grotesk. Do not introduce a third family; do not set body copy in Manrope or section titles in Space Grotesk. (The one sanctioned exception: the small green `.eyebrow` overline is Space Grotesk even above a Manrope h2.)

**The Tabular-Number Rule.** Every metric, accuracy figure, count, time, and theta uses `font-variant-numeric: tabular-nums`. Numbers in this app are data; they must align in columns and never jitter as they update.

## 4. Elevation

This system is flat by conviction. Depth is built from a 1px `warm-border` plus three tonal steps of off-white (`warm-limestone` → `oat-surface` → `oat-recessed`); shadow is a quiet secondary cue, never the structural one. Both shared shadow tokens are intentionally soft, low-alpha (≤0.07), and tinted with a green-black ink (`rgba(21,34,27,…)`) so even elevation stays on-theme. Genuinely lifted, higher-alpha shadows are reserved exclusively for surfaces that literally float free of the page: the AI coach FAB and dock, dropdown popovers, and the modal. Hover almost never adds elevation — it shifts background tint to `--primary-lt` and tightens the border instead. Focus uses rings, not shadows.

### Shadow Vocabulary
- **Resting** (`box-shadow: 0 1px 2px rgba(0,0,0,0.03), 0 3px 10px rgba(21,34,27,0.04)` — token `--shadow`): cards, top bar, sticky section nav. Barely-there lift.
- **Overlay** (`0 2px 6px rgba(0,0,0,0.05), 0 10px 28px rgba(21,34,27,0.07)` — token `--shadow-2`): the centered modal, above a `rgba(12,16,14,0.48)` scrim. The one "raised" token.
- **Soft (Tailwind)** (`0 1px 2px rgba(0,0,0,0.05), 0 6px 24px rgba(21,34,27,0.08)`): the shadcn primitive Card/Dialog use this; hand-rolled `.card` uses `--shadow`. Keep them visually equivalent.
- **Primary-button micro-lift** (`0 1px 2px rgba(61,122,94,0.15)` → hover `0 1px 4px rgba(61,122,94,0.22)`): the only button carrying elevation; a green-tinted hint that deepens on hover.
- **Floating dock** (`0 8px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)`): the AI coach panel — the most pronounced elevation in the app, justified because it floats over content.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat at rest. If you reach for a shadow to separate two elements, first try a tonal surface step or a 1px border — that is almost always the right answer. A shadow is permitted only when the element genuinely floats above the page (modal, dropdown, FAB, drag preview).

**The Green-Ink Shadow Rule.** Diffuse shadow layers use `rgba(21,34,27,…)`, never pure black. Pure-black shadows on this cream surface read cold and cheap.

## 5. Components

### Buttons
- **Shape:** gently rounded, 10px (`rounded.control`); fixed 40px height (sm 32px, lg 44px).
- **Primary:** solid `forest-sage` fill, white text, `8px 16px` padding, the green micro-lift shadow; hover deepens to `sage-deep`.
- **Secondary / Outline:** transparent fill, `forest-sage` text, 1px green border (50% alpha); hover fills with `--primary-lt`. (In CSS this is `.btn-secondary`; in the cva primitive it is `variant="outline"`.)
- **Ghost:** ink text, no border; reveals a faint green wash on hover. For inline/toolbar actions.
- **Destructive:** solid `brick-danger`, white text; hover darkens. Focus ring stays gold like every other button.
- **Focus:** a 2px gold ring (`box-shadow: 0 0 0 2px rgba(196,168,67,0.7)` on the primitives). **Disabled:** opacity 0.5 on shadcn primitives, 0.4 on hand-rolled buttons (a known split — prefer 0.5 for new work).

### Chips & Pills
- **Shape:** full pill (`9999px`), uppercase micro-label text.
- **Status pill:** `STRONG` (green), `IMPROVING` (brass-ink gold), `NEEDS-FOCUS` (red) — each a 10% tinted fill with a 25% border. The performance-classification vocabulary.
- **Result pill:** `CORRECT` / `WRONG` — brighter green/red family; drives row tinting in the review table.
- **Difficulty chip:** hard (red) / medium (gold) / easy (green), tinted; may carry an inner `theta` sub-span (0.62rem tabular IRT estimate).
- **Source chip:** the cross-table identity marker — see The Source-Color Rule. Hand-written, one fixed color family per source, uppercase 0.7rem, `2px 9px`. A lighter 8px **source dot** with a 2px colored halo ring appears in the error-log date cell.
- **Badge primitive** (cva): default/secondary/outline/success/info/warning — soft tinted fills of the theme tokens for quiet in-table status.

### Cards / Containers
- **Corner:** 14px for the shadcn Card primitive (`rounded.lg`), 12px for the hand-rolled `.card` (`--r`).
- **Background:** `oat-surface` on the `warm-limestone` page; grouped/secondary surfaces drop to `oat-recessed`.
- **Border:** 1px `warm-border` always. **Shadow:** Resting (`--shadow`) only — see Elevation.
- **Padding:** 16px hand-rolled, 24px shadcn Card. Flat `.page-section` variants use a top-border divider and no box at all. **Never nest a card inside a card.**

### Inputs / Fields
- **Shape:** 10px radius, 40px height, `8px 12px` padding. Sit on the page background (`warm-limestone`), so they read as wells recessed into cards.
- **Focus (the triple mechanism, by design):** a bare `<input>` gets a green `:focus` ring (`0 0 0 3px rgba(47,109,79,0.14)` + `forest-sage` border); the global `:focus-visible` adds a 2px gold outline; the shadcn primitives use a 2px gold `ring-accent/70`. Keep gold as the keyboard-focus signature.
- **Filter selects:** a compact 34px variant with right-padded chevron room, distinct from the 42px default controls.

### Navigation
- **Section nav:** a sticky (`top:0`, z-index 100) segmented pill-tab strip on an `oat-surface` track; links idle `stone-muted` → hover `deep-pine-ink` on `oat-recessed` → active `forest-sage` on `--primary-lt`. Equal-width tabs, smooth in-page anchor scroll with 56px scroll-padding.

### Signature Components
- **Answer-choice card (the centerpiece):** three semantic variants set by a **3px left-border + matching 5–6% tint** — gold (`aged-brass`) = the correct answer the user did *not* pick; red (`brick-danger`) = the user's wrong pick; green (`forest-sage`) = the user's right pick. The same gold/red/green legend repeats across the matrix grid (DI), the dropdown blanks, and the legend dots. The coloring logic checks two flags independently (`anyMine`, `anyCorrectFlagged`) and each falls back separately to row-level `my_answer`/`correct_answer`, so sources with partial flag data still color correctly. **This left-border-as-semantic-code is the one sanctioned exception to the no-side-stripe ban; never extend it to decorative use.**
- **Floating AI coach:** a 60px circular `forest-sage` FAB with a green glow that opens a 420×600 chat dock (scale+fade in). Solid-green header, Review/Chat tabs, quick-prompt chips, a pill composer with a circular send button; assistant bubbles are white, the user's are solid slate-blue. Goes full-width bottom-sheet under 480px.

### Status & Empty States
- **Status callout:** a full-width message bar with a 3px `slate-info` left edge, an `info` tint fill, and right-only rounded corners (`0 5px 5px 0`) — for non-blocking system messages (scrape finished, count saved). The `.error` variant flips the edge, fill, and text to `brick-danger`. This is the *second* sanctioned thick-left-border, alongside the answer semantic.
- **Empty states:** centered, italic, `stone-muted` "no data" rows inside tables and panels (metrics, mistake tags, sessions, answer blanks). Keep them quiet and specific — "No sessions in this window" beats "No data" — and use the space to point at the next action, not to apologize.
- **Skeleton / shimmer loaders:** async surfaces use a `shimmer` sweep (`translateX(-100% → 100%)`, ~1.4s) over `oat-recessed` blocks, and a `pulse` opacity fade (1 ↔ 0.4) for inline "thinking" states. Pair any new loader with a `prefers-reduced-motion` crossfade — the existing ones are only partially guarded.

## 6. Do's and Don'ts

### Do:
- **Do** keep saturated color rationed — green for the user's success and the system's voice, gold for attention/the missed answer, per The Two-Voice Rule.
- **Do** build depth from 1px `warm-border` + the three tonal off-white steps first; add a shadow only for things that float (modal, dropdown, FAB).
- **Do** set every caption, eyebrow, table header, and chip as the uppercase ~0.7rem tracked micro-label, and every number as `tabular-nums`.
- **Do** keep Manrope for titles and Space Grotesk for everything else — two families, no more.
- **Do** preserve the gold/red/green answer semantic exactly (gold = correct-missed, red = wrong-pick, green = right-pick) wherever correctness is shown.
- **Do** use `pine-ink-soft` (`#4a524e`) for any text a reader must actually read; reserve `stone-muted` for bold uppercase micro-labels.
- **Do** honor `prefers-reduced-motion` for new motion — the main dashboard's `rise`/`pulse`/coach animations are currently *not* covered by a global guard; close that gap rather than widen it.

### Don't:
- **Don't gamify.** No mascots, no confetti-on-streak, no XP bars, no toy-bright cartoon energy. Progress is shown as honest data (a falling error count, a rising bar), never a slot-machine reward. (PRODUCT.md anti-reference.)
- **Don't drift toward enterprise BI.** No dense chrome, no nested config panels, no toolbar thickets, no charts that bury the one insight under ten controls. The data is the hero; the chrome disappears. (PRODUCT.md anti-reference.)
- **Don't** set body or placeholder text in `stone-muted` (`#7a807c`) on the cream surfaces — it lands near 3.7:1, under the 4.5:1 floor. Bump to `pine-ink-soft` for anything readers read.
- **Don't** add `border-left` (or `border-right`) greater than 1px as a *decorative* colored stripe on cards, lists, or callouts. The only legal thick left-border is the established answer/status semantic (gold/red/green/info); everything else uses a full border or a background tint.
- **Don't** use gradient text (`background-clip: text`), decorative glassmorphism, the big-number hero-metric template, or identical icon+heading+text card grids.
- **Don't** spread the Study Plan's indigo/violet, inline-styled palette into the main dashboard — it is a known inconsistency; bring new study-plan work back toward the sage/gold token system.
- **Don't** reuse a data-source hue (indigo/amber/emerald/purple/rose) for unrelated UI — those colors are a source key, not theme accents.
