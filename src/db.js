const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { deriveQuestionMetadata, enrichQuestionMetadata } = require('./question-metadata');

const dbDir = path.resolve(__dirname, '..', 'data');
const dbPath = path.join(dbDir, 'gmat-error-log.db');
const QUESTION_ATTEMPT_INSERT_COLUMNS = [
  'run_id',
  'session_id',
  'q_code',
  'q_id',
  'cat_id',
  'subject_code',
  'category_code',
  'subcategory',
  'subject_sub',
  'subject_sub_raw',
  'question_url',
  'question_stem',
  'answer_choices',
  'response_format',
  'response_details',
  'correct',
  'difficulty',
  'difficulty_theta',
  'confidence',
  'time_sec',
  'my_answer',
  'correct_answer',
  'topic',
  'topic_source',
  'content_domain',
  'mistake_type',
  'notes',
  'passage_text',
];

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function buildInsertStatement(tableName, columns) {
  const placeholders = columns.map(() => '?').join(', ');
  return `
    INSERT INTO ${tableName} (
      ${columns.join(',\n      ')}
    ) VALUES (${placeholders})
  `;
}

function assertValueCount(label, columns, values) {
  if (columns.length !== values.length) {
    throw new Error(`${label} value mismatch: expected ${columns.length}, received ${values.length}.`);
  }
}

async function ensureQuestionAttemptsColumn(columnName, definition) {
  const columns = await all('PRAGMA table_info(question_attempts)');
  if (columns.some((column) => column.name === columnName)) return;
  await run(`ALTER TABLE question_attempts ADD COLUMN ${columnName} ${definition}`);
}

async function initDb() {
  await run('PRAGMA foreign_keys = ON');

  await run(`
    CREATE TABLE IF NOT EXISTS scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      extracted_at TEXT NOT NULL,
      since_value TEXT,
      source TEXT,
      review_category_id INTEGER,
      total_sessions INTEGER NOT NULL,
      total_questions INTEGER NOT NULL,
      total_errors INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      session_external_id INTEGER NOT NULL,
      session_date TEXT,
      source TEXT,
      subject TEXT,
      total_q_api INTEGER,
      total_q_categories INTEGER,
      correct_count INTEGER,
      error_count INTEGER,
      accuracy_pct REAL,
      avg_time_sec INTEGER,
      avg_correct_time_sec INTEGER,
      avg_incorrect_time_sec INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES scrape_runs(id) ON DELETE CASCADE,
      UNIQUE(run_id, session_external_id)
    )
  `);

  // OPE scaled-score columns: GMAT total (205-805) + 3 section scores (60-90)
  // and matching percentiles. Idempotent; safe to re-run.
  for (const col of [
    'total_score INTEGER',
    'total_percentile INTEGER',
    'quant_score INTEGER',
    'quant_percentile INTEGER',
    'verbal_score INTEGER',
    'verbal_percentile INTEGER',
    'di_score INTEGER',
    'di_percentile INTEGER',
  ]) {
    try { await run(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch (_e) { /* exists */ }
  }

  await run(`
    CREATE TABLE IF NOT EXISTS question_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      session_id INTEGER NOT NULL,
      q_code TEXT,
      q_id TEXT,
      cat_id INTEGER,
      subject_code TEXT,
      category_code TEXT,
      subcategory TEXT,
      subject_sub TEXT,
      subject_sub_raw TEXT,
      question_url TEXT,
      question_stem TEXT,
      answer_choices TEXT,
      response_format TEXT,
      response_details TEXT,
      correct INTEGER NOT NULL,
      difficulty TEXT,
      confidence TEXT,
      time_sec INTEGER,
      my_answer TEXT,
      correct_answer TEXT,
      topic TEXT,
      topic_source TEXT,
      content_domain TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES scrape_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  await ensureQuestionAttemptsColumn('q_id', 'TEXT');
  await ensureQuestionAttemptsColumn('cat_id', 'INTEGER');
  await ensureQuestionAttemptsColumn('subject_code', 'TEXT');
  await ensureQuestionAttemptsColumn('category_code', 'TEXT');
  await ensureQuestionAttemptsColumn('subcategory', 'TEXT');
  await ensureQuestionAttemptsColumn('subject_sub', 'TEXT');
  await ensureQuestionAttemptsColumn('subject_sub_raw', 'TEXT');
  await ensureQuestionAttemptsColumn('question_url', 'TEXT');
  await ensureQuestionAttemptsColumn('question_stem', 'TEXT');
  await ensureQuestionAttemptsColumn('answer_choices', 'TEXT');
  await ensureQuestionAttemptsColumn('response_format', 'TEXT');
  await ensureQuestionAttemptsColumn('response_details', 'TEXT');
  await ensureQuestionAttemptsColumn('mistake_type', 'TEXT');
  await ensureQuestionAttemptsColumn('notes', 'TEXT');
  await ensureQuestionAttemptsColumn('topic_source', 'TEXT');
  await ensureQuestionAttemptsColumn('content_domain', 'TEXT');
  await ensureQuestionAttemptsColumn('passage_text', 'TEXT');
  await ensureQuestionAttemptsColumn('difficulty_theta', 'REAL');

  // One-time backfill: older OPE Phase 3 writes stored the raw IRT theta as a
  // numeric string in `difficulty` (e.g. "-0.647"), which the UI then rendered
  // as a number instead of an Easy/Medium/Hard chip. Move those values into
  // `difficulty_theta` and replace `difficulty` with the bucketed label. The
  // WHERE clause makes this idempotent — rows already migrated have a
  // non-null `difficulty_theta` and won't be touched again.
  await run(`
    UPDATE question_attempts
    SET difficulty_theta = CAST(difficulty AS REAL),
        difficulty = CASE
          WHEN CAST(difficulty AS REAL) < -0.43 THEN 'Easy'
          WHEN CAST(difficulty AS REAL) >  0.43 THEN 'Hard'
          ELSE 'Medium'
        END
    WHERE difficulty_theta IS NULL
      AND (
        difficulty GLOB '-[0-9]*'
        OR difficulty GLOB '[0-9]*'
        OR difficulty GLOB '.[0-9]*'
        OR difficulty GLOB '-.[0-9]*'
      )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_sessions_run_id ON sessions(run_id)');
  await run(
    'CREATE INDEX IF NOT EXISTS idx_sessions_external_source ON sessions(session_external_id, source)'
  );
  await run('CREATE INDEX IF NOT EXISTS idx_questions_run_id ON question_attempts(run_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_questions_correct ON question_attempts(correct)');
  await run('CREATE INDEX IF NOT EXISTS idx_questions_q_code ON question_attempts(q_code)');
  await run('CREATE INDEX IF NOT EXISTS idx_questions_q_id ON question_attempts(q_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_questions_topic ON question_attempts(topic)');
  await run('CREATE INDEX IF NOT EXISTS idx_questions_difficulty ON question_attempts(difficulty)');

  // Empirical IRT difficulty cutoffs. Populated by recomputeIrtCutoffs()
  // after each enrichment. The OPE bank's b-parameter scale differs by
  // subject and even by DI subcategory (Quant tops out near 0.4 while DI's
  // MSR Math items extend past 5), so a single global ±0.43 cutoff is wrong.
  // Q and V key on subject_code alone (sub_key=''); DI splits by topic so
  // MSR's wide right tail doesn't contaminate DS/GT/TPA buckets.
  await run(`DROP TABLE IF EXISTS irt_cutoffs`);
  await run(`
    CREATE TABLE irt_cutoffs (
      subject_code TEXT NOT NULL,
      sub_key TEXT NOT NULL DEFAULT '',
      p33 REAL NOT NULL,
      p67 REAL NOT NULL,
      n INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (subject_code, sub_key)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS coach_sessions (
      id TEXT PRIMARY KEY,
      title TEXT DEFAULT '',
      run_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS coach_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES coach_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_coach_messages_session ON coach_messages(session_id)');

  await run(`
    CREATE TABLE IF NOT EXISTS coach_memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      embedding TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_coach_memories_created ON coach_memories(created_at DESC)');

  await run(`
    CREATE TABLE IF NOT EXISTS lsat_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_num INTEGER NOT NULL,
      section_roman TEXT NOT NULL,
      section_kind TEXT NOT NULL,
      question_number INTEGER NOT NULL,
      user_answer TEXT NOT NULL,
      correct_answer TEXT,
      is_correct INTEGER,
      confidence TEXT,
      time_ms INTEGER,
      session_id INTEGER,
      attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Older versions had UNIQUE(test_num, section_roman, question_number) which made
  // every retake overwrite history. Migrate to a session-scoped unique key so we
  // keep a row per (question, session). Detect via PRAGMA, copy data, swap tables.
  try {
    const idxs = await all("PRAGMA index_list('lsat_attempts')");
    const hasLegacyUnique = (idxs || []).some(
      (i) => i.unique === 1 && /^sqlite_autoindex_lsat_attempts_/.test(i.name)
    );
    if (hasLegacyUnique) {
      await run(`CREATE TABLE lsat_attempts_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_num INTEGER NOT NULL,
        section_roman TEXT NOT NULL,
        section_kind TEXT NOT NULL,
        question_number INTEGER NOT NULL,
        user_answer TEXT NOT NULL,
        correct_answer TEXT,
        is_correct INTEGER,
        confidence TEXT,
        time_ms INTEGER,
        session_id INTEGER,
        attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      // Copy preserving every column we know about.
      await run(`INSERT INTO lsat_attempts_v2
        (id, test_num, section_roman, section_kind, question_number, user_answer, correct_answer, is_correct, confidence, time_ms, session_id, attempted_at)
        SELECT id, test_num, section_roman, section_kind, question_number, user_answer, correct_answer, is_correct, confidence, time_ms, session_id, attempted_at
        FROM lsat_attempts`);
      await run('DROP TABLE lsat_attempts');
      await run('ALTER TABLE lsat_attempts_v2 RENAME TO lsat_attempts');
    }
  } catch (e) {
    // If introspection / migration fails on a fresh DB it's fine — the new
    // CREATE TABLE above already used the new shape.
  }
  // ALTERs are no-ops if columns already present.
  try { await run('ALTER TABLE lsat_attempts ADD COLUMN confidence TEXT'); } catch (e) { /* exists */ }
  try { await run('ALTER TABLE lsat_attempts ADD COLUMN time_ms INTEGER'); } catch (e) { /* exists */ }
  try { await run('ALTER TABLE lsat_attempts ADD COLUMN session_id INTEGER'); } catch (e) { /* exists */ }
  await run('CREATE INDEX IF NOT EXISTS idx_lsat_attempts_test ON lsat_attempts(test_num, section_roman)');
  await run('CREATE INDEX IF NOT EXISTS idx_lsat_attempts_session ON lsat_attempts(session_id)');
  // Within one session, each question can only have one attempt row (we UPDATE on retry).
  // Across sessions, attempts accumulate as history.
  await run('CREATE UNIQUE INDEX IF NOT EXISTS uq_lsat_attempts_session_q ON lsat_attempts(test_num, section_roman, question_number, session_id)');

  await run(`
    CREATE TABLE IF NOT EXISTS lsat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_num INTEGER NOT NULL,
      section_roman TEXT NOT NULL,
      section_kind TEXT NOT NULL,
      set_key TEXT NOT NULL,
      set_label TEXT,
      first_question INTEGER NOT NULL,
      last_question INTEGER NOT NULL,
      mode TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    )
  `);
  try { await run('ALTER TABLE lsat_sessions ADD COLUMN mode TEXT'); } catch (e) { /* exists */ }
  try { await run('ALTER TABLE lsat_sessions ADD COLUMN question_numbers TEXT'); } catch (e) { /* exists */ }
  await run('CREATE INDEX IF NOT EXISTS idx_lsat_sessions_test ON lsat_sessions(test_num, section_roman)');
  await run('CREATE INDEX IF NOT EXISTS idx_lsat_sessions_started ON lsat_sessions(started_at DESC)');

  // ─── Study Plan ──────────────────────────────────────────────────────────
  // Holds the 4-week final-sprint plan and its sub-task checklist. Each row
  // is one actionable item ("warm-up", "DI Tables timed set", "review"). One
  // day can have multiple rows ordered by `position`. `status` is the
  // checkbox state; user edits live in `title`/`description`/`notes`.
  await run(`
    CREATE TABLE IF NOT EXISTS study_plan_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_date TEXT NOT NULL,
      week_number INTEGER NOT NULL,
      day_label TEXT,
      day_theme TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT,
      est_minutes INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','skipped')),
      completed_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_study_plan_day ON study_plan_tasks(day_date)');
  await run('CREATE INDEX IF NOT EXISTS idx_study_plan_week ON study_plan_tasks(week_number)');
  await run('CREATE INDEX IF NOT EXISTS idx_study_plan_status ON study_plan_tasks(status)');

  // Plan-level metadata (test date, target score, seeded flag).
  await run(`
    CREATE TABLE IF NOT EXISTS study_plan_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Full-length mock exam results. One row per mock attempt. Section scores
  // are GMAT Focus scale (60-90); total is 205-805. Percentiles are 0-100.
  // `source_label` is free-form (e.g., "OPE3", "GMAT Club CAT", "OPE4").
  await run(`
    CREATE TABLE IF NOT EXISTS mock_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mock_date TEXT NOT NULL,
      source_label TEXT NOT NULL,
      total_score INTEGER,
      total_percentile INTEGER,
      quant_score INTEGER,
      quant_percentile INTEGER,
      di_score INTEGER,
      di_percentile INTEGER,
      verbal_score INTEGER,
      verbal_percentile INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_mock_results_date ON mock_results(mock_date)');

  await backfillSparseQuestionAttempts();
}

async function saveLsatAttempt({ testNum, sectionRoman, sectionKind, questionNumber, userAnswer, correctAnswer, confidence, timeMs, sessionId }) {
  // correctAnswer can be null when the parser couldn't recover the answer key
  // for that test. In that case is_correct stays null too — the attempt is still
  // recorded for review/history purposes, just unscored.
  const corr = correctAnswer ? String(correctAnswer).toUpperCase() : null;
  const isCorrect = corr == null
    ? null
    : (String(userAnswer).toUpperCase() === corr ? 1 : 0);
  const conf = confidence ? String(confidence).toLowerCase() : null;
  const tMs = Number.isFinite(Number(timeMs)) ? Math.max(0, Math.round(Number(timeMs))) : null;
  const sId = Number.isFinite(Number(sessionId)) ? Number(sessionId) : null;
  // Conflict resolution is per-(question, session): re-submitting within the
  // same session updates the row; a NEW session creates a fresh history entry.
  await run(
    `INSERT INTO lsat_attempts (test_num, section_roman, section_kind, question_number, user_answer, correct_answer, is_correct, confidence, time_ms, session_id, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(test_num, section_roman, question_number, session_id) DO UPDATE SET
       user_answer = excluded.user_answer,
       correct_answer = excluded.correct_answer,
       is_correct = excluded.is_correct,
       confidence = excluded.confidence,
       time_ms = excluded.time_ms,
       attempted_at = datetime('now')`,
    [testNum, sectionRoman, sectionKind, questionNumber, String(userAnswer).toUpperCase(), corr, isCorrect, conf, tMs, sId]
  );
  return { isCorrect };
}

async function createLsatSession({ testNum, sectionRoman, sectionKind, setKey, setLabel, firstQuestion, lastQuestion, mode }) {
  const result = await run(
    `INSERT INTO lsat_sessions (test_num, section_roman, section_kind, set_key, set_label, first_question, last_question, mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [testNum, sectionRoman, sectionKind, setKey, setLabel || null, firstQuestion, lastQuestion, mode || null]
  );
  return { id: result.lastID };
}

async function completeLsatSession(id) {
  // A session's answered questions are its attempts. Freeze them as the session's
  // subset so History can replay exactly what was answered. This overwrites any
  // creation-time question_numbers with the actually-answered set.
  const rows = await all(
    'SELECT DISTINCT question_number FROM lsat_attempts WHERE session_id = ? ORDER BY question_number',
    [id]
  );
  const numbers = rows.map((r) => r.question_number);
  await run(
    `UPDATE lsat_sessions SET completed_at = datetime('now'), question_numbers = ? WHERE id = ?`,
    [JSON.stringify(numbers), id]
  );
  return { answeredCount: numbers.length };
}

// lsat_sessions.question_numbers is stored as a JSON array string (or NULL for
// full-section sessions). Parse it back to an array (or null) for callers.
function parseLsatSessionRow(row) {
  if (!row) return row;
  let questionNumbers = null;
  if (row.question_numbers) {
    try { questionNumbers = JSON.parse(row.question_numbers); } catch (e) { questionNumbers = null; }
  }
  return { ...row, question_numbers: questionNumbers };
}

async function listLsatSessions({ testNum, sectionRoman } = {}) {
  const where = [];
  const params = [];
  if (testNum != null) { where.push('test_num = ?'); params.push(testNum); }
  if (sectionRoman) { where.push('section_roman = ?'); params.push(sectionRoman); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await all(`SELECT * FROM lsat_sessions ${whereSql} ORDER BY started_at DESC`, params);
  return rows.map(parseLsatSessionRow);
}

async function getLsatSession(id) {
  return parseLsatSessionRow(await get('SELECT * FROM lsat_sessions WHERE id = ?', [id]));
}

async function listLsatAttempts({ testNum, sessionId, latestOnly } = {}) {
  // latestOnly: returns only the most-recent attempt per (test, section, question).
  // Used for "current view" in the library/picker.
  if (latestOnly) {
    const where = [];
    const params = [];
    if (testNum != null) { where.push('test_num = ?'); params.push(testNum); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return await all(`
      SELECT a.* FROM lsat_attempts a
      INNER JOIN (
        SELECT test_num, section_roman, question_number, MAX(attempted_at) AS latest_at
        FROM lsat_attempts
        ${whereSql}
        GROUP BY test_num, section_roman, question_number
      ) m
      ON a.test_num = m.test_num AND a.section_roman = m.section_roman
        AND a.question_number = m.question_number AND a.attempted_at = m.latest_at
      ORDER BY a.test_num, a.section_roman, a.question_number
    `, params);
  }
  if (sessionId != null) {
    return await all('SELECT * FROM lsat_attempts WHERE session_id = ? ORDER BY question_number', [sessionId]);
  }
  if (testNum != null) {
    return await all('SELECT * FROM lsat_attempts WHERE test_num = ? ORDER BY section_roman, question_number, attempted_at DESC', [testNum]);
  }
  return await all('SELECT * FROM lsat_attempts ORDER BY attempted_at DESC');
}

async function listLsatErrors({ testNum, sectionRoman, limit = 200 } = {}) {
  // Most recent INCORRECT attempts (across sessions). Excludes unscored
  // attempts (where is_correct is null because the answer key wasn't parsed).
  const where = ['is_correct = 0'];
  const params = [];
  if (testNum != null) { where.push('test_num = ?'); params.push(testNum); }
  if (sectionRoman) { where.push('section_roman = ?'); params.push(sectionRoman.toUpperCase()); }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  return await all(`SELECT * FROM lsat_attempts ${whereSql} ORDER BY attempted_at DESC LIMIT ?`, [...params, limit]);
}

async function clearLsatAttempts({ testNum, sectionRoman }) {
  if (testNum == null || !sectionRoman) {
    throw new Error('testNum and sectionRoman are required');
  }
  const before = await get(
    'SELECT COUNT(*) AS n FROM lsat_attempts WHERE test_num = ? AND section_roman = ?',
    [testNum, String(sectionRoman).toUpperCase()]
  );
  await run(
    'DELETE FROM lsat_attempts WHERE test_num = ? AND section_roman = ?',
    [testNum, String(sectionRoman).toUpperCase()]
  );
  return { deleted: before?.n || 0 };
}

async function lsatStats() {
  const totals = await get('SELECT COUNT(*) AS n, SUM(is_correct) AS c FROM lsat_attempts');
  const byKind = await all(`SELECT section_kind AS kind, COUNT(*) AS n, SUM(is_correct) AS c FROM lsat_attempts GROUP BY section_kind`);
  const byTest = await all(`SELECT test_num AS testNum, COUNT(*) AS n, SUM(is_correct) AS c FROM lsat_attempts GROUP BY test_num ORDER BY test_num`);
  return { totals, byKind, byTest };
}

function safeInt(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

// Range-validating integer: returns the value rounded to int if it falls
// within [min, max] inclusive, otherwise null. Used at the persistence
// boundary so the DB never holds an out-of-spec scaled score (e.g.,
// total > 805 or section < 60).
function safeIntInRange(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return Math.round(n);
}

function boolToInt(value) {
  return value ? 1 : 0;
}

function normalizedTextOrNull(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeAnswerChoicesForStorage(value) {
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => {
        const label = normalizedTextOrNull(item?.label);
        const text = normalizedTextOrNull(item?.text);
        if (!label && !text) return null;
        return {
          label: label || null,
          text: text || null,
        };
      })
      .filter(Boolean);
    return normalized.length ? JSON.stringify(normalized) : null;
  }

  const text = normalizedTextOrNull(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return text;
    return normalizeAnswerChoicesForStorage(parsed);
  } catch (_error) {
    return text;
  }
}

function toNullableInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  return parsed;
}

function unansweredPlaceholderExpr(alias = 'q') {
  const prefix = alias ? `${alias}.` : '';
  return `(
    COALESCE(TRIM(${prefix}my_answer), '') = ''
    AND COALESCE(TRIM(${prefix}correct_answer), '') = ''
    AND COALESCE(TRIM(${prefix}question_stem), '') = ''
    AND COALESCE(${prefix}time_sec, 0) <= 5
  )`;
}

function parseReviewRouteFromUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return null;
  const match = value.match(/custom-quiz\/(\d+)\/review\/categories\/(\d+)\/([^/?#]+)/i);
  if (!match) return null;
  return {
    sessionExternalId: match[1],
    catId: toNullableInteger(match[2]),
    qId: String(match[3] || '').trim() || null,
  };
}

function baseUrlWithoutHash(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  return value.split('#')[0].trim();
}

function buildReviewUrl(baseUrl, sessionExternalId, catId, qId) {
  const base = String(baseUrl || '').trim();
  const session = String(sessionExternalId || '').trim();
  const questionId = String(qId || '').trim();
  const categoryId = toNullableInteger(catId);
  if (!base || !session || !questionId || !Number.isInteger(categoryId)) return '';
  return `${base}#custom-quiz/${session}/review/categories/${categoryId}/${questionId}`;
}

function fallbackTopicFromSubjectSubCodes(subjectSubRaw, subjectSub) {
  const code = String(subjectSubRaw || subjectSub || '').trim().toUpperCase();
  if (!code) return null;
  if (code === 'PS') return 'Problem Solving';
  if (code === 'DS') return 'Data Sufficiency';
  if (code === 'MSR') return 'Multi-Source Reasoning';
  if (code === 'TA') return 'Table Analysis';
  if (code === 'GI') return 'Graphics Interpretation';
  if (code === 'TPA') return 'Two-Part Analysis';
  return null;
}

function normalizeResponseDetailsForStorage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const slots = Array.isArray(value.slots)
    ? value.slots
        .map((slot, slotIndex) => {
          const options = Array.isArray(slot?.options)
            ? slot.options
                .map((option, optionIndex) => {
                  const rawId = normalizedTextOrNull(option?.id);
                  const label = normalizedTextOrNull(option?.label);
                  const text = normalizedTextOrNull(option?.text);
                  if (!rawId && !label && !text) return null;
                  return {
                    id: rawId || `option_${optionIndex + 1}`,
                    label: label || null,
                    text: text || null,
                    selected: Boolean(option?.selected),
                    correct: Boolean(option?.correct),
                    incorrect: Boolean(option?.incorrect),
                  };
                })
                .filter(Boolean)
            : [];

          return {
            slot_id: normalizedTextOrNull(slot?.slot_id) || `slot_${slotIndex + 1}`,
            slot_type: normalizedTextOrNull(slot?.slot_type) || null,
            prompt: normalizedTextOrNull(slot?.prompt) || null,
            user_value: normalizedTextOrNull(slot?.user_value) || null,
            correct_value: normalizedTextOrNull(slot?.correct_value) || null,
            options,
          };
        })
        .filter((slot) => slot && (slot.prompt || slot.options.length || slot.user_value || slot.correct_value))
    : [];

  const responseFormat = normalizedTextOrNull(value.response_format);
  if (!responseFormat && !slots.length) return null;

  return JSON.stringify({
    response_format: responseFormat || null,
    slots,
  });
}

async function backfillSparseQuestionAttempts({ sessionIds = [] } = {}) {
  const scopedSessionIds = Array.isArray(sessionIds)
    ? Array.from(
        new Set(
          sessionIds
            .map((id) => toNullableInteger(id))
            .filter((id) => Number.isInteger(id) && id > 0)
        )
      )
    : [];

  const scopeClause = scopedSessionIds.length
    ? `AND q.session_id IN (${scopedSessionIds.map(() => '?').join(', ')})`
    : '';

  const sparseRows = await all(
    `
      SELECT
        q.id,
        q.session_id,
        q.q_id,
        q.q_code,
        q.cat_id,
        q.subject_sub,
        q.subject_sub_raw,
        q.topic,
        q.question_url,
        s.source,
        s.session_external_id
      FROM question_attempts q
      INNER JOIN sessions s ON s.id = q.session_id
      WHERE COALESCE(TRIM(q.q_id), '') <> ''
        AND (
          COALESCE(TRIM(q.q_code), '') = ''
          OR COALESCE(TRIM(q.topic), '') = ''
          OR COALESCE(TRIM(q.question_url), '') = ''
        )
      ${scopeClause}
      ORDER BY q.id ASC
    `,
    scopedSessionIds
  );

  let updated = 0;

  for (const row of sparseRows) {
    const donor = await get(
      `
        SELECT
          q2.q_code,
          q2.cat_id,
          q2.topic,
          q2.question_url,
          s2.source
        FROM question_attempts q2
        INNER JOIN sessions s2 ON s2.id = q2.session_id
        WHERE q2.id <> ?
          AND q2.q_id = ?
          AND (
            COALESCE(TRIM(q2.q_code), '') <> ''
            OR COALESCE(TRIM(q2.topic), '') <> ''
            OR COALESCE(TRIM(q2.question_url), '') <> ''
            OR q2.cat_id IS NOT NULL
          )
        ORDER BY
          CASE WHEN COALESCE(s2.source, '') = COALESCE(?, '') THEN 0 ELSE 1 END,
          CASE WHEN COALESCE(TRIM(q2.question_url), '') <> '' THEN 0 ELSE 1 END,
          q2.id DESC
        LIMIT 1
      `,
      [row.id, row.q_id, row.source || null]
    );

    const currentQCode = normalizedTextOrNull(row.q_code);
    const currentTopic = normalizedTextOrNull(row.topic);
    const currentUrl = normalizedTextOrNull(row.question_url);
    const currentCatId = toNullableInteger(row.cat_id);

    const donorQCode = normalizedTextOrNull(donor?.q_code);
    const donorTopic = normalizedTextOrNull(donor?.topic);
    const donorUrl = normalizedTextOrNull(donor?.question_url);
    const donorRoute = parseReviewRouteFromUrl(donorUrl);
    const donorCatId = toNullableInteger(donor?.cat_id) || donorRoute?.catId || null;
    const donorBaseUrl = baseUrlWithoutHash(donorUrl);
    const fallbackTopic = fallbackTopicFromSubjectSubCodes(row.subject_sub_raw, row.subject_sub);

    const nextQCode = currentQCode || donorQCode || null;
    const nextTopic = currentTopic || donorTopic || fallbackTopic || null;
    let nextCatId = currentCatId;
    if (Number.isInteger(donorCatId) && (!Number.isInteger(nextCatId) || !currentUrl)) {
      nextCatId = donorCatId;
    }

    let nextUrl = currentUrl;
    if (!nextUrl) {
      const rebuilt = buildReviewUrl(donorBaseUrl, row.session_external_id, nextCatId, row.q_id);
      nextUrl = rebuilt || donorUrl || null;
    }

    const catChanged =
      (Number.isInteger(nextCatId) ? nextCatId : null) !==
      (Number.isInteger(currentCatId) ? currentCatId : null);
    const changed =
      nextQCode !== currentQCode ||
      nextTopic !== currentTopic ||
      (nextUrl || null) !== (currentUrl || null) ||
      catChanged;

    if (!changed) continue;

    await run(
      `
        UPDATE question_attempts
        SET
          q_code = ?,
          cat_id = ?,
          topic = ?,
          question_url = ?
        WHERE id = ?
      `,
      [nextQCode, nextCatId, nextTopic, nextUrl, row.id]
    );
    updated += 1;
  }

  return {
    scanned: sparseRows.length,
    updated,
  };
}

function pushIndexedAnnotation(map, key, value) {
  if (!key) return;
  const current = map.get(key) || [];
  current.push(value);
  map.set(key, current);
}

function buildAnnotationIndex(rows = []) {
  const byQid = new Map();
  const byQcodeCat = new Map();
  const byQcode = new Map();

  for (const row of rows) {
    const mistakeType = normalizedTextOrNull(row?.mistake_type);
    const notes = normalizedTextOrNull(row?.notes);
    if (!mistakeType && !notes) continue;

    const item = {
      mistake_type: mistakeType,
      notes,
      used: false,
    };

    const qid = String(row?.q_id || '').trim();
    const qcode = String(row?.q_code || '').trim();
    const catId = String(row?.cat_id || '').trim();

    if (qid) pushIndexedAnnotation(byQid, qid, item);
    if (qcode && catId) pushIndexedAnnotation(byQcodeCat, `${qcode}|${catId}`, item);
    if (qcode) pushIndexedAnnotation(byQcode, qcode, item);
  }

  return { byQid, byQcodeCat, byQcode };
}

function takeUnused(items = []) {
  const hit = items.find((item) => item && !item.used);
  if (!hit) return null;
  hit.used = true;
  return hit;
}

function pickPreservedAnnotation(index, question = {}) {
  if (!index) return null;

  const qid = String(question?.q_id || '').trim();
  if (qid) {
    const fromQid = takeUnused(index.byQid.get(qid) || []);
    if (fromQid) return fromQid;
  }

  const qcode = String(question?.q_code || '').trim();
  const catId = String(question?.cat_id || '').trim();
  if (qcode && catId) {
    const fromQcodeCat = takeUnused(index.byQcodeCat.get(`${qcode}|${catId}`) || []);
    if (fromQcodeCat) return fromQcodeCat;
  }

  if (qcode) {
    const fromQcode = takeUnused(index.byQcode.get(qcode) || []);
    if (fromQcode) return fromQcode;
  }

  return null;
}

function scoreAttemptSnapshot(snapshot = {}) {
  let score = 0;
  if (snapshot.q_code) score += 2;
  if (snapshot.question_url) score += 2;
  if (snapshot.question_stem) score += 2;
  if (snapshot.subject_code) score += 1;
  if (snapshot.category_code) score += 1;
  if (snapshot.subcategory) score += 1;
  if (snapshot.answer_choices) score += 1;
  if (snapshot.response_format) score += 1;
  if (snapshot.response_details) score += 2;
  if (snapshot.topic) score += 1;
  if (snapshot.topic_source) score += 1;
  if (snapshot.content_domain) score += 1;
  if (Number.isInteger(snapshot.cat_id)) score += 1;
  if (snapshot.mistake_type) score += 1;
  if (snapshot.notes) score += 1;
  return score;
}

function setSnapshotIfBetter(map, key, snapshot) {
  if (!key) return;
  const current = map.get(key);
  if (!current || scoreAttemptSnapshot(snapshot) > scoreAttemptSnapshot(current)) {
    map.set(key, snapshot);
  }
}

function buildAttemptSnapshotIndex(rows = []) {
  const byQid = new Map();
  const byQcodeCat = new Map();
  const byQcode = new Map();

  for (const row of rows || []) {
    const snapshot = {
      q_code: normalizedTextOrNull(row?.q_code),
      cat_id: toNullableInteger(row?.cat_id),
      subject_code: normalizedTextOrNull(row?.subject_code),
      category_code: normalizedTextOrNull(row?.category_code),
      subcategory: normalizedTextOrNull(row?.subcategory),
      topic: normalizedTextOrNull(row?.topic),
      topic_source: normalizedTextOrNull(row?.topic_source),
      content_domain: normalizedTextOrNull(row?.content_domain),
      question_url: normalizedTextOrNull(row?.question_url),
      question_stem: normalizedTextOrNull(row?.question_stem),
      answer_choices: normalizeAnswerChoicesForStorage(row?.answer_choices),
      response_format: normalizedTextOrNull(row?.response_format),
      response_details: normalizeResponseDetailsForStorage(row?.response_details),
      passage_text: normalizedTextOrNull(row?.passage_text),
      mistake_type: normalizedTextOrNull(row?.mistake_type),
      notes: normalizedTextOrNull(row?.notes),
      // OPE Phase 3 enriches `difficulty` (label) + `difficulty_theta` (raw
      // theta). Phase 1 rescrapes wipe and reinsert attempts, so we preserve
      // these fields from the existing row when the scraper doesn't supply
      // them — same pattern as mistake_type / notes.
      difficulty: normalizedTextOrNull(row?.difficulty),
      difficulty_theta: Number.isFinite(Number(row?.difficulty_theta)) ? Number(row.difficulty_theta) : null,
    };

    const qid = String(row?.q_id || '').trim();
    const qcode = String(row?.q_code || '').trim();
    const catId = String(row?.cat_id || '').trim();

    if (qid) setSnapshotIfBetter(byQid, qid, snapshot);
    if (qcode && catId) setSnapshotIfBetter(byQcodeCat, `${qcode}|${catId}`, snapshot);
    if (qcode) setSnapshotIfBetter(byQcode, qcode, snapshot);
  }

  return { byQid, byQcodeCat, byQcode };
}

function pickAttemptSnapshot(index, question = {}) {
  if (!index) return null;

  const qid = String(question?.q_id || '').trim();
  if (qid) {
    const fromQid = index.byQid.get(qid);
    if (fromQid) return fromQid;
  }

  const qcode = String(question?.q_code || '').trim();
  const catId = String(question?.cat_id || '').trim();
  if (qcode && catId) {
    const fromQcodeCat = index.byQcodeCat.get(`${qcode}|${catId}`);
    if (fromQcodeCat) return fromQcodeCat;
  }

  if (qcode) {
    const fromQcode = index.byQcode.get(qcode);
    if (fromQcode) return fromQcode;
  }

  return null;
}

async function saveScrapeResult(data, scrapeOptions = {}) {
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const totalQuestions = sessions.reduce((sum, session) => sum + (session.stats?.total_q_api || 0), 0);
  const totalErrors = sessions.reduce((sum, session) => sum + (session.stats?.errors || 0), 0);

  const runInsert = await run(
    `
      INSERT INTO scrape_runs (
        extracted_at,
        since_value,
        source,
        review_category_id,
        total_sessions,
        total_questions,
        total_errors
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      data.extracted_at || new Date().toISOString(),
      scrapeOptions.since || data.config?.since || null,
      scrapeOptions.source || data.config?.source || null,
      safeInt(scrapeOptions.reviewCategoryId),
      sessions.length,
      totalQuestions,
      totalErrors,
    ]
  );

  const runId = runInsert.lastID;
  const touchedSessionIds = [];

  for (const session of sessions) {
    const stats = session.stats || {};
    let sessionId = null;
    let preservedAnnotationIndex = null;
    let preservedSnapshotIndex = null;

    const existing = await get(
      `
        SELECT id
        FROM sessions
        WHERE session_external_id = ?
          AND COALESCE(source, '') = COALESCE(?, '')
        ORDER BY id DESC
        LIMIT 1
      `,
      [safeInt(session.session_id), session.source || null]
    );

    if (existing?.id) {
      const existingAttempts = await all(
        `
          SELECT q_id, q_code, cat_id, subject_code, category_code, subcategory, topic, topic_source, content_domain, question_url, question_stem, answer_choices, response_format, response_details, passage_text, mistake_type, notes, difficulty, difficulty_theta
          FROM question_attempts
          WHERE session_id = ?
        `,
        [existing.id]
      );
      preservedAnnotationIndex = buildAnnotationIndex(existingAttempts);
      preservedSnapshotIndex = buildAttemptSnapshotIndex(existingAttempts);

      await run(
        `
          UPDATE sessions
          SET
            run_id = ?,
            session_date = ?,
            source = ?,
            subject = ?,
            total_q_api = ?,
            total_q_categories = ?,
            correct_count = ?,
            error_count = ?,
            accuracy_pct = ?,
            avg_time_sec = ?,
            avg_correct_time_sec = ?,
            avg_incorrect_time_sec = ?,
            total_score = COALESCE(?, total_score),
            total_percentile = COALESCE(?, total_percentile),
            quant_score = COALESCE(?, quant_score),
            quant_percentile = COALESCE(?, quant_percentile),
            verbal_score = COALESCE(?, verbal_score),
            verbal_percentile = COALESCE(?, verbal_percentile),
            di_score = COALESCE(?, di_score),
            di_percentile = COALESCE(?, di_percentile)
          WHERE id = ?
        `,
        [
          runId,
          session.date || null,
          session.source || null,
          session.subject || null,
          safeInt(stats.total_q_api),
          safeInt(stats.total_q_categories),
          safeInt(stats.correct),
          safeInt(stats.errors),
          Number.isFinite(Number(stats.accuracy_pct)) ? Number(stats.accuracy_pct) : null,
          safeInt(stats.avg_time_sec),
          safeInt(stats.avg_correct_time_sec),
          safeInt(stats.avg_incorrect_time_sec),
          safeIntInRange(session.scoreSummary?.total?.score, 205, 805),
          safeIntInRange(session.scoreSummary?.total?.percentile, 0, 100),
          safeIntInRange(session.scoreSummary?.quant?.score, 60, 90),
          safeIntInRange(session.scoreSummary?.quant?.percentile, 0, 100),
          safeIntInRange(session.scoreSummary?.verbal?.score, 60, 90),
          safeIntInRange(session.scoreSummary?.verbal?.percentile, 0, 100),
          safeIntInRange(session.scoreSummary?.di?.score, 60, 90),
          safeIntInRange(session.scoreSummary?.di?.percentile, 0, 100),
          existing.id,
        ]
      );
      sessionId = existing.id;
      await run('DELETE FROM question_attempts WHERE session_id = ?', [sessionId]);
    } else {
      const sessionInsert = await run(
        `
          INSERT INTO sessions (
            run_id,
            session_external_id,
            session_date,
            source,
            subject,
            total_q_api,
            total_q_categories,
            correct_count,
            error_count,
            accuracy_pct,
            avg_time_sec,
            avg_correct_time_sec,
            avg_incorrect_time_sec,
            total_score,
            total_percentile,
            quant_score,
            quant_percentile,
            verbal_score,
            verbal_percentile,
            di_score,
            di_percentile
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          runId,
          safeInt(session.session_id),
          session.date || null,
          session.source || null,
          session.subject || null,
          safeInt(stats.total_q_api),
          safeInt(stats.total_q_categories),
          safeInt(stats.correct),
          safeInt(stats.errors),
          Number.isFinite(Number(stats.accuracy_pct)) ? Number(stats.accuracy_pct) : null,
          safeInt(stats.avg_time_sec),
          safeInt(stats.avg_correct_time_sec),
          safeInt(stats.avg_incorrect_time_sec),
          safeIntInRange(session.scoreSummary?.total?.score, 205, 805),
          safeIntInRange(session.scoreSummary?.total?.percentile, 0, 100),
          safeIntInRange(session.scoreSummary?.quant?.score, 60, 90),
          safeIntInRange(session.scoreSummary?.quant?.percentile, 0, 100),
          safeIntInRange(session.scoreSummary?.verbal?.score, 60, 90),
          safeIntInRange(session.scoreSummary?.verbal?.percentile, 0, 100),
          safeIntInRange(session.scoreSummary?.di?.score, 60, 90),
          safeIntInRange(session.scoreSummary?.di?.percentile, 0, 100),
        ]
      );
      sessionId = sessionInsert.lastID;
    }
    if (Number.isInteger(sessionId) && sessionId > 0) touchedSessionIds.push(sessionId);
    const attempts = Array.isArray(session.questions) ? session.questions : [];

    for (const q of attempts) {
      const preserved = pickPreservedAnnotation(preservedAnnotationIndex, q);
      const preservedSnapshot = pickAttemptSnapshot(preservedSnapshotIndex, q);
      const mistakeType =
        normalizedTextOrNull(q.mistake_type) ||
        preserved?.mistake_type ||
        preservedSnapshot?.mistake_type ||
        null;
      const notes =
        normalizedTextOrNull(q.notes) ||
        preserved?.notes ||
        preservedSnapshot?.notes ||
        null;
      const qCode = normalizedTextOrNull(q.q_code) || preservedSnapshot?.q_code || null;
      const catId = toNullableInteger(q.cat_id) ?? preservedSnapshot?.cat_id ?? null;
      const topic = normalizedTextOrNull(q.topic) || preservedSnapshot?.topic || null;
      const topicSource =
        normalizedTextOrNull(q.topic_source) ||
        (normalizedTextOrNull(q.topic) ? 'heuristic' : null) ||
        preservedSnapshot?.topic_source ||
        null;
      const contentDomain =
        normalizedTextOrNull(q.content_domain) ||
        preservedSnapshot?.content_domain ||
        null;
      const questionUrl = normalizedTextOrNull(q.question_url) || preservedSnapshot?.question_url || null;
      const questionStem = normalizedTextOrNull(q.question_stem) || preservedSnapshot?.question_stem || null;
      const answerChoices =
        normalizeAnswerChoicesForStorage(q.answer_choices) ||
        preservedSnapshot?.answer_choices ||
        null;
      const responseFormat =
        normalizedTextOrNull(q.response_format) ||
        preservedSnapshot?.response_format ||
        null;
      const responseDetails =
        normalizeResponseDetailsForStorage(q.response_details) ||
        preservedSnapshot?.response_details ||
        null;
      const passageText =
        normalizedTextOrNull(q.passage_text) ||
        preservedSnapshot?.passage_text ||
        null;
      const metadata = deriveQuestionMetadata(
        {
          ...q,
          topic,
          subcategory: q.subcategory || preservedSnapshot?.subcategory || null,
          category_code: q.category_code || preservedSnapshot?.category_code || null,
          subject_code: q.subject_code || preservedSnapshot?.subject_code || null,
        },
        session
      );

      const attemptValues = [
        runId,
        sessionId,
        qCode,
        q.q_id || null,
        catId,
        metadata.subject_code,
        metadata.category_code,
        metadata.subcategory,
        q.subject_sub || null,
        q.subject_sub_raw || null,
        questionUrl,
          questionStem,
          answerChoices,
          responseFormat,
          responseDetails,
          boolToInt(Boolean(q.correct)),
          // Preserve Phase 3 theta enrichment across Phase 1 rescrapes — same
          // pattern as mistake_type / notes above. Phase 1 doesn't supply
          // difficulty for OPE, so without this fallback every rescrape would
          // null out the labels and thetas.
          q.difficulty || preservedSnapshot?.difficulty || null,
          Number.isFinite(Number(q.difficulty_theta))
            ? Number(q.difficulty_theta)
            : (preservedSnapshot?.difficulty_theta ?? null),
          q.confidence || null,
          safeInt(q.time_sec),
          q.my_answer || null,
          q.correct_answer || null,
          topic,
          topicSource,
          contentDomain,
          mistakeType,
          notes,
          passageText,
      ];
      assertValueCount('question_attempts insert', QUESTION_ATTEMPT_INSERT_COLUMNS, attemptValues);

      await run(
        buildInsertStatement('question_attempts', QUESTION_ATTEMPT_INSERT_COLUMNS),
        attemptValues
      );
    }
  }

  await backfillSparseQuestionAttempts({ sessionIds: touchedSessionIds });

  return get('SELECT * FROM scrape_runs WHERE id = ?', [runId]);
}

async function listRuns(limit = 20) {
  return all(
    `
      SELECT *
      FROM scrape_runs
      ORDER BY id DESC
      LIMIT ?
    `,
    [limit]
  );
}

async function getLatestRunId() {
  const row = await get('SELECT id FROM scrape_runs ORDER BY id DESC LIMIT 1');
  return row ? row.id : null;
}

function platformWhereClause(platform) {
  // Heuristic match — matches the frontend's getSourcePlatform().
  if (platform === 'gmatclub') return "LOWER(COALESCE(s.source, '')) LIKE '%gmat club%'";
  if (platform === 'ttp') return "LOWER(COALESCE(s.source, '')) LIKE '%target test prep%'";
  if (platform === 'ope-mock') return "LOWER(COALESCE(s.source, '')) LIKE '%practice exam%'";
  if (platform === 'starttest') {
    // Official Guide books: anything that's not gmatclub, ttp, or an OPE mock.
    return "LOWER(COALESCE(s.source, '')) NOT LIKE '%gmat club%' AND LOWER(COALESCE(s.source, '')) NOT LIKE '%target test prep%' AND LOWER(COALESCE(s.source, '')) NOT LIKE '%practice exam%'";
  }
  return null;
}

// Buckets the `difficulty` text column into Easy/Medium/Hard. OPE Phase 3 stores
// the raw IRT 3PL b-parameter (theta, e.g. "-0.076"); other sources store text
// labels which pass through unchanged. Cutoffs at ±0.43 are the exact terciles
// of the standard N(0,1) ability scale that GMAC's item bank is calibrated on
// — anchored on 0 so semantics stay stable as new sessions arrive, rather than
// drifting with the user's seen-sample mean.
function difficultyBucketExpr(alias = 'q') {
  const col = `${alias}.difficulty`;
  return `CASE
    WHEN COALESCE(NULLIF(${col}, ''), '') = '' THEN 'Unknown'
    WHEN ${col} GLOB '-[0-9]*' OR ${col} GLOB '[0-9]*' OR ${col} GLOB '.[0-9]*' OR ${col} GLOB '-.[0-9]*' THEN
      CASE
        WHEN CAST(${col} AS REAL) < -0.43 THEN 'Easy'
        WHEN CAST(${col} AS REAL) > 0.43 THEN 'Hard'
        ELSE 'Medium'
      END
    ELSE ${col}
  END`;
}

// Normalizes the raw `subject` column to the frontend's 'Q' | 'V' | 'DI' buckets.
// Mirrors normalizeSubjectCodeValue in client/src/App.jsx — keep in sync.
function subjectNormalizationExpr(prefix) {
  const col = `UPPER(TRIM(COALESCE(${prefix}subject, '')))`;
  return `CASE
    WHEN ${col} IN ('Q','QUANT','PS') THEN 'Q'
    WHEN ${col} IN ('V','VERBAL','CR','RC') THEN 'V'
    WHEN ${col} IN ('DI','DS','MSR','TPA','GI','TA') THEN 'DI'
    ELSE ${col}
  END`;
}

async function listSessions(runId, { limit, offset, platform, subject, startDate, endDate } = {}) {
  const params = [];
  const conditions = [];
  if (runId) {
    conditions.push('s.run_id = ?');
    params.push(runId);
  }
  const platformClause = platformWhereClause(platform);
  if (platformClause) conditions.push(platformClause);
  if (subject) {
    conditions.push(`${subjectNormalizationExpr('s.')} = ?`);
    params.push(String(subject).toUpperCase());
  }
  if (startDate) {
    conditions.push('DATE(s.session_date) >= DATE(?)');
    params.push(startDate);
  }
  if (endDate) {
    conditions.push('DATE(s.session_date) <= DATE(?)');
    params.push(endDate);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const unansweredExpr = unansweredPlaceholderExpr('q');
  const answeredCountExpr = `SUM(CASE WHEN NOT (${unansweredExpr}) THEN 1 ELSE 0 END)`;
  const answeredCorrectExpr = `SUM(CASE WHEN NOT (${unansweredExpr}) AND q.correct = 1 THEN 1 ELSE 0 END)`;
  const answeredWrongExpr = `SUM(CASE WHEN NOT (${unansweredExpr}) AND q.correct = 0 THEN 1 ELSE 0 END)`;
  const answeredAvgTimeExpr = `ROUND(AVG(CASE WHEN NOT (${unansweredExpr}) THEN q.time_sec END), 0)`;
  const answeredAvgCorrectTimeExpr = `ROUND(AVG(CASE WHEN NOT (${unansweredExpr}) AND q.correct = 1 THEN q.time_sec END), 0)`;
  const answeredAvgWrongTimeExpr = `ROUND(AVG(CASE WHEN NOT (${unansweredExpr}) AND q.correct = 0 THEN q.time_sec END), 0)`;

  let limitClause = '';
  if (limit !== undefined && offset !== undefined) {
    limitClause = 'LIMIT ? OFFSET ?';
    params.push(limit, offset);
  }

  return all(
    `
      SELECT
        s.id,
        s.run_id,
        s.session_external_id,
        s.session_date,
        s.source,
        s.subject,
        s.total_q_api,
        s.total_q_categories,
        s.correct_count,
        s.error_count,
        s.total_score,
        s.total_percentile,
        s.quant_score,
        s.quant_percentile,
        s.verbal_score,
        s.verbal_percentile,
        s.di_score,
        s.di_percentile,
        ${answeredCountExpr} AS attempt_total,
        COALESCE(${answeredCorrectExpr}, 0) AS attempt_correct,
        COALESCE(${answeredWrongExpr}, 0) AS attempt_wrong,
        ROUND(
          CASE
            WHEN ${answeredCountExpr} > 0
              THEN
                100.0
                * ${answeredCorrectExpr}
                / ${answeredCountExpr}
            WHEN (COALESCE(s.correct_count, 0) + COALESCE(s.error_count, 0)) > 0
              THEN
                100.0
                * COALESCE(s.correct_count, 0)
                / (COALESCE(s.correct_count, 0) + COALESCE(s.error_count, 0))
            ELSE s.accuracy_pct
          END,
          1
        ) AS accuracy_pct,
        COALESCE(${answeredAvgTimeExpr}, s.avg_time_sec) AS avg_time_sec,
        COALESCE(${answeredAvgCorrectTimeExpr}, s.avg_correct_time_sec) AS avg_correct_time_sec,
        COALESCE(${answeredAvgWrongTimeExpr}, s.avg_incorrect_time_sec) AS avg_incorrect_time_sec,
        SUM(CASE WHEN LOWER(COALESCE(q.difficulty, '')) = 'hard' THEN 1 ELSE 0 END) AS hard_total,
        SUM(
          CASE
            WHEN LOWER(COALESCE(q.difficulty, '')) = 'hard' AND q.correct = 1 THEN 1
            ELSE 0
          END
        ) AS hard_correct,
        ROUND(
          CASE
            WHEN SUM(CASE WHEN LOWER(COALESCE(q.difficulty, '')) = 'hard' THEN 1 ELSE 0 END) > 0
              THEN
                100.0
                * SUM(
                  CASE
                    WHEN LOWER(COALESCE(q.difficulty, '')) = 'hard' AND q.correct = 1 THEN 1
                    ELSE 0
                  END
                )
                / SUM(CASE WHEN LOWER(COALESCE(q.difficulty, '')) = 'hard' THEN 1 ELSE 0 END)
            ELSE NULL
          END,
          1
        ) AS hard_accuracy_pct,
        ROUND(
          AVG(CASE WHEN LOWER(COALESCE(q.difficulty, '')) = 'hard' THEN q.time_sec END),
          0
        ) AS hard_avg_time_sec,
        SUM(CASE WHEN LOWER(COALESCE(q.difficulty, '')) = 'medium' THEN 1 ELSE 0 END) AS medium_total,
        SUM(
          CASE
            WHEN LOWER(COALESCE(q.difficulty, '')) = 'medium' AND q.correct = 1 THEN 1
            ELSE 0
          END
        ) AS medium_correct,
        ROUND(
          CASE
            WHEN SUM(CASE WHEN LOWER(COALESCE(q.difficulty, '')) = 'medium' THEN 1 ELSE 0 END) > 0
              THEN
                100.0
                * SUM(
                  CASE
                    WHEN LOWER(COALESCE(q.difficulty, '')) = 'medium' AND q.correct = 1 THEN 1
                    ELSE 0
                  END
                )
                / SUM(CASE WHEN LOWER(COALESCE(q.difficulty, '')) = 'medium' THEN 1 ELSE 0 END)
            ELSE NULL
          END,
          1
        ) AS medium_accuracy_pct,
        ROUND(
          AVG(CASE WHEN LOWER(COALESCE(q.difficulty, '')) = 'medium' THEN q.time_sec END),
          0
        ) AS medium_avg_time_sec,
        SUM(CASE WHEN LOWER(COALESCE(q.difficulty, '')) = 'easy' THEN 1 ELSE 0 END) AS easy_total,
        SUM(
          CASE
            WHEN LOWER(COALESCE(q.difficulty, '')) = 'easy' AND q.correct = 1 THEN 1
            ELSE 0
          END
        ) AS easy_correct,
        ROUND(
          CASE
            WHEN SUM(CASE WHEN LOWER(COALESCE(q.difficulty, '')) = 'easy' THEN 1 ELSE 0 END) > 0
              THEN
                100.0
                * SUM(
                  CASE
                    WHEN LOWER(COALESCE(q.difficulty, '')) = 'easy' AND q.correct = 1 THEN 1
                    ELSE 0
                  END
                )
                / SUM(CASE WHEN LOWER(COALESCE(q.difficulty, '')) = 'easy' THEN 1 ELSE 0 END)
            ELSE NULL
          END,
          1
        ) AS easy_accuracy_pct,
        ROUND(
          AVG(CASE WHEN LOWER(COALESCE(q.difficulty, '')) = 'easy' THEN q.time_sec END),
          0
        ) AS easy_avg_time_sec
      FROM sessions s
      LEFT JOIN question_attempts q ON q.session_id = s.id
      ${whereClause}
      GROUP BY s.id
      ORDER BY s.session_date DESC, s.session_external_id DESC
      ${limitClause}
    `,
    params
  );
}

async function countSessions(runId, { platform, subject, startDate, endDate } = {}) {
  const params = [];
  const conditions = [];
  if (runId) {
    conditions.push('run_id = ?');
    params.push(runId);
  }
  // Mirror listSessions but on the bare table (no `s.` alias here).
  if (platform === 'gmatclub') {
    conditions.push("LOWER(COALESCE(source, '')) LIKE '%gmat club%'");
  } else if (platform === 'ttp') {
    conditions.push("LOWER(COALESCE(source, '')) LIKE '%target test prep%'");
  } else if (platform === 'ope-mock') {
    conditions.push("LOWER(COALESCE(source, '')) LIKE '%practice exam%'");
  } else if (platform === 'starttest') {
    conditions.push("LOWER(COALESCE(source, '')) NOT LIKE '%gmat club%' AND LOWER(COALESCE(source, '')) NOT LIKE '%target test prep%' AND LOWER(COALESCE(source, '')) NOT LIKE '%practice exam%'");
  }
  if (subject) {
    conditions.push(`${subjectNormalizationExpr('')} = ?`);
    params.push(String(subject).toUpperCase());
  }
  if (startDate) {
    conditions.push('DATE(session_date) >= DATE(?)');
    params.push(startDate);
  }
  if (endDate) {
    conditions.push('DATE(session_date) <= DATE(?)');
    params.push(endDate);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const row = await get(`SELECT COUNT(*) as total FROM sessions ${whereClause}`, params);
  return row ? row.total : 0;
}

async function listErrors({ runId, subject, difficulty, topic, confidence, search, mistakeTag, platform, sortKey, sortOrder, limit, offset }) {
  const ALLOWED_SORT = {
    session_date: 's.session_date',
    session_external_id: 's.session_external_id',
    source: 's.source',
    q_code: 'q.q_code',
    subject: 'subject',
    difficulty: 'q.difficulty',
    topic: 'topic',
    time_sec: 'q.time_sec',
    mistake_type: 'q.mistake_type',
  };
  const sortCol = ALLOWED_SORT[sortKey] || 's.session_date';
  const sortDir = sortOrder === 'asc' ? 'ASC' : 'DESC';
  const params = [];
  const where = ['q.correct = 0', `NOT (${unansweredPlaceholderExpr('q')})`];
  const normalizedSubExpr = `
    CASE
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) IN ('QUANT', 'PS') THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) IN ('CR', 'RC', 'DS', 'MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.category_code, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) = 'DI' THEN 'DI'
      WHEN q.cat_id IN (1337013, 1336833, 1336853) THEN 'RC'
      WHEN q.cat_id IN (1337023, 1336843, 1336863) THEN 'CR'
      WHEN q.cat_id IN (1336733, 1336743) THEN 'DS'
      WHEN q.cat_id = 1336753 THEN 'MSR'
      WHEN q.cat_id = 1336763 THEN 'TA'
      WHEN q.cat_id = 1336773 THEN 'GI'
      WHEN q.cat_id = 1336783 THEN 'TPA'
      WHEN q.cat_id IN (1336803, 1336813) THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'DS' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) IN ('MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'DS' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'DI' THEN 'DI'
      WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%data sufficiency%' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('CR', 'RC', 'PS', 'QUANT', 'VERBAL') THEN
        CASE UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
          WHEN 'QUANT' THEN 'PS'
          WHEN 'VERBAL' THEN 'Verbal'
          ELSE UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
        END
      ELSE ''
    END
  `;
  const subjectCodeExpr = `
    CASE
      WHEN COALESCE(NULLIF(q.subject_code, ''), '') <> '' THEN UPPER(q.subject_code)
      WHEN (${normalizedSubExpr}) IN ('DS', 'DI', 'TA', 'GI', 'MSR', 'TPA') THEN 'DI'
      WHEN (${normalizedSubExpr}) IN ('CR', 'RC', 'VERBAL') THEN 'V'
      WHEN (${normalizedSubExpr}) IN ('PS', 'QUANT') THEN 'Q'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'Verbal' THEN 'V'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'Quant' THEN 'Q'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'DI' THEN 'DI'
      ELSE ''
    END
  `;
  const subjectExpr = `
    CASE
      WHEN (${normalizedSubExpr}) <> '' THEN (${normalizedSubExpr})
      WHEN q.cat_id = 1337013 THEN 'CR'
      WHEN q.cat_id = 1337023 THEN 'RC'
      WHEN COALESCE(NULLIF(s.subject, ''), 'Unknown') = 'Verbal' THEN
        CASE
          WHEN COALESCE(NULLIF(q.topic, ''), '') IN (
            'Main Idea / Purpose', 'Detail', 'Structure / Function', 'Author View', 'Application',
            'Main Idea', 'Purpose', 'Author Attitude', 'Organization'
          ) THEN 'RC'
          WHEN COALESCE(NULLIF(q.topic, ''), '') IN (
            'Support', 'Attack', 'Assumption', 'Resolve', 'Argument Structure',
            'Weaken', 'Strengthen', 'Explain', 'Assumption',
            'Boldface', 'Evaluate', 'Flaw', 'Parallel', 'Complete', 'Method'
          ) THEN 'CR'
          ELSE 'Verbal'
        END
      WHEN q.cat_id BETWEEN 1336700 AND 1336899 THEN 'DI'
      ELSE COALESCE(NULLIF(s.subject, ''), 'Unknown')
    END
  `;
  const categoryHintExpr = `
    CASE
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) IN ('QUANT', 'PS', 'Q') THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) IN ('CR', 'RC', 'DS', 'MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.category_code, ''), ''))
      WHEN q.cat_id IN (1336803, 1336813) THEN 'PS'
      WHEN q.cat_id IN (1337013, 1336843, 1336863) THEN 'CR'
      WHEN q.cat_id IN (1337023, 1336833, 1336853) THEN 'RC'
      WHEN q.cat_id IN (1336733, 1336743) THEN 'DS'
      WHEN q.cat_id = 1336753 THEN 'MSR'
      WHEN q.cat_id = 1336763 THEN 'TA'
      WHEN q.cat_id = 1336773 THEN 'GI'
      WHEN q.cat_id = 1336783 THEN 'TPA'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) IN ('QUANT', 'PS', 'Q') THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) IN ('CR', 'RC', 'DS', 'MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('QUANT', 'PS', 'Q') THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('CR', 'RC', 'DS', 'MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.subject_code, ''), '')) = 'Q' THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_code, ''), '')) = 'DI' THEN 'DI'
      WHEN UPPER(COALESCE(NULLIF(q.subject_code, ''), '')) = 'V' THEN 'V'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'Quant' THEN 'PS'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'DI' THEN 'DI'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'Verbal' THEN 'V'
      ELSE ''
    END
  `;
  const topicExpr = `
    CASE
      WHEN COALESCE(NULLIF(q.topic, ''), '') <> '' THEN
        CASE
          WHEN (${categoryHintExpr}) = 'CR' THEN
            CASE
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Support', 'Strengthen') THEN 'Support'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Attack', 'Weaken', 'Flaw') THEN 'Attack'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Assumption', 'Evaluate') THEN 'Assumption'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Inference', 'Complete') THEN 'Inference'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Resolve', 'Explain') THEN 'Resolve'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Argument Structure', 'Boldface', 'Method', 'Parallel') THEN 'Argument Structure'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'RC' THEN
            CASE
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Main Idea / Purpose', 'Main Idea', 'Purpose') THEN 'Main Idea / Purpose'
              WHEN COALESCE(NULLIF(q.topic, ''), '') = 'Detail' THEN 'Detail'
              WHEN COALESCE(NULLIF(q.topic, ''), '') = 'Inference' THEN 'Inference'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Structure / Function', 'Organization') THEN 'Structure / Function'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Author View', 'Author Attitude') THEN 'Author View'
              WHEN COALESCE(NULLIF(q.topic, ''), '') = 'Application' THEN 'Application'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'PS' THEN
            CASE
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%overlapping sets%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%venn%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%set theory%' THEN 'Overlapping Sets'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%mean%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%median%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%standard deviation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%variance%' THEN 'Statistics'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%combin%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%permut%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%counting%' THEN 'Counting & Probability'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%distance%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%speed%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%work%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%time%' THEN 'Rates, Work & Motion'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%function%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%sequence%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inequal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%absolute value%' THEN 'Functions, Sequences & Inequalities'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%word problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%age problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%digit problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%mixture%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%problem solving%' THEN 'General Word Problems'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%percent%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%interest%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%fraction%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%ratio%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%proportion%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%decimal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%average%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%fdp%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%remainder%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%multiple%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%factor%' THEN 'Arithmetic, FDP & Ratios'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%triangle%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%circle%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%area%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%volume%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%coordinate%' THEN 'Geometry'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%number properties%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%divis%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%integer%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%odd%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%even%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%prime%' THEN 'Number Properties'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%equation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%quadratic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%linear%' THEN 'Algebra & Equations'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'DS' THEN
            CASE
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%data sufficiency%' THEN 'Unclear Topic'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%unclear topic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%poor quality%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%bad question%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%ambiguous%' THEN 'Unclear Topic'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%overlapping sets%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%venn%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%set theory%' THEN 'Overlapping Sets'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%mean%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%median%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%standard deviation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%variance%' THEN 'Statistics'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%combin%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%permut%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%counting%' THEN 'Counting & Probability'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%distance%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%speed%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%work%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%time%' THEN 'Rates, Work & Motion'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%function%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%sequence%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inequal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%absolute value%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%custom character%' THEN 'Functions, Sequences & Inequalities'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%word problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%age problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%digit problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%mixture%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%problem solving%' THEN 'General Word Problems'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%percent%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%interest%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%fraction%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%ratio%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%proportion%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%decimal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%average%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%fdp%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%remainder%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%multiple%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%factor%' THEN 'Arithmetic, FDP & Ratios'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%triangle%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%circle%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%area%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%volume%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%coordinate%' THEN 'Geometry'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%number properties%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%divis%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%integer%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%odd%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%even%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%prime%' THEN 'Number Properties'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%equation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%quadratic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%linear%' THEN 'Algebra & Equations'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'GI' THEN
            CASE
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%graphs%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%graphics interpretation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%graph%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%chart%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%plot%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%axis%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t graphs%' THEN 'Graphs'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Interpretation'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Interpretation'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non-math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%verbal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%reading%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inference%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%author%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%purpose%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t non-math related%' THEN 'Non-Math Interpretation'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%number properties%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t math related%' THEN 'Math-Based Interpretation'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'TA' THEN
            CASE
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%tables%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%table analysis%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%table%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t tables%' THEN 'Tables'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Analysis'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Analysis'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non-math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%verbal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%reading%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inference%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%author%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%purpose%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t non-math related%' THEN 'Non-Math Analysis'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%number properties%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t math related%' THEN 'Math-Based Analysis'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'MSR' THEN
            CASE
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Reasoning'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Reasoning'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non-math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%verbal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%reading%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inference%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%author%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%purpose%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%msr non-math related%' THEN 'Non-Math Reasoning'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%multi-source reasoning%' THEN 'Unknown'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%msr math related%' THEN 'Math-Based Reasoning'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'TPA' THEN
            CASE
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Reasoning'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Reasoning'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non-math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%verbal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%reading%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inference%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%author%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%purpose%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%tpa non-math related%' THEN 'Non-Math Reasoning'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%two-part analysis%' THEN 'Unknown'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%tpa math related%' THEN 'Math-Based Reasoning'
              ELSE q.topic
            END
          ELSE q.topic
        END
      WHEN (${categoryHintExpr}) = 'GI' THEN 'Graphs'
      WHEN (${categoryHintExpr}) = 'TA' THEN 'Tables'
      WHEN (${categoryHintExpr}) = 'MSR' THEN
        CASE
          WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Reasoning'
          WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Reasoning'
          ELSE 'Unknown'
        END
      WHEN (${categoryHintExpr}) = 'TPA' THEN
        CASE
          WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Reasoning'
          WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Reasoning'
          ELSE 'Unknown'
        END
      WHEN (${categoryHintExpr}) = 'DS' THEN 'Unclear Topic'
      ELSE 'Unknown'
    END
  `;
  const difficultyExpr = `
    CASE
      WHEN LOWER(COALESCE(NULLIF(q.difficulty, ''), '')) = 'hard' THEN 'Hard'
      WHEN LOWER(COALESCE(NULLIF(q.difficulty, ''), '')) = 'medium' THEN 'Medium'
      WHEN LOWER(COALESCE(NULLIF(q.difficulty, ''), '')) = 'easy' THEN 'Easy'
      ELSE 'Unknown'
    END
  `;
  if (runId) {
    where.push('q.run_id = ?');
    params.push(runId);
  }
  const platformClause = platformWhereClause(platform);
  if (platformClause) where.push(platformClause);

  if (subject) {
    const normalizedSubjectFilter = String(subject || '').trim().toUpperCase();
    if (['Q', 'V', 'DI'].includes(normalizedSubjectFilter)) {
      where.push(`(${subjectCodeExpr}) = ?`);
      params.push(normalizedSubjectFilter);
    } else {
      where.push(`(${subjectExpr}) = ?`);
      params.push(subject);
    }
  }
  if (difficulty) {
    where.push(`COALESCE(NULLIF(q.difficulty, ''), 'Unknown') = ?`);
    params.push(difficulty);
  }
  if (topic) {
    where.push(`(${topicExpr}) = ?`);
    params.push(topic);
  }
  if (confidence) {
    where.push(`COALESCE(NULLIF(q.confidence, ''), 'not selected') = ?`);
    params.push(confidence);
  }
  if (search) {
    where.push(
      `(UPPER(COALESCE(q.topic, '')) LIKE UPPER(?) OR UPPER(COALESCE(q.q_code, '')) LIKE UPPER(?) OR UPPER(COALESCE(q.question_stem, '')) LIKE UPPER(?))`
    );
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (mistakeTag) {
    where.push(`COALESCE(q.mistake_type, '') LIKE ?`);
    params.push(`%${mistakeTag}%`);
  }

  let limitClause = '';
  if (limit !== undefined && offset !== undefined) {
    limitClause = 'LIMIT ? OFFSET ?';
    params.push(limit, offset);
  } else {
    limitClause = 'LIMIT 500';
  }

  const rows = await all(
    `
      SELECT
        q.id,
        q.run_id,
        s.session_external_id,
        s.session_date,
        ${subjectExpr} AS subject,
        q.subject_code,
        q.category_code,
        q.subcategory,
        q.subject_sub,
        q.subject_sub_raw,
        s.source,
        q.q_code,
        q.q_id,
        q.cat_id,
        q.question_url,
        q.question_stem,
        q.passage_text,
        q.answer_choices,
        q.response_format,
        q.response_details,
        q.difficulty,
        q.difficulty_theta,
        q.confidence,
        ${topicExpr} AS topic,
        q.topic_source,
        q.content_domain,
        q.time_sec,
        q.my_answer,
        q.correct_answer,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM question_attempts q2
            INNER JOIN sessions s2 ON s2.id = q2.session_id
            WHERE q2.correct = 1
              AND COALESCE(NULLIF(TRIM(q.q_code), ''), '') <> ''
              AND COALESCE(NULLIF(TRIM(q2.q_code), ''), '') = COALESCE(NULLIF(TRIM(q.q_code), ''), '')
              AND (
                COALESCE(s2.session_date, '') > COALESCE(s.session_date, '')
                OR (
                  COALESCE(s2.session_date, '') = COALESCE(s.session_date, '')
                  AND q2.id > q.id
                )
              )
          ) THEN 1
          WHEN EXISTS (
            SELECT 1
            FROM question_attempts q2
            INNER JOIN sessions s2 ON s2.id = q2.session_id
            WHERE q2.correct = 1
              AND COALESCE(NULLIF(TRIM(q.q_code), ''), '') = ''
              AND COALESCE(NULLIF(TRIM(q.q_id), ''), '') <> ''
              AND COALESCE(NULLIF(TRIM(q2.q_id), ''), '') = COALESCE(NULLIF(TRIM(q.q_id), ''), '')
              AND (
                COALESCE(s2.session_date, '') > COALESCE(s.session_date, '')
                OR (
                  COALESCE(s2.session_date, '') = COALESCE(s.session_date, '')
                  AND q2.id > q.id
                )
              )
          ) THEN 1
          ELSE 0
        END AS corrected_later,
        q.mistake_type,
        q.notes
      FROM question_attempts q
      INNER JOIN sessions s ON s.id = q.session_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${sortCol} ${sortDir}, q.id ${sortDir}
      ${limitClause}
    `,
    params
  );
  return rows.map((row) => enrichQuestionMetadata(row));
}

async function countErrors({ runId, subject, difficulty, topic, confidence, search, mistakeTag, platform }) {
  const params = [];
  const where = ['q.correct = 0', `NOT (${unansweredPlaceholderExpr('q')})`];
  // Re-use expressions for subject and topic logic to ensure consistency
  const normalizedSubExpr = `
    CASE
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) IN ('QUANT', 'PS') THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) IN ('CR', 'RC', 'DS', 'MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.category_code, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) = 'DI' THEN 'DI'
      WHEN q.cat_id IN (1337013, 1336833, 1336853) THEN 'RC'
      WHEN q.cat_id IN (1337023, 1336843, 1336863) THEN 'CR'
      WHEN q.cat_id IN (1336733, 1336743) THEN 'DS'
      WHEN q.cat_id = 1336753 THEN 'MSR'
      WHEN q.cat_id = 1336763 THEN 'TA'
      WHEN q.cat_id = 1336773 THEN 'GI'
      WHEN q.cat_id = 1336783 THEN 'TPA'
      WHEN q.cat_id IN (1336803, 1336813) THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'DS' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) IN ('MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'DS' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'DI' THEN 'DI'
      WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%data sufficiency%' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('CR', 'RC', 'PS', 'QUANT', 'VERBAL') THEN
        CASE UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
          WHEN 'QUANT' THEN 'PS'
          WHEN 'VERBAL' THEN 'Verbal'
          ELSE UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
        END
      ELSE ''
    END
  `;
  const subjectCodeExpr = `
    CASE
      WHEN COALESCE(NULLIF(q.subject_code, ''), '') <> '' THEN UPPER(q.subject_code)
      WHEN (${normalizedSubExpr}) IN ('DS', 'DI', 'TA', 'GI', 'MSR', 'TPA') THEN 'DI'
      WHEN (${normalizedSubExpr}) IN ('CR', 'RC', 'VERBAL') THEN 'V'
      WHEN (${normalizedSubExpr}) IN ('PS', 'QUANT') THEN 'Q'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'Verbal' THEN 'V'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'Quant' THEN 'Q'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'DI' THEN 'DI'
      ELSE ''
    END
  `;
  const subjectExpr = `
    CASE
      WHEN (${normalizedSubExpr}) <> '' THEN (${normalizedSubExpr})
      WHEN q.cat_id = 1337013 THEN 'CR'
      WHEN q.cat_id = 1337023 THEN 'RC'
      WHEN COALESCE(NULLIF(s.subject, ''), 'Unknown') = 'Verbal' THEN
        CASE
          WHEN COALESCE(NULLIF(q.topic, ''), '') IN (
            'Main Idea / Purpose', 'Detail', 'Structure / Function', 'Author View', 'Application',
            'Main Idea', 'Purpose', 'Author Attitude', 'Organization'
          ) THEN 'RC'
          WHEN COALESCE(NULLIF(q.topic, ''), '') IN (
            'Support', 'Attack', 'Assumption', 'Resolve', 'Argument Structure',
            'Weaken', 'Strengthen', 'Explain', 'Assumption',
            'Boldface', 'Evaluate', 'Flaw', 'Parallel', 'Complete', 'Method'
          ) THEN 'CR'
          ELSE 'Verbal'
        END
      WHEN q.cat_id BETWEEN 1336700 AND 1336899 THEN 'DI'
      ELSE COALESCE(NULLIF(s.subject, ''), 'Unknown')
    END
  `;
  const categoryHintExpr = `
    CASE
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) IN ('QUANT', 'PS', 'Q') THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) IN ('CR', 'RC', 'DS', 'MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.category_code, ''), ''))
      WHEN q.cat_id IN (1336803, 1336813) THEN 'PS'
      WHEN q.cat_id IN (1337013, 1336843, 1336863) THEN 'CR'
      WHEN q.cat_id IN (1337023, 1336833, 1336853) THEN 'RC'
      WHEN q.cat_id IN (1336733, 1336743) THEN 'DS'
      WHEN q.cat_id = 1336753 THEN 'MSR'
      WHEN q.cat_id = 1336763 THEN 'TA'
      WHEN q.cat_id = 1336773 THEN 'GI'
      WHEN q.cat_id = 1336783 THEN 'TPA'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) IN ('QUANT', 'PS', 'Q') THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) IN ('CR', 'RC', 'DS', 'MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('QUANT', 'PS', 'Q') THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('CR', 'RC', 'DS', 'MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.subject_code, ''), '')) = 'Q' THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_code, ''), '')) = 'DI' THEN 'DI'
      WHEN UPPER(COALESCE(NULLIF(q.subject_code, ''), '')) = 'V' THEN 'V'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'Quant' THEN 'PS'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'DI' THEN 'DI'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'Verbal' THEN 'V'
      ELSE ''
    END
  `;
  const topicExpr = `
    CASE
      WHEN COALESCE(NULLIF(q.topic, ''), '') <> '' THEN
        CASE
          WHEN (${categoryHintExpr}) = 'CR' THEN
            CASE
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Support', 'Strengthen') THEN 'Support'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Attack', 'Weaken', 'Flaw') THEN 'Attack'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Assumption', 'Evaluate') THEN 'Assumption'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Inference', 'Complete') THEN 'Inference'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Resolve', 'Explain') THEN 'Resolve'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Argument Structure', 'Boldface', 'Method', 'Parallel') THEN 'Argument Structure'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'RC' THEN
            CASE
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Main Idea / Purpose', 'Main Idea', 'Purpose') THEN 'Main Idea / Purpose'
              WHEN COALESCE(NULLIF(q.topic, ''), '') = 'Detail' THEN 'Detail'
              WHEN COALESCE(NULLIF(q.topic, ''), '') = 'Inference' THEN 'Inference'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Structure / Function', 'Organization') THEN 'Structure / Function'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Author View', 'Author Attitude') THEN 'Author View'
              WHEN COALESCE(NULLIF(q.topic, ''), '') = 'Application' THEN 'Application'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'PS' THEN
            CASE
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%overlapping sets%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%venn%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%set theory%' THEN 'Overlapping Sets'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%mean%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%median%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%standard deviation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%variance%' THEN 'Statistics'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%combin%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%permut%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%counting%' THEN 'Counting & Probability'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%distance%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%speed%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%work%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%time%' THEN 'Rates, Work & Motion'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%function%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%sequence%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inequal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%absolute value%' THEN 'Functions, Sequences & Inequalities'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%word problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%age problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%digit problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%mixture%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%problem solving%' THEN 'General Word Problems'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%percent%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%interest%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%fraction%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%ratio%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%proportion%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%decimal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%average%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%fdp%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%remainder%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%multiple%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%factor%' THEN 'Arithmetic, FDP & Ratios'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%triangle%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%circle%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%area%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%volume%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%coordinate%' THEN 'Geometry'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%number properties%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%divis%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%integer%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%odd%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%even%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%prime%' THEN 'Number Properties'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%equation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%quadratic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%linear%' THEN 'Algebra & Equations'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'DS' THEN
            CASE
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%data sufficiency%' THEN 'Unclear Topic'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%unclear topic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%poor quality%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%bad question%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%ambiguous%' THEN 'Unclear Topic'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%overlapping sets%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%venn%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%set theory%' THEN 'Overlapping Sets'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%mean%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%median%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%standard deviation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%variance%' THEN 'Statistics'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%combin%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%permut%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%counting%' THEN 'Counting & Probability'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%distance%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%speed%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%work%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%time%' THEN 'Rates, Work & Motion'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%function%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%sequence%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inequal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%absolute value%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%custom character%' THEN 'Functions, Sequences & Inequalities'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%word problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%age problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%digit problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%mixture%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%problem solving%' THEN 'General Word Problems'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%percent%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%interest%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%fraction%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%ratio%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%proportion%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%decimal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%average%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%fdp%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%remainder%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%multiple%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%factor%' THEN 'Arithmetic, FDP & Ratios'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%triangle%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%circle%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%area%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%volume%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%coordinate%' THEN 'Geometry'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%number properties%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%divis%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%integer%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%odd%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%even%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%prime%' THEN 'Number Properties'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%equation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%quadratic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%linear%' THEN 'Algebra & Equations'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'GI' THEN
            CASE
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%graphs%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%graphics interpretation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%graph%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%chart%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%plot%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%axis%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t graphs%' THEN 'Graphs'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Interpretation'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Interpretation'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non-math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%verbal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%reading%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inference%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%author%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%purpose%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t non-math related%' THEN 'Non-Math Interpretation'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%number properties%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t math related%' THEN 'Math-Based Interpretation'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'TA' THEN
            CASE
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%tables%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%table analysis%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%table%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t tables%' THEN 'Tables'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Analysis'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Analysis'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non-math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%verbal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%reading%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inference%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%author%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%purpose%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t non-math related%' THEN 'Non-Math Analysis'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%number properties%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t math related%' THEN 'Math-Based Analysis'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'MSR' THEN
            CASE
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Reasoning'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Reasoning'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non-math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%verbal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%reading%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inference%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%author%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%purpose%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%msr non-math related%' THEN 'Non-Math Reasoning'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%multi-source reasoning%' THEN 'Unknown'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%msr math related%' THEN 'Math-Based Reasoning'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'TPA' THEN
            CASE
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Reasoning'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Reasoning'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non-math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%verbal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%reading%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inference%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%author%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%purpose%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%tpa non-math related%' THEN 'Non-Math Reasoning'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%two-part analysis%' THEN 'Unknown'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%tpa math related%' THEN 'Math-Based Reasoning'
              ELSE q.topic
            END
          ELSE q.topic
        END
      WHEN (${categoryHintExpr}) = 'GI' THEN 'Graphs'
      WHEN (${categoryHintExpr}) = 'TA' THEN 'Tables'
      WHEN (${categoryHintExpr}) = 'MSR' THEN
        CASE
          WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Reasoning'
          WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Reasoning'
          ELSE 'Unknown'
        END
      WHEN (${categoryHintExpr}) = 'TPA' THEN
        CASE
          WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Reasoning'
          WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Reasoning'
          ELSE 'Unknown'
        END
      WHEN (${categoryHintExpr}) = 'DS' THEN 'Unclear Topic'
      ELSE 'Unknown'
    END
  `;

  if (runId) {
    where.push('q.run_id = ?');
    params.push(runId);
  }
  const platformClause2 = platformWhereClause(platform);
  if (platformClause2) where.push(platformClause2);
  if (subject) {
    const normalizedSubjectFilter = String(subject || '').trim().toUpperCase();
    if (['Q', 'V', 'DI'].includes(normalizedSubjectFilter)) {
      where.push(`(${subjectCodeExpr}) = ?`);
      params.push(normalizedSubjectFilter);
    } else {
      where.push(`(${subjectExpr}) = ?`);
      params.push(subject);
    }
  }
  if (difficulty) {
    where.push(`COALESCE(NULLIF(q.difficulty, ''), 'Unknown') = ?`);
    params.push(difficulty);
  }
  if (topic) {
    where.push(`(${topicExpr}) = ?`);
    params.push(topic);
  }
  if (confidence) {
    where.push(`COALESCE(NULLIF(q.confidence, ''), 'not selected') = ?`);
    params.push(confidence);
  }
  if (search) {
    where.push(
      `(UPPER(COALESCE(q.topic, '')) LIKE UPPER(?) OR UPPER(COALESCE(q.q_code, '')) LIKE UPPER(?) OR UPPER(COALESCE(q.question_stem, '')) LIKE UPPER(?))`
    );
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (mistakeTag) {
    where.push(`COALESCE(q.mistake_type, '') LIKE ?`);
    params.push(`%${mistakeTag}%`);
  }

  const row = await get(
    `
      SELECT COUNT(*) as total
      FROM question_attempts q
      INNER JOIN sessions s ON s.id = q.session_id
      WHERE ${where.join(' AND ')}
    `,
    params
  );
  return row ? row.total : 0;
}

async function getPatterns(runId) {
  const runClause = runId ? 'q.run_id = ? AND ' : '';
  const runParams = runId ? [runId] : [];
  const runJoinClause = runId ? 'q.run_id = ? AND ' : '';
  const answeredWhere = `NOT (${unansweredPlaceholderExpr('q')})`;
  const normalizedSubExpr = `
    CASE
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) IN ('QUANT', 'PS') THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) IN ('CR', 'RC', 'DS', 'MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.category_code, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) = 'DI' THEN 'DI'
      WHEN q.cat_id IN (1337013, 1336833, 1336853) THEN 'RC'
      WHEN q.cat_id IN (1337023, 1336843, 1336863) THEN 'CR'
      WHEN q.cat_id IN (1336733, 1336743) THEN 'DS'
      WHEN q.cat_id = 1336753 THEN 'MSR'
      WHEN q.cat_id = 1336763 THEN 'TA'
      WHEN q.cat_id = 1336773 THEN 'GI'
      WHEN q.cat_id = 1336783 THEN 'TPA'
      WHEN q.cat_id IN (1336803, 1336813) THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'DS' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) IN ('MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'DS' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'DI' THEN 'DI'
      WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%data sufficiency%' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'QUANT' THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'VERBAL' THEN 'Verbal'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('CR', 'RC', 'PS') THEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
      ELSE ''
    END
  `;
  const subjectSubExpr = `
    CASE
      WHEN (${normalizedSubExpr}) <> '' THEN (${normalizedSubExpr})
      WHEN q.cat_id = 1337013 THEN 'CR'
      WHEN q.cat_id = 1337023 THEN 'RC'
      WHEN COALESCE(NULLIF(s.subject, ''), 'Unknown') = 'Verbal' THEN
        CASE
          WHEN COALESCE(NULLIF(q.topic, ''), '') IN (
            'Main Idea / Purpose', 'Detail', 'Structure / Function', 'Author View', 'Application',
            'Main Idea', 'Purpose', 'Author Attitude', 'Organization'
          ) THEN 'RC'
          WHEN COALESCE(NULLIF(q.topic, ''), '') IN (
            'Support', 'Attack', 'Assumption', 'Resolve', 'Argument Structure',
            'Weaken', 'Strengthen', 'Explain', 'Assumption',
            'Boldface', 'Evaluate', 'Flaw', 'Parallel', 'Complete', 'Method'
          ) THEN 'CR'
          ELSE 'Verbal'
        END
      WHEN q.cat_id BETWEEN 1336700 AND 1336899 THEN 'DI'
      WHEN COALESCE(NULLIF(s.subject, ''), '') IN ('CR', 'RC', 'PS', 'DS', 'DI', 'TA', 'GI', 'MSR', 'TPA') THEN COALESCE(NULLIF(s.subject, ''), 'Unknown')
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'Quant' THEN 'PS'
      WHEN LOWER(COALESCE(s.source, '')) LIKE '%quant%' THEN 'PS'
      WHEN LOWER(COALESCE(s.source, '')) LIKE '%data insights%' THEN 'DI'
      ELSE COALESCE(NULLIF(s.subject, ''), 'Other')
    END
  `;
  const subjectFamilyExpr = `
    CASE
      WHEN (${subjectSubExpr}) IN ('CR', 'RC', 'Verbal') THEN 'Verbal'
      WHEN (${subjectSubExpr}) IN ('PS', 'Quant') THEN 'Quant'
      WHEN (${subjectSubExpr}) IN ('DS', 'DI', 'TA', 'GI', 'MSR', 'TPA') THEN 'DI'
      ELSE 'Other'
    END
  `;
  const subjectExpr = `
    CASE
      WHEN (${normalizedSubExpr}) <> '' THEN (${normalizedSubExpr})
      WHEN q.cat_id = 1337013 THEN 'CR'
      WHEN q.cat_id = 1337023 THEN 'RC'
      WHEN COALESCE(NULLIF(s.subject, ''), 'Unknown') = 'Verbal' THEN
        CASE
          WHEN COALESCE(NULLIF(q.topic, ''), '') IN (
            'Main Idea / Purpose', 'Detail', 'Structure / Function', 'Author View', 'Application',
            'Main Idea', 'Purpose', 'Author Attitude', 'Organization'
          ) THEN 'RC'
          WHEN COALESCE(NULLIF(q.topic, ''), '') IN (
            'Support', 'Attack', 'Assumption', 'Resolve', 'Argument Structure',
            'Weaken', 'Strengthen', 'Explain', 'Assumption',
            'Boldface', 'Evaluate', 'Flaw', 'Parallel', 'Complete', 'Method'
          ) THEN 'CR'
          ELSE 'Verbal'
        END
      WHEN q.cat_id BETWEEN 1336700 AND 1336899 THEN 'DI'
      ELSE COALESCE(NULLIF(s.subject, ''), 'Unknown')
    END
  `;
  const categoryHintExpr = `
    CASE
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) IN ('QUANT', 'PS', 'Q') THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) IN ('CR', 'RC', 'DS', 'MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.category_code, ''), ''))
      WHEN q.cat_id IN (1336803, 1336813) THEN 'PS'
      WHEN q.cat_id IN (1337013, 1336843, 1336863) THEN 'CR'
      WHEN q.cat_id IN (1337023, 1336833, 1336853) THEN 'RC'
      WHEN q.cat_id IN (1336733, 1336743) THEN 'DS'
      WHEN q.cat_id = 1336753 THEN 'MSR'
      WHEN q.cat_id = 1336763 THEN 'TA'
      WHEN q.cat_id = 1336773 THEN 'GI'
      WHEN q.cat_id = 1336783 THEN 'TPA'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) IN ('QUANT', 'PS', 'Q') THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) IN ('CR', 'RC', 'DS', 'MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('QUANT', 'PS', 'Q') THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('CR', 'RC', 'DS', 'MSR', 'TA', 'GI', 'TPA') THEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.subject_code, ''), '')) = 'Q' THEN 'PS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_code, ''), '')) = 'DI' THEN 'DI'
      WHEN UPPER(COALESCE(NULLIF(q.subject_code, ''), '')) = 'V' THEN 'V'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'Quant' THEN 'PS'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'DI' THEN 'DI'
      WHEN COALESCE(NULLIF(s.subject, ''), '') = 'Verbal' THEN 'V'
      ELSE ''
    END
  `;
  const topicExpr = `
    CASE
      WHEN COALESCE(NULLIF(q.topic, ''), '') <> '' THEN
        CASE
          WHEN (${categoryHintExpr}) = 'CR' THEN
            CASE
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Support', 'Strengthen') THEN 'Support'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Attack', 'Weaken', 'Flaw') THEN 'Attack'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Assumption', 'Evaluate') THEN 'Assumption'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Inference', 'Complete') THEN 'Inference'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Resolve', 'Explain') THEN 'Resolve'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Argument Structure', 'Boldface', 'Method', 'Parallel') THEN 'Argument Structure'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'RC' THEN
            CASE
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Main Idea / Purpose', 'Main Idea', 'Purpose') THEN 'Main Idea / Purpose'
              WHEN COALESCE(NULLIF(q.topic, ''), '') = 'Detail' THEN 'Detail'
              WHEN COALESCE(NULLIF(q.topic, ''), '') = 'Inference' THEN 'Inference'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Structure / Function', 'Organization') THEN 'Structure / Function'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Author View', 'Author Attitude') THEN 'Author View'
              WHEN COALESCE(NULLIF(q.topic, ''), '') = 'Application' THEN 'Application'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'PS' THEN
            CASE
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%overlapping sets%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%venn%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%set theory%' THEN 'Overlapping Sets'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%mean%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%median%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%standard deviation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%variance%' THEN 'Statistics'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%combin%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%permut%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%counting%' THEN 'Counting & Probability'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%distance%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%speed%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%work%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%time%' THEN 'Rates, Work & Motion'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%function%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%sequence%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inequal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%absolute value%' THEN 'Functions, Sequences & Inequalities'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%word problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%age problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%digit problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%mixture%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%problem solving%' THEN 'General Word Problems'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%percent%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%interest%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%fraction%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%ratio%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%proportion%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%decimal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%average%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%fdp%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%remainder%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%multiple%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%factor%' THEN 'Arithmetic, FDP & Ratios'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%triangle%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%circle%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%area%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%volume%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%coordinate%' THEN 'Geometry'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%number properties%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%divis%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%integer%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%odd%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%even%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%prime%' THEN 'Number Properties'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%equation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%quadratic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%linear%' THEN 'Algebra & Equations'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'DS' THEN
            CASE
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%data sufficiency%' THEN 'Unclear Topic'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%unclear topic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%poor quality%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%bad question%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%ambiguous%' THEN 'Unclear Topic'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%overlapping sets%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%venn%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%set theory%' THEN 'Overlapping Sets'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%mean%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%median%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%standard deviation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%variance%' THEN 'Statistics'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%combin%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%permut%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%counting%' THEN 'Counting & Probability'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%distance%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%speed%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%work%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%time%' THEN 'Rates, Work & Motion'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%function%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%sequence%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inequal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%absolute value%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%custom character%' THEN 'Functions, Sequences & Inequalities'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%word problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%age problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%digit problem%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%mixture%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%problem solving%' THEN 'General Word Problems'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%percent%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%interest%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%fraction%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%ratio%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%proportion%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%decimal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%average%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%fdp%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%remainder%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%multiple%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%factor%' THEN 'Arithmetic, FDP & Ratios'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%triangle%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%circle%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%area%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%volume%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%coordinate%' THEN 'Geometry'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%number properties%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%divis%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%integer%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%odd%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%even%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%prime%' THEN 'Number Properties'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%equation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%quadratic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%linear%' THEN 'Algebra & Equations'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'GI' THEN
            CASE
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%graphs%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%graphics interpretation%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%graph%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%chart%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%plot%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%axis%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t graphs%' THEN 'Graphs'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Interpretation'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Interpretation'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non-math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%verbal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%reading%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inference%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%author%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%purpose%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t non-math related%' THEN 'Non-Math Interpretation'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%number properties%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t math related%' THEN 'Math-Based Interpretation'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'TA' THEN
            CASE
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%tables%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%table analysis%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%table%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t tables%' THEN 'Tables'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Analysis'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Analysis'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non-math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%verbal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%reading%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inference%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%author%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%purpose%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t non-math related%' THEN 'Non-Math Analysis'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%number properties%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%g&t math related%' THEN 'Math-Based Analysis'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'MSR' THEN
            CASE
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Reasoning'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Reasoning'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non-math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%verbal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%reading%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inference%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%author%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%purpose%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%msr non-math related%' THEN 'Non-Math Reasoning'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%multi-source reasoning%' THEN 'Unknown'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%msr math related%' THEN 'Math-Based Reasoning'
              ELSE q.topic
            END
          WHEN (${categoryHintExpr}) = 'TPA' THEN
            CASE
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Reasoning'
              WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Reasoning'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non-math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%non math%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%verbal%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%reading%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%inference%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%author%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%purpose%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%tpa non-math related%' THEN 'Non-Math Reasoning'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%two-part analysis%' THEN 'Unknown'
              WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math based%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math-related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%math related%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%algebra%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%arithmetic%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%rate%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%probab%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%geometry%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%statistics%' OR LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%tpa math related%' THEN 'Math-Based Reasoning'
              ELSE q.topic
            END
          ELSE q.topic
        END
      WHEN (${categoryHintExpr}) = 'GI' THEN 'Graphs'
      WHEN (${categoryHintExpr}) = 'TA' THEN 'Tables'
      WHEN (${categoryHintExpr}) = 'MSR' THEN
        CASE
          WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Reasoning'
          WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Reasoning'
          ELSE 'Unknown'
        END
      WHEN (${categoryHintExpr}) = 'TPA' THEN
        CASE
          WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'math' THEN 'Math-Based Reasoning'
          WHEN COALESCE(NULLIF(q.content_domain, ''), '') = 'non_math' THEN 'Non-Math Reasoning'
          ELSE 'Unknown'
        END
      WHEN (${categoryHintExpr}) = 'DS' THEN 'Unclear Topic'
      ELSE 'Unknown'
    END
  `;
  const difficultyExpr = `
    CASE
      WHEN LOWER(COALESCE(NULLIF(q.difficulty, ''), '')) = 'hard' THEN 'Hard'
      WHEN LOWER(COALESCE(NULLIF(q.difficulty, ''), '')) = 'medium' THEN 'Medium'
      WHEN LOWER(COALESCE(NULLIF(q.difficulty, ''), '')) = 'easy' THEN 'Easy'
      ELSE 'Unknown'
    END
  `;

  const subjectSortExpr = `
    CASE ${subjectFamilyExpr}
      WHEN 'Verbal' THEN 1
      WHEN 'Quant' THEN 2
      WHEN 'DI' THEN 3
      ELSE 4
    END
  `;

  const byTopic = await all(
    `
      SELECT
        ${topicExpr} AS topic,
        COUNT(*) AS mistakes
      FROM question_attempts q
      INNER JOIN sessions s ON s.id = q.session_id
      WHERE ${runClause}q.correct = 0 AND ${answeredWhere}
      GROUP BY ${topicExpr}
      ORDER BY mistakes DESC, topic ASC
      LIMIT 20
    `,
    runParams
  );

  const byDifficulty = await all(
    `
      SELECT
        ${difficultyBucketExpr('q')} AS difficulty,
        COUNT(*) AS total,
        SUM(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END) AS correct,
        SUM(CASE WHEN q.correct = 0 THEN 1 ELSE 0 END) AS wrong,
        ROUND(AVG(q.time_sec), 0) AS avg_time_sec,
        ROUND(
          100.0 * SUM(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END) / COUNT(*),
          1
        ) AS accuracy_pct
      FROM question_attempts q
      WHERE ${runClause}${answeredWhere}
      GROUP BY ${difficultyBucketExpr('q')}
      ORDER BY total DESC
    `,
    runParams
  );

  const bySubject = await all(
    `
      SELECT
        ${subjectExpr} AS subject,
        COUNT(*) AS mistakes
      FROM question_attempts q
      INNER JOIN sessions s ON s.id = q.session_id
      WHERE ${runJoinClause}q.correct = 0 AND ${answeredWhere}
      GROUP BY ${subjectExpr}
      ORDER BY mistakes DESC, subject ASC
    `,
    runParams
  );

  const bySubjectTopic = await all(
    `
      SELECT
        ${subjectExpr} AS subject,
        ${topicExpr} AS topic,
        COUNT(*) AS mistakes
      FROM question_attempts q
      INNER JOIN sessions s ON s.id = q.session_id
      WHERE ${runJoinClause}q.correct = 0 AND ${answeredWhere}
      GROUP BY ${subjectExpr}, ${topicExpr}
      ORDER BY subject ASC, mistakes DESC, topic ASC
    `,
    runParams
  );

  const confidenceMismatch = await all(
    `
      SELECT
        COALESCE(NULLIF(q.confidence, ''), 'not selected') AS confidence,
        COUNT(*) AS wrong_answers
      FROM question_attempts q
      WHERE ${runClause}q.correct = 0 AND ${answeredWhere}
      GROUP BY COALESCE(NULLIF(q.confidence, ''), 'not selected')
      ORDER BY wrong_answers DESC
    `,
    runParams
  );

  const subjectProgress = await all(
    `
      SELECT
        ${subjectFamilyExpr} AS subject_family,
        ${subjectSubExpr} AS subject_sub,
        COUNT(*) AS total,
        SUM(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END) AS correct,
        SUM(CASE WHEN q.correct = 0 THEN 1 ELSE 0 END) AS wrong,
        ROUND(
          100.0 * SUM(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END) / COUNT(*),
          1
        ) AS accuracy_pct,
        ROUND(AVG(q.time_sec), 0) AS avg_time_sec
      FROM question_attempts q
      INNER JOIN sessions s ON s.id = q.session_id
      WHERE ${runJoinClause}${answeredWhere}
      GROUP BY ${subjectFamilyExpr}, ${subjectSubExpr}
      ORDER BY ${subjectSortExpr}, total DESC, subject_sub ASC
    `,
    runParams
  );

  const categoryBreakdown = await all(
    `
      SELECT
        ${subjectFamilyExpr} AS subject_family,
        ${subjectSubExpr} AS subject_sub,
        COUNT(*) AS total_questions,
        SUM(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END) AS correct_count,
        SUM(CASE WHEN q.correct = 0 THEN 1 ELSE 0 END) AS incorrect_count,
        ROUND(
          100.0 * SUM(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END) / COUNT(*),
          1
        ) AS accuracy_pct,
        ROUND(AVG(q.time_sec), 0) AS avg_time_sec,
        SUM(CASE WHEN (${difficultyExpr}) = 'Hard' THEN 1 ELSE 0 END) AS hard_total,
        ROUND(
          CASE
            WHEN SUM(CASE WHEN (${difficultyExpr}) = 'Hard' THEN 1 ELSE 0 END) > 0 THEN
              100.0
              * SUM(CASE WHEN (${difficultyExpr}) = 'Hard' AND q.correct = 1 THEN 1 ELSE 0 END)
              / SUM(CASE WHEN (${difficultyExpr}) = 'Hard' THEN 1 ELSE 0 END)
            ELSE NULL
          END,
          1
        ) AS hard_accuracy_pct,
        ROUND(AVG(CASE WHEN (${difficultyExpr}) = 'Hard' THEN q.time_sec END), 0) AS hard_avg_time_sec,
        SUM(CASE WHEN (${difficultyExpr}) = 'Medium' THEN 1 ELSE 0 END) AS medium_total,
        ROUND(
          CASE
            WHEN SUM(CASE WHEN (${difficultyExpr}) = 'Medium' THEN 1 ELSE 0 END) > 0 THEN
              100.0
              * SUM(CASE WHEN (${difficultyExpr}) = 'Medium' AND q.correct = 1 THEN 1 ELSE 0 END)
              / SUM(CASE WHEN (${difficultyExpr}) = 'Medium' THEN 1 ELSE 0 END)
            ELSE NULL
          END,
          1
        ) AS medium_accuracy_pct,
        ROUND(AVG(CASE WHEN (${difficultyExpr}) = 'Medium' THEN q.time_sec END), 0) AS medium_avg_time_sec,
        SUM(CASE WHEN (${difficultyExpr}) = 'Easy' THEN 1 ELSE 0 END) AS easy_total,
        ROUND(
          CASE
            WHEN SUM(CASE WHEN (${difficultyExpr}) = 'Easy' THEN 1 ELSE 0 END) > 0 THEN
              100.0
              * SUM(CASE WHEN (${difficultyExpr}) = 'Easy' AND q.correct = 1 THEN 1 ELSE 0 END)
              / SUM(CASE WHEN (${difficultyExpr}) = 'Easy' THEN 1 ELSE 0 END)
            ELSE NULL
          END,
          1
        ) AS easy_accuracy_pct,
        ROUND(AVG(CASE WHEN (${difficultyExpr}) = 'Easy' THEN q.time_sec END), 0) AS easy_avg_time_sec
      FROM question_attempts q
      INNER JOIN sessions s ON s.id = q.session_id
      WHERE ${runJoinClause}${answeredWhere}
      GROUP BY ${subjectFamilyExpr}, ${subjectSubExpr}
      ORDER BY ${subjectSortExpr}, total_questions DESC, subject_sub ASC
    `,
    runParams
  );

  const subtopicBreakdown = await all(
    `
      SELECT
        ${subjectFamilyExpr} AS subject_family,
        ${subjectSubExpr} AS subject_sub,
        ${topicExpr} AS subtopic,
        COUNT(*) AS total_questions,
        SUM(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END) AS correct_count,
        SUM(CASE WHEN q.correct = 0 THEN 1 ELSE 0 END) AS incorrect_count,
        ROUND(
          100.0 * SUM(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END) / COUNT(*),
          1
        ) AS accuracy_pct,
        ROUND(AVG(q.time_sec), 0) AS avg_time_sec,
        SUM(CASE WHEN (${difficultyExpr}) = 'Hard' THEN 1 ELSE 0 END) AS hard_total,
        ROUND(
          CASE
            WHEN SUM(CASE WHEN (${difficultyExpr}) = 'Hard' THEN 1 ELSE 0 END) > 0 THEN
              100.0
              * SUM(CASE WHEN (${difficultyExpr}) = 'Hard' AND q.correct = 1 THEN 1 ELSE 0 END)
              / SUM(CASE WHEN (${difficultyExpr}) = 'Hard' THEN 1 ELSE 0 END)
            ELSE NULL
          END,
          1
        ) AS hard_accuracy_pct,
        ROUND(AVG(CASE WHEN (${difficultyExpr}) = 'Hard' THEN q.time_sec END), 0) AS hard_avg_time_sec,
        SUM(CASE WHEN (${difficultyExpr}) = 'Medium' THEN 1 ELSE 0 END) AS medium_total,
        ROUND(
          CASE
            WHEN SUM(CASE WHEN (${difficultyExpr}) = 'Medium' THEN 1 ELSE 0 END) > 0 THEN
              100.0
              * SUM(CASE WHEN (${difficultyExpr}) = 'Medium' AND q.correct = 1 THEN 1 ELSE 0 END)
              / SUM(CASE WHEN (${difficultyExpr}) = 'Medium' THEN 1 ELSE 0 END)
            ELSE NULL
          END,
          1
        ) AS medium_accuracy_pct,
        ROUND(AVG(CASE WHEN (${difficultyExpr}) = 'Medium' THEN q.time_sec END), 0) AS medium_avg_time_sec,
        SUM(CASE WHEN (${difficultyExpr}) = 'Easy' THEN 1 ELSE 0 END) AS easy_total,
        ROUND(
          CASE
            WHEN SUM(CASE WHEN (${difficultyExpr}) = 'Easy' THEN 1 ELSE 0 END) > 0 THEN
              100.0
              * SUM(CASE WHEN (${difficultyExpr}) = 'Easy' AND q.correct = 1 THEN 1 ELSE 0 END)
              / SUM(CASE WHEN (${difficultyExpr}) = 'Easy' THEN 1 ELSE 0 END)
            ELSE NULL
          END,
          1
        ) AS easy_accuracy_pct,
        ROUND(AVG(CASE WHEN (${difficultyExpr}) = 'Easy' THEN q.time_sec END), 0) AS easy_avg_time_sec
      FROM question_attempts q
      INNER JOIN sessions s ON s.id = q.session_id
      WHERE ${runJoinClause}${answeredWhere}
      GROUP BY ${subjectFamilyExpr}, ${subjectSubExpr}, ${topicExpr}
      ORDER BY ${subjectSortExpr}, subject_sub ASC, incorrect_count DESC, subtopic ASC
      LIMIT 250
    `,
    runParams
  );

  return {
    byTopic,
    bySubject,
    bySubjectTopic,
    byDifficulty,
    confidenceMismatch,
    subjectProgress,
    categoryBreakdown,
    subtopicBreakdown,
  };
}

async function getSessionAnalysis(sessionId) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const unansweredExpr = unansweredPlaceholderExpr('q');
  const answeredCountExpr = `SUM(CASE WHEN NOT (${unansweredExpr}) THEN 1 ELSE 0 END)`;
  const answeredCorrectExpr = `SUM(CASE WHEN NOT (${unansweredExpr}) AND q.correct = 1 THEN 1 ELSE 0 END)`;
  const answeredWrongExpr = `SUM(CASE WHEN NOT (${unansweredExpr}) AND q.correct = 0 THEN 1 ELSE 0 END)`;
  const answeredAvgTimeExpr = `ROUND(AVG(CASE WHEN NOT (${unansweredExpr}) THEN q.time_sec END), 0)`;
  const answeredAvgCorrectTimeExpr = `ROUND(AVG(CASE WHEN NOT (${unansweredExpr}) AND q.correct = 1 THEN q.time_sec END), 0)`;
  const answeredAvgWrongTimeExpr = `ROUND(AVG(CASE WHEN NOT (${unansweredExpr}) AND q.correct = 0 THEN q.time_sec END), 0)`;

  const session = await get(
    `
      SELECT
        s.id,
        s.run_id,
        s.session_external_id,
        s.session_date,
        s.source,
        s.subject,
        s.total_q_api,
        s.total_q_categories,
        s.correct_count,
        s.error_count,
        s.total_score,
        s.total_percentile,
        s.quant_score,
        s.quant_percentile,
        s.verbal_score,
        s.verbal_percentile,
        s.di_score,
        s.di_percentile,
        ${answeredCountExpr} AS attempt_total,
        COALESCE(${answeredCorrectExpr}, 0) AS attempt_correct,
        COALESCE(${answeredWrongExpr}, 0) AS attempt_wrong,
        ROUND(
          CASE
            WHEN ${answeredCountExpr} > 0
              THEN
                100.0
                * ${answeredCorrectExpr}
                / ${answeredCountExpr}
            WHEN (COALESCE(s.correct_count, 0) + COALESCE(s.error_count, 0)) > 0
              THEN
                100.0
                * COALESCE(s.correct_count, 0)
                / (COALESCE(s.correct_count, 0) + COALESCE(s.error_count, 0))
            ELSE s.accuracy_pct
          END,
          1
        ) AS accuracy_pct,
        COALESCE(${answeredAvgTimeExpr}, s.avg_time_sec) AS avg_time_sec,
        COALESCE(${answeredAvgCorrectTimeExpr}, s.avg_correct_time_sec) AS avg_correct_time_sec,
        COALESCE(${answeredAvgWrongTimeExpr}, s.avg_incorrect_time_sec) AS avg_incorrect_time_sec
      FROM sessions s
      LEFT JOIN question_attempts q ON q.session_id = s.id
      WHERE s.id = ?
      GROUP BY s.id
      LIMIT 1
    `,
    [id]
  );

  if (!session) return null;
  const verbalCategoryHintExpr = `
    CASE
      WHEN UPPER(COALESCE(NULLIF(q.category_code, ''), '')) IN ('CR', 'RC') THEN UPPER(COALESCE(NULLIF(q.category_code, ''), ''))
      WHEN q.cat_id IN (1337013, 1336843, 1336863) THEN 'CR'
      WHEN q.cat_id IN (1337023, 1336833, 1336853) THEN 'RC'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) IN ('CR', 'RC') THEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), ''))
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('CR', 'RC') THEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
      ELSE ''
    END
  `;
  const topicExpr = `
    CASE
      WHEN COALESCE(NULLIF(q.topic, ''), '') <> '' THEN
        CASE
          WHEN (${verbalCategoryHintExpr}) = 'CR' THEN
            CASE
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Support', 'Strengthen') THEN 'Support'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Attack', 'Weaken', 'Flaw') THEN 'Attack'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Assumption', 'Evaluate') THEN 'Assumption'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Inference', 'Complete') THEN 'Inference'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Resolve', 'Explain') THEN 'Resolve'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Argument Structure', 'Boldface', 'Method', 'Parallel') THEN 'Argument Structure'
              ELSE q.topic
            END
          WHEN (${verbalCategoryHintExpr}) = 'RC' THEN
            CASE
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Main Idea / Purpose', 'Main Idea', 'Purpose') THEN 'Main Idea / Purpose'
              WHEN COALESCE(NULLIF(q.topic, ''), '') = 'Detail' THEN 'Detail'
              WHEN COALESCE(NULLIF(q.topic, ''), '') = 'Inference' THEN 'Inference'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Structure / Function', 'Organization') THEN 'Structure / Function'
              WHEN COALESCE(NULLIF(q.topic, ''), '') IN ('Author View', 'Author Attitude') THEN 'Author View'
              WHEN COALESCE(NULLIF(q.topic, ''), '') = 'Application' THEN 'Application'
              ELSE q.topic
            END
          ELSE q.topic
        END
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'MSR' THEN 'Multi-Source Reasoning'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'TA' THEN 'Table Analysis'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'GI' THEN 'Graphics Interpretation'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'TPA' THEN 'Two-Part Analysis'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'DS' THEN 'Data Sufficiency'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'PS' THEN 'Problem Solving'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'DS' THEN 'Data Sufficiency'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'PS' THEN 'Problem Solving'
      ELSE 'Unknown'
    END
  `;

  const byDifficulty = await all(
    `
      SELECT
        ${difficultyBucketExpr('q')} AS difficulty,
        COUNT(*) AS total,
        SUM(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END) AS correct,
        SUM(CASE WHEN q.correct = 0 THEN 1 ELSE 0 END) AS wrong,
        ROUND(
          100.0 * SUM(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END) / COUNT(*),
          1
        ) AS accuracy_pct,
        ROUND(AVG(q.time_sec), 0) AS avg_time_sec,
        ROUND(AVG(CASE WHEN q.correct = 1 THEN q.time_sec END), 0) AS avg_correct_time_sec,
        ROUND(AVG(CASE WHEN q.correct = 0 THEN q.time_sec END), 0) AS avg_incorrect_time_sec
      FROM question_attempts q
      WHERE q.session_id = ? AND NOT (${unansweredExpr})
      GROUP BY ${difficultyBucketExpr('q')}
      ORDER BY
        CASE ${difficultyBucketExpr('q')}
          WHEN 'Hard' THEN 1
          WHEN 'Medium' THEN 2
          WHEN 'Easy' THEN 3
          ELSE 4
        END
    `,
    [id]
  );

  const topWrongTopics = await all(
    `
      SELECT
        ${topicExpr} AS topic,
        COUNT(*) AS mistakes
      FROM question_attempts q
      WHERE q.session_id = ? AND q.correct = 0 AND NOT (${unansweredExpr})
      GROUP BY ${topicExpr}
      ORDER BY mistakes DESC, topic ASC
    `,
    [id]
  );

  const confidencePerformance = await all(
    `
      SELECT
        COALESCE(NULLIF(q.confidence, ''), 'not selected') AS confidence,
        COUNT(*) AS total,
        SUM(CASE WHEN q.correct = 0 THEN 1 ELSE 0 END) AS wrong,
        ROUND(
          100.0 * SUM(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END) / COUNT(*),
          1
        ) AS accuracy_pct
      FROM question_attempts q
      WHERE q.session_id = ? AND NOT (${unansweredExpr})
      GROUP BY COALESCE(NULLIF(q.confidence, ''), 'not selected')
      ORDER BY total DESC, confidence ASC
    `,
    [id]
  );

  const slowWrongQuestionsRaw = await all(
    `
      SELECT
        q.id,
        q.q_code,
        q.cat_id,
        q.subject_code,
        q.category_code,
        q.subcategory,
        q.subject_sub,
        q.subject_sub_raw,
        q.difficulty,
        q.difficulty_theta,
        ${topicExpr} AS topic,
        q.my_answer,
        q.correct_answer,
        q.correct,
        q.time_sec,
        q.question_url,
        q.question_stem,
        q.passage_text,
        q.answer_choices,
        q.response_format,
        q.response_details,
        q.topic_source,
        q.content_domain,
        q.mistake_type,
        q.notes,
        s.source
      FROM question_attempts q
      INNER JOIN sessions s ON s.id = q.session_id
      WHERE q.session_id = ? AND NOT (${unansweredExpr})
      ORDER BY q.correct ASC, COALESCE(q.time_sec, 0) DESC, q.id DESC
    `,
    [id]
  );
  const slowWrongQuestions = slowWrongQuestionsRaw.map((row) => enrichQuestionMetadata(row, session));

  return {
    session,
    byDifficulty,
    topWrongTopics,
    confidencePerformance,
    slowWrongQuestions,
  };
}

async function updateErrorAnnotation(errorId, { mistakeType, notes }) {
  const id = Number(errorId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid error id.');
  }

  const nextMistakeType = String(mistakeType || '').trim();
  const nextNotes = String(notes || '').trim();
  const storedMistakeType = nextMistakeType === '[]' ? null : nextMistakeType || null;

  await run(
    `
      UPDATE question_attempts
      SET
        mistake_type = ?,
        notes = ?
      WHERE id = ?
    `,
    [storedMistakeType, nextNotes || null, id]
  );

  return get(
    `
      SELECT
        id,
        mistake_type,
        notes
      FROM question_attempts
      WHERE id = ?
      LIMIT 1
    `,
    [id]
  );
}

async function getLatestRunForSource(source) {
  if (!source) return null;
  return get(
    `
      SELECT *
      FROM scrape_runs
      WHERE source = ?
      ORDER BY extracted_at DESC, id DESC
      LIMIT 1
    `,
    [source]
  );
}

// Phase 2 enrichment: takes a session id (StartTest sid) and the array of items
// returned by runPhase2 in starttest_scraper.js. For each enriched item, find
// the existing question_attempts row by composite q_id ("<sid>-seq-<N>") or by
// already-enriched ItemName, and UPDATE it with full stem/choices/answer/etc.
// User annotations (mistake_type, notes) are preserved automatically because
// the UPDATE statement only touches enrichment columns.
async function enrichSessionAttempts({ sessionExternalId, source, enrichedItems }) {
  const sessionRow = await get(
    `
      SELECT id
      FROM sessions
      WHERE session_external_id = ?
        AND COALESCE(source, '') = COALESCE(?, '')
      ORDER BY id DESC
      LIMIT 1
    `,
    [Number(sessionExternalId) || sessionExternalId, source || null]
  );
  if (!sessionRow?.id) {
    return { matched: 0, updated: 0, skipped: 0, errors: [{ message: 'session-not-found', sessionExternalId, source }] };
  }
  const sessionDbId = sessionRow.id;

  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const item of (Array.isArray(enrichedItems) ? enrichedItems : [])) {
    const seq = Number.isInteger(item?.seq) ? item.seq : null;
    if (seq === null) {
      errors.push({ message: 'item missing seq', item: { vItemName: item?.vItemName } });
      continue;
    }
    const compositeId = `${sessionExternalId}-seq-${seq}`;
    const itemName = item.vItemName || item.itemMeta?.ItemName || null;
    const formQuestionId = item.itemMeta?.FormQuestionID;
    const stableKey =
      Array.isArray(item.vItemInformation) && item.vItemInformation[1]
        ? item.vItemInformation[1].Key || null
        : null;

    // Match on EITHER the Phase 1 composite OR a previously-enriched ItemName.
    const targetRow = await get(
      `
        SELECT id, mistake_type, notes, correct, q_id
        FROM question_attempts
        WHERE session_id = ?
          AND (q_id = ? OR q_id = ?)
        LIMIT 1
      `,
      [sessionDbId, compositeId, itemName || compositeId]
    );
    if (!targetRow) {
      skipped += 1;
      continue;
    }

    // Build derived fields.
    const responseFormat = item.choicesType || null;

    // answer_choices is stored as a FLAT ARRAY of {label, text, ...} so the
    // dashboard's parseAnswerChoices can render it the same way it renders
    // legacy data. Per-choice extras (color, isCorrect, isUserSelected, value)
    // are added on top — the UI ignores fields it doesn't know about.
    // Only strip a leading enumerator like "A) " or "A." — require a real
    // separator. A bare leading letter (e.g. "Bacteria are not...") MUST
    // be left untouched, otherwise the first letter of the choice text gets
    // eaten and the label is misread from the body.
    const cleanText = (s) => String(s || '').replace(/^\s*[A-Za-z][\).]\s+/, '').replace(/\s+/g, ' ').trim();
    let answerChoicesArr = [];
    if (item.choicesType === 'single' && Array.isArray(item.choices)) {
      answerChoicesArr = item.choices.map((c, idx) => {
        const valNum = Number(c?.value);
        const letterFromValue = (Number.isInteger(valNum) && valNum >= 1 && valNum <= 26)
          ? String.fromCharCode(64 + valNum) : null;
        // Same separator-required guard: "A) ..." → "A", but "Bacteria..." → null.
        const letterFromLabel = String(c?.label || '').match(/^\s*([A-E])[\).]/)?.[1] || null;
        const label = letterFromLabel || letterFromValue || String.fromCharCode(65 + idx);
        return {
          label,
          text: cleanText(c?.label),
          value: c?.value,
          color: c?.color || null,
          isCorrect: !!c?.isCorrect,
          isUserSelected: !!c?.isUserSelected,
        };
      });
    } else if (item.choicesType === 'matrix' && item.choices?.rows) {
      // Matrix: one element per sub-question (row). The UI's per-row
      // rendering will need its own component later; for now we expose enough
      // data that it could render a table.
      answerChoicesArr = item.choices.rows.map((row, idx) => ({
        label: `Q${idx + 1}`,
        text: row.label || '',
        options: row.options || [],
        headers: item.choices.headers || [],
      }));
    } else if (item.choicesType === 'dropdown' && Array.isArray(item.choices?.dropdowns)) {
      answerChoicesArr = item.choices.dropdowns.map((d, idx) => ({
        label: `Blank ${idx + 1}`,
        text: d?.selectedText ?? d?.selected ?? '',
        value: d?.selected,
        options: d?.options || [],
      }));
    }

    const responseDetailsPayload = {
      itemType: item.vItemType || null,
      vPassageName: item.vPassageName || null,
      vItemInformation: item.vItemInformation || null,
      answerSelection: item.answerSelection ?? null,
      vPreviousTimeSpentMs: typeof item.vPreviousTimeSpent === 'number' ? item.vPreviousTimeSpent : null,
      passage: item.passage || null,
      keyPoint: item.keyPoint || null,
      rationale: item.rationale || null,
      yourScoreText: item.yourScoreText || null,
      correctKey: item.correctKey || null,
    };

    // Derive my_answer. We prefer the letter form (A/B/C/D/E) for single-choice
    // items so it matches the convention used by the legacy Nuxt scraper's data,
    // making the dashboard's "my answer" column readable across both eras.
    //   - Single-choice: letter from the checked radio's label ("A) ..." → "A").
    //     Falls back to numeric value if no leading letter is found.
    //   - Matrix: CSV from answerSelection[1] (e.g. "1,1,2").
    //   - Fallback: first checked choice in the DOM.
    const choiceValueToLetter = (val) => {
      const n = Number(val);
      return Number.isInteger(n) && n >= 1 && n <= 26 ? String.fromCharCode(64 + n) : null;
    };
    let myAnswer = null;
    if (item.choicesType === 'single' && Array.isArray(item.choices)) {
      // Priority for single-choice MC user-pick:
      //   1. pickByRow — `.ITSMCOptionTableOn` is the authoritative class
      //      ITDReview applies to the user's saved pick row. Always present
      //      once restoration completes (the scraper now waits for it).
      //   2. pickByColor — Quant pages additionally render red/green row
      //      backgrounds. A second independent signal; we keep it as a
      //      fallback for any Quant-specific timing edge case.
      //
      // We deliberately do NOT fall back to `el.checked` or the generic
      // `isUserSelected` flag. Both can carry the radio's HTML default
      // (value=1, label A) when the page was read before ITDReview restored
      // the saved pick — which silently corrupts wrong-answer rows to "A".
      // If neither pickByRow nor pickByColor fires, we leave myAnswer null;
      // the inverse fallback below ("got it right ⇒ my=correct") still
      // recovers correctly-answered items.
      const pickFromChoice = (c) => {
        if (!c) return null;
        // Require an enumerator separator (A) / A.) before treating a leading
        // letter as the option label. Without this guard, a bare-text choice
        // like "Expensive assistance programs..." gets misread as letter "E"
        // and corrupts my_answer (seen on session 61257 q 38180: real pick
        // was option C, regex extracted "E" from the first word "Expensive").
        // The positional `value` (1..5 → A..E) is the authoritative signal
        // for StartTest pages where labels are bare text.
        const labelLetter = (c.label || '').match(/^\s*([A-E])[\).]/)?.[1];
        return labelLetter || choiceValueToLetter(c.value) || (c.value != null ? String(c.value) : null);
      };
      const byRow = item.choices.find((c) => c && c.pickByRow === true);
      const byColor = byRow ? null : item.choices.find((c) => c && c.pickByColor === true);
      const reliable = byRow || byColor;
      if (reliable) {
        myAnswer = pickFromChoice(reliable);
      }
      // Re-sync per-choice isUserSelected flags so the review modal highlights
      // the right option. Clear all first, then set the chosen one.
      if (Array.isArray(answerChoicesArr) && myAnswer) {
        for (const c of answerChoicesArr) { if (c) c.isUserSelected = false; }
        const matchIdx = answerChoicesArr.findIndex((c) => c && c.label === myAnswer);
        if (matchIdx >= 0) answerChoicesArr[matchIdx].isUserSelected = true;
      }
    } else if (item.choicesType === 'matrix' && item.choices?.rows) {
      // Matrix has two layouts that need different my_answer formats:
      //   - MSR Yes/No-style: pick one COLUMN per ROW. Key1 has rowCount entries
      //     (e.g. "1,2,2" for 3 rows). my_answer = col index per row.
      //   - Two-Part Analysis: pick one ROW per COLUMN. Key1 has colCount entries
      //     (e.g. "4,5" for 2 cols). my_answer = row index per col.
      // Detect from Key1 arity; fall back to row-walk for ambiguous cases.
      const rows = item.choices.rows;
      const colCount = (item.choices.headers || []).length || (rows[0]?.options?.length ?? 0);
      const keyParts = (item.correctKey || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      const isTwoPart = keyParts.length > 0
        && keyParts.length === colCount
        && colCount !== rows.length;
      if (isTwoPart) {
        const parts = [];
        for (let c = 0; c < colCount; c += 1) {
          const rIdx = rows.findIndex((row) => row.options?.[c]?.isUserSelected);
          parts.push(rIdx >= 0 ? String(rIdx + 1) : '');
        }
        myAnswer = parts.join(',');
      } else {
        const parts = rows.map((row) => {
          const idx = (row.options || []).findIndex((o) => o && o.isUserSelected);
          return idx >= 0 ? String(idx + 1) : '';
        });
        myAnswer = parts.join(',');
      }
    } else if (item.choicesType === 'dropdown' && item.choices && Array.isArray(item.choices.dropdowns)) {
      // Graphics Interpretation: join each dropdown's selected text with commas.
      // Skip the placeholder "Select..." that appears when the user didn't pick.
      const parts = item.choices.dropdowns.map((d) => {
        const t = String(d?.selectedText ?? d?.selected ?? '').trim();
        return /^select\.\.\.?$/i.test(t) ? '' : t;
      });
      myAnswer = parts.some(Boolean) ? parts.join(',') : null;
    }
    // Note: an earlier version fell back to `window.answerSelection[1]` for
    // unrecognized item types. That global is `[0,1]` on every ITDReview
    // frame (it's a per-item min/max selection-count config, NOT the user's
    // pick), so reading it as the answer leaked a constant "1" → letter "A".
    // Removed to prevent silent A-leaks on unknown item shapes.
    // Correct answer comes from the hidden <input name="Key1"> form field on
    // the ITDReview page — authoritative for both single-choice (one value)
    // and matrix items (CSV like "2,2,1"). For single-choice MC we convert
    // the numeric value to a letter to match the legacy convention.
    let correctAnswer = null;
    const rawKey = (item.correctKey || '').trim();
    if (rawKey) {
      if (item.choicesType === 'dropdown' && item.choices?.dropdowns?.length) {
        // Graphics Interpretation: Key1 like "A1,B3" — codes that index into
        // each dropdown's option list. Translate to readable text.
        const parts = rawKey.split(/[,;]/).map((s) => s.trim());
        correctAnswer = parts.map((part, idx) => {
          const d = item.choices.dropdowns[idx];
          if (!d) return part;
          const opt = (d.options || []).find((o) => o.value === part);
          return opt ? opt.text : part;
        }).join(',');
      } else if (item.choicesType === 'matrix' || rawKey.includes(',') || rawKey.includes(';')) {
        correctAnswer = rawKey.replace(/;/g, ','); // normalize separator
      } else {
        const n = Number(rawKey);
        correctAnswer = (Number.isInteger(n) && n >= 1 && n <= 26)
          ? String.fromCharCode(64 + n)
          : rawKey;
      }
    }
    // Fallback: if no Key1 was found (some item types) but we know the user
    // got it right, the user's pick IS the correct answer.
    if (!correctAnswer && Number(targetRow.correct) === 1 && myAnswer) {
      correctAnswer = myAnswer;
    }
    // Inverse fallback: when no reliable user-pick signal was found in the
    // DOM (Verbal review pages frequently lack the red/green highlight) but
    // Phase 1 says the user got it right, the user's pick is mathematically
    // the correct answer. Without this, my_answer stays null and the
    // dashboard can't color-code the review modal.
    if (
      item.choicesType === 'single' &&
      !myAnswer &&
      correctAnswer &&
      Number(targetRow.correct) === 1
    ) {
      myAnswer = correctAnswer;
      if (Array.isArray(answerChoicesArr)) {
        for (const c of answerChoicesArr) { if (c) c.isUserSelected = false; }
        const matchIdx = answerChoicesArr.findIndex((c) => c && c.label === myAnswer);
        if (matchIdx >= 0) answerChoicesArr[matchIdx].isUserSelected = true;
      }
    }

    // Convert ms → seconds; preserve existing time_sec if not available.
    const timeSecPrecise =
      typeof item.vPreviousTimeSpent === 'number' && Number.isFinite(item.vPreviousTimeSpent)
        ? Math.max(1, Math.round(item.vPreviousTimeSpent / 1000))
        : null;

    // Sanity guard: a row marked WRONG by Phase 1 cannot have my_answer ===
    // correct_answer. If we see this, my_answer is corrupted (historically:
    // the bare-label regex extracting "E" from "Expensive..."). Drop the
    // suspect my_answer rather than persist a contradiction; an operator
    // re-running Phase 2 after a code fix will refill it. Same guard in
    // reverse for correct=1 rows where my_answer differs from correct_answer.
    if (
      item.choicesType === 'single' &&
      myAnswer && correctAnswer &&
      Number(targetRow.correct) === 0 &&
      myAnswer === correctAnswer
    ) {
      errors.push({
        seq, itemName,
        message: `inconsistent: correct=0 but my_answer===correct_answer===${myAnswer}; my_answer dropped`,
      });
      myAnswer = null;
      if (Array.isArray(answerChoicesArr)) {
        for (const c of answerChoicesArr) { if (c) c.isUserSelected = false; }
      }
    }

    try {
      // NOTE: do NOT overwrite q_id here. Phase 1 writes the composite
      // "<sessionExternalId>-seq-<N>" and Phase 2 must leave it untouched so
      // that a subsequent Phase 1 re-scrape can match the existing row via
      // the snapshot/annotation indexes (both keyed on q_id). If Phase 2
      // mutates q_id to ItemName, the next Phase 1 wipes question_stem,
      // answer_choices, passage_text, mistake_type, notes — silently.
      // The Phase 2 lookup above already accepts either composite OR
      // itemName, so leaving q_id alone is sufficient.
      await run(
        `
          UPDATE question_attempts
          SET q_code = COALESCE(?, q_code),
              question_stem = COALESCE(?, question_stem),
              answer_choices = ?,
              response_format = COALESCE(?, response_format),
              response_details = ?,
              my_answer = COALESCE(?, my_answer),
              correct_answer = COALESCE(?, correct_answer),
              time_sec = COALESCE(?, time_sec),
              passage_text = COALESCE(NULLIF(?, ''), passage_text)
          WHERE id = ?
        `,
        [
          formQuestionId != null ? String(formQuestionId) : (stableKey || null),
          item.stem || null,
          JSON.stringify(answerChoicesArr),
          responseFormat,
          JSON.stringify(responseDetailsPayload),
          myAnswer,
          correctAnswer,
          timeSecPrecise,
          item.passage || '',
          targetRow.id,
        ]
      );
      updated += 1;
    } catch (err) {
      errors.push({ seq, itemName, message: err.message });
    }
  }

  await refreshSessionTimingAggregates(sessionDbId);

  return { sessionDbId, matched: enrichedItems.length, updated, skipped, errors };
}

// Phase 2 overwrites per-question time_sec with vPreviousTimeSpent, but
// s.avg_time_sec was set at Phase-1 time and would otherwise drift away
// from the live AVG. listSessions/getSessionAnalysis both COALESCE live
// over stored, so the discrepancy is invisible in the UI for sessions that
// have any answered question; but other consumers (and the dashboard's
// pre-aggregated cards) read s.avg_time_sec directly. Keep them in sync.
async function refreshSessionTimingAggregates(sessionDbId) {
  const id = Number(sessionDbId);
  if (!Number.isInteger(id) || id <= 0) return;
  const unansweredExpr = unansweredPlaceholderExpr('q');
  await run(
    `
      UPDATE sessions
      SET
        avg_time_sec = COALESCE((
          SELECT ROUND(AVG(CASE WHEN NOT (${unansweredExpr}) THEN q.time_sec END), 0)
          FROM question_attempts q WHERE q.session_id = ?
        ), avg_time_sec),
        avg_correct_time_sec = COALESCE((
          SELECT ROUND(AVG(CASE WHEN NOT (${unansweredExpr}) AND q.correct = 1 THEN q.time_sec END), 0)
          FROM question_attempts q WHERE q.session_id = ?
        ), avg_correct_time_sec),
        avg_incorrect_time_sec = COALESCE((
          SELECT ROUND(AVG(CASE WHEN NOT (${unansweredExpr}) AND q.correct = 0 THEN q.time_sec END), 0)
          FROM question_attempts q WHERE q.session_id = ?
        ), avg_incorrect_time_sec)
      WHERE id = ?
    `,
    [id, id, id, id]
  );
}

// GMAT Club Phase-2 enrichment writer. The runner returns one item per
// visited topic; each item carries the `q_id` we sent in (e.g. "gc-att-86204128")
// so we can match the row back without iterating sessions/sequences.
async function enrichGmatClubSessionAttempts({ sessionExternalId, source, enrichedItems }) {
  const sessionRow = await get(
    `
      SELECT id
      FROM sessions
      WHERE session_external_id = ?
        AND COALESCE(source, '') = COALESCE(?, '')
      ORDER BY id DESC
      LIMIT 1
    `,
    [Number(sessionExternalId) || sessionExternalId, source || null]
  );
  if (!sessionRow?.id) {
    return { matched: 0, updated: 0, skipped: 0, errors: [{ message: 'session-not-found', sessionExternalId, source }] };
  }
  const sessionDbId = sessionRow.id;

  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const item of (Array.isArray(enrichedItems) ? enrichedItems : [])) {
    const qId = String(item?.q_id || '').trim();
    if (!qId) {
      errors.push({ message: 'item missing q_id', url: item?.source_url });
      continue;
    }

    const targetRow = await get(
      `
        SELECT id, question_stem, answer_choices, correct_answer
        FROM question_attempts
        WHERE session_id = ? AND q_id = ?
        LIMIT 1
      `,
      [sessionDbId, qId]
    );
    if (!targetRow) {
      skipped += 1;
      continue;
    }

    const choices = Array.isArray(item.choices) ? item.choices : [];
    // Normalize to {label, text} entries that match the dashboard renderer.
    const answerChoicesArr = choices
      .map((c) => ({
        label: String(c?.label || '').trim() || null,
        text: String(c?.text || '').trim() || null,
      }))
      .filter((c) => c.label || c.text);

    try {
      await run(
        `
          UPDATE question_attempts
          SET question_stem = COALESCE(NULLIF(?, ''), question_stem),
              answer_choices = CASE WHEN ? > 0 THEN ? ELSE answer_choices END,
              correct_answer = COALESCE(NULLIF(?, ''), correct_answer),
              my_answer = COALESCE(NULLIF(?, ''), my_answer),
              question_url = COALESCE(NULLIF(?, ''), question_url),
              passage_text = COALESCE(NULLIF(?, ''), passage_text)
          WHERE id = ?
        `,
        [
          item.stem || '',
          answerChoicesArr.length,
          answerChoicesArr.length ? JSON.stringify(answerChoicesArr) : null,
          item.correct_answer || '',
          item.my_answer || '',
          item.final_url || item.source_url || '',
          item.passage_text || '',
          targetRow.id,
        ]
      );
      updated += 1;
    } catch (err) {
      errors.push({ q_id: qId, message: err.message });
    }
  }

  await refreshSessionTimingAggregates(sessionDbId);

  return { sessionDbId, matched: enrichedItems.length, updated, skipped, errors };
}

// OPE Phase 3 enrichment writer. Matches rows by q_id = "ope-${itemName}-p${positionInSection}"
// (the composite Phase 2 wrote). Updates stem, choices, my_answer, correct_answer,
// difficulty, and replaces time_sec with the precise ms-based vPreviousTimeSpent.
async function enrichOpeSessionAttempts({ sessionExternalId, source, enrichedItems }) {
  const sessionRow = await get(
    `
      SELECT id
      FROM sessions
      WHERE session_external_id = ?
        AND COALESCE(source, '') = COALESCE(?, '')
      ORDER BY id DESC
      LIMIT 1
    `,
    [Number(sessionExternalId) || sessionExternalId, source || null]
  );
  if (!sessionRow?.id) {
    return { matched: 0, updated: 0, skipped: 0, errors: [{ message: 'session-not-found', sessionExternalId, source }] };
  }
  const sessionDbId = sessionRow.id;

  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const item of (Array.isArray(enrichedItems) ? enrichedItems : [])) {
    const itemName = String(item?.itemName || '').trim();
    const position = Number(item?.positionInSection);
    if (!itemName || !Number.isFinite(position) || position < 1) {
      errors.push({ message: 'item missing itemName or positionInSection', item });
      continue;
    }
    const qId = `ope-${itemName}-p${position}`;
    const targetRow = await get(
      `SELECT id FROM question_attempts WHERE session_id = ? AND q_id = ? LIMIT 1`,
      [sessionDbId, qId]
    );
    if (!targetRow) {
      skipped += 1;
      // Capture the mismatch for debugging — write to errors so the API
      // response surfaces what q_ids we tried but couldn't match.
      errors.push({
        skipped: true,
        composedQid: qId,
        itemName,
        positionInSection: position,
        section: item.section || null,
      });
      continue;
    }
    const choices = Array.isArray(item.choices) ? item.choices : [];
    const answerChoicesArr = choices
      .map((c) => ({
        label: String(c?.label || '').trim() || null,
        // Preserve `value` for matrix (e.g. "1:2" = row:col) and dropdown
        // (e.g. "1:A3" = ddIdx:optionValue) items; downstream backfill
        // scripts use it to reconstruct the grid / dropdown ordering.
        value: c?.value != null ? String(c.value).trim() : null,
        text: String(c?.text || '').trim() || null,
        isCorrect: !!c?.isCorrect,
        isUserSelected: !!c?.isUserSelected,
      }))
      .filter((c) => c.label || c.text);

    const timeSecPrecise = Number.isFinite(Number(item?.vPreviousTimeSpentMs))
      ? Math.round(Number(item.vPreviousTimeSpentMs) / 1000)
      : null;
    // OPE Phase 3 exposes the IRT 3PL b-parameter as a raw float. Store it on
    // `difficulty_theta` (for sorting/analytics) and bucket to a text label on
    // `difficulty` (for the chip-rendering UI). The ±0.43 below is just an
    // initial guess; recomputeIrtCutoffs() runs at the end of this function
    // and overwrites every label with per-subject empirical p33/p67 cutoffs.
    const thetaNum = Number.isFinite(Number(item?.difficulty))
      ? Number(item.difficulty)
      : null;
    const difficultyLabel = thetaNum == null
      ? null
      : thetaNum < -0.43 ? 'Easy' : thetaNum > 0.43 ? 'Hard' : 'Medium';

    try {
      await run(
        `
          UPDATE question_attempts
          SET question_stem = COALESCE(NULLIF(?, ''), question_stem),
              answer_choices = CASE WHEN ? > 0 THEN ? ELSE answer_choices END,
              correct_answer = COALESCE(NULLIF(?, ''), correct_answer),
              my_answer = COALESCE(NULLIF(?, ''), my_answer),
              difficulty = COALESCE(NULLIF(?, ''), difficulty),
              difficulty_theta = COALESCE(?, difficulty_theta),
              time_sec = COALESCE(?, time_sec)
          WHERE id = ?
        `,
        [
          item.stem || '',
          answerChoicesArr.length,
          answerChoicesArr.length ? JSON.stringify(answerChoicesArr) : null,
          item.correct_answer || '',
          item.my_answer || '',
          difficultyLabel || '',
          thetaNum,
          timeSecPrecise,
          targetRow.id,
        ]
      );
      updated += 1;
    } catch (err) {
      errors.push({ q_id: qId, message: err.message });
    }
  }

  await refreshSessionTimingAggregates(sessionDbId);
  await recomputeIrtCutoffs();

  return { sessionDbId, matched: enrichedItems.length, updated, skipped, errors };
}

// Recomputes empirical IRT cutoffs from current theta data and rebuckets
// every theta-bearing row's `difficulty` label to match. Called after each
// Phase 3 enrichment so the OPE buckets stay consistent as new attempts
// arrive.
//
// Keying:
//   Q, V → cutoffs keyed on subject_code alone (sub_key='')
//   DI   → cutoffs keyed on (subject_code='DI', sub_key=topic) so MSR's
//          wide right tail doesn't contaminate DS/GT/TPA. (DI topics:
//          'Data Sufficiency', 'Graphs and Tables', 'Two-part analysis',
//          'Multi-source reasoning'.)
//
// Buckets with fewer than 10 theta-bearing rows are skipped; those rows
// fall back to the global ±0.43 cutoff (the legacy default) until the
// sample grows.
async function recomputeIrtCutoffs() {
  // Q and V: one cutoff per subject_code.
  const qvRows = await all(`
    WITH ranked AS (
      SELECT subject_code, difficulty_theta,
             PERCENT_RANK() OVER (PARTITION BY subject_code ORDER BY difficulty_theta) AS pr,
             COUNT(*) OVER (PARTITION BY subject_code) AS n
      FROM question_attempts
      WHERE difficulty_theta IS NOT NULL
        AND subject_code IN ('Q','V')
    )
    SELECT subject_code,
           '' AS sub_key,
           MIN(CASE WHEN pr >= 0.3333 THEN difficulty_theta END) AS p33,
           MIN(CASE WHEN pr >= 0.6667 THEN difficulty_theta END) AS p67,
           MAX(n) AS n
    FROM ranked
    GROUP BY subject_code
    HAVING MAX(n) >= 10
  `);

  // DI: one cutoff per (subject_code, topic).
  const diRows = await all(`
    WITH ranked AS (
      SELECT subject_code, COALESCE(topic, '') AS sub_key, difficulty_theta,
             PERCENT_RANK() OVER (
               PARTITION BY subject_code, COALESCE(topic, '')
               ORDER BY difficulty_theta
             ) AS pr,
             COUNT(*) OVER (
               PARTITION BY subject_code, COALESCE(topic, '')
             ) AS n
      FROM question_attempts
      WHERE difficulty_theta IS NOT NULL
        AND subject_code = 'DI'
        AND COALESCE(topic, '') <> ''
    )
    SELECT subject_code, sub_key,
           MIN(CASE WHEN pr >= 0.3333 THEN difficulty_theta END) AS p33,
           MIN(CASE WHEN pr >= 0.6667 THEN difficulty_theta END) AS p67,
           MAX(n) AS n
    FROM ranked
    GROUP BY subject_code, sub_key
    HAVING MAX(n) >= 10
  `);

  const rows = [...qvRows, ...diRows];
  for (const r of rows) {
    if (r.p33 == null || r.p67 == null) continue;
    await run(
      `INSERT INTO irt_cutoffs(subject_code, sub_key, p33, p67, n, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(subject_code, sub_key) DO UPDATE SET
         p33 = excluded.p33,
         p67 = excluded.p67,
         n = excluded.n,
         updated_at = excluded.updated_at`,
      [r.subject_code, r.sub_key, r.p33, r.p67, r.n]
    );
  }

  // Rebucket: match each row to its cutoff entry by (subject_code, key).
  // For Q/V the cutoff row has sub_key=''; for DI it has sub_key=topic.
  await run(`
    UPDATE question_attempts
    SET difficulty = (
      SELECT CASE
        WHEN question_attempts.difficulty_theta < c.p33 THEN 'Easy'
        WHEN question_attempts.difficulty_theta > c.p67 THEN 'Hard'
        ELSE 'Medium'
      END
      FROM irt_cutoffs c
      WHERE c.subject_code = question_attempts.subject_code
        AND c.sub_key = CASE
          WHEN question_attempts.subject_code = 'DI'
            THEN COALESCE(question_attempts.topic, '')
          ELSE ''
        END
    )
    WHERE difficulty_theta IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM irt_cutoffs c
        WHERE c.subject_code = question_attempts.subject_code
          AND c.sub_key = CASE
            WHEN question_attempts.subject_code = 'DI'
              THEN COALESCE(question_attempts.topic, '')
            ELSE ''
          END
      )
  `);

  // Fallback ±0.43 for any theta-bearing row that didn't match a cutoff
  // (small sub-buckets, unknown subject codes, etc.).
  await run(`
    UPDATE question_attempts
    SET difficulty = CASE
      WHEN difficulty_theta < -0.43 THEN 'Easy'
      WHEN difficulty_theta >  0.43 THEN 'Hard'
      ELSE 'Medium'
    END
    WHERE difficulty_theta IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM irt_cutoffs c
        WHERE c.subject_code = question_attempts.subject_code
          AND c.sub_key = CASE
            WHEN question_attempts.subject_code = 'DI'
              THEN COALESCE(question_attempts.topic, '')
            ELSE ''
          END
      )
  `);

  return rows;
}

async function listGmatClubEnrichTargets(sessionDbId) {
  return all(
    `
      SELECT q.id, q.q_id, q.q_code, q.question_url, q.question_stem
      FROM question_attempts q
      WHERE q.session_id = ?
        AND COALESCE(NULLIF(q.q_id, ''), '') <> ''
        AND COALESCE(NULLIF(q.question_url, ''), '') <> ''
      ORDER BY q.id ASC
    `,
    [sessionDbId]
  );
}

// ─── Study Plan helpers ──────────────────────────────────────────────────────

const STUDY_PLAN_TASK_ALLOWED_STATUS = new Set(['pending', 'done', 'skipped']);

function normalizeStudyPlanStatus(value) {
  const v = String(value || '').toLowerCase();
  return STUDY_PLAN_TASK_ALLOWED_STATUS.has(v) ? v : 'pending';
}

async function listStudyPlanTasks() {
  return await all(
    `SELECT id, day_date, week_number, day_label, day_theme, position,
            title, description, est_minutes, status, completed_at, notes,
            created_at, updated_at
       FROM study_plan_tasks
      ORDER BY day_date ASC, position ASC, id ASC`
  );
}

async function getStudyPlanTask(id) {
  return await get('SELECT * FROM study_plan_tasks WHERE id = ?', [id]);
}

async function createStudyPlanTask(input) {
  const dayDate = String(input.day_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayDate)) {
    throw new Error('day_date must be YYYY-MM-DD');
  }
  const weekNumber = Number.isFinite(Number(input.week_number)) ? Number(input.week_number) : 1;
  const title = String(input.title || '').trim();
  if (!title) throw new Error('title is required');
  const description = input.description == null ? null : String(input.description);
  const dayLabel = input.day_label == null ? null : String(input.day_label);
  const dayTheme = input.day_theme == null ? null : String(input.day_theme);
  const estMinutes = Number.isFinite(Number(input.est_minutes)) ? Number(input.est_minutes) : null;
  const status = normalizeStudyPlanStatus(input.status);
  const notes = input.notes == null ? null : String(input.notes);
  // Default new task to the end of its day's list.
  let position = Number.isFinite(Number(input.position)) ? Number(input.position) : null;
  if (position == null) {
    const row = await get(
      'SELECT COALESCE(MAX(position), -1) AS maxpos FROM study_plan_tasks WHERE day_date = ?',
      [dayDate]
    );
    position = (row?.maxpos ?? -1) + 1;
  }
  const result = await run(
    `INSERT INTO study_plan_tasks
       (day_date, week_number, day_label, day_theme, position, title, description,
        est_minutes, status, completed_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [dayDate, weekNumber, dayLabel, dayTheme, position, title, description,
     estMinutes, status, status === 'done' ? new Date().toISOString() : null, notes]
  );
  return await getStudyPlanTask(result.lastID);
}

async function updateStudyPlanTask(id, patch) {
  const existing = await getStudyPlanTask(id);
  if (!existing) return null;
  const fields = [];
  const params = [];
  const set = (col, val) => { fields.push(`${col} = ?`); params.push(val); };

  if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
    const v = String(patch.title || '').trim();
    if (!v) throw new Error('title cannot be empty');
    set('title', v);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'description')) {
    set('description', patch.description == null ? null : String(patch.description));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'day_date')) {
    const v = String(patch.day_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('day_date must be YYYY-MM-DD');
    set('day_date', v);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'week_number')) {
    set('week_number', Number(patch.week_number));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'day_label')) {
    set('day_label', patch.day_label == null ? null : String(patch.day_label));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'day_theme')) {
    set('day_theme', patch.day_theme == null ? null : String(patch.day_theme));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'position')) {
    set('position', Number(patch.position));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'est_minutes')) {
    set('est_minutes', patch.est_minutes == null ? null : Number(patch.est_minutes));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'notes')) {
    set('notes', patch.notes == null ? null : String(patch.notes));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    const status = normalizeStudyPlanStatus(patch.status);
    set('status', status);
    if (status === 'done' && existing.status !== 'done') {
      set('completed_at', new Date().toISOString());
    } else if (status !== 'done') {
      set('completed_at', null);
    }
  }
  if (!fields.length) return existing;
  fields.push("updated_at = datetime('now')");
  params.push(id);
  await run(`UPDATE study_plan_tasks SET ${fields.join(', ')} WHERE id = ?`, params);
  return await getStudyPlanTask(id);
}

async function deleteStudyPlanTask(id) {
  const result = await run('DELETE FROM study_plan_tasks WHERE id = ?', [id]);
  return result.changes > 0;
}

async function getStudyPlanMeta() {
  const rows = await all('SELECT key, value FROM study_plan_meta');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function setStudyPlanMeta(key, value) {
  await run(
    `INSERT INTO study_plan_meta (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [String(key), value == null ? null : String(value)]
  );
}

// Wipe the entire plan (tasks only — meta preserved) so a fresh seed can run.
// Returns the number of deleted rows.
async function resetStudyPlanTasks() {
  const result = await run('DELETE FROM study_plan_tasks');
  return { deleted: result.changes };
}

// ─── Mock Results helpers ───────────────────────────────────────────────────

function normalizeMockInput(input) {
  const date = String(input.mock_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('mock_date must be YYYY-MM-DD');
  }
  const source = String(input.source_label || '').trim();
  if (!source) throw new Error('source_label is required');
  const intOrNull = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  return {
    mock_date: date,
    source_label: source,
    total_score: intOrNull(input.total_score),
    total_percentile: intOrNull(input.total_percentile),
    quant_score: intOrNull(input.quant_score),
    quant_percentile: intOrNull(input.quant_percentile),
    di_score: intOrNull(input.di_score),
    di_percentile: intOrNull(input.di_percentile),
    verbal_score: intOrNull(input.verbal_score),
    verbal_percentile: intOrNull(input.verbal_percentile),
    notes: input.notes == null ? null : String(input.notes),
  };
}

async function listMockResults() {
  return await all(
    `SELECT id, mock_date, source_label, total_score, total_percentile,
            quant_score, quant_percentile, di_score, di_percentile,
            verbal_score, verbal_percentile, notes, created_at, updated_at
       FROM mock_results
      ORDER BY mock_date ASC, id ASC`
  );
}

async function getMockResult(id) {
  return await get('SELECT * FROM mock_results WHERE id = ?', [id]);
}

async function createMockResult(input) {
  const v = normalizeMockInput(input);
  const result = await run(
    `INSERT INTO mock_results
       (mock_date, source_label, total_score, total_percentile,
        quant_score, quant_percentile, di_score, di_percentile,
        verbal_score, verbal_percentile, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [v.mock_date, v.source_label, v.total_score, v.total_percentile,
     v.quant_score, v.quant_percentile, v.di_score, v.di_percentile,
     v.verbal_score, v.verbal_percentile, v.notes]
  );
  return await getMockResult(result.lastID);
}

async function updateMockResult(id, patch) {
  const existing = await getMockResult(id);
  if (!existing) return null;
  // Merge patch over existing and re-validate.
  const merged = { ...existing, ...patch };
  const v = normalizeMockInput(merged);
  await run(
    `UPDATE mock_results
        SET mock_date = ?, source_label = ?,
            total_score = ?, total_percentile = ?,
            quant_score = ?, quant_percentile = ?,
            di_score = ?, di_percentile = ?,
            verbal_score = ?, verbal_percentile = ?,
            notes = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
    [v.mock_date, v.source_label, v.total_score, v.total_percentile,
     v.quant_score, v.quant_percentile, v.di_score, v.di_percentile,
     v.verbal_score, v.verbal_percentile, v.notes, id]
  );
  return await getMockResult(id);
}

async function deleteMockResult(id) {
  const result = await run('DELETE FROM mock_results WHERE id = ?', [id]);
  return result.changes > 0;
}

// Returns OPE mock sessions that the scraper has captured score data for, in
// the same shape as listMockResults() so the UI can merge them with manual
// entries. Only rows with at least one section/total score column populated
// are surfaced (regular practice sessions leave these NULL).
async function listScrapedMockResults() {
  const rows = await all(
    `SELECT id, session_external_id, session_date, source,
            total_score, total_percentile,
            quant_score, quant_percentile,
            di_score, di_percentile,
            verbal_score, verbal_percentile
       FROM sessions
      WHERE total_score IS NOT NULL
         OR quant_score IS NOT NULL
         OR verbal_score IS NOT NULL
         OR di_score IS NOT NULL
      ORDER BY session_date ASC, id ASC`
  );
  return rows.map((r) => ({
    id: `scraped-${r.id}`,
    session_id: r.id,
    session_external_id: r.session_external_id,
    mock_date: r.session_date,
    source_label: r.source,
    total_score: r.total_score,
    total_percentile: r.total_percentile,
    quant_score: r.quant_score,
    quant_percentile: r.quant_percentile,
    di_score: r.di_score,
    di_percentile: r.di_percentile,
    verbal_score: r.verbal_score,
    verbal_percentile: r.verbal_percentile,
    notes: null,
    source_type: 'scraped',
  }));
}

// Seed Mock #1 baseline (605 from OPE3 on 2026-05-24) if no mock rows exist.
async function seedMockResultsIfEmpty() {
  const row = await get('SELECT COUNT(*) AS n FROM mock_results');
  if (row && Number(row.n) > 0) return { seeded: false };
  await createMockResult({
    mock_date: '2026-05-24',
    source_label: 'OPE3 (used twice)',
    total_score: 605,
    total_percentile: 70,
    quant_score: 86,
    quant_percentile: 91,
    di_score: 76,
    di_percentile: 53,
    verbal_score: 78,
    verbal_percentile: 38,
    notes: 'Diagnostic baseline. Reveals Verbal at 38th %ile as biggest opportunity; Quant strong; DI middle. Plan rebalanced toward Verbal after this mock.',
  });
  return { seeded: true };
}

// Smart sync: apply the latest buildStudyPlanSeed() to existing rows, matching
// by (day_date, position). Preserves user-modified state:
//   • If status != 'pending' (done or skipped) → leave row alone
//   • If notes is non-empty → leave row alone
// For preserved rows we still update day_theme (label-level change) but not the
// task-level fields. New seed rows that don't match any existing row are
// inserted. Existing rows not matched by any seed row are left alone (the user
// may have added them manually).
async function syncStudyPlanFromSeed() {
  const seed = buildStudyPlanSeed();
  const existing = await all(
    `SELECT id, day_date, position, status, notes
       FROM study_plan_tasks`
  );
  // Index existing rows by (day_date, position) for O(1) lookup.
  const key = (d, p) => `${d}|${p}`;
  const map = new Map();
  for (const r of existing) map.set(key(r.day_date, r.position), r);

  let updated = 0, preservedThemeOnly = 0, inserted = 0;

  for (const day of seed.days) {
    let pos = 0;
    for (const task of day.tasks) {
      const k = key(day.date, pos);
      const ex = map.get(k);
      if (!ex) {
        // New seed row — insert.
        await run(
          `INSERT INTO study_plan_tasks
             (day_date, week_number, day_label, day_theme, position, title,
              description, est_minutes, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          [day.date, day.week, day.label, day.theme, pos, task.title,
           task.description || null, task.minutes || null]
        );
        inserted++;
      } else {
        const userModified = ex.status !== 'pending'
          || (ex.notes != null && String(ex.notes).trim() !== '');
        if (userModified) {
          // Only update day_theme (it's denormalized — label change shouldn't be lost).
          await run(
            `UPDATE study_plan_tasks
               SET day_theme = ?, day_label = ?, week_number = ?,
                   updated_at = datetime('now')
             WHERE id = ?`,
            [day.theme, day.label, day.week, ex.id]
          );
          preservedThemeOnly++;
        } else {
          // Full update — apply seed fully.
          await run(
            `UPDATE study_plan_tasks
               SET day_theme = ?, day_label = ?, week_number = ?,
                   title = ?, description = ?, est_minutes = ?,
                   updated_at = datetime('now')
             WHERE id = ?`,
            [day.theme, day.label, day.week, task.title,
             task.description || null, task.minutes || null, ex.id]
          );
          updated++;
        }
      }
      pos++;
    }
  }
  return { updated, preservedThemeOnly, inserted };
}

// One-time seed of the 4-week final-sprint plan drafted 2026-05-23.
// Returns { seeded: boolean, inserted: number }.
async function seedStudyPlanIfEmpty() {
  const row = await get('SELECT COUNT(*) AS n FROM study_plan_tasks');
  if (row && Number(row.n) > 0) return { seeded: false, inserted: 0 };
  const plan = buildStudyPlanSeed();
  let inserted = 0;
  for (const day of plan.days) {
    let pos = 0;
    for (const task of day.tasks) {
      await run(
        `INSERT INTO study_plan_tasks
           (day_date, week_number, day_label, day_theme, position, title, description,
            est_minutes, status, completed_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)`,
        [day.date, day.week, day.label, day.theme, pos++, task.title,
         task.description || null, task.minutes || null]
      );
      inserted++;
    }
  }
  // Set initial meta only if absent.
  const meta = await getStudyPlanMeta();
  if (!meta.test_date) await setStudyPlanMeta('test_date', '2026-06-20');
  if (!meta.plan_title) await setStudyPlanMeta('plan_title', 'GMAT Final Sprint — 4 Weeks');
  if (!meta.daily_target_hours) await setStudyPlanMeta('daily_target_hours', '2.5');
  return { seeded: true, inserted };
}

function buildStudyPlanSeed() {
  // 4-week final-sprint plan, drafted 2026-05-23, revised 2026-05-24 after Mock #1.
  //
  // STRATEGIC FRAME (target: 645–685, test day ~2026-06-20):
  //  Mock #1 (OPE3, 2026-05-24) = 605 total. Section scores:
  //    Quant 86 (91st %ile) — STRENGTH, near ceiling. Don't chase.
  //    DI    76 (53rd %ile) — middle. DS-first still right, but reduced hours.
  //    Verbal 78 (38th %ile) — AT-MEAN. Biggest score lever to 645+.
  //
  //  • Verbal (PRIMARY focus after Mock #1): CR Assumption (53%, n=58) and RC
  //    Main Idea/Purpose (66%, n=107) + easy/medium accuracy push. The 38th-
  //    %ile Verbal score suggests careless mistakes on easy/medium questions
  //    (which the adaptive algorithm punishes disproportionately).
  //    Techniques: Negation Test for CR Assumption, Passage Map for RC.
  //  • DI (SECONDARY): DS-first — DS is the largest share of DI questions and
  //    most technique-learnable. MSR/GI/TPA stay on maintenance touches.
  //  • Quant (MAINTENANCE only — minimal hours): 91st %ile already, marginal
  //    return on extra work. Combo/perm/prob polished — DO NOT redrill.
  //  • Mocks: 4 total (research recommends 2/week in weeks 2-3).
  //    OPE3 (Mock #1, done) + OPE4 (Mock #2) + 2 × GMAT Club CAT (Mocks #3-#4).
  //    OPE5/OPE6 reserved sealed for potential retake.
  //  • Process: every session ends with 5-category mistake tagging
  //    (conceptual / technique / careless / misread / timing).
  //  • Hard-question discipline: easy/medium accuracy ≥85% is the bottleneck
  //    for 645-685, not hard-question accuracy. Don't over-invest in hards.
  //
  // POST-MOCK-#1 REBALANCE: 4 sessions converted from DI/Quant to Verbal —
  //    Thu May 28 (DS hard → Verbal easy/medium drill),
  //    Sat May 30 (CR + Quant maint → CR + RC expansion),
  //    Wed Jun  3 (DS reinforcement → Verbal section pace),
  //    Mon Jun  8 (DS speed → Verbal speed). Net: ~7h more Verbal.
  //
  // Each day has 1-4 sub-tasks. Standard non-mock days follow:
  //   warm-up (15 min) → focused set (60-90 min) → review (30-45 min)
  const WARMUP_DESC = 'Open the error log, scroll the last 5 misses, recall the fix.';
  const REVIEW_DESC = 'For every miss: tag mistake type (conceptual / technique / careless / misread / timing), write a 1-line "what I should have seen", flag recurring q_codes.';

  const days = [
    // ─── Week 1 (May 24–30) — Diagnostic + DS Foundation + CR Assumption ───
    {
      date: '2026-05-24', week: 1, label: 'Sun', theme: 'Mock #1 — OPE3 (diagnostic baseline)',
      tasks: [
        { title: 'Pre-mock setup (snacks, water, quiet space, same time of day as real test)', minutes: 10 },
        { title: 'Mock #1 — GMAT Official Practice Exam 3, full-length, timed',
          description: 'OPE3 used once before — slightly inflated signal, but acceptable baseline since OPE1/OPE2 are burned. Take real breaks; no pauses inside sections. Treat this as test day.',
          minutes: 150 },
      ],
    },
    {
      date: '2026-05-25', week: 1, label: 'Mon', theme: 'Mock #1 deep review',
      tasks: [
        { title: 'Mock #1 (OPE3) review — every miss with 5-category tagging',
          description: REVIEW_DESC, minutes: 90 },
        { title: 'Write top 3 patterns from Mock #1 in a notes file',
          description: 'e.g. "DS-Probability traps", "RC Main Idea over-specific answers", "TPA hard collapse". This list drives the rest of the week.',
          minutes: 30 },
      ],
    },
    {
      date: '2026-05-26', week: 1, label: 'Tue', theme: 'DS technique drill (foundation)',
      tasks: [
        { title: 'Warm-up (5 last misses)', description: WARMUP_DESC, minutes: 15 },
        { title: 'DS technique drill — 15 medium DS Qs using AD/BCE elimination',
          description: 'Rules: (1) Evaluate each statement INDEPENDENTLY first — wipe the slate clean between (1) and (2). (2) AD/BCE: if (1) is sufficient, answer is A or D; if not, it\'s B/C/E. (3) Look at the simpler statement first. (4) Do NOT solve — only determine sufficiency.',
          minutes: 75 },
        { title: 'Review + log DS patterns you recognize', description: REVIEW_DESC, minutes: 30 },
      ],
    },
    {
      date: '2026-05-27', week: 1, label: 'Wed', theme: 'CR Assumption fundamentals',
      tasks: [
        { title: 'Warm-up (5 last misses)', description: WARMUP_DESC, minutes: 15 },
        { title: 'CR Assumption — 12 OG Assumption Qs with Pre-Think + Negation Test',
          description: 'PROCESS: (1) Read stem first to confirm it\'s an Assumption question. (2) Identify conclusion + evidence. (3) Pre-think the gap (the unstated link). (4) Only then read choices. (5) Negation Test: negate each finalist — if negation destroys argument, that\'s the answer. CR Assumption is your weakest CR topic at 53% (n=58).',
          minutes: 75 },
        { title: 'Review + log which step you skipped on every miss',
          description: 'Was it pre-thinking? Negation Test? Conclusion misread?',
          minutes: 30 },
      ],
    },
    {
      date: '2026-05-28', week: 1, label: 'Thu', theme: 'Verbal easy/medium accuracy drill (Mock #1 reveal)',
      tasks: [
        { title: 'Warm-up (5 last misses)', description: WARMUP_DESC, minutes: 15 },
        { title: 'Verbal — 20 mixed CR + RC Qs, easy/medium only, accuracy target ≥85%',
          description: 'Mock #1 showed Verbal at 38th percentile / score 78 — biggest score lever to 645+. The likely leak: careless mistakes on easy/medium Verbal questions (the adaptive algorithm punishes these disproportionately). Slow down on the easy ones — read stem twice, eliminate methodically. No hard questions in this set.',
          minutes: 90 },
        { title: 'Review every miss — was it actual content or a careless slip?',
          description: 'For each wrong easy/medium Verbal: did you misread? Pick the trap? Forget the technique? Tag with one of the 5 mistake categories. ' + REVIEW_DESC,
          minutes: 45 },
      ],
    },
    {
      date: '2026-05-29', week: 1, label: 'Fri', theme: 'RC Main Idea / Purpose deep-dive',
      tasks: [
        { title: 'Warm-up (5 last misses)', description: WARMUP_DESC, minutes: 15 },
        { title: 'RC — 3 passages with explicit Passage Maps + Main Idea questions',
          description: 'PROCESS: For each passage, write down (a) the Purpose in your own words, (b) 1-sentence summary per paragraph, (c) author\'s stance. ON Main Idea Qs: go to your Purpose note, then eliminate choices that are too specific or only relate to one paragraph. RC Main Idea/Purpose is your biggest RC opportunity at 66% (n=107).',
          minutes: 75 },
        { title: 'Review — score the quality of each passage map you wrote',
          description: 'Was your Purpose right? Did you miss a contrast signal? ' + REVIEW_DESC,
          minutes: 30 },
      ],
    },
    {
      date: '2026-05-30', week: 1, label: 'Sat', theme: 'CR Inference + RC Main Idea expansion',
      tasks: [
        { title: 'Warm-up (5 last misses)', description: WARMUP_DESC, minutes: 15 },
        { title: 'CR Inference — 12 hard-tilted CR Inference Qs',
          description: 'CR Inference at 62% (n=94) is your second CR weak spot. Inference ≠ Strengthen/Weaken — pick the choice that MUST be true based only on stated premises. Watch for "extreme" language in trap choices.',
          minutes: 50 },
        { title: 'RC Main Idea push — 2 passages with explicit Purpose extraction',
          description: 'Mock #1 says Verbal is your biggest gap. RC Main Idea/Purpose at 66% (n=107) is the largest RC opportunity. Quant maintenance dropped from today\'s plan — you\'re at 91st percentile, marginal return on extra Quant work.',
          minutes: 40 },
        { title: 'Review both blocks', description: REVIEW_DESC, minutes: 15 },
      ],
    },

    // ─── Week 2 (May 31–Jun 6) — DS Depth + Section Pace + Mock #2 ─────────
    {
      date: '2026-05-31', week: 2, label: 'Sun', theme: 'DS section-pace + MSR primer',
      tasks: [
        { title: 'Warm-up (5 last misses)', description: WARMUP_DESC, minutes: 15 },
        { title: 'DS section-pace — 10 DS Qs in 20 min (real test pacing)',
          description: 'DS questions are 35-50% faster than other DI types (your avg 117s vs 185-234s). Banking time on DS lets you spend it on slow MSR/TPA. Target: 12 sec margin per DS.',
          minutes: 25 },
        { title: 'MSR primer — 3 MSR Qs to keep skill warm',
          description: 'MSR is at 46% (n=84). NOT the focus this round, but skill decays fast. Practice: read source labels first, NOT the full content; return to specific source per question. Pace: ~2.5 min/Q.',
          minutes: 45 },
        { title: 'Review both blocks', description: REVIEW_DESC, minutes: 45 },
      ],
    },
    {
      date: '2026-06-01', week: 2, label: 'Mon', theme: 'RC mixed timed (4 passages)',
      tasks: [
        { title: 'Warm-up (5 last misses)', description: WARMUP_DESC, minutes: 15 },
        { title: 'RC — 4 passages timed, focus on Main Idea + Inference question types',
          description: 'Build a passage map BEFORE looking at any questions. Read for STRUCTURE on first pass, not memorization. Note Purpose of each ¶, location of contrast signals, author stance.',
          minutes: 75 },
        { title: 'Review — passage-map quality check + tag misses',
          description: 'For each missed Q: did your map have the info? Or did you miss a structural cue? ' + REVIEW_DESC,
          minutes: 30 },
      ],
    },
    {
      date: '2026-06-02', week: 2, label: 'Tue', theme: 'Verbal mixed deep-dive',
      tasks: [
        { title: 'Warm-up (5 last misses)', description: WARMUP_DESC, minutes: 15 },
        { title: 'CR mixed — 12 Qs (Assumption + Inference focus), untimed first',
          description: 'Phase 1: untimed. Force pre-thinking + Negation Test on every Q. No shortcuts.',
          minutes: 50 },
        { title: 'Same 12 Qs re-do timed (2 min each)',
          description: 'Phase 2: see how much of the untimed reasoning you can actually deploy under pressure.',
          minutes: 30 },
        { title: '2 RC passages on Main Idea/Purpose',
          description: 'Apply passage map technique. Time-box: 15 min total.',
          minutes: 30 },
        { title: 'Review delta between untimed/timed CR + RC',
          description: REVIEW_DESC, minutes: 25 },
      ],
    },
    {
      date: '2026-06-03', week: 2, label: 'Wed', theme: 'Verbal section-pace drill',
      tasks: [
        { title: 'Warm-up (5 last misses)', description: WARMUP_DESC, minutes: 15 },
        { title: 'Verbal section-pace — 20 Qs in 38 min (mix of CR Assumption + CR Inference + RC Main Idea)',
          description: 'Mirrors actual Verbal section pacing (23 Qs / 45 min). The 38th-percentile Verbal mock score says you need pacing + accuracy gains under section timing, not just topic-by-topic work. Force the techniques (Pre-Think, Negation Test, Passage Map) under time pressure.',
          minutes: 40 },
        { title: 'Review + section-pace audit',
          description: 'Which Qs took >2 min? Were they actually hard, or did you over-think a medium? Where did the technique break down? ' + REVIEW_DESC,
          minutes: 65 },
      ],
    },
    {
      date: '2026-06-04', week: 2, label: 'Thu', theme: 'DI full sectional (real timing)',
      tasks: [
        { title: 'Pre-section setup — silence phone, clear desk, 5-min warmup', minutes: 10 },
        { title: 'DI sectional — 20 Qs in 45 min (no pauses, no checking)',
          description: 'This is your first full-section DI under real timing in this plan. The mix exposes whether your DS gains transfer when MSR/GI/TPA interrupt your rhythm. Pacing target: 2:15/Q average.',
          minutes: 45 },
        { title: 'Full sectional review — every miss + every guess + every slow Q',
          description: 'Mark Qs where you spent >3 min — those are pacing leaks, even when correct. ' + REVIEW_DESC,
          minutes: 75 },
      ],
    },
    {
      date: '2026-06-05', week: 2, label: 'Fri', theme: 'Error-log replay (recurring misses)',
      tasks: [
        { title: 'Pull every error tagged "misread" or "concept-OK-execution-failed" from last 60d', minutes: 15 },
        { title: 'Redo cold — no peeking, no notes',
          description: 'Read stem aloud. Mark constraints on paper. Force the discipline. These are your top mistake tags (n=8 + n=6).',
          minutes: 75 },
        { title: 'Compare: which misses persisted across attempts?',
          description: 'Recurring misses tell you which fix patterns aren\'t sticking yet — those need the most attention.',
          minutes: 30 },
      ],
    },
    {
      date: '2026-06-06', week: 2, label: 'Sat', theme: 'Mock #2 — OPE4 (fresh, cleanest signal)',
      tasks: [
        { title: 'Pre-mock setup — same time of day as real test if possible', minutes: 10 },
        { title: 'Mock #2 — GMAT Official Practice Exam 4, full-length, timed',
          description: 'OPE4 is fresh and your cleanest score signal of the plan. Anchor for mid-plan calibration. Strict timing, real breaks, no pauses.',
          minutes: 150 },
      ],
    },

    // ─── Week 3 (Jun 7–13) — Mock-Heavy Calibration (research: 2 mocks/wk) ─
    {
      date: '2026-06-07', week: 3, label: 'Sun', theme: 'Mock #2 deep review + calibration',
      tasks: [
        { title: 'Mock #2 (OPE4) review — every miss with 5-category tagging',
          description: REVIEW_DESC, minutes: 105 },
        { title: 'Calibration check + adjustment (score-based, anchored on Mock #1=605)',
          description: 'Mock #2 (OPE4) targets: Verbal ≥80 (vs 78 baseline), DI ≥78 (vs 76), Quant ≥86, Total ≥625. Verbal is the primary lever — if Verbal didn\'t climb, double Verbal time in Week 3 (steal from DS sessions). If DI dropped, the DS-first hypothesis needs revisiting.',
          minutes: 30 },
      ],
    },
    {
      date: '2026-06-08', week: 3, label: 'Mon', theme: 'Verbal speed drill + 7-day mistake-tag review',
      tasks: [
        { title: 'Warm-up (5 last misses)', description: WARMUP_DESC, minutes: 15 },
        { title: 'Verbal speed drill — 20 Verbal Qs in 38 min',
          description: 'Target: ≥85% accuracy, ~1:55 per question. This is the 2nd Verbal section-timed drill of the plan — Mock #2 (just reviewed Sun) should reveal whether Verbal climbed from 78. If it did, lean into momentum; if it didn\'t, this is the calibration day.',
          minutes: 40 },
        { title: 'Mistake-tag analysis from last 14 days',
          description: 'Which of the 5 mistake categories (conceptual/technique/careless/misread/timing) is most common across CR + RC misses? That\'s the highest-leverage Verbal fix for Week 3.',
          minutes: 35 },
        { title: 'DS pattern log review (short — DS deprioritized after Mock #1)',
          description: 'Quick check: are DS patterns still stable from Week 1-2 work? If yes, no extra DS time needed before Mock #3.',
          minutes: 25 },
      ],
    },
    {
      date: '2026-06-09', week: 3, label: 'Tue', theme: 'Mock #3 — GMAT Club CAT #1',
      tasks: [
        { title: 'Pre-mock setup', minutes: 10 },
        { title: 'Mock #3 — GMAT Club CAT, full-length, timed',
          description: 'Research recommends 2 mocks/week in last 2-3 weeks for stamina + pacing calibration. GMAT Club CAT signal less reliable than official — focus on pacing patterns and section-by-section rhythm, NOT the raw score. OPE5/OPE6 preserved for retake.',
          minutes: 150 },
      ],
    },
    {
      date: '2026-06-10', week: 3, label: 'Wed', theme: 'Mock #3 review + RC Inference push',
      tasks: [
        { title: 'Mock #3 review — patterns + pacing only (score is noisy)',
          description: 'Where did you slow down? Where did you rush? Which DS Qs did you actually solve vs. determine sufficiency? ' + REVIEW_DESC,
          minutes: 60 },
        { title: 'RC Inference focused set — 12 RC Inference Qs',
          description: 'RC Inference at 72% (n=95). Push to 80%+. Same passage-map approach, but Inference questions need you to NOT extrapolate beyond the passage — pick the choice that\'s most directly supported.',
          minutes: 60 },
      ],
    },
    {
      date: '2026-06-11', week: 3, label: 'Thu', theme: 'Process-discipline drill',
      tasks: [
        { title: 'Pull every error tagged "misread" or "careless" from Mocks 2 & 3', minutes: 15 },
        { title: 'Redo cold with FORCED process: read stem aloud, mark constraints, name structure',
          description: 'For DI: name the data structure before reading the prompt (table type, MSR tab roles, GI axes). For CR: state the conclusion in your own words. For RC: write 1-sentence purpose before answering.',
          minutes: 75 },
        { title: 'Write a 1-page process cheat sheet to consult during mocks',
          description: 'Pin this where you can see it during Week 4 mocks.',
          minutes: 30 },
      ],
    },
    {
      date: '2026-06-12', week: 3, label: 'Fri', theme: 'Light review + pre-mock sleep prep',
      tasks: [
        { title: 'Light review of process cheat sheet + week 3 notes',
          description: 'No new questions. Cement what you already know.',
          minutes: 60 },
        { title: 'Pre-mock prep: in bed by 10pm, no screens after 9:30',
          description: 'Tomorrow\'s mock is the last full one — needs you fresh.',
          minutes: 30 },
      ],
    },
    {
      date: '2026-06-13', week: 3, label: 'Sat', theme: 'Mock #4 — GMAT Club CAT #2',
      tasks: [
        { title: 'Pre-mock setup — same time as real test, full conditions', minutes: 10 },
        { title: 'Mock #4 — GMAT Club CAT, full-length, timed',
          description: 'Last full mock. Goal: validate that process discipline holds under fatigue. Track which section had the cleanest pacing.',
          minutes: 150 },
      ],
    },

    // ─── Week 4 (Jun 14–20) — Taper + Test (no new content) ────────────────
    {
      date: '2026-06-14', week: 4, label: 'Sun', theme: 'Mock #4 deep review + trend check',
      tasks: [
        { title: 'Mock #4 review — every miss with tagging',
          description: 'Final round of mistake-tagging. ' + REVIEW_DESC, minutes: 90 },
        { title: 'Compare Mocks #1, #2, #4 for score trend (score-based gate)',
          description: 'Targets: Verbal ≥82 (38th → 60th %ile), DI ≥80, Quant ≥86, Total ≥645. If still below 645, consider rescheduling the test. Whichever section is weakest — that\'s Tue\'s targeted block focus.',
          minutes: 30 },
      ],
    },
    {
      date: '2026-06-15', week: 4, label: 'Mon', theme: 'Recurring-miss final pull',
      tasks: [
        { title: 'Pull q_codes wrong on 2+ attempts (uses /api/errors + recurring-miss SQL)', minutes: 15 },
        { title: 'Redo cold — no notes, no peeking',
          description: 'These are the misses your study process has NOT fixed yet. Last chance to break them.',
          minutes: 75 },
        { title: 'Write final fix note per recurring miss',
          description: 'One sentence each. These go on the test-day reference card (Wed).',
          minutes: 30 },
      ],
    },
    {
      date: '2026-06-16', week: 4, label: 'Tue', theme: 'Final targeted block (no full mock — research says no mocks <3 days before test)',
      tasks: [
        { title: 'Quant section-timed — 10 Qs / 20 min',
          description: 'Focus on whatever section had weakest Mock #4 pacing.',
          minutes: 25 },
        { title: 'Verbal section-timed — 10 Qs / 20 min',
          description: 'CR Assumption + RC Main Idea question types specifically.',
          minutes: 25 },
        { title: 'DI section-timed — 10 Qs / 20 min',
          description: 'DS-heavy mix (60% DS, 40% other types) — mirrors actual test distribution.',
          minutes: 25 },
        { title: 'Review all three blocks',
          description: 'Replaces a 4th full mock to preserve OPE5/OPE6 + mental energy. Research: avoid mocks in last 2-3 days. ' + REVIEW_DESC,
          minutes: 60 },
      ],
    },
    {
      date: '2026-06-17', week: 4, label: 'Wed', theme: 'Consolidate + final test-day reference card',
      tasks: [
        { title: 'Build a 1-page test-day reference card',
          description: 'Sections: (1) DS process — AD/BCE, independent statements, simpler-first. (2) CR Assumption — pre-think, Negation Test. (3) RC — passage map, Purpose first. (4) Top 5 recurring traps from your error log. (5) Pacing targets per section.',
          minutes: 60 },
        { title: 'Final pacing plan — target time per question by section',
          description: 'Quant 2:00/Q, Verbal 1:55/Q, DI 2:15/Q (with DS = 1:45, others = 2:30).',
          minutes: 30 },
        { title: 'Re-read process cheat sheet from Week 3 once', minutes: 30 },
      ],
    },
    {
      date: '2026-06-18', week: 4, label: 'Thu', theme: 'Light reasoning practice (no timing)',
      tasks: [
        { title: 'Light untimed practice — 10 Qs each section, talk reasoning out loud',
          description: 'Goal: keep neurons warm without fatigue. Stop if you feel stressed — the math is done.',
          minutes: 90 },
      ],
    },
    {
      date: '2026-06-19', week: 4, label: 'Fri', theme: 'REST DAY — notes only',
      tasks: [
        { title: 'Read test-day reference card once', minutes: 15 },
        { title: 'No GMAT material the rest of the day',
          description: 'Hydrate. Light food. In bed by 10pm. Research consistently says preparation in the last 1-2 days does not change your score, but sleep does.',
          minutes: 15 },
      ],
    },
    {
      date: '2026-06-20', week: 4, label: 'Sat', theme: 'TEST DAY',
      tasks: [
        { title: 'Light warmup — 3 Qs each section before leaving home',
          description: 'Goal: warm the brain, not learn. Easy/medium only.',
          minutes: 20 },
        { title: 'Test day — go execute the process',
          description: 'Remember: easy/medium accuracy is the bottleneck for 645-685, not hards. Don\'t dwell on a hard Q — accept the loss and move on (the adaptive algorithm hates streaks of wrongs more than it hates scattered wrongs).',
          minutes: 0 },
      ],
    },
  ];
  return { days };
}

module.exports = {
  dbPath,
  run,
  all,
  get,
  initDb,
  backfillSparseQuestionAttempts,
  saveScrapeResult,
  enrichSessionAttempts,
  enrichGmatClubSessionAttempts,
  enrichOpeSessionAttempts,
  listGmatClubEnrichTargets,
  listRuns,
  listSessions,
  countSessions,
  listErrors,
  countErrors,
  getPatterns,
  getSessionAnalysis,
  getLatestRunForSource,
  updateErrorAnnotation,
  saveLsatAttempt,
  listLsatAttempts,
  listLsatErrors,
  lsatStats,
  clearLsatAttempts,
  createLsatSession,
  completeLsatSession,
  listLsatSessions,
  getLsatSession,
  // Study plan
  listStudyPlanTasks,
  getStudyPlanTask,
  createStudyPlanTask,
  updateStudyPlanTask,
  deleteStudyPlanTask,
  getStudyPlanMeta,
  setStudyPlanMeta,
  seedStudyPlanIfEmpty,
  resetStudyPlanTasks,
  syncStudyPlanFromSeed,
  // Mock results
  listMockResults,
  listScrapedMockResults,
  getMockResult,
  createMockResult,
  updateMockResult,
  deleteMockResult,
  seedMockResultsIfEmpty,
};
