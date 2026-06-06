# LSAT Difficulty Classification (GMAT criteria) — Design

**Date:** 2026-06-06
**Status:** Approved (design)

## Goal

Classify every question in the LSAT question bank (`data/lsat-questions.json`)
into a GMAT-style difficulty label — **Easy / Medium / Hard** — using OpenAI's
**gpt-5-nano** model, and surface those labels in the existing dashboard.

LSAT data was added to this GMAT-study app because LSAT Logical Reasoning ≈ GMAT
Critical Reasoning and LSAT Reading Comprehension ≈ GMAT Reading Comprehension.
The bank currently has **no** difficulty information, so the dashboard renders the
difficulty column as `null`. This feature fills that gap on GMAT terms.

## Scope of the bank

- 34 PrepTests, 110 sections, **2,805 questions** total.
- 921 RC questions, 1,884 LR questions.
- Zero questions currently have a `difficulty` field.

## Why "Easy / Medium / Hard"

The app's database already uses exactly this vocabulary for GMAT difficulty
(917 `Medium`, 893 `Easy`, 845 `Hard` rows in `question_attempts`, plus uppercase
variants). Reusing it means LSAT rows render alongside GMAT rows with **no new UI
or new difficulty vocabulary**.

## Approach

A standalone batch script reads the JSON bank, calls gpt-5-nano, and writes labels
back into the bank. Plus a 2-line dashboard wiring change.

Rejected alternatives:
- **Extend `question-topic-classifier.js`** — it operates on DB rows; the LSAT bank
  lives in JSON and is outside the classifier's flow. Wrong layer.
- **Server endpoint + UI button** — the bank is static data parsed once from a PDF.
  On-demand triggering adds complexity with no benefit.

## Components

### 1. `scripts/classify-lsat-difficulty.mjs`

- **Model:** forces OpenAI **gpt-5-nano**, independent of the app's `LLM_PROVIDER`
  setting. Default model id `gpt-5-nano`, overridable via `LSAT_DIFFICULTY_MODEL`.
  Reuses existing `OPENAI_API_KEY` and `OPENAI_API_BASE` env handling.
- **CLI flags:**
  - `--test <num>` — classify only one PrepTest (pilot).
  - `--limit <n>` — cap number of questions processed.
  - `--force` — re-classify questions that already have a `difficulty`.
  - `--dry-run` — call the model and print/report, but do not write the bank.
- **Idempotent:** skips any question that already has a non-empty `difficulty`
  unless `--force` is passed.
- **Safe writes:**
  - Back up the bank to `data/lsat-questions.json.bak-difficulty-<timestamp>`
    before the first mutation.
  - Write incrementally (flush after each batch/section) so a crash mid-run keeps
    completed labels.

### 2. GMAT difficulty rubric (system prompt)

The model scores each question on **GMAT** difficulty, not LSAT difficulty. The
rubric, baked into the system prompt:

- **Easy (≈ sub-555):** single-step reasoning, literal/explicit content, an obvious
  correct answer, weak distractors.
- **Medium (≈ 555–655):** moderate inference, some abstraction, one genuinely
  plausible trap answer.
- **Hard (≈ 655+):** multi-step or abstract reasoning, dense/technical language,
  subtle trap answers that require careful elimination.

Explicit difficulty drivers named in the prompt: number of logical steps,
abstraction level, trap-answer subtlety, language/passage density, inference depth.

### 3. Prompt & batching strategy

RC and LR are batched differently because of context needs:

- **LR** (stimulus is inline in the stem): batch ~15 questions per call; each
  question is self-contained.
- **RC** (questions share a passage): group questions by passage and send the
  passage **once** plus all its questions in a single call — saves tokens and gives
  the model the shared context it needs.

The model returns strict JSON: `[{ "number": <int>, "difficulty": "Easy|Medium|Hard",
"reason": "<short phrase>" }]`. Responses are validated; unparseable or
out-of-vocabulary labels for a batch are retried once, then skipped (logged).

`reason` is used only for the pilot review report — it is **not** stored in the bank.

### 4. Output shape

Per question object in `data/lsat-questions.json`:

```json
{
  "number": 1,
  "stem": "...",
  "choices": [ ... ],
  "correct": "B",
  "difficulty": "Hard",
  "difficulty_source": "gpt-5-nano"
}
```

`difficulty_source` records provenance so a later human override is distinguishable
from a model label.

### 5. Dashboard wiring (`src/lsat-dashboard.js`)

- In `questionIndex()`, add `difficulty: q.difficulty || null` (and
  `difficulty_source` if useful) to the indexed object.
- Change the hardcoded `difficulty: null` at the question-row builder to
  `difficulty: q.difficulty || null`.

LSAT rows then display Easy/Medium/Hard in the Error Log and the per-question
review modal, identically to GMAT rows. (Session-level `byDifficulty` aggregation
is out of scope for this pass.)

## Pilot → full workflow

1. Run `--test 1` (~75 questions). Write a review report to `/tmp/` containing
   `number | kind | difficulty | reason | stem-snippet` so the labels and rubric can
   be eyeballed.
2. On approval, run the full bank (2,805 questions). At gpt-5-nano pricing this is a
   few cents.

## Error handling

- Missing `OPENAI_API_KEY` → clear, actionable error before any model call.
- Per-batch model/parse failure → one retry, then skip that batch (questions remain
  unlabeled, logged), so one bad batch never aborts the whole run.
- The bank backup + incremental writes guarantee no data loss on crash.

## Out of scope

- Session-level difficulty aggregation (`byDifficulty`, per-band accuracy columns)
  for LSAT sessions.
- Writing difficulty into the SQLite DB (the dashboard reads difficulty via the JSON
  join in `lsat-dashboard.js`, so the JSON is sufficient).
- Re-deriving difficulty from real LSAT/GMAT response statistics (this is an
  LLM-estimated label, marked as such via `difficulty_source`).
