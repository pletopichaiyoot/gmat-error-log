# LSAT practice in the main dashboard — design

**Date:** 2026-06-02
**Status:** Approved (lean / inline execution)
**Area:** `src/db.js`, `src/server.js`, `client/src/App.jsx`, `client/src/styles.css`

## Goal

Surface LSAT practice (stored in `lsat_sessions` / `lsat_attempts`, with stems/choices in
`data/lsat-questions.json`) inside the **main** GMAT dashboard as a new **"LSAT"** source:

1. LSAT sessions appear in the **Performance by Session** table.
2. LSAT incorrect answers appear in the **Error Log**.
3. Every LSAT question (correct **and** incorrect) opens the **same review modal**, reached via
   the **Session Analysis** modal (lists all questions in a session) and from Error Log rows.

## Decisions

- **Approach A:** integrate into the main dashboard (not a separate LSAT-app modal).
- **Subject mapping:** LSAT section `RC` → subject `"RC"`; LSAT section `LR` → subject `"CR"`
  (GMAT's Critical Reasoning analog). Add `RC` and `CR` to the Subject filter dropdowns.
- **Source:** badge/label `"LSAT"`, platform key `"lsat"`.
- **Difficulty:** LSAT has no difficulty bands → Hard/Med/Easy cells render `—`.
- No AI-coach changes.

## Architecture — JS merge in the server routes (db.js stays pure SQL)

The main list endpoints read `sessions`/`question_attempts` via `listSessions`/`listErrors` in
`db.js`. LSAT data + question text live elsewhere. Rather than a cross-schema SQL UNION, the
**server route handlers** (where `loadLsatData()` already exists) map LSAT rows into the dashboard's
existing row shapes and merge them with the GMAT rows. `db.js` already exposes `listLsatSessions`,
`listLsatAttempts`, `getLsatSession`.

Single-user local DB → trivial volume, so: fetch GMAT rows unpaginated, build LSAT rows, concat,
sort by the requested key, then slice for limit/offset in JS.

### Mappers (server-side helpers)

`mapLsatSessions()` → session-shaped rows consumed by Performance by Session:
- `id: "lsat-{session.id}"` (string; namespaced so it can't collide with integer GMAT ids)
- `session_date` = `started_at`
- `source` = `"LSAT PrepTest {test_num} · Section {section_roman}"`
- `subject` = `RC` if section kind RC else `CR`
- `question_count` = answered count (attempts for the session)
- `error_count` = attempts with `is_correct = 0`
- `answered_accuracy_pct`, `avg_time_sec` from attempts
- Difficulty breakdown fields = null/`—`

`mapLsatErrors()` → error-shaped rows consumed by Error Log + review modal (only `is_correct = 0`):
- `id: "lsat-{attempt.id}"`
- `source` (as above), `subject` (RC/CR), `topic` = section kind label
- `question_stem` + `answer_choices: [{label, text}]` looked up from `lsat-questions.json` by
  `(test_num, section_roman, question_number)`
- `my_answer` = `user_answer`, `correct_answer`, `time_sec` = `time_ms/1000`, `confidence`
- `difficulty` = null (renders `—`)

The review modal already handles the `[{label,text}]` choice shape with row-level
`my_answer`/`correct_answer` comparison (same as GMAT Club rows), so no modal changes needed.

### Endpoints

- `GET /api/sessions` — merge mapped LSAT sessions with GMAT. Honor `platform` filter: `lsat`
  returns only LSAT; `starttest/gmatclub/ttp/ope-mock` exclude LSAT; unset returns both. Honor
  `subject` filter for `RC`/`CR`. Merge counts into the returned `total`.
- `GET /api/errors` — same merge for LSAT incorrect answers; honor `platform`/`subject`.
- `GET /api/sessions/:id/analysis` — if `:id` starts with `"lsat-"`, build the analysis object from
  `lsat_sessions` + `lsat_attempts` + JSON, returning **all** questions of the session (correct +
  incorrect), each in the modal-ready row shape. Otherwise unchanged.
- `platformWhereClause` / filter handling: add `"lsat"`.

## Frontend (`client/src/App.jsx`, `styles.css`)

- `getSourcePlatform(label)`: add `if (/lsat/i.test(label)) return 'lsat';`.
- `SourceBadge`: `'lsat'` → label `"LSAT"`; new `.source-lsat` chip color in `styles.css`.
- Performance-by-Session **and** Error Log source filters: add `<option value="lsat">LSAT</option>`.
- Subject filter (both tables): add `<option value="RC">RC</option>` and `<option value="CR">CR</option>`.
- Session Analysis modal + review modal: unchanged — LSAT rows carry the expected fields; difficulty
  cells render `—` via existing null handling.

## Edge cases

- Namespaced `"lsat-{id}"` keys avoid PK collision with integer GMAT ids; analysis route branches on the prefix.
- A question whose JSON lookup fails (missing/renumbered) → stem/choices empty; row still renders with answers.
- Sessions with zero answered questions don't appear (no attempts → not in error/analysis; session row would show 0 — acceptable, matches LSAT app behavior).
- Sorting a merged set by columns LSAT lacks (difficulty buckets) → LSAT sorts as null/last.

## Out of scope

- Writing LSAT data into `question_attempts`/`sessions` (no dual-write).
- AI coach / patterns endpoints over LSAT.
- Difficulty estimation for LSAT questions.
