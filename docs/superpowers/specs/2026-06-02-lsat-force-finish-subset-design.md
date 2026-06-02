# LSAT — Force-finish a practice set as a replayable subset

**Date:** 2026-06-02
**Status:** Design approved (pending written-spec review)
**Area:** LSAT practice (`client/src/LsatPractice.jsx`, `src/server.js`, `src/db.js`)

## Problem

A LSAT practice session always spans a whole section (e.g. 28 questions). The user
sometimes wants to practice or review just a few questions, finish early, and have
the session recorded as *only the questions they answered* — and be able to redo
exactly that subset later. Today there is no early-finish path (`onComplete()` only
fires on the last question), and a partial run is recorded against the full section
range, so it reads "3/28 answered" rather than as a standalone 3-question set.

## Core model

A session's answered questions **are** its attempts (one attempt per question per
session, enforced by the `uq_lsat_attempts_session_q` unique index). There is no real
difference between "force finish" and the existing "natural finish" on the last
question — both end a session whose answered set is its attempts.

So: **when a session completes (by either path), the server freezes the answered
question numbers onto the session.** Replay semantics then split by entry point:

- **Library** ("Start" / "Continue" / "Retake") → always the full section. Unchanged.
- **Session history** ("Retake") → replays just that session's frozen questions.

This keeps full-section practice intact while making history the place to redo a
specific past session's exact questions.

## Decisions (from brainstorming)

- Scope: a force-finished session is a **replayable subset**, not just a stats tweak.
- Finish trigger: a **persistent top-bar "Finish" button** in the question view.
- Unsubmitted current pick at finish: **discarded** (only submitted attempts count).
- Storage: **freeze on complete** via a new `question_numbers` column (recommended
  over deriving-from-attempts and over a full custom-set builder).
- Partial-session badge in history: **no badge** (the question count implies it).
- Retake from history: **show the mode-confirm screen** ("N questions" + mode), then start.

## Data model

`lsat_sessions` gains a nullable column:

```sql
ALTER TABLE lsat_sessions ADD COLUMN question_numbers TEXT;  -- JSON array of ints, e.g. "[3,12,20]"
```

Added with the existing try/catch `ALTER TABLE … ADD COLUMN` migration pattern
(see `src/db.js` ~line 369).

- `null` → full section. Applies to legacy rows and freshly-started Library sessions
  (until they complete).
- On completion → set to the sorted, de-duplicated answered question numbers.

No separate `answered_count` column — derive count from the array length (or attempts).

## Backend changes (`src/db.js`, `src/server.js`)

1. **`completeLsatSession(id)`** — stamp `completed_at` **and** freeze the subset.
   Compute in JS (no SQLite json1 dependency):
   - `SELECT DISTINCT question_number FROM lsat_attempts WHERE session_id = ? ORDER BY question_number`
   - `UPDATE lsat_sessions SET completed_at = datetime('now'), question_numbers = ? WHERE id = ?`
     with `JSON.stringify(numbers)`.
   - Return `{ ok: true, answeredCount: numbers.length }`.
   - This **overwrites** any creation-time `question_numbers` with the actually-answered
     set. So replaying a 3-question subset but answering only 2 before finishing freezes
     the new session at those 2 — consistent with "the session is what you answered."
     A creation-time list is therefore only the *intended* scope of an in-progress
     subset; completion always reduces it to answered.

2. **`createLsatSession({ …, questionNumbers })`** — accept an optional
   `questionNumbers` array. When present, store `question_numbers = JSON.stringify(sorted)`
   at creation and set `first_question`/`last_question` = min/max (kept for range
   display / back-compat). Used by the history-retake flow.

3. **`listLsatSessions` / `getLsatSession`** — parse `question_numbers` from JSON back
   to an array (or `null`) in the returned rows.

4. **`POST /api/lsat/sessions`** — pass through `questionNumbers` to `createLsatSession`.

5. **`POST /api/lsat/sessions/:id/complete`** — unchanged request contract (server
   derives the subset from attempts); response includes `answeredCount`.

## Frontend changes (`client/src/LsatPractice.jsx`)

### SessionView (question UI)

- Add a persistent **Finish** button in the top bar (`.lsat-st-topbar`).
- Clicking opens a confirm dialog (new `FinishConfirm` component / reused modal):
  - Copy: "Finish session? You've answered **N** of **M** questions. Only the N
    answered questions are saved to this session."
  - Any selected-but-unsubmitted pick on the current question is **discarded**
    (no auto-submit).
  - If **N = 0**, the confirm button is disabled with a hint
    ("Answer at least one question to finish.").
  - Confirm → calls existing `onComplete()` → `handleSessionComplete()` →
    POST complete → Summary view.
- SessionView stays **subset-agnostic**: it renders whatever `set.questions` it is
  given. The section countdown (`sectionBudgetMs(setQuestions.length)`), the score
  `done/total`, and the navigator grid all already key off `set.questions`, so they
  scale to the subset automatically.
- The existing last-question "Finish" Next button stays and uses the same
  `onComplete()` path.

### Summary

- `SummaryWrapper` already re-fetches attempts, so the summary already shows only
  answered questions and correct/total over them.
- Add a **"Retake these N"** action that replays the just-finished subset (same flow
  as history retake, below).

### Session history

- Denominator: `total = question_numbers ? question_numbers.length : (last_question - first_question + 1)`.
  A frozen partial then reads e.g. **"3 questions · 2/3 correct"** instead of "3/28".
- **No** partial badge.
- **Retake** handler change: load the section, filter its questions to the session's
  frozen `question_numbers` (preserving order and each question's `passageIdx`), then
  route to the **ConfirmationScreen** showing "N questions" + mode selection. On start,
  create a new session with `questionNumbers` and enter SessionView with the subset.
- Legacy rows (`question_numbers === null`) → fall back to current full-section retake.

### ConfirmationScreen

- Accept an optional subset (array of question numbers / count). When present, show
  "N questions" in the summary instead of the full section count, and pass
  `questionNumbers` through to session creation.

## Scope

- Built against **exam mode** (practice mode is still "COMING SOON"). The subset logic
  is mode-agnostic, so practice mode inherits it when it ships.

## Edge cases

- **Zero answered at finish** → cannot finish (confirm disabled + hint).
- **Unsubmitted pick at finish** → discarded.
- **RC subset spanning multiple passages** → each question carries `passageIdx`, so the
  correct passage shows per question; passages with no included question simply don't appear.
- **Legacy sessions** (`question_numbers` null) → full-section fallback everywhere.
- **Timer budget** scales to subset size automatically.

## Files touched

- `src/db.js` — migration; `completeLsatSession` (freeze); `createLsatSession`
  (accept `questionNumbers`); `listLsatSessions` / `getLsatSession` (parse JSON).
- `src/server.js` — `POST /api/lsat/sessions` accepts `questionNumbers`; complete
  endpoint returns `answeredCount`.
- `client/src/LsatPractice.jsx` — top-bar Finish button + confirm dialog; history
  denominator + subset-retake handler; ConfirmationScreen subset support; Summary
  "Retake these N".
- `client/src/styles.css` — Finish button + confirm dialog styling.

## Out of scope

- Full custom-set builder (hand-pick arbitrary questions, e.g. from the error log).
- Practice-mode-specific behavior (mode not yet shipped).
- Editing a frozen subset after the fact.
