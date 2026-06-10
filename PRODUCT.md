# Product

## Register

product

## Users

A single person preparing for the GMAT — the app's owner. They arrive after a practice session (GMAT Official Practice, GMAT Club, or Target Test Prep), often tired and a little raw from the questions they just got wrong, and they want to know two things fast: *how did I do* and *where is my time best spent next*. They use it repeatedly over weeks of prep, on a Mac, alone. Their job-to-be-done is converting a pile of scraped attempts into a clear next move: which subject is slipping, which wrong question deserves a second look, what the AI coach makes of the trend. They are technical enough to run a scraper but, in this moment, they are a test-taker, not a developer.

## Product Purpose

A local analytics workspace that turns scraped GMAT practice history into legible performance signal. It scrapes sessions over Chrome CDP, stores attempts in SQLite, and surfaces session-level tracking, an annotatable error log, topic/pattern analysis, a wrong-question review modal, and a LangGraph AI coach that reviews and answers questions grounded in the user's own data. Success is a session that ends with the user knowing exactly what to drill next — and feeling like the grind is paying off, because the trend line says so.

## Brand Personality

Encouraging, grounded, focused. A coach who has read your whole record and tells you the truth kindly. Motivation here is *earned*, not sprinkled on: it comes from progress made legible — trends that climb, weak spots that shrink, a wrong answer understood. The voice is warm and direct, never a cheerleader and never a clipboard. Three words: **encouraging, honest, calm-under-pressure**. The emotional goal is momentum — the user should leave a review feeling capable and clear about the next rep, not scolded by red error counts or numbed by a wall of charts.

## Anti-references

- **Gamified / playful prep apps (Duolingo-style).** No mascots, no confetti-on-streak, no toy-bright cartoon energy, no XP-bar dopamine loops. This is a high-stakes adult exam; the encouragement has to read as a serious coach, not a game. Streaks and progress are shown as honest data, not slot-machine rewards.
- **Heavy enterprise BI (Tableau / Power BI).** No dense chrome, nested config panels, toolbar thickets, or charts that bury the one insight under ten controls. The data is the hero; the interface should get out of its way. No "build your own dashboard" complexity for an audience of one.
- General cross-project tells still apply: gradient-accent SaaS metric tiles, identical icon+heading+text card grids, decorative glassmorphism.

## Design Principles

1. **Honest encouragement.** Show progress *and* weak spots truthfully; motivation comes from clarity, not cheerleading. A shrinking error count is the reward — never a confetti burst. Frame weakness as the next rep, not a failure.
2. **The data is the hero; the chrome disappears.** Lead with the insight, not the controls. Every panel should answer a question the user actually has ("where am I weakest", "what did I get wrong") before it offers a knob to turn.
3. **Grown-up warmth, never gamified.** Warmth lives in tone, pacing, and the sage/gold palette — not in mascots, badges, or toy interactions. Treat the user as a capable adult under real pressure.
4. **Built for the long grind.** This is used daily over weeks. Favor recognition over onboarding scaffolding, make trends legible at a glance, and reward *returning and improving* over any single moment.
5. **Single-user intimacy.** One person, their own data, used fast and often. Optimize for speed and familiarity, not for explaining the product to a stranger.

## Accessibility & Inclusion

Target WCAG 2.2 AA for the essentials: body text ≥4.5:1 contrast (watch the muted-gray-on-cream trap in the current palette), visible focus states, and full keyboard operability for the dialogs, selects, and the drag-to-reorder study plan. No specialized accommodations required beyond that — single known user, standard readability. Honor `prefers-reduced-motion` as good hygiene for any new motion even though it wasn't requested.
