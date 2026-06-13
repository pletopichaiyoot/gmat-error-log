# SQLite → PostgreSQL Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SQLite data layer with a local Docker PostgreSQL 16 instance, porting all raw SQL to `node-postgres`, and migrate the existing ~6.1 MB database with zero data loss.

**Architecture:** Raw SQL stays (no ORM). The three `run/all/get` wrappers in `src/db.js` are rewritten over a `pg.Pool`; a `toPg()` helper renumbers `?`→`$n` inside the wrapper so the ~430 call-sites need no edits. Schema moves from imperative `CREATE`+`ALTER`+`PRAGMA` at boot to numbered `.sql` files applied by a tiny runner. A one-time ETL copies the live SQLite data into Postgres. Big-bang on a feature branch; the old `.db` is the rollback.

**Tech Stack:** Node 20 (CommonJS), Express, `pg` (new), `pgvector/pgvector:pg16` via Docker Compose, `node:test` (built-in) for unit tests, the existing `sqlite3` kept only as a dev-time ETL reader.

**Reference spec:** `docs/superpowers/specs/2026-06-13-postgres-migration-design.md` (read it for the rationale, the silent-break checklist, and the locked decisions).

**Conventions for every task:**
- All commands run from the repo root `/Users/pletopichaiyoot/Desktop/codespace/gmat-error-log`.
- Docker Desktop must be running. Postgres must be up (`npm run db:up`) before any `db:migrate`, `db:etl`, or verify step.
- The live SQLite file must remain at `data/gmat-error-log.db` untouched throughout (it is the ETL source and the rollback).
- Commit after each task with the message shown.

---

## Task 1: Feature branch, dependencies, Docker Compose, env

**Files:**
- Create: `docker-compose.yml`
- Modify: `package.json` (deps + scripts)
- Modify: `.env.example`
- Modify: `.gitignore` (ensure `.env` ignored — verify only)

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b feat/postgres-migration
```

- [ ] **Step 2: Add the `pg` dependency**

Run:
```bash
npm install pg@^8.13.0
```
Expected: `pg` added to `package.json` dependencies, no errors. (Keep `sqlite3` — the ETL reads the old file with it.)

- [ ] **Step 3: Write `docker-compose.yml`**

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    container_name: gmat-pg
    environment:
      POSTGRES_DB: gmat
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: gmat
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d gmat"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  pgdata:
```

- [ ] **Step 4: Add npm scripts to `package.json`**

Add these to the `"scripts"` block (keep existing scripts):
```json
"db:up": "docker compose up -d && until docker exec gmat-pg pg_isready -U postgres -d gmat; do sleep 1; done",
"db:down": "docker compose down",
"db:reset": "docker compose down -v && npm run db:up && npm run db:migrate",
"db:migrate": "node scripts/migrate.js",
"db:etl": "node scripts/migrate-sqlite-to-pg.js",
"db:verify": "node scripts/verify-schema-parity.js && node scripts/verify-migration.js",
"test": "node --test \"test/unit/*.test.js\""
```
(Node 24 treats `node --test test/unit/` as a module path and crashes; the quoted glob is robust across shells.)

- [ ] **Step 5: Update `.env.example`**

Add (keep existing keys like `OPENAI_API_KEY`):
```
# PostgreSQL (local Docker). For a hosted instance, change only this line.
DATABASE_URL=postgres://postgres:gmat@localhost:5432/gmat
# Legacy SQLite path — used ONLY by the one-time ETL and rollback, not at runtime.
GMAT_DB_PATH=./data/gmat-error-log.db
```

- [ ] **Step 6: Create your real `.env`**

```bash
grep -q '^DATABASE_URL=' .env || echo 'DATABASE_URL=postgres://postgres:gmat@localhost:5432/gmat' >> .env
```
Expected: `.env` now contains `DATABASE_URL`. Confirm `.env` is gitignored: `git check-ignore .env` prints `.env`.

- [ ] **Step 7: Bring Postgres up**

Run:
```bash
npm run db:up
```
Expected: container `gmat-pg` starts and `pg_isready` eventually prints `... accepting connections`.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml package.json package-lock.json .env.example
git commit -m "chore(db): add postgres docker-compose, pg dep, db npm scripts"
```

---

## Task 2: Pure SQL helpers (`toPg`, `toTimestamptz`) with unit tests — TDD

These two pure functions carry the most mechanical risk (placeholder renumbering, dual-format timestamp parsing). They live in their own module so they unit-test with **zero** DB connection.

**Files:**
- Create: `src/sql-util.js`
- Test: `test/unit/sql-util.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/sql-util.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { toPg, toTimestamptz } = require('../../src/sql-util');

test('toPg renumbers ? to $1,$2 left-to-right', () => {
  assert.equal(
    toPg('SELECT * FROM t WHERE a = ? AND b = ?'),
    'SELECT * FROM t WHERE a = $1 AND b = $2'
  );
});

test('toPg handles an INSERT placeholder list', () => {
  assert.equal(toPg('INSERT INTO t (a,b,c) VALUES (?, ?, ?)'),
               'INSERT INTO t (a,b,c) VALUES ($1, $2, $3)');
});

test('toPg leaves a no-placeholder query unchanged', () => {
  assert.equal(toPg('SELECT 1'), 'SELECT 1');
});

test('toTimestamptz parses SQLite datetime() UTC format as a Date', () => {
  const d = toTimestamptz('2026-06-13 10:00:00');
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString(), '2026-06-13T10:00:00.000Z');
});

test('toTimestamptz passes through ISO toISOString() format', () => {
  const d = toTimestamptz('2026-06-13T10:00:00.000Z');
  assert.equal(d.toISOString(), '2026-06-13T10:00:00.000Z');
});

test('toTimestamptz maps null/empty to null', () => {
  assert.equal(toTimestamptz(null), null);
  assert.equal(toTimestamptz(''), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/sql-util.test.js`
Expected: FAIL — `Cannot find module '../../src/sql-util'`.

- [ ] **Step 3: Write the implementation**

```js
// src/sql-util.js
// Pure helpers for the SQLite -> Postgres port. No DB dependency (unit-testable).

// Rewrite SQLite '?' positional placeholders to Postgres $1,$2,... left-to-right.
// Safe for every query in this codebase: verified that no SQL string contains a
// literal '?' inside a string literal or identifier — all '?' are bind params.
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Parse the two timestamp text formats the SQLite DB stored into a JS Date that
// node-postgres serializes to timestamptz: SQLite datetime('now') -> UTC
// 'YYYY-MM-DD HH:MM:SS' (no zone marker), and JS toISOString() -> ISO 'YYYY-MM-DDTHH:MM:SS.sssZ'.
function toTimestamptz(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (s.includes('T')) return new Date(s);          // already ISO/zoned
  return new Date(s.replace(' ', 'T') + 'Z');         // SQLite UTC, no marker
}

module.exports = { toPg, toTimestamptz };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/sql-util.test.js`
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sql-util.js test/unit/sql-util.test.js
git commit -m "feat(db): pure ?->\$n and timestamptz helpers with unit tests"
```

---

## Task 3: Schema DDL — `migrations/0001_init.sql`

Full target schema with all 34 runtime `ALTER ADD COLUMN`s folded into base tables, types translated per the spec. This file is the authoritative schema.

**Files:**
- Create: `migrations/0001_init.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- migrations/0001_init.sql
-- Target schema for the SQLite -> Postgres migration. Runtime ALTERs folded in.
-- Type rules: AUTOINCREMENT -> IDENTITY; timestamps -> timestamptz DEFAULT now();
-- session_date -> date; session_external_id -> bigint; booleans kept as integer;
-- JSON kept as text (jsonb deferred). date-string PKs (study_plan_days.date,
-- day_date, mock_date) kept text to preserve join/PK semantics.

CREATE TABLE schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scrape_runs (
  id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  extracted_at       timestamptz NOT NULL,
  since_value        text,
  source             text,
  review_category_id integer,
  total_sessions     integer NOT NULL,
  total_questions    integer NOT NULL,
  total_errors       integer NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id                     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id                 integer NOT NULL REFERENCES scrape_runs(id) ON DELETE CASCADE,
  session_external_id    bigint  NOT NULL,
  session_date           date,
  source                 text,
  subject                text,
  total_q_api            integer,
  total_q_categories     integer,
  correct_count          integer,
  error_count            integer,
  accuracy_pct           real,
  avg_time_sec           integer,
  avg_correct_time_sec   integer,
  avg_incorrect_time_sec integer,
  created_at             timestamptz NOT NULL DEFAULT now(),
  total_score            integer,
  total_percentile       integer,
  quant_score            integer,
  quant_percentile       integer,
  verbal_score           integer,
  verbal_percentile      integer,
  di_score               integer,
  di_percentile          integer,
  UNIQUE (run_id, session_external_id)
);

CREATE TABLE question_attempts (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id           integer NOT NULL REFERENCES scrape_runs(id) ON DELETE CASCADE,
  session_id       integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  q_code           text,
  q_id             text,
  cat_id           integer,
  subject_code     text,
  category_code    text,
  subcategory      text,
  subject_sub      text,
  subject_sub_raw  text,
  question_url     text,
  question_stem    text,
  answer_choices   text,
  response_format  text,
  response_details text,
  correct          integer NOT NULL,
  difficulty       text,
  confidence       text,
  time_sec         integer,
  my_answer        text,
  correct_answer   text,
  topic            text,
  topic_source     text,
  content_domain   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  mistake_type     text,
  notes            text,
  passage_text     text,
  difficulty_theta real,
  taxonomy_path    text
);

-- Rebuildable cache (NOT dropped on boot anymore; recomputeIrtCutoffs() repopulates).
CREATE TABLE irt_cutoffs (
  subject_code text NOT NULL,
  sub_key      text NOT NULL DEFAULT '',
  p33          real NOT NULL,
  p67          real NOT NULL,
  n            integer NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_code, sub_key)
);

CREATE TABLE coach_sessions (
  id         text PRIMARY KEY,
  title      text DEFAULT '',
  run_id     integer,            -- intentionally NO FK (loose ref; see spec §13)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coach_messages (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id text NOT NULL REFERENCES coach_sessions(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user','assistant','system')),
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coach_memories (
  id         text PRIMARY KEY,
  content    text NOT NULL,
  embedding  text NOT NULL,      -- JSON float array as text (pgvector deferred)
  metadata   text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lsat_attempts (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  test_num        integer NOT NULL,
  section_roman   text NOT NULL,
  section_kind    text NOT NULL,
  question_number integer NOT NULL,
  user_answer     text NOT NULL,
  correct_answer  text,
  is_correct      integer,        -- nullable 3-state, kept integer
  confidence      text,
  time_ms         integer,
  session_id      integer,
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  mistake_type    text,
  notes           text
);

CREATE TABLE lsat_sessions (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  test_num         integer NOT NULL,
  section_roman    text NOT NULL,
  section_kind     text NOT NULL,
  set_key          text NOT NULL,
  set_label        text,
  first_question   integer NOT NULL,
  last_question    integer NOT NULL,
  mode             text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  question_numbers text             -- JSON array as text
);

CREATE TABLE study_plan_tasks (
  id           integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, -- explicit-id upsert
  day_date     text NOT NULL,
  week_number  integer NOT NULL,
  day_label    text,
  day_theme    text,
  position     integer NOT NULL DEFAULT 0,
  title        text NOT NULL,
  description  text,
  est_minutes  integer,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped')),
  completed_at timestamptz,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE study_plan_days (
  date        text PRIMARY KEY,
  week_number integer NOT NULL DEFAULT 1,
  day_label   text,
  day_theme   text,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE study_plan_meta (
  key        text PRIMARY KEY,
  value      text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mock_results (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mock_date         text NOT NULL,
  source_label      text NOT NULL,
  total_score       integer,
  total_percentile  integer,
  quant_score       integer,
  quant_percentile  integer,
  di_score          integer,
  di_percentile     integer,
  verbal_score      integer,
  verbal_percentile integer,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Indexes (CREATE INDEX IF NOT EXISTS is supported by Postgres).
CREATE INDEX idx_sessions_run_id ON sessions(run_id);
CREATE INDEX idx_sessions_external_source ON sessions(session_external_id, source);
CREATE INDEX idx_questions_run_id ON question_attempts(run_id);
CREATE INDEX idx_questions_correct ON question_attempts(correct);
CREATE INDEX idx_questions_q_code ON question_attempts(q_code);
CREATE INDEX idx_questions_q_id ON question_attempts(q_id);
CREATE INDEX idx_questions_topic ON question_attempts(topic);
CREATE INDEX idx_questions_difficulty ON question_attempts(difficulty);
CREATE INDEX idx_coach_messages_session ON coach_messages(session_id);
CREATE INDEX idx_coach_memories_created ON coach_memories(created_at DESC);
CREATE INDEX idx_lsat_attempts_test ON lsat_attempts(test_num, section_roman);
CREATE INDEX idx_lsat_attempts_session ON lsat_attempts(session_id);
-- session_id is nullable; Postgres default NULLS DISTINCT matches SQLite (multiple
-- NULL session_id rows allowed), so a plain unique index reproduces the behavior.
CREATE UNIQUE INDEX uq_lsat_attempts_session_q
  ON lsat_attempts(test_num, section_roman, question_number, session_id);
CREATE INDEX idx_lsat_sessions_test ON lsat_sessions(test_num, section_roman);
CREATE INDEX idx_lsat_sessions_started ON lsat_sessions(started_at DESC);
CREATE INDEX idx_study_plan_day ON study_plan_tasks(day_date);
CREATE INDEX idx_study_plan_week ON study_plan_tasks(week_number);
CREATE INDEX idx_study_plan_status ON study_plan_tasks(status);
CREATE INDEX idx_study_plan_days_order ON study_plan_days(sort_order);
CREATE INDEX idx_mock_results_date ON mock_results(mock_date);
```

- [ ] **Step 2: Commit**

```bash
git add migrations/0001_init.sql
git commit -m "feat(db): postgres schema migration 0001 (ALTERs folded, types translated)"
```

---

## Task 4: Migration runner — `scripts/migrate.js`

Applies unapplied `migrations/*.sql` in filename order, each in its own transaction, tracked in `schema_migrations`. Exports `runMigrations(pool)` so `initDb()` can reuse it.

**Files:**
- Create: `scripts/migrate.js`

- [ ] **Step 1: Write the runner**

```js
// scripts/migrate.js
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

async function runMigrations(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set(
    (await pool.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename)
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

module.exports = { runMigrations };

if (require.main === module) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  runMigrations(pool)
    .then(() => { console.log('migrations up to date'); return pool.end(); })
    .catch((err) => { console.error(err); process.exit(1); });
}
```

> Note: `0001_init.sql` includes its own `CREATE TABLE schema_migrations`; the runner's `CREATE TABLE IF NOT EXISTS` makes that harmless. If the duplicate `CREATE TABLE schema_migrations` inside the file errors (it is non-`IF NOT EXISTS`), delete the line from `0001_init.sql` — the runner owns that table. Do this now: remove the `CREATE TABLE schema_migrations (...)` block from `migrations/0001_init.sql`.

- [ ] **Step 2: Apply the migration against the running Postgres**

Run:
```bash
npm run db:migrate
```
Expected: `applied 0001_init.sql` then `migrations up to date`.

- [ ] **Step 3: Verify the tables exist**

Run:
```bash
docker exec gmat-pg psql -U postgres -d gmat -c "\dt"
```
Expected: 14 app tables + `schema_migrations` listed.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate.js migrations/0001_init.sql
git commit -m "feat(db): migration runner; remove duplicate schema_migrations DDL"
```

---

## Task 5: Rewrite the connection + wrappers in `src/db.js`

**Files:**
- Modify: `src/db.js:1-106` (imports, connection, `run/all/get`, `ensureQuestionAttemptsColumn`, `initDb` head)

- [ ] **Step 1: Replace the imports and connection (db.js:1-46)**

Replace lines 1-9 and 42-46 region. New top of file:
```js
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { toPg, toTimestamptz } = require('./sql-util');
const { runMigrations } = require('../scripts/migrate');
const { deriveQuestionMetadata, enrichQuestionMetadata } = require('./question-metadata');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// Close the pool once on shutdown (the SQLite version never closed; a pool must).
let poolClosing = false;
function closePool() {
  if (poolClosing) return Promise.resolve();
  poolClosing = true;
  return pool.end();
}
process.on('SIGINT', () => closePool().finally(() => process.exit(0)));
process.on('SIGTERM', () => closePool().finally(() => process.exit(0)));
```
Delete: the `sqlite3` require, `dbDir`/`dbPath` resolution, the `fs.existsSync(dbDir)` mkdir block, `const db = new sqlite3.Database(dbPath)`. (`QUESTION_ATTEMPT_INSERT_COLUMNS` at lines 10-40 stays unchanged.) `toTimestamptz` is imported here for later tasks; if lint flags it unused until then, that is fine (the config warns, not errors).

- [ ] **Step 2: Rewrite the three wrappers (db.js:48-82)**

```js
async function run(sql, params = []) {
  const res = await pool.query(toPg(sql), params);
  return { changes: res.rowCount };
}

async function all(sql, params = []) {
  const res = await pool.query(toPg(sql), params);
  return res.rows;
}

async function get(sql, params = []) {
  const res = await pool.query(toPg(sql), params);
  return res.rows[0];
}

// Run fn inside a single pooled-client transaction. fn receives {run, get, all}
// bound to that client so multi-statement writes are atomic on ONE connection.
async function withTransaction(fn) {
  const client = await pool.connect();
  const crun = async (sql, p = []) => ({ changes: (await client.query(toPg(sql), p)).rowCount });
  const call = async (sql, p = []) => (await client.query(toPg(sql), p)).rows;
  const cget = async (sql, p = []) => (await client.query(toPg(sql), p)).rows[0];
  try {
    await client.query('BEGIN');
    const result = await fn({ run: crun, all: call, get: cget });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* surface original */ }
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 3: Replace `ensureQuestionAttemptsColumn` + `initDb` head (db.js:99-106)**

`ensureQuestionAttemptsColumn` (used PRAGMA) is obsolete — the schema is now complete in `0001_init.sql`. Delete the function (lines 99-103) and all 19 `await ensureQuestionAttemptsColumn(...)` calls (db.js:192-212).

Replace `initDb()`'s head. Old lines 105-106 (`async function initDb() {` + `await run('PRAGMA foreign_keys = ON');`) become:
```js
async function initDb() {
  await runMigrations(pool);
```
Delete from `initDb` the entire DDL/ALTER/PRAGMA body that `0001_init.sql` now owns: the `CREATE TABLE` blocks, the `for (const col of [...]) ALTER sessions` loop (146-157), the `ensureQuestionAttemptsColumn` calls (192-212), the `CREATE INDEX` statements (237-246, 286, 297, 358-362, 381-382, 407-409, 426, 464), the `DROP TABLE IF EXISTS irt_cutoffs` + `CREATE TABLE irt_cutoffs` (254-265), and the `lsat_attempts` PRAGMA-detect/v2-swap block (318-349). **Keep** the one-time difficulty backfill (220-235) for now — Task 7 ports it. **Keep** the idempotent seed calls: `await backfillStudyPlanDays();` (429), `await rebucketWeeksMonSunOnce();` (441), `await backfillSparseQuestionAttempts();` (466). After edits, `initDb` is: `runMigrations` → difficulty backfill (ported in Task 7) → the three seed/backfill calls.

- [ ] **Step 4: Export `withTransaction` and `closePool`**

In the `module.exports` block at the bottom of `db.js`, add `withTransaction` and `closePool` alongside the existing exports.

- [ ] **Step 5: Smoke-check the module loads and initializes**

Run:
```bash
node -e "require('dotenv').config(); const db=require('./src/db'); db.initDb().then(()=>{console.log('initDb OK'); return db.closePool();}).catch(e=>{console.error(e);process.exit(1);})"
```
Expected: `migrations up to date` (already applied) then `initDb OK`, exit 0. (If `dotenv` isn't a dep, prefix the command with `DATABASE_URL=postgres://postgres:gmat@localhost:5432/gmat`.)

- [ ] **Step 6: Run unit tests (still green)**

Run: `npm test`
Expected: PASS — the `sql-util` tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/db.js
git commit -m "feat(db): pg.Pool wrappers, withTransaction, initDb runs migrations"
```

---

## Task 6: Port `RETURNING id` insert sites

`pg` has no `lastID`. Every insert that consumed it appends `RETURNING id` and reads `rows[0].id` via `all()`.

**Files:**
- Modify: `src/db.js` (lines ~1099-1122, ~1244-1258, `createLsatSession` ~501-506, `createStudyPlanTask` ~3747, `createMockResult` ~4274)
- Modify: `src/coach-session.js:~40`

- [ ] **Step 1: `saveScrapeResult` — scrape_runs insert (db.js:1099-1122)**

Change `const runInsert = await run(` to `const runInsert = await all(`, append `RETURNING id` to the SQL (after the `VALUES (...)`), and change `const runId = runInsert.lastID;` to `const runId = runInsert[0].id;`. Resulting SQL tail:
```sql
      ) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
```

- [ ] **Step 2: `saveScrapeResult` — sessions insert (db.js:~1230-1258)**

The session `INSERT` (whose result is read at `sessionId = sessionInsert.lastID;`, line 1258): change its `await run(` to `await all(`, append `RETURNING id` to that INSERT's SQL, and change line 1258 to `sessionId = sessionInsert[0].id;`.

- [ ] **Step 3: `createLsatSession` (db.js:501-506)**

```js
  const result = await all(
    `INSERT INTO lsat_sessions (test_num, section_roman, section_kind, set_key, set_label, first_question, last_question, mode, question_numbers)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [testNum, sectionRoman, sectionKind, setKey, setLabel || null, firstQuestion, lastQuestion, mode || null, qn]
  );
  return { id: result[0].id };
```

- [ ] **Step 4: `createStudyPlanTask` (db.js:~3747) and `createMockResult` (db.js:~4274)**

Apply the identical pattern at each: switch `run(` → `all(`, append ` RETURNING id` to the INSERT, and read the new id as `result[0].id` (replacing the `.lastID` read). Read each function first to confirm the variable name holding the result.

- [ ] **Step 5: `coach-session.js` (~line 40)**

The insert into `coach_messages` reads `result.lastID`. Switch to `all(... RETURNING id)` and read `result[0].id`. (This file imports `run/all/get` from `./db`.)

- [ ] **Step 6: Verify a write path end-to-end after Task 11's ETL** — for now just confirm the module still loads:

Run: `node -e "DATABASE_URL=$DATABASE_URL node; " 2>/dev/null; node -e "require('./src/db'); require('./src/coach-session'); console.log('require OK')"`
Expected: `require OK`.

- [ ] **Step 7: Commit**

```bash
git add src/db.js src/coach-session.js
git commit -m "feat(db): use RETURNING id for all insert id reads (no lastID in pg)"
```

---

## Task 7: Port SQLite-specific SQL constructs

All mechanical, verified against line numbers. Do each, then run the smoke query.

**Files:**
- Modify: `src/db.js`

- [ ] **Step 1: `datetime('now')` → `now()` everywhere**

Replace every literal `datetime('now')` with `now()` across `src/db.js` (table-default DDL is already gone; remaining sites are inline INSERT/UPDATE, e.g. db.js:484, 491, 519, 3615, 3798, 3846, 3869-3870, 3915, 4027, 4036, 4087, 4092, 4141, 4173, 4186-4187, 4291). Run a grep to confirm none remain:
```bash
grep -rn "datetime('now')" src/ && echo "STILL PRESENT" || echo "clean"
```
Expected (after edits): `clean`.

- [ ] **Step 2: `difficultyBucketExpr` GLOB → POSIX regex (db.js:1403-1415)**

Replace the GLOB line so the function reads:
```js
function difficultyBucketExpr(alias = 'q') {
  const col = `${alias}.difficulty`;
  return `CASE
    WHEN COALESCE(NULLIF(${col}, ''), '') = '' THEN 'Unknown'
    WHEN ${col} ~ '^-?\\.?[0-9]' THEN
      CASE
        WHEN CAST(${col} AS REAL) < -0.43 THEN 'Easy'
        WHEN CAST(${col} AS REAL) > 0.43 THEN 'Hard'
        ELSE 'Medium'
      END
    ELSE ${col}
  END`;
}
```
The regex `^-?\.?[0-9]` matches all four original GLOB branches (optional leading `-`, optional `.`, then a digit) and keeps guarding the `CAST(... AS REAL)` against non-numeric strings.

- [ ] **Step 3: One-time difficulty backfill GLOB → regex (db.js:220-235, kept in initDb)**

Replace the four `difficulty GLOB '...'` lines with a single regex condition:
```sql
    WHERE difficulty_theta IS NULL
      AND difficulty ~ '^-?\.?[0-9]'
```
(Keep the `SET difficulty_theta = CAST(difficulty AS REAL), difficulty = CASE ... END` body unchanged — `CAST(... AS REAL)` is valid in PG and the regex guard prevents non-numeric input.)

- [ ] **Step 4: `DATE()` filters (db.js:1443, 1447, 1622, 1626)**

`session_date` is now a `date` column. Replace:
- `'DATE(s.session_date) >= DATE(?)'` → `'s.session_date >= ?::date'`
- `'DATE(s.session_date) <= DATE(?)'` → `'s.session_date <= ?::date'`
Apply the same at the two listErrors sites (1622, 1626), matching their exact alias (`s.`).

- [ ] **Step 5: `ROUND(AVG(int), 0)` → `ROUND(AVG(int)::numeric, 0)`**

At every site, cast the `AVG(...)` to `numeric` before the 2-arg `ROUND`. Sites: db.js:1455, 1456, 1457, and the analytics aggregates at 2502, 2569, 2591, 2603, 2615, 2627, 2650, 2717-2718. Pattern, e.g. line 1455:
```js
  const answeredAvgTimeExpr = `ROUND(AVG(CASE WHEN NOT (${unansweredExpr}) THEN q.time_sec END)::numeric, 0)`;
```
Grep to find any remaining 2-arg ROUND over AVG:
```bash
grep -rn "ROUND(AVG" src/db.js
```
Confirm each hit now has `::numeric` before `, 0)`.

- [ ] **Step 6: `printf('%07d', ...)` → `lpad(...)` and `session_date::text` in the composite key (db.js:1914, 1923, 1963, 1967)**

In the `corr_code`/`corr_id` CTEs and the outer `corrected_later` comparison, the composite-key expression must stay byte-identical in all four places. New form (note `session_date::text` because the column is now `date`):
- CTE (1914 and 1923):
```sql
        SELECT TRIM(q2.q_code) AS code,
               MAX(COALESCE(s2.session_date::text, '') || ' ' || lpad(q2.id::text, 7, '0')) AS maxkey
```
(line 1923 is the same but `q2.q_id AS qid`)
- Outer comparison (1963 and 1967):
```sql
               AND cc.maxkey > (COALESCE(s.session_date::text, '') || ' ' || lpad(q.id::text, 7, '0')) THEN 1
```
(1967 uses `ci.maxkey`)

- [ ] **Step 7: Smoke-test the read queries against Postgres** (data is empty until Task 11, but the SQL must parse/execute without error)

Run:
```bash
node -e "process.env.DATABASE_URL=process.env.DATABASE_URL||'postgres://postgres:gmat@localhost:5432/gmat'; const db=require('./src/db'); (async()=>{ await db.initDb(); await db.listSessions(null,{}); await db.listErrors({}); await db.getPatterns({}); console.log('queries parse+run OK'); await db.closePool(); })().catch(e=>{console.error(e);process.exit(1)})"
```
Expected: `queries parse+run OK` (empty results are fine). Any `function round(double precision, integer) does not exist`, `operator does not exist`, or `GLOB`/`printf`/`DATE` error here means a site was missed — fix before committing.

- [ ] **Step 8: Commit**

```bash
git add src/db.js
git commit -m "feat(db): port datetime/GLOB/DATE/ROUND/printf SQLite-isms to postgres"
```

---

## Task 8: Make multi-statement writers atomic (`withTransaction`)

The point of the migration is concurrency; bare `BEGIN/COMMIT` strings scatter across pooled connections and the delete+reinsert is non-atomic.

**Files:**
- Modify: `src/db.js`

- [ ] **Step 1: Convert the study-plan transactions to `withTransaction`**

Pattern — replace the bare `await run('BEGIN'); try { ...; await run('COMMIT'); } catch { await run('ROLLBACK'); throw }` blocks with `withTransaction`, using `tx.run`/`tx.all` inside. Example for `reorderStudyPlanTasks` (db.js:3840-3855):
```js
  await withTransaction(async (tx) => {
    for (const u of clean) {
      await tx.run(
        `UPDATE study_plan_tasks
            SET day_date = ?, week_number = ?, day_label = ?, day_theme = ?, position = ?,
                updated_at = now()
          WHERE id = ?`,
        [u.day_date, u.week_number, u.day_label, u.day_theme, u.position, u.id],
      );
    }
  });
  return await listStudyPlanTasks();
```
Apply the same conversion to every bare-transaction site: `rebucketWeeksMonSunOnce` (~3911), `reorderStudyPlanDays` (~4023), `deleteStudyPlanDay` (~4055), `moveStudyPlanDay` (~4082-4098), `replaceStudyPlan` (~4122-4196), `resetStudyPlanTasks` (~4207-4216). Inside each, every `run(`/`all(`/`get(` becomes `tx.run(`/`tx.all(`/`tx.get(`. Confirm none remain:
```bash
grep -rn "run('BEGIN')\|run('COMMIT')\|run('ROLLBACK')" src/db.js && echo "STILL PRESENT" || echo "clean"
```
Expected: `clean`.

- [ ] **Step 2: Wrap `saveScrapeResult` in one transaction (db.js:~1094-1366)**

Wrap the write sequence (scrape_runs insert → per-session upsert → `DELETE FROM question_attempts WHERE session_id = ?` → per-question re-INSERT) in a single `withTransaction(async (tx) => { ... })`, replacing the `run`/`all`/`get` calls inside with `tx.run`/`tx.all`/`tx.get` (including the Task 6 `RETURNING id` reads via `tx.all`). Return the final result from the transaction callback. This makes a concurrent `/api/sessions` read unable to observe the deleted-but-not-yet-reinserted window.

- [ ] **Step 3: Wrap the Phase-2 enrichers per session**

In `enrichSessionAttempts` (~2982), `enrichGmatClubSessionAttempts` (~3349), and `enrichOpeSessionAttempts` (~3437), wrap each session's sequence of `UPDATE question_attempts ...` statements (plus the timing-aggregate refresh) in a single `withTransaction`, swapping inner `run`/`all` for `tx.run`/`tx.all`.

- [ ] **Step 4: Smoke-test a real write round-trip** (requires data — defer the assertion to Task 11; for now confirm the module loads and `initDb` still succeeds)

Run:
```bash
node -e "process.env.DATABASE_URL=process.env.DATABASE_URL||'postgres://postgres:gmat@localhost:5432/gmat'; const db=require('./src/db'); db.initDb().then(()=>{console.log('OK');return db.closePool()}).catch(e=>{console.error(e);process.exit(1)})"
```
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add src/db.js
git commit -m "feat(db): atomic transactions for scrape save, enrichers, study-plan writes"
```

---

## Task 9: Port the remaining SQL modules

**Files:**
- Modify: `src/coach-session.js`, `src/memory.js`, `src/lsat-dashboard.js`, `src/server.js`

- [ ] **Step 1: `src/memory.js` (5 SQL sites) and `src/coach-session.js` (remaining sites)**

These import `run/all/get` from `./db`, so the `?`→`$n` rewrite is automatic. Only fix SQLite-isms: replace any `datetime('now')` with `now()`. (The `coach-session.js` `lastID` was handled in Task 6.) Grep to confirm:
```bash
grep -rn "datetime('now')\|\.lastID" src/coach-session.js src/memory.js && echo "FIX THESE" || echo "clean"
```
Expected: `clean`.

- [ ] **Step 2: `src/lsat-dashboard.js` (6 SQL sites)**

Same: rewrite via shared wrappers is automatic. Check for `datetime('now')`, `.lastID`, and any `SUM(is_correct)` (still fine — `is_correct` stays integer). Replace `datetime('now')`→`now()` if present. If any `DATE(...)` over a date/text column appears, apply the Task 7 Step 4 treatment.
```bash
grep -rn "datetime('now')\|\.lastID\|GLOB\|printf(" src/lsat-dashboard.js && echo "FIX THESE" || echo "clean"
```
Expected: `clean`.

- [ ] **Step 3: `src/server.js` — the single inline query (~line 1048)**

`SELECT s.id, s.session_external_id, s.source, s.total_q_api FROM sessions s WHERE s.id = ?` runs through the imported `get` wrapper, so the `?`→`$1` rewrite is automatic. No change needed unless it contains a SQLite-ism (it does not). Confirm `server.js` has no other raw SQL or `datetime('now')`:
```bash
grep -rn "datetime('now')\|PRAGMA\|GLOB\|\.lastID" src/server.js && echo "FIX THESE" || echo "clean"
```
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add src/coach-session.js src/memory.js src/lsat-dashboard.js src/server.js
git commit -m "feat(db): port coach/memory/lsat-dashboard/server SQL to postgres"
```

---

## Task 10: Schema column-parity verification script

The guard against silently dropping any of the 34 runtime ALTER columns: assert every table's Postgres columns match the SQLite source's columns.

**Files:**
- Create: `scripts/verify-schema-parity.js`

- [ ] **Step 1: Write the parity check**

```js
// scripts/verify-schema-parity.js
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

const SQLITE_PATH = process.env.GMAT_DB_PATH || path.resolve(__dirname, '..', 'data', 'gmat-error-log.db');
// Tables expected to exist in BOTH (exclude transient/rebuildable: lsat_attempts_v2 never exists; irt_cutoffs is empty/rebuilt).
const TABLES = ['scrape_runs','sessions','question_attempts','irt_cutoffs','coach_sessions',
  'coach_messages','coach_memories','lsat_attempts','lsat_sessions','study_plan_tasks',
  'study_plan_days','study_plan_meta','mock_results'];

function sqliteCols(db, table) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, (err, rows) =>
      err ? reject(err) : resolve(rows.map((r) => r.name).sort()));
  });
}

(async () => {
  const db = new sqlite3.Database(SQLITE_PATH, sqlite3.OPEN_READONLY);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let failed = false;
  for (const t of TABLES) {
    const sCols = await sqliteCols(db, t);
    const pCols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`, [t]
    )).rows.map((r) => r.column_name).sort();
    const missingInPg = sCols.filter((c) => !pCols.includes(c));
    const extraInPg = pCols.filter((c) => !sCols.includes(c));
    if (missingInPg.length || extraInPg.length) {
      failed = true;
      console.error(`MISMATCH ${t}: missing-in-pg=[${missingInPg}] extra-in-pg=[${extraInPg}]`);
    } else {
      console.log(`OK ${t} (${pCols.length} cols)`);
    }
  }
  db.close();
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it**

Run:
```bash
node scripts/verify-schema-parity.js
```
Expected: `OK <table>` for all 13 tables, exit 0. Any `MISMATCH` lists the dropped/extra column — fix `0001_init.sql`, `npm run db:reset`, re-run.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-schema-parity.js
git commit -m "test(db): schema column-parity check (sqlite PRAGMA vs pg information_schema)"
```

---

## Task 11: One-time data ETL — `scripts/migrate-sqlite-to-pg.js`

**Files:**
- Create: `scripts/migrate-sqlite-to-pg.js`

- [ ] **Step 1: Write the ETL**

```js
// scripts/migrate-sqlite-to-pg.js
// One-time copy of the live SQLite DB into Postgres. Idempotent guard: refuses to
// run unless target tables are empty (override with --force after db:reset).
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const { toTimestamptz } = require('../src/sql-util');

const SQLITE_PATH = process.env.GMAT_DB_PATH || path.resolve(__dirname, '..', 'data', 'gmat-error-log.db');
const FORCE = process.argv.includes('--force');

// FK dependency order. irt_cutoffs (rebuildable) and lsat_attempts_v2 (transient) skipped.
const TABLES = ['scrape_runs','sessions','question_attempts','coach_sessions','coach_messages',
  'coach_memories','lsat_sessions','lsat_attempts','study_plan_tasks','study_plan_days',
  'study_plan_meta','mock_results'];

const TS_COLS = new Set(['created_at','updated_at','extracted_at','completed_at','attempted_at','started_at']);
const DATE_COLS = new Set(['session_date']);

const sAll = (db, sql) => new Promise((res, rej) => db.all(sql, (e, r) => e ? rej(e) : res(r)));
const sCols = (db, t) => sAll(db, `PRAGMA table_info(${t})`).then((r) => r.map((c) => c.name));

function transform(col, v) {
  if (v === undefined) v = null;
  if (TS_COLS.has(col)) return toTimestamptz(v);
  if (DATE_COLS.has(col)) {
    if (v == null || v === '') return null;
    const m = String(v).match(/^\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : null;
  }
  return v; // text/int/json pass through verbatim; '' sentinels preserved
}

async function main() {
  const db = new sqlite3.Database(SQLITE_PATH, sqlite3.OPEN_READONLY);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  if (!FORCE) {
    for (const t of TABLES) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
      if (rows[0].n > 0) throw new Error(`target ${t} not empty (n=${rows[0].n}); use --force after db:reset`);
    }
  }

  const counts = {};
  for (const t of TABLES) {
    const cols = await sCols(db, t);
    const srcRows = await sAll(db, `SELECT * FROM ${t}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of srcRows) {
        const vals = cols.map((c) => transform(c, row[c]));
        const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(
          `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${ph})`, vals
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`load ${t} failed: ${e.message}`);
    } finally {
      client.release();
    }
    counts[t] = srcRows.length;
    console.log(`loaded ${t}: ${srcRows.length}`);
  }

  // Resync IDENTITY sequences to MAX(id)+1 (explicit ids were inserted above).
  const IDENTITY_TABLES = ['scrape_runs','sessions','question_attempts','coach_messages',
    'lsat_attempts','lsat_sessions','study_plan_tasks','mock_results'];
  for (const t of IDENTITY_TABLES) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('${t}','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM ${t}), 1))`
    );
  }

  // Verify counts match the SQLite source.
  let mismatch = false;
  for (const t of TABLES) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
    if (rows[0].n !== counts[t]) {
      mismatch = true;
      console.error(`COUNT MISMATCH ${t}: sqlite=${counts[t]} pg=${rows[0].n}`);
    }
  }
  db.close();
  await pool.end();
  if (mismatch) process.exit(1);
  console.log('ETL complete, counts verified');
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the ETL**

Run:
```bash
npm run db:etl
```
Expected: `loaded <table>: <n>` for each, then `ETL complete, counts verified`. Cross-check against the audit's live counts (question_attempts 3603, sessions 277, scrape_runs 199, study_plan_tasks 151, lsat_attempts 68, study_plan_days 42, coach_memories 28, coach_messages 21, lsat_sessions 19, coach_sessions 6, mock_results 0).

- [ ] **Step 3: Rebuild the IRT cutoffs cache**

Run:
```bash
node -e "process.env.DATABASE_URL=process.env.DATABASE_URL||'postgres://postgres:gmat@localhost:5432/gmat'; const db=require('./src/db'); db.recomputeIrtCutoffs().then((r)=>{console.log('irt rebuilt',r);return db.closePool()}).catch(e=>{console.error(e);process.exit(1)})"
```
Expected: prints a result object, exit 0. (Confirm `recomputeIrtCutoffs` is exported; if not, add it to `module.exports`.)

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate-sqlite-to-pg.js src/db.js
git commit -m "feat(db): one-time sqlite->postgres ETL with count verification"
```

---

## Task 12: Maintenance scripts — archive one-shots, port the keeper

**Files:**
- Move: 7 scripts to `scripts/archive/`
- Modify: `scripts/restore-purged-annotations.js`

- [ ] **Step 1: Archive the already-applied one-shots**

```bash
mkdir -p scripts/archive
git mv scripts/backfill-my-answer.js scripts/archive/
git mv scripts/backfill-ope-matrix-format.js scripts/archive/
git mv scripts/backfill-q-id-composite.js scripts/archive/
git mv scripts/backfill-verbal-pick.js scripts/archive/
git mv scripts/backfill-passage-text.js scripts/archive/
git mv scripts/repair-pickbycolor-falsepos.js scripts/archive/
git mv scripts/migrate-tags-v3.js scripts/archive/
```

- [ ] **Step 2: Add an archive README**

Create `scripts/archive/README.md`:
```markdown
# Archived one-shot SQLite scripts

These ran once against the SQLite DB; their effects are baked into the data the
Postgres ETL (`scripts/migrate-sqlite-to-pg.js`) carried over. Kept for history,
NOT runnable against Postgres (they open a raw sqlite3 connection). If a similar
backfill is ever needed again, write a fresh script against the pg Pool.
```

- [ ] **Step 3: Port `restore-purged-annotations.js` to Postgres**

Rewrite it to read annotations from a source and write via the `pg` Pool. Replace the `new sqlite3.Database(...)` live connection with `const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL });`, switch its UPDATE/SELECT calls to `pool.query` with `$n` placeholders, and define its backup source as a prior SQLite snapshot opened `OPEN_READONLY` (the read side may stay sqlite3 since backups are `.db.bak-*` files). Keep its row-matching logic. Confirm it loads:
```bash
node -c scripts/restore-purged-annotations.js && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 4: Commit**

```bash
git add scripts/archive/ scripts/restore-purged-annotations.js
git commit -m "chore(scripts): archive applied one-shots; port annotation-restore to pg"
```

---

## Task 13: End-to-end validation, silent-break audit, docs

**Files:**
- Create: `scripts/verify-migration.js`
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Write the integration verification script**

```js
// scripts/verify-migration.js
// Exercises the main read paths against Postgres and asserts they return without
// error and with sane row counts. Run AFTER the ETL.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:gmat@localhost:5432/gmat';
const db = require('../src/db');

(async () => {
  await db.initDb();
  const runId = await db.getLatestRunId();
  const checks = [
    ['listRuns', () => db.listRuns()],
    ['listSessions', () => db.listSessions(null, {})],
    ['listSessions(gmatclub)', () => db.listSessions(null, { platform: 'gmatclub' })],
    ['listErrors', () => db.listErrors({})],
    ['listErrors(sorted)', () => db.listErrors({ sortKey: 'time', sortDir: 'desc' })],
    ['getPatterns', () => db.getPatterns({})],
    ['lsatStats', () => db.lsatStats()],
    ['listStudyPlanTasks', () => db.listStudyPlanTasks()],
    ['listMockResults', () => db.listMockResults()],
  ];
  for (const [name, fn] of checks) {
    const r = await fn();
    const n = Array.isArray(r) ? r.length : (r ? 1 : 0);
    console.log(`OK ${name} -> ${n} row(s)`);
  }
  // Sanity: total error count should be > 0 (we know there are wrong answers).
  const errs = await db.listErrors({});
  if (!errs.length) throw new Error('listErrors returned 0 rows — expected wrong answers in migrated data');
  await db.closePool();
  console.log('verify-migration OK');
})().catch((e) => { console.error(e); process.exit(1); });
```

Run:
```bash
node scripts/verify-migration.js
```
Expected: `OK <name> -> <n> row(s)` for each, then `verify-migration OK`. Adjust exported function names if any differ.

- [ ] **Step 2: Silent-break audit — every un-wrapped `LIKE` (spec §13 #1)**

List every `LIKE` in the canonicalizing CASE expressions and confirm each compares a `LOWER(...)`/`UPPER(...)`-normalized column (PG `LIKE` is case-sensitive):
```bash
grep -n "LIKE" src/db.js | grep -v "LOWER(" | grep -v "UPPER("
```
Expected: review each hit. Any raw-column `LIKE 'literal'` in `categoryHintExpr`/`topicExpr`/`subjectExpr` (db.js ~1669-1825) that is NOT case-normalized must be wrapped in `LOWER(...)` on both sides, or it will silently mis-bucket. Document the result (even "all wrapped — no change") in the PR description.

- [ ] **Step 3: Pre-flight the `difficulty` CAST guard (spec §13 #3)**

Confirm no raw numeric-theta strings remain in `difficulty` that would error on `CAST(... AS REAL)` outside the regex guard:
```bash
docker exec gmat-pg psql -U postgres -d gmat -c "SELECT count(*) FROM question_attempts WHERE difficulty ~ '^-?\.?[0-9]';"
```
Expected: `0` (the one-time backfill already converted them to labels). If non-zero, the `difficultyBucketExpr` regex guard handles them at query time — confirm `getPatterns`/`listErrors` still ran clean in Step 1.

- [ ] **Step 4: Manual app smoke test**

```bash
npm run dev
```
Then in the browser verify against the migrated data: sessions list loads with correct counts; error log loads, sorts, and every Source filter (Official Guide / GMAT Club / TTP) works; pattern view renders; open a session deep-dive modal; the AI coach panel + memory load; the study plan reorders and a day restores; the LSAT dashboard loads; mock results render. Run one Phase-1 scrape and one Phase-2 enrich end-to-end (requires the Chrome CDP setup) and confirm no `database is locked`-class errors and that annotations survived. Stop the server (Ctrl-C) and confirm the SIGINT handler closes the pool cleanly (no hang).

- [ ] **Step 5: Update docs**

In `CLAUDE.md`, update the **Backend** and **Key Patterns** sections that describe SQLite specifics: `db.js` is now "raw SQL over a `pg.Pool` (no ORM); schema in `migrations/*.sql` applied by `scripts/migrate.js`; `?` placeholders auto-rewritten to `$n` by the `toPg` wrapper; transactions via `withTransaction`"; note `INSERT OR REPLACE`/`AUTOINCREMENT`/`datetime('now')` are gone; add the `npm run db:*` commands to the Commands table; note the one-time ETL and that the old `.db` is the rollback. In `README.md`, add a "Database (PostgreSQL)" setup section: `npm run db:up`, `npm run db:migrate`, `npm run db:etl`, the `DATABASE_URL` env var.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-migration.js README.md CLAUDE.md
git commit -m "test(db): integration verify script; docs for postgres setup + rollback"
```

---

## Task 14: Update the Raycast start script to bring up Postgres

The Raycast launcher `~/Desktop/RaycastScripts/start-gmat.sh` currently starts Chrome CDP + `npm run dev`. After migration the app needs Postgres up first. This script lives **outside the repo** (on the Desktop, not version-controlled), so it is edited in place. Depends on Task 1 (`npm run db:up`).

**Files:**
- Modify: `/Users/pletopichaiyoot/Desktop/RaycastScripts/start-gmat.sh`

- [ ] **Step 1: Add a Docker-daemon guard before the iTerm block**

Insert this block after the Chrome CDP `if/else/fi` (after the current line 27) and before the `osascript` block:
```bash
# Ensure Docker Desktop is running (npm run db:up needs the daemon).
if ! docker info >/dev/null 2>&1; then
  echo "Starting Docker Desktop..."
  open -ga Docker
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi
if docker info >/dev/null 2>&1; then
  echo "Docker is running"
else
  echo "WARNING: Docker did not start; Postgres will be unavailable"
fi
```

- [ ] **Step 2: Bring Postgres up in the same iTerm window before the dev servers**

Change the iTerm command (current line 35) so Postgres starts (and the `db:up` readiness loop blocks) right before `npm run dev`, with output visible in the terminal:
```bash
    write text "cd $PROJECT_DIR && npm run db:up && npm run dev"
```
(Was: `write text "cd $PROJECT_DIR && npm run dev"`.)

- [ ] **Step 3: Dry-run the script**

Run:
```bash
bash ~/Desktop/RaycastScripts/start-gmat.sh
```
Expected: prints `Docker is running`, opens an iTerm window where `npm run db:up` reports Postgres `accepting connections`, then `npm run dev` boots the API + web. (Close the extra Chrome/iTerm afterward.)

- [ ] **Step 4: (Optional) Mirror in `stop-gmat.sh`**

The user did not ask to stop Postgres on shutdown, and the `pgdata` volume persists data either way. If desired, append `docker compose -f "$PROJECT_DIR/docker-compose.yml" down` to `~/Desktop/RaycastScripts/stop-gmat.sh` (add `PROJECT_DIR="/Users/pletopichaiyoot/Desktop/codespace/gmat-error-log"` near the top). Otherwise leave Postgres running between sessions — it is cheap and avoids cold starts. **Default: skip this step** unless you want the container stopped too.

> Note: these Desktop scripts are not in the repo, so there is no commit for this task. The edits are applied directly in place.

---

## Cutover & rollback (post-implementation)

- **Cutover:** merge `feat/postgres-migration` once Task 13 passes. From then on, boot requires `npm run db:up`.
- **Rollback:** `git revert`/checkout the pre-migration commit on `main`; the SQLite file at `data/gmat-error-log.db` is untouched and `GMAT_DB_PATH` still points the old code at it. Document the exact revert SHA in the PR.
- **Cleanup later (optional):** once confident, prune the ~28 `data/*.db.bak-*` snapshots and the two stray 0-byte legacy files; remove `sqlite3` from deps when the ETL/restore scripts are no longer needed.

---

## Self-Review

**Spec coverage:** Infra (T1) ✓ · pg wrappers + withTransaction + pool.end (T2,T5) ✓ · numbered .sql migrations + runner (T3,T4) ✓ · schema translation incl. timestamptz/bigint/IDENTITY/`BY DEFAULT` (T3) ✓ · RETURNING id (T6) ✓ · datetime/GLOB/DATE/ROUND/printf/PRAGMA rewrites (T5 removes PRAGMA, T7) ✓ · atomic writers (T8) ✓ · other modules (T9) ✓ · ETL with count verify + sequence resync + dual-timestamp parse + `''` preserved + copy-by-name (T11) ✓ · schema parity guard (T10) ✓ · maintenance scripts disposition (T12) ✓ · silent-break LIKE audit + CAST pre-flight + validation + docs + rollback (T13, Cutover) ✓ · Raycast start script brings up Postgres before dev servers (T14) ✓ · deferred jsonb/pgvector/FTS explicitly out (spec §14, untouched). No spec requirement left unimplemented.

**Type/name consistency:** `toPg`/`toTimestamptz` (T2) used in T5/T11; `withTransaction({run,all,get})` (T5) used in T8; `closePool` (T5) used in verify scripts; `RETURNING id` + `result[0].id` consistent across T6; `runMigrations(pool)` exported in T4, consumed in T5. Verify-script function names (`getLatestRunId`, `recomputeIrtCutoffs`, `lsatStats`, `listStudyPlanTasks`, `listMockResults`) are flagged to confirm against actual exports during T11/T13.
