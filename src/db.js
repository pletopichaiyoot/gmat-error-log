const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = path.resolve(__dirname, '..', 'data');
const dbPath = path.join(dbDir, 'gmat-error-log.db');

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

  await run(`
    CREATE TABLE IF NOT EXISTS question_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      session_id INTEGER NOT NULL,
      q_code TEXT,
      q_id TEXT,
      cat_id INTEGER,
      subject_sub TEXT,
      subject_sub_raw TEXT,
      question_url TEXT,
      correct INTEGER NOT NULL,
      difficulty TEXT,
      confidence TEXT,
      time_sec INTEGER,
      my_answer TEXT,
      correct_answer TEXT,
      topic TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES scrape_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  await ensureQuestionAttemptsColumn('q_id', 'TEXT');
  await ensureQuestionAttemptsColumn('cat_id', 'INTEGER');
  await ensureQuestionAttemptsColumn('subject_sub', 'TEXT');
  await ensureQuestionAttemptsColumn('subject_sub_raw', 'TEXT');
  await ensureQuestionAttemptsColumn('question_url', 'TEXT');
  await ensureQuestionAttemptsColumn('mistake_type', 'TEXT');
  await ensureQuestionAttemptsColumn('notes', 'TEXT');

  await run('CREATE INDEX IF NOT EXISTS idx_sessions_run_id ON sessions(run_id)');
  await run(
    'CREATE INDEX IF NOT EXISTS idx_sessions_external_source ON sessions(session_external_id, source)'
  );
  await run('CREATE INDEX IF NOT EXISTS idx_questions_run_id ON question_attempts(run_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_questions_correct ON question_attempts(correct)');
  await run('CREATE INDEX IF NOT EXISTS idx_questions_topic ON question_attempts(topic)');
  await run('CREATE INDEX IF NOT EXISTS idx_questions_difficulty ON question_attempts(difficulty)');
}

function safeInt(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function boolToInt(value) {
  return value ? 1 : 0;
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

  for (const session of sessions) {
    const stats = session.stats || {};
    let sessionId = null;

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
            avg_incorrect_time_sec = ?
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
            avg_incorrect_time_sec
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        ]
      );
      sessionId = sessionInsert.lastID;
    }
    const attempts = Array.isArray(session.questions) ? session.questions : [];

    for (const q of attempts) {
      await run(
        `
          INSERT INTO question_attempts (
            run_id,
            session_id,
            q_code,
            q_id,
            cat_id,
            subject_sub,
            subject_sub_raw,
            question_url,
            correct,
            difficulty,
            confidence,
            time_sec,
            my_answer,
            correct_answer,
            topic
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          runId,
          sessionId,
          q.q_code || null,
          q.q_id || null,
          safeInt(q.cat_id),
          q.subject_sub || null,
          q.subject_sub_raw || null,
          q.question_url || null,
          boolToInt(Boolean(q.correct)),
          q.difficulty || null,
          q.confidence || null,
          safeInt(q.time_sec),
          q.my_answer || null,
          q.correct_answer || null,
          q.topic || null,
        ]
      );
    }
  }

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

async function listSessions(runId, { limit, offset } = {}) {
  const params = [];
  const whereClause = runId ? 'WHERE s.run_id = ?' : '';
  if (runId) params.push(runId);

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
        ROUND(
          CASE
            WHEN COUNT(q.id) > 0
              THEN
                100.0
                * SUM(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END)
                / COUNT(q.id)
            WHEN (COALESCE(s.correct_count, 0) + COALESCE(s.error_count, 0)) > 0
              THEN
                100.0
                * COALESCE(s.correct_count, 0)
                / (COALESCE(s.correct_count, 0) + COALESCE(s.error_count, 0))
            ELSE s.accuracy_pct
          END,
          1
        ) AS accuracy_pct,
        s.avg_time_sec,
        s.avg_correct_time_sec,
        s.avg_incorrect_time_sec,
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

async function countSessions(runId) {
  const params = [];
  const whereClause = runId ? 'WHERE run_id = ?' : '';
  if (runId) params.push(runId);
  const row = await get(`SELECT COUNT(*) as total FROM sessions ${whereClause}`, params);
  return row ? row.total : 0;
}

async function listErrors({ runId, subject, difficulty, topic, confidence, search, sortKey, sortOrder, limit, offset }) {
  const ALLOWED_SORT = {
    session_date: 's.session_date',
    session_external_id: 's.session_external_id',
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
  const where = ['q.correct = 0'];
  const normalizedSubExpr = `
    CASE
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'DS' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) IN ('MSR', 'TA', 'GI', 'TPA') THEN 'DI'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'DS' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('DI', 'TA', 'GI', 'MSR', 'TPA') THEN 'DI'
      WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%data sufficiency%' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('CR', 'RC', 'PS', 'QUANT', 'VERBAL') THEN
        CASE UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
          WHEN 'QUANT' THEN 'Quant'
          WHEN 'VERBAL' THEN 'Verbal'
          ELSE UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
        END
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
            'Main Idea', 'Detail', 'Purpose', 'Author Attitude', 'Organization', 'Application'
          ) THEN 'RC'
          WHEN COALESCE(NULLIF(q.topic, ''), '') IN (
            'Weaken', 'Strengthen', 'Explain', 'Inference', 'Assumption',
            'Boldface', 'Evaluate', 'Flaw', 'Parallel', 'Complete', 'Method'
          ) THEN 'CR'
          ELSE 'Verbal'
        END
      WHEN q.cat_id BETWEEN 1336700 AND 1336899 THEN 'DI'
      ELSE COALESCE(NULLIF(s.subject, ''), 'Unknown')
    END
  `;
  const topicExpr = `
    CASE
      WHEN COALESCE(NULLIF(q.topic, ''), '') <> '' THEN q.topic
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'MSR' THEN 'Multi-Source Reasoning'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'TA' THEN 'Table Analysis'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'GI' THEN 'Graphics Interpretation'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'TPA' THEN 'Two-Part Analysis'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'DS' THEN 'Data Sufficiency'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'DS' THEN 'Data Sufficiency'
      ELSE 'Unknown'
    END
  `;
  if (runId) {
    where.push('q.run_id = ?');
    params.push(runId);
  }

  if (subject) {
    where.push(`(${subjectExpr}) = ?`);
    params.push(subject);
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
    where.push(`(UPPER(COALESCE(q.topic, '')) LIKE UPPER(?) OR UPPER(COALESCE(q.q_code, '')) LIKE UPPER(?))`);
    params.push(`%${search}%`, `%${search}%`);
  }

  let limitClause = '';
  if (limit !== undefined && offset !== undefined) {
    limitClause = 'LIMIT ? OFFSET ?';
    params.push(limit, offset);
  } else {
    limitClause = 'LIMIT 500';
  }

  return all(
    `
      SELECT
        q.id,
        q.run_id,
        s.session_external_id,
        s.session_date,
        ${subjectExpr} AS subject,
        q.subject_sub,
        q.subject_sub_raw,
        s.source,
        q.q_code,
        q.q_id,
        q.cat_id,
        q.question_url,
        q.difficulty,
        q.confidence,
        ${topicExpr} AS topic,
        q.time_sec,
        q.my_answer,
        q.correct_answer,
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
}

async function countErrors({ runId, subject, difficulty, topic, confidence, search }) {
  const params = [];
  const where = ['q.correct = 0'];
  // Re-use expressions for subject and topic logic to ensure consistency
  const normalizedSubExpr = `
    CASE
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'DS' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) IN ('MSR', 'TA', 'GI', 'TPA') THEN 'DI'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'DS' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('DI', 'TA', 'GI', 'MSR', 'TPA') THEN 'DI'
      WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%data sufficiency%' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('CR', 'RC', 'PS', 'QUANT', 'VERBAL') THEN
        CASE UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
          WHEN 'QUANT' THEN 'Quant'
          WHEN 'VERBAL' THEN 'Verbal'
          ELSE UPPER(COALESCE(NULLIF(q.subject_sub, ''), ''))
        END
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
            'Main Idea', 'Detail', 'Purpose', 'Author Attitude', 'Organization', 'Application'
          ) THEN 'RC'
          WHEN COALESCE(NULLIF(q.topic, ''), '') IN (
            'Weaken', 'Strengthen', 'Explain', 'Inference', 'Assumption',
            'Boldface', 'Evaluate', 'Flaw', 'Parallel', 'Complete', 'Method'
          ) THEN 'CR'
          ELSE 'Verbal'
        END
      WHEN q.cat_id BETWEEN 1336700 AND 1336899 THEN 'DI'
      ELSE COALESCE(NULLIF(s.subject, ''), 'Unknown')
    END
  `;
  const topicExpr = `
    CASE
      WHEN COALESCE(NULLIF(q.topic, ''), '') <> '' THEN q.topic
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'MSR' THEN 'Multi-Source Reasoning'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'TA' THEN 'Table Analysis'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'GI' THEN 'Graphics Interpretation'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'TPA' THEN 'Two-Part Analysis'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'DS' THEN 'Data Sufficiency'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'DS' THEN 'Data Sufficiency'
      ELSE 'Unknown'
    END
  `;

  if (runId) {
    where.push('q.run_id = ?');
    params.push(runId);
  }
  if (subject) {
    where.push(`(${subjectExpr}) = ?`);
    params.push(subject);
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
    where.push(`(UPPER(COALESCE(q.topic, '')) LIKE UPPER(?) OR UPPER(COALESCE(q.q_code, '')) LIKE UPPER(?))`);
    params.push(`%${search}%`, `%${search}%`);
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
  const runClause = runId ? 'run_id = ? AND ' : '';
  const runParams = runId ? [runId] : [];
  const runJoinClause = runId ? 'q.run_id = ? AND ' : '';
  const normalizedSubExpr = `
    CASE
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'DS' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) IN ('MSR', 'TA', 'GI', 'TPA') THEN 'DI'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'DS' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) IN ('DI', 'TA', 'GI', 'MSR', 'TPA') THEN 'DI'
      WHEN LOWER(COALESCE(NULLIF(q.topic, ''), '')) LIKE '%data sufficiency%' THEN 'DS'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'QUANT' THEN 'Quant'
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
            'Main Idea', 'Detail', 'Purpose', 'Author Attitude', 'Organization', 'Application'
          ) THEN 'RC'
          WHEN COALESCE(NULLIF(q.topic, ''), '') IN (
            'Weaken', 'Strengthen', 'Explain', 'Inference', 'Assumption',
            'Boldface', 'Evaluate', 'Flaw', 'Parallel', 'Complete', 'Method'
          ) THEN 'CR'
          ELSE 'Verbal'
        END
      WHEN q.cat_id BETWEEN 1336700 AND 1336899 THEN 'DI'
      WHEN COALESCE(NULLIF(s.subject, ''), '') IN ('CR', 'RC', 'PS', 'DS', 'Quant', 'DI', 'TA', 'GI', 'MSR', 'TPA') THEN COALESCE(NULLIF(s.subject, ''), 'Unknown')
      WHEN LOWER(COALESCE(s.source, '')) LIKE '%quant%' THEN 'Quant'
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
            'Main Idea', 'Detail', 'Purpose', 'Author Attitude', 'Organization', 'Application'
          ) THEN 'RC'
          WHEN COALESCE(NULLIF(q.topic, ''), '') IN (
            'Weaken', 'Strengthen', 'Explain', 'Inference', 'Assumption',
            'Boldface', 'Evaluate', 'Flaw', 'Parallel', 'Complete', 'Method'
          ) THEN 'CR'
          ELSE 'Verbal'
        END
      WHEN q.cat_id BETWEEN 1336700 AND 1336899 THEN 'DI'
      ELSE COALESCE(NULLIF(s.subject, ''), 'Unknown')
    END
  `;
  const topicExpr = `
    CASE
      WHEN COALESCE(NULLIF(q.topic, ''), '') <> '' THEN q.topic
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'MSR' THEN 'Multi-Source Reasoning'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'TA' THEN 'Table Analysis'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'GI' THEN 'Graphics Interpretation'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'TPA' THEN 'Two-Part Analysis'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'DS' THEN 'Data Sufficiency'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'DS' THEN 'Data Sufficiency'
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
      WHERE ${runClause}q.correct = 0
      GROUP BY ${topicExpr}
      ORDER BY mistakes DESC, topic ASC
      LIMIT 20
    `,
    runParams
  );

  const byDifficulty = await all(
    `
      SELECT
        COALESCE(NULLIF(difficulty, ''), 'Unknown') AS difficulty,
        COUNT(*) AS total,
        SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS correct,
        SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END) AS wrong,
        ROUND(
          100.0 * SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) / COUNT(*),
          1
        ) AS accuracy_pct
      FROM question_attempts
      WHERE ${runClause}1 = 1
      GROUP BY COALESCE(NULLIF(difficulty, ''), 'Unknown')
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
      WHERE ${runJoinClause}q.correct = 0
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
      WHERE ${runJoinClause}q.correct = 0
      GROUP BY ${subjectExpr}, ${topicExpr}
      ORDER BY subject ASC, mistakes DESC, topic ASC
    `,
    runParams
  );

  const confidenceMismatch = await all(
    `
      SELECT
        COALESCE(NULLIF(confidence, ''), 'not selected') AS confidence,
        COUNT(*) AS wrong_answers
      FROM question_attempts
      WHERE ${runClause}correct = 0
      GROUP BY COALESCE(NULLIF(confidence, ''), 'not selected')
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
      WHERE ${runJoinClause}1 = 1
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
        ROUND(AVG(q.time_sec), 0) AS avg_time_sec
      FROM question_attempts q
      INNER JOIN sessions s ON s.id = q.session_id
      WHERE ${runJoinClause}1 = 1
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
        COUNT(*) AS incorrect_count,
        ROUND(AVG(q.time_sec), 0) AS avg_time_sec
      FROM question_attempts q
      INNER JOIN sessions s ON s.id = q.session_id
      WHERE ${runJoinClause}q.correct = 0
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
        ROUND(
          CASE
            WHEN COUNT(q.id) > 0
              THEN
                100.0
                * SUM(CASE WHEN q.correct = 1 THEN 1 ELSE 0 END)
                / COUNT(q.id)
            WHEN (COALESCE(s.correct_count, 0) + COALESCE(s.error_count, 0)) > 0
              THEN
                100.0
                * COALESCE(s.correct_count, 0)
                / (COALESCE(s.correct_count, 0) + COALESCE(s.error_count, 0))
            ELSE s.accuracy_pct
          END,
          1
        ) AS accuracy_pct,
        s.avg_time_sec,
        s.avg_correct_time_sec,
        s.avg_incorrect_time_sec
      FROM sessions s
      LEFT JOIN question_attempts q ON q.session_id = s.id
      WHERE s.id = ?
      GROUP BY s.id
      LIMIT 1
    `,
    [id]
  );

  if (!session) return null;
  const topicExpr = `
    CASE
      WHEN COALESCE(NULLIF(q.topic, ''), '') <> '' THEN q.topic
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'MSR' THEN 'Multi-Source Reasoning'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'TA' THEN 'Table Analysis'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'GI' THEN 'Graphics Interpretation'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'TPA' THEN 'Two-Part Analysis'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub_raw, ''), '')) = 'DS' THEN 'Data Sufficiency'
      WHEN UPPER(COALESCE(NULLIF(q.subject_sub, ''), '')) = 'DS' THEN 'Data Sufficiency'
      ELSE 'Unknown'
    END
  `;

  const byDifficulty = await all(
    `
      SELECT
        COALESCE(NULLIF(q.difficulty, ''), 'Unknown') AS difficulty,
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
      WHERE q.session_id = ?
      GROUP BY COALESCE(NULLIF(q.difficulty, ''), 'Unknown')
      ORDER BY
        CASE COALESCE(NULLIF(q.difficulty, ''), 'Unknown')
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
      WHERE q.session_id = ? AND q.correct = 0
      GROUP BY ${topicExpr}
      ORDER BY mistakes DESC, topic ASC
    `,
    [id]
  );

  const confidencePerformance = await all(
    `
      SELECT
        COALESCE(NULLIF(confidence, ''), 'not selected') AS confidence,
        COUNT(*) AS total,
        SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END) AS wrong,
        ROUND(
          100.0 * SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) / COUNT(*),
          1
        ) AS accuracy_pct
      FROM question_attempts
      WHERE session_id = ?
      GROUP BY COALESCE(NULLIF(confidence, ''), 'not selected')
      ORDER BY total DESC, confidence ASC
    `,
    [id]
  );

  const slowWrongQuestions = await all(
    `
      SELECT
        id,
        q_code,
        difficulty,
        ${topicExpr} AS topic,
        my_answer,
        correct_answer,
        time_sec,
        question_url,
        mistake_type,
        notes
      FROM question_attempts q
      WHERE q.session_id = ? AND q.correct = 0
      ORDER BY COALESCE(q.time_sec, 0) DESC, q.id DESC
    `,
    [id]
  );

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

  await run(
    `
      UPDATE question_attempts
      SET
        mistake_type = ?,
        notes = ?
      WHERE id = ?
    `,
    [nextMistakeType || null, nextNotes || null, id]
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

module.exports = {
  dbPath,
  initDb,
  saveScrapeResult,
  listRuns,
  listSessions,
  countSessions,
  listErrors,
  countErrors,
  getPatterns,
  getSessionAnalysis,
  getLatestRunForSource,
  updateErrorAnnotation,
};
