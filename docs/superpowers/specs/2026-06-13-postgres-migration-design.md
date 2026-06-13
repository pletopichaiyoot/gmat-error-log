# SQLite → PostgreSQL Migration — Design

**Status:** Draft (awaiting review) · **Date:** 2026-06-13 · **Owner:** single maintainer
**Scope:** Replace the SQLite (`sqlite3 ^6.0.1`, raw, no ORM) data layer with a local PostgreSQL 16 + pgvector instance, port all hand-written SQL to `node-postgres`, and migrate the existing ~6.1 MB database — preserving all user annotations, AI-coach memory, and history.

---

## 1. Goal & motivation

Two motivations drove this (confirmed with the maintainer); they define what "done" means and what is explicitly *not* in scope:

- **Concurrency & reliability.** Today every statement runs through a *single* shared `sqlite3` connection (`src/db.js:46`) opened at module load and never closed, with the default rollback journal (no WAL). Overlapping work — a scrape writing while the dashboard reads, or a maintenance script running alongside the server — can hit `SQLITE_BUSY` locks. Postgres' MVCC removes the single-writer cliff.
- **Postgres-native features / future-proofing.** Real `jsonb` querying, full-text search, window functions, and (later) `pgvector` for the coach. Standardize on a "proper" engine for where this is heading.

This stays a **single-user, local-first** application. Remote access and multi-user were explicitly *not* selected as motivations.

## 2. Non-goals (out of scope for this migration)

- **No auth, no multi-user, no per-user columns, no row-level security.** Single user.
- **No hosting / deployment.** Postgres runs locally in Docker. The connection is env-driven so a hosted instance is a one-line `.env` change later — but that is not built now.
- **No ORM / query builder.** Stay on raw SQL (matches today's style and keeps ANALYSIS.md's recipes valid).
- **`data/lsat-questions.json` (~5 MB) stays on disk.** It is a static question bank, not relational data; it is not absorbed into Postgres.
- **Deferred enhancements (separate follow-ups, see §14):** `jsonb` conversion, `pgvector` similarity, full-text search.

## 3. Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | App shape | Single-user, local-first |
| 2 | Runtime | Local Docker, `pgvector/pgvector:pg16`, env-driven `DATABASE_URL` |
| 3 | Data-access layer | Raw SQL on `pg`; numbered `.sql` migration files + tiny runner |
| 4 | Existing data | One-time ETL; preserve annotations + AI memory; keep old `.db` as rollback |
| 5 | Column types | Modernize timestamps → `timestamptz`; keep JSON as `text`; keep booleans as integer; `session_date` → `date`; `session_external_id` → `bigint` |
| 6 | Coach embeddings | Defer `pgvector`; keep JS-side cosine similarity for now |
| 7 | Maintenance scripts | Retire already-applied one-shots; port only `restore-purged-annotations.js` |
| 8 | Execution strategy | Big-bang on a feature branch; keep `.db` + `GMAT_DB_PATH` fallback as documented rollback |

## 4. Target architecture

```
┌──────────────────────────────────────────────────────────┐
│ Express API (src/server.js)  ── unchanged except 1 query  │
│        │ imports run/all/get + named writers              │
│        ▼                                                   │
│ src/db.js  ── pg.Pool, withTransaction(), RETURNING ids   │
│        │ DATABASE_URL                                      │
│        ▼                                                   │
│ Docker: pgvector/pgvector:pg16  (volume: pgdata)          │
└──────────────────────────────────────────────────────────┘
   schema applied by: scripts/migrate.js  (numbered .sql files)
   data loaded by:    scripts/migrate-sqlite-to-pg.js (one-time)
```

- **`docker-compose.yml`** at repo root: `pgvector/pgvector:pg16`, `POSTGRES_DB=gmat`, password from `.env`, port `5432`, named volume `pgdata`. pgvector is pre-installed in the image even though §6 defers its use.
- **`.env`**: `DATABASE_URL=postgres://postgres:<pw>@localhost:5432/gmat`. `.env.example` updated. The legacy `GMAT_DB_PATH` is retained only for the ETL/rollback (pointing at the old SQLite file), not for app runtime.
- **Dependency change**: add `pg`; remove `sqlite3` from app runtime (the ETL script keeps a dev-time `sqlite3` import to read the source file).
- **Connection**: a single module-level `pg.Pool` in `src/db.js`. Add `pool.end()` on `SIGINT`/`SIGTERM` (there is no shutdown handler today — a lifecycle gap the pool introduces).

## 5. Schema translation

The schema is **not** a 1:1 copy of the `CREATE TABLE` statements. `src/db.js initDb()` (lines 105–467) builds the live schema from CREATE **plus 34 runtime `ALTER TABLE ADD COLUMN`s** plus PRAGMA-guarded checks. The target DDL **folds every runtime ALTER into the base table definition** — a naive "translate the CREATEs" port would produce tables missing columns.

**14 logical tables** (row counts from the live DB):

| Table | Rows | Migration notes |
|---|---:|---|
| `question_attempts` | 3,603 | 19 runtime ALTER columns folded in; JSON-in-`text`; dynamic-typed `difficulty` |
| `sessions` | 277 | 8 score/percentile ALTER columns folded in; `session_external_id` → `bigint` |
| `scrape_runs` | 199 | FK parent (CASCADE) of `sessions` + `question_attempts` |
| `study_plan_tasks` | 151 | **`id` must be `GENERATED BY DEFAULT AS IDENTITY`** (explicit-id upsert, see below) |
| `lsat_attempts` | 68 | v2 table-swap → in-place constraint change; partial-NULL unique index |
| `study_plan_days` | 42 | natural `text` PK (`date`) |
| `coach_memories` | 28 | `embedding`/`metadata` stay `text` (pgvector deferred) |
| `coach_messages` | 21 | inline `REFERENCES`; `CHECK(role IN …)` ports as-is |
| `lsat_sessions` | 19 | `question_numbers` JSON-array stays `text` |
| `coach_sessions` | 6 | app-generated `text` PK; loose `run_id` integer (no FK) |
| `mock_results` | 0 | plain INSERT/UPDATE; **column order differs (`di` before `verbal`)** — ETL copies by name, never positionally |
| `study_plan_meta` | k/v | key/value store |
| `irt_cutoffs` | 0 | **rebuildable cache** — create empty, do not migrate data, drop the drop-on-boot |
| `lsat_attempts_v2` | — | transient migration artifact — **not** part of target schema |

**Type-translation rules:**

- **`INTEGER PRIMARY KEY AUTOINCREMENT` → `GENERATED ALWAYS AS IDENTITY`** on 8 tables (`scrape_runs`, `sessions`, `question_attempts`, `coach_messages`, `coach_memories`, `lsat_attempts`, `lsat_sessions`, `mock_results`). **Exception: the 9th, `study_plan_tasks.id` → `GENERATED BY DEFAULT AS IDENTITY`** because `replaceStudyPlan`/restore inserts *explicit* id values via `ON CONFLICT(id)` (db.js ~4156-4178); the IDENTITY sequence must be **resynced** (`setval`) after any explicit-id batch or the next auto-insert collides.
- **Timestamps → `timestamptz`** (decision #5) for `created_at`, `updated_at`, `extracted_at`, `completed_at`, `attempted_at`. Defaults `(datetime('now'))` → `DEFAULT now()`. This **fixes a real latent bug**: writers currently mix `datetime('now')` (`2026-06-13 10:00:00`) and JS `toISOString()` (`2026-06-13T10:00:00.000Z`) in the same columns, which sort differently as text (space `0x20` < `T` `0x54`), so "latest attempt/correct" logic can pick the wrong row. The ETL must parse **both** formats when loading these columns.
- **`session_date` → `date`** (values are `YYYY-MM-DD`). Note: the `corrected_later` composite key concatenates it (`session_date || ' ' || …`), so that expression needs `session_date::text` after the type change.
- **`session_external_id` → `bigint`** — holds synthesized 53-bit hashes for gmatclub/ttp that exceed int32.
- **Booleans stay integer** (decision #5): `question_attempts.correct` (NOT NULL, compared `= 1`/`= 0`) and `lsat_attempts.is_correct` (nullable 3-state). Converting to `boolean` would force rewriting every comparison and every `SUM(is_correct)` (`lsat-dashboard.js`, `lsatStats`) — not worth it.
- **JSON columns stay `text`** (decision #5): `answer_choices`, `response_details`, `metadata`, `embedding`, `question_numbers`. They round-trip via JS `JSON.parse`/`stringify`; keeping `text` means **zero reader changes**. (`jsonb` is a deferred follow-up — see §14.)
- **`difficulty` stays `text`** — dual-purpose (labels + legacy numeric strings). See the CAST guard in §8/§13.
- **`irt_cutoffs.sub_key DEFAULT ''`** — the empty string is an **intentional PK component** (Q/V use `''`, DI uses topic). The ETL must **not** coerce `''`→`NULL` or the natural PK `(subject_code, sub_key)` fragments.

## 6. Schema migration tooling

Replace `initDb()`'s imperative CREATE + ALTER + PRAGMA scheme with **plain numbered SQL files** and a tiny runner:

```
migrations/
  0001_init.sql            -- all 14 tables, full DDL (runtime ALTERs folded in), indexes, FKs
  0002_*.sql               -- future changes, append-only
scripts/migrate.js         -- ~30 lines: tracks applied files in a `schema_migrations` table,
                              runs unapplied files in order inside a transaction each
```

- `migrate.js` records applied filenames in a `schema_migrations(filename, applied_at)` table, runs each new file in a transaction, stops on error. Idempotent and ordered.
- `initDb()` shrinks to: ensure the pool is up, run `migrate.js`'s logic (or call it), done. No more `CREATE TABLE IF NOT EXISTS`/`ALTER … ADD COLUMN`/`PRAGMA` at boot.
- `irt_cutoffs` is created empty by `0001` and **rebuilt** by `recomputeIrtCutoffs()` — the `DROP TABLE … ; CREATE` on every boot (db.js:254) is removed (destructive DDL under a pool is dangerous).
- `npm run` scripts: `db:up` (docker compose up -d), `db:down`, `db:migrate`, `db:reset` (nuke volume + migrate), `db:etl` (one-time data load).

## 7. Data-access layer port (`src/db.js`)

**The three wrappers (db.js:48-82)** are rewritten once; call sites mostly stay put:

```js
const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// ? -> $n renumber happens here, so 207 call-sites with `?` need NO edit.
// Safe because every `?` is a bind placeholder (verified: none appear inside string literals/identifiers).
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`) }

const all = (sql, p = []) => pool.query(toPg(sql), p).then(r => r.rows)
const get = (sql, p = []) => all(sql, p).then(r => r[0])
const run = (sql, p = []) => pool.query(toPg(sql), p).then(r => ({ changes: r.rowCount }))
```

- **`result.lastID` → `RETURNING id`.** The `sqlite3` `this.lastID`/`this.changes` capture is gone. Every insert that consumed `lastID` appends `RETURNING id` and reads `rows[0].id`: `saveScrapeResult` (db.js:1122, 1258), `createLsatSession` (506), `createStudyPlanTask` (3747), `createMockResult` (4274), `coach-session.js:40`. `this.changes` reads → `rowCount`.
- **`buildInsertStatement` (db.js:84-91)** keeps emitting `?`; the wrapper renumbers them. No change needed beyond confirming param order.
- **Param-order caveat:** `LIMIT ?/OFFSET ?` params are pushed *after* the WHERE params in `listSessions`/`listErrors`; the positional array order is already correct, and `toPg` renumbers left-to-right, so it stays correct — but this is called out as a test target.
- **Dynamic SQL stays as-is** (it is code-controlled, not user input): the `ALLOWED_SORT` whitelist + forced `ASC`/`DESC` in `listErrors` (db.js:1635-1648, interpolated at 1980), the fixed-key dynamic SET builders in study-plan/mock updates, and the `IN (?,?,…)` list builders (db.js:814, 4127, 4150). Keep the whitelist; the IN-lists renumber cleanly (or switch to `= ANY($1::int[])` — optional).

## 8. SQLite-ism rewrite catalogue

All verified against line numbers in the audit. Grouped by how they fail:

**Blockers (error immediately):**
- `?` placeholders → `$n` (handled in wrapper, §7).
- `datetime('now')` (~40 sites: table defaults + inline INSERT/UPDATE + `coach-session.js:37,56`) → `now()` / `CURRENT_TIMESTAMP`.
- `AUTOINCREMENT` (9 tables) → `IDENTITY` (§5).
- `result.lastID` → `RETURNING id` (§7).

**Rewrites (no PG equivalent):**
- `PRAGMA table_info` / `PRAGMA index_list` (db.js:100, 319; `scripts/backfill-passage-text.js:21`) → gone with the migration-runner rewrite (§6); any residual introspection uses `information_schema`. `PRAGMA foreign_keys=ON` (106) → removed (PG always enforces FKs).
- `printf('%07d', q.id)` in the `corrected_later` composite-key CTEs (db.js:1914, 1923, 1963, 1967) → `lpad(q.id::text, 7, '0')`. **The CTE and the outer comparison must stay byte-identical** or ordering breaks; with `session_date::date`, the concat side needs `session_date::text`.
- `GLOB` (db.js:230-233 theta backfill; 1407 `difficultyBucketExpr`) → POSIX regex `~` (e.g. `col ~ '^-?\.?[0-9]'`).
- `DATE(s.session_date)` / `DATE(?)` (db.js:1443, 1447, 1622, 1626) → `s.session_date::date` / `?::date` (or direct compare since values are `YYYY-MM-DD`).
- `ROUND(AVG(int_col), 0)` (db.js:1455-1457, 2502, 2569, 2591, 2603, 2615, 2627, 2650, 2717-2718, …) → `ROUND(AVG(col)::numeric, 0)`. PG has no `ROUND(double precision, integer)`.
- `lsat_attempts` v2 table-swap (db.js:318-349) → in-place `ALTER TABLE … DROP/ADD CONSTRAINT`; the partial unique index ports as `CREATE UNIQUE INDEX … WHERE session_id IS NOT NULL` (Postgres supports partial indexes).

**Minor (port cleanly if types preserved):**
- Booleans as 0/1 — no change (kept integer).
- JSON-in-`text` — no change (kept text).
- `CAST(difficulty AS REAL)` (db.js:222-225, 1409-1410) — valid in PG but **errors on a non-numeric string** (SQLite returns `0.0`). Keep the GLOB→regex pre-filter that guards it.
- `LOWER(...) LIKE '%…%'` / `UPPER(col) LIKE UPPER(?)` — already case-normalized; **not** a problem, no `ILIKE` needed.

## 9. One-time data ETL — `scripts/migrate-sqlite-to-pg.js`

```
1. Open data/gmat-error-log.db read-only (sqlite3 OPEN_READONLY) and DATABASE_URL pool.
2. Pre-flight: assert target schema is migrated and tables are empty (refuse to double-load).
3. For each table in FK dependency order:
     scrape_runs → sessions → question_attempts → lsat_sessions → lsat_attempts
     → coach_sessions → coach_messages → coach_memories
     → study_plan_tasks → study_plan_days → study_plan_meta → mock_results
   - SELECT * from SQLite, transform per row:
       · timestamps (created_at/updated_at/extracted_at/completed_at/attempted_at):
         parse BOTH 'YYYY-MM-DD HH:MM:SS' and ISO 'YYYY-MM-DDTHH:MM:SS.sssZ' → timestamptz
       · session_date → date ; session_external_id → bigint
       · JSON columns: pass through verbatim (still text)
       · preserve '' sentinels (do NOT coerce to NULL)
       · copy by COLUMN NAME, never positionally (mock_results has di before verbal)
   - Batch INSERT (parameterized, ~500 rows/batch) inside a transaction per table.
4. Skip irt_cutoffs (rebuilt by recomputeIrtCutoffs() post-load) and lsat_attempts_v2 (transient).
5. Resync IDENTITY sequences to MAX(id)+1 for every IDENTITY table (esp. study_plan_tasks).
6. Verify: assert per-table COUNT(*) matches SQLite source; print a diff table; exit non-zero on mismatch.
7. (post) run recomputeIrtCutoffs() to rebuild the cache.
```

- Idempotency: the pre-flight empty-check + an explicit `--force` flag to re-run after `db:reset`.
- Verify against the live counts the audit captured (question_attempts 3603, sessions 277, scrape_runs 199, study_plan_tasks 151, lsat_attempts 68, study_plan_days 42, coach_memories 28, coach_messages 21, lsat_sessions 19, coach_sessions 6, mock_results 0).

## 10. Concurrency correctness (the point of the migration)

This is the highest-risk area — it will *not* error on a naive port, it will silently misbehave.

- **`withTransaction(fn)` helper**: checks out one client via `pool.connect()`, runs `BEGIN`/`COMMIT`/`ROLLBACK` **on that client**, releases it. Every bare `run('BEGIN')`/`run('COMMIT')`/`run('ROLLBACK')` (db.js:3840, 3851, 3853, 3911, 4023, 4055, 4082-4098, 4122-4196, 4207-4216) is converted to run inside `withTransaction`. On a pool, the bare strings would otherwise land on *different* connections — BEGIN on one, writes on another — committing nothing or partial writes, no error raised.
- **Wrap `saveScrapeResult` (db.js:1094-1366) in a transaction.** Its `DELETE FROM question_attempts WHERE session_id=?` (1206) followed by per-question re-INSERT is non-atomic *today* and only safe because SQLite serializes one connection. Under PG concurrency, a reader can observe the deleted-but-not-yet-reinserted window (a session showing 0 questions), and two concurrent scrapes can interleave. Wrap the whole per-session delete+reinsert in `withTransaction`.
- **Wrap the Phase-2 enrichers** (`enrichSessionAttempts` db.js:2982, `enrichGmatClubSessionAttempts` 3349, `enrichOpeSessionAttempts` 3437) — currently bare sequential UPDATEs — one transaction per session.
- **Pool sizing**: modest `max` (e.g. 10) is plenty for single-user; document it.

## 11. Maintenance scripts disposition (decision #7)

8 scripts in `scripts/` open their own `sqlite3.Database` — a second DB surface beyond `src/db.js`.

- **Retire / archive (effects already baked into the migrated data):** `backfill-my-answer.js`, `backfill-ope-matrix-format.js`, `backfill-q-id-composite.js`, `backfill-verbal-pick.js`, `backfill-passage-text.js`, `repair-pickbycolor-falsepos.js`, `migrate-tags-v3.js`. Move to `scripts/archive/` (keep git history) or delete. These ran once against the live data; the ETL carries their results forward.
- **Port to Postgres (ongoing utility):** `restore-purged-annotations.js` — restores `mistake_type`/`notes` from a backup. Rework it to read a backup source and write via the `pg` pool. (Its current "read a `.bak` SQLite file in OPEN_READONLY" mode has no PG analogue; redefine "backup" as a prior pg dump or a kept SQLite snapshot read via the ETL reader.)

## 12. Cutover, validation & rollback

1. All work on a branch (e.g. `feat/postgres-migration`). Old `data/gmat-error-log.db` is untouched throughout.
2. `npm run db:up && npm run db:migrate && npm run db:etl` → counts verified.
3. **Validation checklist** (manual, single-user app, no test suite): boot the server against PG; load the dashboard; spot-check sessions list, error log (sort + every platform filter), pattern view, a session deep-dive modal, the AI coach panel + memory, the study plan (reorder, restore), LSAT dashboard, mock results. Run a Phase-1 scrape and a Phase-2 enrich end-to-end. Confirm no `database is locked`-class errors and that annotations survived.
4. **Rollback:** revert the branch; the SQLite file is intact. During a transition window the app can still be pointed at SQLite via the old code path on `main`. Document the exact rollback command sequence in the PR.
5. Update `README.md`, `.env.example`, and `CLAUDE.md` (the "Backend" / "Key Patterns" sections describe SQLite specifics — `INSERT OR REPLACE`, raw SQLite3, the two-phase upsert — these need updating to the PG reality).

## 13. Risks & silent-break checklist (verify each before merge)

1. **Case-sensitive `LIKE` in the big CASE blocks.** PG `LIKE` is case-sensitive; SQLite's is case-insensitive for ASCII. The platform/search filters are already `LOWER(...)`-wrapped (safe), **but every `LIKE` inside `categoryHintExpr`/`topicExpr`/`subjectExpr` (db.js:1669-1825) must be individually checked** — any raw-column `LIKE 'literal'` without `LOWER` will silently stop matching and mis-bucket topics. Do not assume; verify each.
2. **Integer division guarded only by the `100.0` literal.** All accuracy %s use `100.0 * SUM(...)/…`. No bare integer division exists today and div-by-zero is structurally guarded (`CASE WHEN SUM(...) > 0 … ELSE NULL`). Migration risk = a transcription that reorders operands or drops `100.0`. Keep the guards; PG raises on `/0` where SQLite returned NULL.
3. **Dynamic-typed `difficulty` CAST.** Keep the GLOB→regex pre-filter on every `CAST(... AS REAL)` site, or PG errors on a stray non-numeric string. Pre-flight the source: confirm zero numeric-string `difficulty` rows remain (the one-time backfill at db.js:220-235 should already have run — verify, since the ETL copies `difficulty` verbatim).
4. **Empty-string PK sentinel** (`irt_cutoffs.sub_key`) — ETL must preserve `''`.
5. **IDENTITY sequence resync** after explicit-id inserts (`study_plan_tasks`) — §5/§9 step 5.
6. **Timestamp lexical ordering** — fixed by the `timestamptz` conversion, *provided* the ETL parses both source formats (§9).
7. **`coach_sessions.run_id`** is a loose integer with no FK. Do **not** add an FK in the migration without first checking for orphaned rows.
8. **`mock_results` column order** (`di` before `verbal`) — ETL copies by name (§9).

## 14. Deferred follow-ups (explicitly out of this migration)

Each is a small, independent PR once the core migration is validated:
- **`jsonb` conversion** of `answer_choices`/`response_details`/`metadata`/`question_numbers` — requires removing JS-side `JSON.parse` at every reader (node-pg returns `jsonb` pre-parsed). Enables in-SQL JSON querying.
- **`pgvector`** for `coach_memories.embedding` — move similarity from JS into `ORDER BY embedding <=> $1` + an index. (Image already supports it; 28 rows.)
- **Full-text search** on stems/notes via `tsvector` + GIN.

## 15. Workstream sequencing

These map to plan phases (the detailed step-by-step comes from the writing-plans skill next):

1. **Infra** — docker-compose, `.env`/`.env.example`, `pg` dep, `npm run db:*` scripts.
2. **Schema** — author `migrations/0001_init.sql` (all tables, ALTERs folded in, indexes, FKs, partial index) + `scripts/migrate.js`.
3. **DB core** — rewrite `run/all/get` for `pg.Pool`, `toPg` renumber, `withTransaction`, `pool.end()` shutdown.
4. **Query port** — RETURNING ids, the §8 SQLite-ism rewrites, transaction-wrap `saveScrapeResult` + enrichers; port `coach-session.js`/`memory.js`/`lsat-dashboard.js`/`server.js`'s one query.
5. **ETL** — `scripts/migrate-sqlite-to-pg.js` with count verification.
6. **Scripts** — archive one-shots, port `restore-purged-annotations.js`.
7. **Cutover** — run ETL, validation checklist, docs (`README`/`CLAUDE.md`/`.env.example`), rollback notes in the PR.

## Appendix — primary files touched

`src/db.js` (the bulk), `src/server.js` (1 query + nothing else), `src/coach-session.js`, `src/memory.js`, `src/lsat-dashboard.js`; new: `docker-compose.yml`, `.env.example`, `migrations/0001_init.sql`, `scripts/migrate.js`, `scripts/migrate-sqlite-to-pg.js`; docs: `README.md`, `CLAUDE.md`. Untouched: `scraper-runner.js`, `scrapers/*`, `llm-coach-agent.js`, `question-topic-classifier.js`, `question-metadata.js`, the React frontend (all consume the API, not the DB).
