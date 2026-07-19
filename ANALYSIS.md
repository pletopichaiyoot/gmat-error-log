# ANALYSIS.md

How to query the error log and analyze performance against the local SQLite store. Aimed at a future Claude (or you) opening this repo to answer questions like "what did I get wrong this week?", "where am I weakest in CR?", "is my hard-question accuracy improving?".

## Where the data lives

- File: `data/gmat-error-log.db` (SQLite, created on first scrape).
- Three core tables: `scrape_runs`, `sessions`, `question_attempts`. Plus coach tables (`coach_sessions`, `coach_messages`, `coach_memories`).
- All schema + table-creation lives in `src/db.js` around lines 100–235. Migrations are `ALTER TABLE ADD COLUMN` with existence checks — never trust an in-context schema dump alone, run `PRAGMA table_info(question_attempts)` if a column might be new.
- Two ways to query: hit the REST API on port 4310 (preferred — applies the same normalization the dashboard uses), or open the DB directly with `sqlite3 data/gmat-error-log.db` for ad-hoc work.

## Picking the right entry point

| Question | Use |
|---|---|
| "What did I miss in the last session?" | `GET /api/sessions/:id/analysis` |
| "Show me all errors filtered by subject/topic/difficulty/mistake-tag" | `GET /api/errors?...` |
| "Which sessions did I do, with accuracy + difficulty breakdown?" | `GET /api/sessions?...` |
| "Where are my recurring weak spots?" | `GET /api/patterns?runId=` |
| "What scrapes have I run?" | `GET /api/runs` |
| "Free-form SQL — count, group, custom join" | `sqlite3 data/gmat-error-log.db` |
| "AI write-up of recent performance" | `POST /api/ai/review` (body: `runId`, `focus`, optional `sessionId`) |
| "Chat with the coach about a specific session" | `POST /api/ai/chat` |

The REST endpoints already apply unanswered-row filtering, subject normalization, and topic canonicalization. Direct SQL is faster to iterate but you have to replicate those rules yourself — see "Conventions" below.

## Schema cheat sheet

### `scrape_runs`
One row per `/api/scrape` invocation. Columns: `id`, `extracted_at`, `since_value`, `source`, `review_category_id`, `total_sessions`, `total_questions`, `total_errors`, `created_at`. Use `id` to scope queries to "the latest pull only".

### `sessions`
One row per practice session. Identified externally by `(session_external_id, source)`. GMAT Club rows are synthesized one-per-day (`session_id = hash("${source}|${dateKey}")`), StartTest rows map to a real session.

Columns worth knowing: `subject` (`Quant` | `Verbal` | `DI` | `Mixed` | NULL), `total_q_api`, `total_q_categories`, `correct_count`, `error_count`, `accuracy_pct`, `avg_time_sec`, `avg_correct_time_sec`, `avg_incorrect_time_sec`. The dashboard recomputes accuracy/time on the fly from `question_attempts` (filtering out unanswered placeholders) and only falls back to these stored columns when no attempts join.

### `question_attempts`
One row per attempt. The big table. Key columns:

- Identity: `q_code` (per-question stable id, GMAT Club: `gc-q-{topic_id}`), `q_id` (per-attempt; GMAT Club: `gc-att-{timer_history_id}`), `cat_id`, `question_url`.
- Subject/topic: `subject_code` (`Q` | `V` | `DI`), `category_code` (PS/CR/RC/DS/MSR/TA/GI/TPA), `subcategory` (StartTest abbreviation like "ARI"/"VEO"), `subject_sub`, `subject_sub_raw`, `topic` (canonical readable label), `topic_source` (`starttest-report` | `gmatclub-canonical` | `llm`), `content_domain`.
- Outcome: `correct` (0/1), `difficulty` (`easy`/`medium`/`hard`), `time_sec`, `my_answer`, `correct_answer`, `confidence`.
- Content: `question_stem`, `answer_choices` (JSON — see CLAUDE.md "Answer-choice storage shape"), `passage_text`, `response_format`, `response_details`.
- User annotations (preserved across re-scrapes): `mistake_type`, `notes`.

## Conventions you must apply when writing raw SQL

These are baked into the API. If you query the DB directly without them, your numbers won't match the dashboard.

**Filter out unanswered placeholders** before computing accuracy or counting errors. Phase-1 StartTest rows that the user skipped show up as empty stems with no answer and ≤5s time. Mirror `unansweredPlaceholderExpr` in `src/db.js`:

```sql
-- An attempt is an unanswered placeholder when ALL of these hold:
COALESCE(TRIM(q.my_answer), '')      = ''
AND COALESCE(TRIM(q.correct_answer), '') = ''
AND COALESCE(TRIM(q.question_stem), '')  = ''
AND COALESCE(q.time_sec, 0)              <= 5
```

So "real errors" = `q.correct = 0 AND NOT (<unanswered placeholder>)`.

**Source / platform filtering** uses a substring match — `LOWER(source) LIKE '%gmat club%'` for GMAT Club, the negation for StartTest. The frontend's `getSourcePlatform()` and the backend's `platformWhereClause()` both rely on this single convention, so don't invent your own (see CLAUDE.md "Source-platform identification").

**Subject inference is not just `q.subject_code`.** A long `CASE` chain in `listErrors` resolves subject from `category_code` → `cat_id` ranges → `subject_sub`/`subject_sub_raw` → topic-keyword fallback → `s.subject`. For ad-hoc subject grouping the simplified version is:

```sql
CASE
  WHEN UPPER(q.category_code) IN ('PS','QUANT')                    THEN 'Q'
  WHEN UPPER(q.category_code) IN ('CR','RC')                       THEN 'V'
  WHEN UPPER(q.category_code) IN ('DS','MSR','TA','GI','TPA','DI') THEN 'DI'
  WHEN s.subject = 'Quant'  THEN 'Q'
  WHEN s.subject = 'Verbal' THEN 'V'
  WHEN s.subject = 'DI'     THEN 'DI'
  ELSE 'Unknown'
END
```

Use the full expression from `src/db.js` (`subjectCodeExpr` / `subjectExpr`) only when you need parity with the dashboard's filters.

**Topic canonicalization** also happens in SQL. CR sub-topics like "Strengthen"/"Weaken"/"Flaw" get folded into `Support`/`Attack`, RC sub-topics into `Main Idea / Purpose`, etc. — see the `topicExpr` block. If you're grouping by topic for an analysis, decide whether you want raw `q.topic` (more granular, splits "Weaken" from "Attack") or the canonicalized version (matches dashboard pattern view).

**Dates** are Thai time (`Asia/Bangkok`, UTC+7). `session.session_date` is text; sort lexicographically (`ORDER BY s.session_date DESC`) — it's stored in a sortable format. The `since` query param to `/api/scrape` is `YYYYMMDDHHmmss`.

## Common ad-hoc queries

Run from the repo root after `sqlite3 data/gmat-error-log.db`. Each one already excludes unanswered placeholders.

**1. Last 30 days at a glance, by subject:**

```sql
SELECT
  CASE
    WHEN UPPER(q.category_code) IN ('PS','QUANT') THEN 'Q'
    WHEN UPPER(q.category_code) IN ('CR','RC')    THEN 'V'
    ELSE 'DI'
  END AS subject,
  COUNT(*)                                     AS attempts,
  SUM(q.correct)                               AS correct,
  ROUND(100.0 * SUM(q.correct) / COUNT(*), 1) AS accuracy_pct,
  ROUND(AVG(q.time_sec), 0)                    AS avg_sec
FROM question_attempts q
JOIN sessions s ON s.id = q.session_id
WHERE s.session_date >= date('now', '-30 days')
  AND NOT (
    COALESCE(TRIM(q.my_answer),'')      = ''
    AND COALESCE(TRIM(q.correct_answer),'') = ''
    AND COALESCE(TRIM(q.question_stem),'')  = ''
    AND COALESCE(q.time_sec, 0)              <= 5
  )
GROUP BY 1
ORDER BY 1;
```

**2. Weakest topics (≥5 attempts, <70% accuracy):**

```sql
SELECT q.topic,
       COUNT(*)                                     AS attempts,
       SUM(q.correct)                               AS correct,
       ROUND(100.0 * SUM(q.correct) / COUNT(*), 1) AS accuracy_pct,
       ROUND(AVG(q.time_sec), 0)                    AS avg_sec
FROM question_attempts q
WHERE COALESCE(NULLIF(q.topic, ''), '') <> ''
  AND NOT (
    COALESCE(TRIM(q.my_answer),'')      = ''
    AND COALESCE(TRIM(q.correct_answer),'') = ''
    AND COALESCE(TRIM(q.question_stem),'')  = ''
    AND COALESCE(q.time_sec, 0)              <= 5
  )
GROUP BY q.topic
HAVING attempts >= 5 AND accuracy_pct < 70
ORDER BY accuracy_pct ASC, attempts DESC;
```

**3. Hard-question accuracy trend, week over week:**

```sql
SELECT strftime('%Y-W%W', s.session_date) AS week,
       COUNT(*)                                     AS hard_attempts,
       SUM(q.correct)                               AS hard_correct,
       ROUND(100.0 * SUM(q.correct) / COUNT(*), 1) AS hard_accuracy_pct
FROM question_attempts q
JOIN sessions s ON s.id = q.session_id
WHERE LOWER(COALESCE(q.difficulty,'')) = 'hard'
  AND NOT (
    COALESCE(TRIM(q.my_answer),'')      = ''
    AND COALESCE(TRIM(q.correct_answer),'') = ''
    AND COALESCE(TRIM(q.question_stem),'')  = ''
    AND COALESCE(q.time_sec, 0)              <= 5
  )
GROUP BY week
ORDER BY week DESC;
```

**4. All wrong answers in the most recent session, with stem + mistake tag:**

```sql
WITH latest AS (
  SELECT id FROM sessions ORDER BY session_date DESC, session_external_id DESC LIMIT 1
)
SELECT q.q_code, q.topic, q.difficulty, q.time_sec,
       q.my_answer, q.correct_answer, q.mistake_type,
       SUBSTR(q.question_stem, 1, 200) AS stem_preview
FROM question_attempts q
JOIN latest l ON q.session_id = l.id
WHERE q.correct = 0
  AND NOT (
    COALESCE(TRIM(q.my_answer),'')      = ''
    AND COALESCE(TRIM(q.correct_answer),'') = ''
    AND COALESCE(TRIM(q.question_stem),'')  = ''
    AND COALESCE(q.time_sec, 0)              <= 5
  )
ORDER BY q.id;
```

**5. Recurring misses — same `q_code` wrong on multiple attempts:**

```sql
SELECT q.q_code, q.topic, COUNT(*) AS wrong_attempts,
       MIN(s.session_date) AS first_wrong, MAX(s.session_date) AS last_wrong
FROM question_attempts q
JOIN sessions s ON s.id = q.session_id
WHERE q.correct = 0
  AND COALESCE(NULLIF(q.q_code,''), '') <> ''
GROUP BY q.q_code
HAVING wrong_attempts >= 2
ORDER BY wrong_attempts DESC, last_wrong DESC;
```

**6. Mistake-tag breakdown (uses your annotations):**

```sql
SELECT COALESCE(NULLIF(q.mistake_type,''), '(untagged)') AS tag,
       COUNT(*) AS occurrences
FROM question_attempts q
WHERE q.correct = 0
  AND NOT (
    COALESCE(TRIM(q.my_answer),'')      = ''
    AND COALESCE(TRIM(q.correct_answer),'') = ''
    AND COALESCE(TRIM(q.question_stem),'')  = ''
    AND COALESCE(q.time_sec, 0)              <= 5
  )
GROUP BY tag
ORDER BY occurrences DESC;
```

**7. Scope to one source / platform:** add `AND LOWER(s.source) LIKE '%gmat club%'` (or the negation for StartTest) to any of the above.

## REST API quick reference

All endpoints are on `http://127.0.0.1:4310` and the Vite dev server proxies `/api/*` to them. Pagination on list endpoints: `page` (1-indexed), `pageSize` (capped at 100).

| Method + Path | Notable params | Returns |
|---|---|---|
| `GET /api/runs?limit=N` | `limit` (default 20) | `{ runs: [...] }` — most recent first |
| `GET /api/sessions` | `runId`, `page`, `pageSize`, `platform` (`gmatclub`\|`starttest`) | `{ sessions, total, page, pageSize, totalPages }` with per-difficulty accuracy + time aggregates already computed |
| `GET /api/sessions/:id/analysis` | — | full session payload: header stats, per-question rows, per-topic and per-difficulty rollups |
| `GET /api/errors` | `runId`, `subject` (`Q`\|`V`\|`DI` or full label), `difficulty`, `topic`, `confidence`, `search`, `mistakeTag`, `platform`, `sortKey` (`session_date`, `source`, `q_code`, `subject`, `difficulty`, `topic`, `time_sec`, `mistake_type`), `sortOrder`, `page`, `pageSize` | only `correct = 0` rows, with unanswered placeholders excluded |
| `GET /api/patterns?runId=` | `runId` optional | recurring weak-topic / weak-subject / time-pressure rollups for the pattern view |
| `POST /api/ai/review` | body: `runId`, `focus`, `sessionId` (optional) | LLM-written performance review; returns `{ ok, review, contextMeta }` |
| `POST /api/ai/chat` | coach session id + message | streaming-ish coach reply |
| `POST /api/sessions/:id/enrich` | — | Phase-2 deep enrichment for one session (fetches stems/choices/answers) |

`subject` accepts both the short codes (`Q`, `V`, `DI`) and full labels — the server uppercases and routes to the right `CASE` arm in `listErrors`.

## Pitfalls

- **Don't compute accuracy from `s.correct_count` / `s.error_count` alone.** Those are scraper-reported and can disagree with the joined attempts (especially after a Phase-2 enrichment fixes a mis-labeled answer). Always recompute from `question_attempts` with the unanswered filter.
- **GMAT Club rows are deduplicated daily**, not per-session. If you see one "session" per day with dozens of attempts spanning hours, that's correct.
- **Per-choice flags (`isCorrect`/`isUserSelected`) only exist on StartTest rows.** GMAT Club Phase-2 stores `{label, text}` and uses row-level `my_answer`/`correct_answer`. Any analytics over choice-level data must fall back to the row-level columns when the per-choice fields are missing.
- **`topic_source = 'gmatclub-canonical'` rows are pre-mapped at scrape time** by `GMATCLUB_CATEGORY_TO_CODE`; only ~4-5% of GMAT Club rows ever hit the LLM classifier. If a topic looks misclassified, check the mapping in `src/scrapers/gmat_club_scraper.js` first.
- **Annotations (`mistake_type`, `notes`) survive re-scrapes.** Phase 1 deletes-and-reinserts attempts but copies annotations forward by `q_id`; Phase 2 is `UPDATE`-only. Safe to query at any time.
- **`subcategory` is sometimes a 3–5 char abbreviation** (StartTest) and sometimes a full label (GMAT Club). For display, `pickReadableSubcategory` in `client/src/App.jsx` prefers `topic` whenever `subcategory` looks abbreviation-shaped.

## Curating an AI Practice set

The **AI Curated Practice** tab lets you redo previously-attempted questions you got wrong. Curation itself happens *outside* the app: you (as Claude, in a coding session — "Claude Cowork") query the error log, pick which attempts are worth a redo, and write a small JSON file. The app does the rest — lists the set, serves each question (answer stripped), grades the submission server-side, and logs a new session so it shows up in the dashboard like any other practice.

**Workflow:**

1. Query the DB for redo candidates (see SQL below) — wrong, gradeable, oldest-first.
2. Pick the ids you want (e.g. by topic/subject/`mistake_type`) and write a set file.
3. User opens the **AI Practice** tab → the set appears → **Start** → answers each question → **Finish**.
4. The app logs a new session with `source = 'AI Curated Practice'`, one `question_attempts` row per item, **`q_code` copied unchanged from the original attempt** — so the redo links back to the prior attempt(s) even if the original came from a different platform (GMAT Club, StartTest, TTP, …). `q_id` is synthesized as `aic-att-<slug>-<n>` (not stable across re-edits of the set file — don't rely on it for identity, use `q_code`).

**Where set files live:** `data/ai-practice-sets/<slug>.json` — gitignored, **read fresh on every request** (`readSetFiles()` in `src/ai-practice-sets.js`, called with no caching from `loadAiPracticeSets()` in `src/server.js`). No server restart needed after adding/editing a file.

**Set-file schema:**

```json
{
  "slug": "quant-algebra-redo-01",
  "title": "Algebra redo — inequalities & exponents",
  "focusNote": "Recent misses on inequality direction-flips and exponent rules.",
  "subject": "Quant",
  "items": [1287, 1290, 1305]
}
```

- `slug` must match `^[a-z0-9][a-z0-9-]*$` and doubles as the filename stem (by convention, though the loader doesn't enforce filename==slug).
- `items` are **`question_attempts.id`** values (the DB row id of the *original* enriched attempt) — not `q_code`, not `q_id`. Get these straight out of the candidate query below.
- `title`/`focusNote`/`subject` are display-only; `subject` isn't validated against the Q/Verbal/DI enum.

**Gradeability requirement (v1 is single-answer only):** an item is only servable if it has a non-empty `question_stem`, `answer_choices` that parse as a **flat** `[{label, text, ...}]` array, and a non-empty `correct_answer`. Multi-part DI (TPA/MSR/GI matrix items, which nest `options[]` inside each row) fail this check — `isFlatGradeableChoices()` in `src/ai-practice-sets.js` explicitly rejects any choice object carrying an `options` key. Don't put multi-part DI attempt ids in a set file; they'll be silently dropped.

**Never curate scraped-incorrectly "blank-choice" rows.** Some scraped rows have a well-formed `answer_choices` *array* but with empty/whitespace `text` on one or more options (a scrape glitch — e.g. 5 options, 3 blank). These **pass** `isFlatGradeableChoices()` (it counts the array + rejects nested `options[]`, but does **not** inspect choice text), so they still serve — and render as empty buttons the user can't answer. Always exclude them at curation time by adding this to the candidate query:

```sql
AND (SELECT count(*) FROM json_array_elements(qa.answer_choices::json) e
     WHERE COALESCE(TRIM(e->>'text'),'') = '') = 0
```

(Real example: attempt `14839` — "t = 2x + 1, in terms of t, 4x is" — has 5 choices with 3 blank; it must not go in a set.)

Ungradeable or missing ids aren't an error — `GET /api/ai-practice/sets/:slug` returns them in a `missing: [id, ...]` array alongside the servable `questions`, so a set can be curated a little loosely and the UI just shows fewer questions than `items.length`.

**Candidate SQL** (redo candidates: wrong, gradeable, least-recently-attempted first — reproduced from `listAiPracticeCandidates` in `src/db.js`):

```sql
SELECT qa.id, qa.q_code, s.source, qa.topic, qa.subcategory, qa.difficulty,
       qa.correct, qa.created_at
FROM question_attempts qa JOIN sessions s ON s.id = qa.session_id
WHERE qa.correct = 0
  AND qa.question_stem IS NOT NULL AND length(qa.question_stem) > 10
  AND qa.answer_choices IS NOT NULL AND qa.answer_choices NOT IN ('', '[]')
  AND qa.correct_answer IS NOT NULL AND qa.correct_answer <> ''
  AND LOWER(COALESCE(s.source,'')) NOT LIKE '%ai curated%'
  AND qa.subject_code = 'Q'
ORDER BY qa.created_at ASC
LIMIT 30;
```

Notes on the SQL:
- `subject_code` is `'Q' | 'V' | 'DI'` — drop that line entirely to pull candidates across all subjects.
- The `NOT LIKE '%ai curated%'` guard keeps you from re-curating an already-curated redo as a "candidate" (its `answer_choices` there is the stripped `{label,text}` shape anyway).
- This is the same predicate the real endpoint uses (`listAiPracticeCandidates`), plus a JS-side `isFlatGradeableChoices()` pass to drop multi-part DI — replicate that filter (no nested `options[]` in any choice) if you run the SQL by hand instead of hitting the function directly, since raw SQL can't easily express "flat JSON array of objects with no `options` key."
- Add `AND qa.mistake_type = '...'` or `AND LOWER(qa.topic) LIKE '%...%'` to scope curation to a specific weakness.

**Platform/badge plumbing:** the source label is `AI Curated Practice`; the platform key is `ai-curated` (`platformWhereClause('ai-curated')` in `src/db.js` matches `LOWER(source) LIKE '%ai curated%'`), consistent with how every other source is filtered (see "Source-platform identification" in CLAUDE.md).

**Difficulty**: the original attempt's `difficulty` label is copied onto the new redo row as-is; `difficulty_theta` is never set (AI Curated Practice is not IRT-scored — same rule as every non-OPE source, see CLAUDE.md).
