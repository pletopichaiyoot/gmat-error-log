# Review-rules rollup — "My Process" (Stage 2)

**Date:** 2026-09-09
**Status:** proposed
**Depends on:** Stage 1 (structured review notes, `client/src/lib/reviewNotes.mjs`)

## Problem

Stage 1 made every review note carry an if-then rule (`Next time: When <trigger> → <action>`).
Those rules are still invisible in aggregate: a rule written on twenty questions looks exactly
like a rule written once, and the only way to see the pattern is to read notes row by row.

The artifacts that actually change behaviour — `TPA_AttemptProtocol_Drill`,
`DS_AnchorTest_Cheatsheet`, `RC_PassageMap_Sprint_4Labels` in the MBA2027-GMAT folder — are
written by hand from memory after each review. They are exactly what a rollup of the rules
would produce, if the rules were counted.

**Goal:** one screen that ranks the rules by how often they were needed, so the process doc
builds itself out of the error log instead of being rewritten from scratch.

## Non-goals

- No editing or renaming a rule across the rows that carry it. Rules group by exact trigger
  text; rewording forks the rule. (Same ceiling Stage 1 already carries.)
- No fuzzy/LLM clustering of near-duplicate triggers. Exact match first — see whether reuse
  via the datalist actually holds before paying for similarity.
- No spaced-redo scheduling. AI Curated Practice already delivers redos.
- No migration. Rules stay inside `question_attempts.notes`.

## Data

No schema change. A rule is derived from `notes`, so the source of truth is the note itself
and a rescrape cannot lose it (Phase-1 rescrapes already preserve `notes`).

## Backend

**`rollupRules(rows)` — `client/src/lib/reviewNotes.mjs`.** Pure aggregation over rows that
each carry `{notes, q_code, category_code, subject_code, session_date}`. Extends the existing
`collectRules` (which the modal's datalist uses) rather than duplicating it — `collectRules`
becomes a thin caller of the same grouping. Per rule it returns:

```js
{
  when, then,               // canonical wording = the most recent row's
  hits,                     // rows carrying this trigger
  questions,                // distinct q_code count (a re-attempt is not a new lesson)
  categories: ['DS', 'GI'], // distinct, most-frequent first
  subjects: ['DI'],
  firstSeen, lastSeen,      // session_date
  sampleQCodes: [...]       // capped at 5, most recent first
}
```

Sorted `hits` desc, then `lastSeen` desc. Grouping key is the lowercased, whitespace-collapsed
trigger.

**`listReviewRules({ includeExcluded })` — `src/db.js`.** One query:

```sql
SELECT q.q_code, q.notes, q.subject_code, q.category_code, s.session_date
FROM question_attempts q
INNER JOIN sessions s ON s.id = q.session_id
WHERE LOWER(COALESCE(q.notes, '')) LIKE '%next time:%'
  AND <excludedSessionClause('s', includeExcluded)>
```

`LIKE` is lowercased on both sides (Postgres `LIKE` is case-sensitive — the CLAUDE.md gotcha),
and the SQL contains no literal `?` so `toPg` is safe. The prefilter is a cheap narrowing, not
the parser: `rollupRules` still decides what is a rule.

It also returns `unruled` — attempts with `correct = 0`, not an unanswered placeholder, whose
notes carry no rule — as the nudge count.

**Parser sharing.** `db.js` is CJS, `reviewNotes.mjs` is ESM, so the module is loaded with a
memoized `await import()`. Rejected the alternative of mirroring the parser into `src/` the way
`src/mistake-tags.js` mirrors `MISTAKE_TYPES`: the tag mirror is a *vocabulary* (rarely changes,
and drift is visible), while a parser that drifts silently mis-splits notes on one side only.

**`GET /api/review-rules`** — `{ rules: [...], unruled: <int> }`, honouring `includeExcluded`
via the existing `wantsExcluded(req)`. No pagination: the rule count is bounded by how many
distinct rules a person writes, not by attempts.

## Frontend

New `<section id="process">` **My Process**, placed directly after the Error Log section in
`client/src/App.jsx`, with a nav link beside "Error Log". Collapsible like every other section.

Each rule renders as a row:

| column | content |
|---|---|
| Rule | `When <trigger>` on the first line, `→ <action>` on the second |
| Hits | `12×` — brass at 2–4, forest at 5+, plain below 2 (the same escalation the modal chip uses) |
| Where | category chips (`DS`, `GI`), reusing `.mistake-tag-pill` |
| Last used | relative date, `session_date` in the title attribute |
| Questions | distinct-question count, with the sample `q_code`s in the title attribute |

Header line: `<n> rules · <m> errors with no rule yet`, the second half muted, so the gap is
visible without nagging.

Empty state: "No rules yet — the *Next time* field on any error becomes one." No CTA button;
the error log is one section up.

Loads once with the dashboard's other fetches and refetches after a successful annotation save
(`applyAnnotationLocally` already runs there).

The annotation modal's trigger datalist switches to this endpoint's rules, which fixes a Stage-1
ceiling: today it can only offer triggers found on the error rows currently loaded, so a rule
written three months ago is invisible when you need to reuse it.

## Testing

- `test/unit/review-notes.test.js` gains `rollupRules` cases: repeat counting, distinct-question
  vs hit count, canonical wording taken from the most recent row, category ordering, rows with
  no rule ignored.
- `listReviewRules` is exercised by hand against the live DB (the repo has no DB test harness);
  the SQL is a single read with no writes.

## Risks

- **Trigger drift.** Two wordings of the same rule count separately. Mitigated by the datalist
  offering existing triggers first; revisit only if the panel shows visible near-duplicates.
- **Legacy notes.** Notes written before Stage 1 have no rule and never appear here. They stay
  in the note's *Other notes* slot and count toward `unruled` if the row is a miss.
