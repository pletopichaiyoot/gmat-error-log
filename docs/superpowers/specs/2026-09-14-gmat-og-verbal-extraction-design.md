# GMAT OG Verbal (CR + RC) extraction and practice track

**Date:** 2026-09-14
**Status:** Approved, ready for implementation planning

## Goal

Extract Critical Reasoning and Reading Comprehension practice questions from three
GMAT Official Guide PDFs and serve them as a practice track alongside the existing
LSAT one, with a StartTest-style filter-based set builder.

Sentence Correction is out of scope. The GMAT Focus exam dropped SC, so the chapter
is dead weight for this user.

## Sources

| Book | File | Pages | Text layer | Quality |
|---|---|---|---|---|
| OG 12th edition | `docs/The official guide for gmat review, 12th edition.pdf` | 843 | native (Quartz) | clean; real spaces, `ﬁ`/`ﬄ` ligatures |
| OG 13th edition | `docs/OG13.pdf` | 842 | OCR (ScanSnap / Adobe Scan 3.1) | good stems, spaces dropped in explanations, `QQ:1014347461制作` watermark |
| Verbal Review 2e | `docs/The Official Guide for GMAT Verbal Review, 2nd edition.pdf` | 338 | OCR (Acrobat 8 Paper Capture, 2009) | poor; spaces dropped throughout, `(8)` misread for `(B)`, unstable running heads; text only on pages 2-330 |

### Chapter layout

Each book lays CR and RC out identically: a practice/sample section, a flat answer
key, and an answer-explanations section.

| Book | RC chapter | CR chapter | Section suffixes |
|---|---|---|---|
| OG 12e | 7 | 8 | `.4 Sample Questions`, `.5 Answer Key`, `.6 Answer Explanations` |
| OG 13e | 7 | 8 | `.4 Practice Questions`, `.5 Answer Key`, `.6 Answer Explanations` |
| Verbal Review 2e | 3 | 4 | `.4 Sample Questions`, `.5 Answer Key`, `.6 Answer Explanations` |

Two traps in locating these boundaries:

1. **Section headers recur as running heads** inside the body text (`8.4 Critical
   Reasoning Practice Questions` appears mid-question on every page of the section).
   Take the first occurrence as the region boundary; strip every later one as a
   running head.
2. **Verbal Review 2e's OCR mangles the running head differently on nearly every
   page** (`3.4 Reading Comprehension Sample Que sti ons`, `3.0 Reading
   Comprehensio n`, `4.4 Critica l Reasoning Sam ple Questions`). Header matching
   must be whitespace-insensitive: collapse all whitespace before comparing.

### What each region yields

- **Practice section** — question number, stem, choices A-E. Two-column layout;
  RC passages carry gutter line numbers. This is the canonical question text.
- **Answer key** — a flat `73. C` list, one entry per question. The primary key
  source; no prose parsing needed.
- **Answer explanations** — for CR, repeats the full question and choices in
  single-column flow (better line breaks than the practice section, worse OCR
  spacing in OG13); for both CR and RC, carries an official question-type label, a
  Situation/Reasoning block, and a per-choice rationale where exactly one choice
  opens with `Correct.`. That marker is a **second, independent answer key**.

  RC explanations do **not** repeat the passage — they cite "the passage on page
  358" and "Lines 26-28". RC passages must come from the practice section via
  geometry extraction.

Observed type-label counts (CR and RC combined, per book): OG12 ~300, OG13 ~300,
Verbal Review 2e ~150. Labels seen: `Argument Construction`, `Argument Evaluation`,
`Evaluation of a Plan`, `Evaluation`, `Inference`, `Main idea`, `Supporting ideas`,
`Supporting idea`, `Logical structure`, `Application`, `Style and tone`. The
singular/plural pairs are the same label and must be folded together.

## Pipeline

Four offline stages. Every output is gitignored; regeneration is always possible
from the PDFs, which are the only tracked inputs.

### Stage 0 — re-OCR the scanned books

`brew install ocrmypdf` (pulls tesseract, ghostscript, qpdf), then

```
ocrmypdf --redo-ocr docs/OG13.pdf docs/ocr/OG13.ocr.pdf
ocrmypdf --redo-ocr "docs/The Official Guide for GMAT Verbal Review, 2nd edition.pdf" \
                    docs/ocr/VerbalReview2e.ocr.pdf
```

`--redo-ocr` rasterizes and re-recognizes with Tesseract 5, replacing the 2009-era
text layer. This is the fix for the dropped spaces and the `(8)`/`(B)` confusion —
repairing them downstream with a dictionary respacer would introduce its own errors
on proper nouns and numerals.

OG 12e is not re-OCR'd; its native text layer is already correct.

`docs/ocr/` is gitignored.

### Stage 1 — `scripts/parse-og-pdf.js`

Node, modeled on `scripts/parse-lsat-pdf.js`. Reads `pdftotext -raw` output and
emits the question structure.

Per book, per subject (CR, RC):

1. Locate the three regions by whitespace-insensitive header match.
2. Parse the answer key into a `number -> letter` map. Self-check: the highest
   question number in the key must equal the count of questions parsed from the
   practice section.
3. Parse the practice section into questions. Reuses the hardening the LSAT parser
   already needed:
   - page footers that `pdftotext` runs onto the end of the previous line
   - running heads (see above)
   - the `(?<!\d)` guard so a decimal like `4.6` is not read as question 6
   - choice labels `(A)` through `(E)`, tolerating the OCR `(8)` for `(B)` once
     re-OCR has been applied and verified (keep the tolerance as a fallback)
   - the OG13 `QQ:1014347461制作` watermark line
4. Parse the explanations section into, per question: type label, Situation text,
   Reasoning text, and per-choice rationale keyed A-E. The choice whose rationale
   opens with `Correct.` gives the second key.
5. **Cross-check the two keys.** Agreement is required. Disagreements are written to
   the parse report and the question is marked `keyDisputed: true`; they are never
   silently resolved in favor of one source.
6. Where a practice-section question fails to parse (missing choices, truncated
   stem), fall back to the explanation section's copy of the same question and mark
   `stemSource: 'explanation'`.

The script emits a **parse report** alongside the JSON: per book and subject, the
question count, % keyed, % with exactly five choices, count of disputed keys, count
of stems falling back to the explanation copy, and any residual footer/running-head
junk. Thresholds must clear before the output is merged (see Acceptance).

### Stage 2 — `scripts/extract-og-passages.py`

Python + pdfplumber, adapted from `scripts/extract-lsat-passages.py`. Reads page
geometry and rewrites only passage and stem-formatting fields, leaving questions,
choices, and keys byte-identical. Same `--merge` / dry-run-report contract as the
LSAT script.

Two jobs:

1. **RC passages** — true paragraphs from first-line indentation, LSAT-style gutter
   line numbers so an explanation citing "Lines 26-28" is followable, and
   bold/italic highlights. Per-passage schema mirrors the LSAT one: `firstQuestion`,
   `text` (paragraphs joined by `\n\n`), `lines[]` (`{n, marker, para, text}`),
   `highlights[]`.
2. **Boldface CR stems** — roughly 25-30 CR questions per OG edition ask "the
   portion in **boldface** plays which of the following roles". Plain-text
   extraction loses the emphasis and the question becomes unanswerable. Font weight
   from pdfplumber marks those spans, emitted as a `stemHtml` field with `<b>`
   wrappers. Questions whose stem mentions boldface but where no bold span was
   recovered are flagged in the parse report.

### Stage 3 — `scripts/dedup-og-questions.mjs`

OG 12e and OG 13e share a large fraction of their question pool. Fingerprint on the
normalized stem (lowercase, punctuation and whitespace collapsed, first 200
characters). Keep one copy, preferring the OG13 rendering. The surviving question
carries `refs: [{book, number, page}]` for every edition it appeared in, so the
physical book is still reachable.

Verbal Review 2e is a distinct pool and should produce few or no collisions; a high
collision count against it is a signal the fingerprint is too loose and belongs in
the report.

**RC dedups at the passage group, not the question.** Deduping RC question by
question would gut a passage's group — leaving OG12's passage with three of its six
questions because the other three matched OG13 — and a partial group is not
practiceable. An RC passage is fingerprinted on its own normalized text; when two
editions share a passage, the whole group from the preferred edition survives and
the other edition's group is dropped entire. CR, having no group structure, dedups
per question.

### Stage 4 — `scripts/classify-og-difficulty.mjs`

The OG books print no difficulty label. One offline LLM pass assigns
Easy/Medium/Hard, writing `difficulty` and `difficulty_source: 'llm'`, mirroring
`scripts/classify-lsat-difficulty.mjs` and reusing its provider plumbing. Runs once;
idempotent on re-run (skips questions that already carry a difficulty).

## Data file

`data/gmat-og-questions.json`, with `.bak-<reason>-<timestamp>` siblings
for rollback — the same convention `data/lsat-questions.json` uses.

`.gitignore` gains `data/gmat-og-questions.json*` and `docs/ocr/`. The source PDFs
under `docs/` stay tracked; they are the only inputs the pipeline cannot regenerate.

```
{
  books: [
    {
      code: 'OG13',            // 'OG13' | 'OG12' | 'VR2'
      title: 'The Official Guide for GMAT Review, 13th Edition',
      sections: [
        {
          kind: 'RC',          // 'RC' | 'CR'
          passages: [
            { id, firstQuestion, text, lines: [{n, marker, para, text}], highlights: [] }
          ],
          questions: [
            {
              id,              // stable: '<book>-<kind>-<number>', e.g. 'OG13-CR-56'
              number,          // as printed in the book
              page,
              stem,
              stemHtml,        // present only when bold spans were recovered
              choices: [{ label, text }],
              correct,         // 'A'..'E'
              typeLabel,       // 'Argument Construction', 'Main idea', ...
              difficulty,
              difficulty_source,
              explanation: { situation, reasoning, choices: { A: '', B: '', ... } },
              passageId,       // RC only
              refs: [{ book, number, page }],
              keyDisputed,     // true only when the two key sources disagreed
              stemSource       // 'practice' (default) | 'explanation'
            }
          ]
        }
      ]
    }
  ]
}
```

Served by a cached `loadOgData()` in `src/server.js`, matching `loadLsatData`.
**The cache is in-process, so the API must be restarted after regenerating the
file** — the same gotcha the LSAT track has.

`id` is the stable per-question identifier and is what the DB stores. It survives
regeneration of the JSON as long as the book and printed question number are
unchanged. Dedup does not rewrite ids: the survivor keeps its own book's id and
records the other edition in `refs`.

## Database

Migration `migrations/0010_gmat_og_practice.sql`. Two tables, copied from the
`lsat_*` pair, with one structural difference: OG sessions are built from filters
rather than a question range, so they store the resolved id list and the filter
payload instead of `test_num` / `first_question` / `last_question`.

```sql
CREATE TABLE og_attempts (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_id     text NOT NULL,      -- 'OG13-CR-56'
  book_code       text NOT NULL,
  kind            text NOT NULL,      -- 'CR' | 'RC'
  user_answer     text NOT NULL,
  correct_answer  text,
  is_correct      integer,
  confidence      text,
  time_ms         integer,
  session_id      integer,
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  mistake_type    text,
  notes           text
);

CREATE TABLE og_sessions (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  set_label     text,
  mode          text,          -- 'practice' | 'timed'
  filters       text,          -- JSON payload of the builder selections
  question_ids  text,          -- JSON array of question ids, in order
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE INDEX idx_og_attempts_question ON og_attempts(question_id);
CREATE INDEX idx_og_attempts_session  ON og_attempts(session_id);
CREATE INDEX idx_og_sessions_started  ON og_sessions(started_at DESC);
```

A question may be attempted more than once across sessions — redo is the point of
the seen/wrong filter — so there is deliberately no unique constraint on
`og_attempts`. Within a single session the builder guarantees each question appears
at most once.

`mistake_type` routes through `src/mistake-tags.js` on write, like every other
annotation path in the codebase. `notes` uses the structured review-note shape
parsed by `client/src/lib/reviewNotes.mjs`.

## Backend module and API

`src/og-dashboard.js`, mirroring `src/lsat-dashboard.js`: `saveOgAttempt`,
`createOgSession`, `completeOgSession`, `listOgSessions`, `listOgAttempts`,
`listOgErrors`, `ogStats`, `getOgDashboardAnalysis`.

Endpoints under `/api/og`:

| Endpoint | Purpose |
|---|---|
| `GET /api/og/library` | books, sections, counts, and the distinct type labels available per subject — feeds the builder's dropdowns |
| `POST /api/og/build-set` | takes the filter payload, returns the resolved question list for preview; creates nothing |
| `POST /api/og/sessions` | commits a resolved set as a session |
| `POST /api/og/sessions/:id/complete` | marks it finished |
| `GET /api/og/sessions`, `GET /api/og/sessions/:id` | history |
| `POST /api/og/attempts`, `GET /api/og/attempts` | per-question answers |
| `GET /api/og/errors` | wrong answers, for the error log |
| `GET /api/og/stats` | accuracy by book, subject, type label, difficulty |

`build-set` is separate from `sessions` so the builder can show "this gives you 18
questions across 5 passages" before anything is written.

The existing merged list endpoints gain an `og` platform, exactly as LSAT is merged
today at `src/server.js:573-594` and `:679-697`: `/api/sessions` and `/api/errors`
accept `platform=og`, and OG rows carry a namespaced `og-<id>` session id so the
deep-dive route can dispatch on the prefix.

## Set builder

The StartTest Practice Now model: pick filters, get a set. Axes in v1:

- **Book** — multi-select over OG13 / OG12 / Verbal Review 2e
- **Subject** — CR or RC
- **Question type** — multi-select over the official labels for that subject
- **Difficulty** — multi-select over Easy / Medium / Hard
- **History** — unseen, previously wrong, or all (evaluated against `og_attempts`)
- **Count** — number of questions
- **Mode** — Practice (explanation shown immediately after each answer) or Timed
  (explanations withheld until an end-of-set review screen)

**RC draws whole passages.** A count-based random draw would split a passage's
question group and leave a set that cannot be worked as written. In RC mode the
builder adds whole passages until the next one would overshoot the requested count,
so the delivered count is approximate; the preview states the actual count and
passage total. A type-label filter in RC mode selects *passages containing* at least
one matching question, and the set still contains that passage's full group —
otherwise the passage is being read for one question, which is not how RC is
practiced.

Filters combine as AND across axes and OR within an axis. An empty selection on an
axis means "no constraint", not "nothing".

If the filters resolve to fewer questions than requested, the builder returns what
it has and the preview says so; it does not silently relax a filter.

## Frontend

`client/src/GmatOgPractice.jsx`, modeled on `client/src/LsatPractice.jsx`: builder
screen, runner, review screen.

The RC runner renders passage and questions side by side with the gutter line
numbers visible, since the explanations cite them. CR renders `stemHtml` when
present so boldface questions are answerable.

`LsatPractice.jsx` is already ~59KB; the new file must not repeat that. Shared
pieces — the choice-button row, the timer, the annotation modal wiring, the
review-note editor — are lifted into `client/src/lib/` or a small shared component
rather than copied. This refactor is limited to what the OG track actually reuses;
no unrelated restructuring of the LSAT file.

## Testing

- `test/unit/og-parser.test.js` — answer-key parsing, choice-label parsing including
  the `(8)` fallback, running-head stripping, the decimal-as-question-number guard,
  and the explanation-vs-key cross-check flagging a disagreement rather than picking
  a side.
- `test/unit/og-set-builder.test.js` — RC draws whole passages; the count never
  splits a group; unseen/wrong history filters; an over-constrained filter returns a
  short set rather than relaxing.
- The stage-1 parse report is the gate on extraction quality, checked by hand before
  each merge.

## Acceptance

Extraction is done when, for each book and subject:

- every question parsed from the practice section has a key from the answer-key list
- the explanation-derived key agrees with it (disputes reported and resolved, not
  carried into the data file)
- at least 98% of questions have exactly five choices
- zero stems or choices contain a page footer, running head, or watermark fragment
- every RC question resolves to a passage, and every passage has at least one
  question
- every CR question whose stem mentions boldface carries a `stemHtml` with at least
  one bold span

The track is done when a set can be built from filters, worked end to end in both
modes, and its misses appear in the main error log under `platform=og` with
annotation and bookmarking working as they do for every other source.

## Risks

- **Verbal Review 2e may not survive re-OCR.** The source scan is 2009 fax-quality.
  If stage 0 output still fails the acceptance thresholds, ship the two OG editions
  and report the gap rather than pollute the pool with unreadable questions.
- **RC gutter line numbers drift a few near a passage's end** — a known limitation
  of the LSAT geometry extractor that this one inherits. Paragraph text is correct;
  only the numbering is approximate at the tail.
- **OG12/OG13 overlap may be larger or smaller than assumed.** The dedup report
  surfaces the actual collision count before the merge is accepted.
- **The LLM difficulty pass is one-way spend.** It runs after extraction is accepted,
  not during iteration on the parser.

## Build order

1. `brew install ocrmypdf`; re-OCR OG13 and Verbal Review 2e; eyeball the result
2. `parse-og-pdf.js`, CR only, OG12 only — the cleanest source, validated against
   its own answer key
3. Add RC, and `extract-og-passages.py` for passages and boldface spans
4. Extend to OG13, then Verbal Review 2e
5. Dedup, then the difficulty pass
6. Migration, `og-dashboard.js`, `/api/og/*`
7. `GmatOgPractice.jsx` and the shared-component lift
8. Merge OG into `/api/sessions` and `/api/errors`
