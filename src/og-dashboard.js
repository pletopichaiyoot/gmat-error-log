// Bridges GMAT OG book practice (og_sessions / og_attempts + the cached question
// pool) into the main dashboard's row shapes, so OG shows up in Performance by
// Session, the Error Log, and the Session Analysis modal as its own source.
// db.js stays pure SQL; the JSON join and the shape mapping live here, exactly
// as src/lsat-dashboard.js does for the LSAT track.
//
// Subjects are RC and CR — the same two the LSAT bridge emits, and distinct from
// GMAT's Q/V/DI, which is what lets the merged endpoints route a subject filter
// to the right readers.

const {
  listOgSessions,
  listOgAttempts,
  getOgSession,
  updateOgAttemptAnnotation,
} = require('./db');
const { ogPool } = require('./og-data');

// "GMAT OG Book" and nothing shorter: three StartTest presets are already named
// "OG Verbal Review" / "OG Quant Review" / "OG 2024-2025 Main", and the
// frontend's getSourcePlatform classifies by substring.
function ogSourceLabel(bookCode) {
  return `GMAT OG Book · ${bookCode || 'OG'}`;
}

function subjectForKind(kind) {
  return String(kind || '').toUpperCase() === 'RC' ? 'RC' : 'CR';
}
function topicForQuestion(question, kind) {
  if (question && question.typeLabel) return question.typeLabel;
  return subjectForKind(kind) === 'RC' ? 'Reading Comprehension' : 'Critical Reasoning';
}

// A session can mix books (the builder filters across editions), so the session
// row's source names the track and the per-question rows name the book.
function sessionSourceLabel(atts) {
  const books = [...new Set(atts.map((a) => a.book_code).filter(Boolean))];
  return books.length === 1 ? ogSourceLabel(books[0]) : 'GMAT OG Book · Mixed';
}

function attemptStats(atts) {
  const answered = atts.length;
  const correct = atts.filter((a) => a.is_correct).length;
  const avg = (pred) => {
    let t = 0;
    let n = 0;
    for (const a of atts) {
      if (a.time_ms == null) continue;
      if (pred(a)) { t += a.time_ms; n += 1; }
    }
    return n ? Math.round(t / n / 1000) : null;
  };
  return {
    answered,
    correct,
    wrong: answered - correct,
    accuracy_pct: answered ? Number(((correct * 100) / answered).toFixed(1)) : null,
    avg_time_sec: avg(() => true),
    avg_correct_time_sec: avg((a) => a.is_correct),
    avg_incorrect_time_sec: avg((a) => !a.is_correct),
  };
}

function buildSessionRow(s, atts) {
  const st = attemptStats(atts);
  const kinds = [...new Set(atts.map((a) => subjectForKind(a.kind)))];
  return {
    id: `og-${s.id}`,
    run_id: 'og',
    session_external_id: `og-${s.id}`,
    session_date: s.started_at,
    created_at: s.started_at,
    source: sessionSourceLabel(atts),
    subject: kinds.length === 1 ? kinds[0] : 'Mixed',
    subject_code: null,
    total_q_api: st.answered,
    total_q_categories: st.answered,
    correct_count: st.correct,
    error_count: st.wrong,
    total_score: null, total_percentile: null,
    quant_score: null, quant_percentile: null,
    verbal_score: null, verbal_percentile: null,
    di_score: null, di_percentile: null,
    attempt_total: st.answered,
    attempt_correct: st.correct,
    attempt_wrong: st.wrong,
    accuracy_pct: st.accuracy_pct,
    avg_time_sec: st.avg_time_sec,
    avg_correct_time_sec: st.avg_correct_time_sec,
    avg_incorrect_time_sec: st.avg_incorrect_time_sec,
    hard_total: null, hard_accuracy_pct: null, hard_avg_time_sec: null,
    medium_total: null, medium_accuracy_pct: null, medium_avg_time_sec: null,
    easy_total: null, easy_accuracy_pct: null, easy_avg_time_sec: null,
  };
}

// `tallies` carries the lifetime attempt count per question id, matching the
// attempt_count / attempt_accuracy_pct the GMAT reader computes in SQL; without
// it a row reports only itself.
function buildOgQuestionRow(s, a, question, tallies) {
  const q = question || {};
  const tally = (tallies && tallies.get(a.question_id)) || { n: 1, ok: a.is_correct ? 1 : 0 };
  const sessionDbId = s ? s.id : a.session_id;
  return {
    id: `og-${a.id}`,
    run_id: 'og',
    session_id: sessionDbId != null ? `og-${sessionDbId}` : null,
    session_external_id: sessionDbId != null ? `og-${sessionDbId}` : null,
    session_date: s ? s.started_at : a.attempted_at,
    source: ogSourceLabel(a.book_code || q.bookCode),
    subject: subjectForKind(a.kind),
    subject_code: null,
    category_code: subjectForKind(a.kind),
    subcategory: null,
    q_code: `og-${a.question_id}`,
    q_id: `og-att-${a.id}`,
    cat_id: null,
    question_url: null,
    question_stem: q.stem || '',
    question_stem_html: q.stemHtml || null,
    passage_text: q.passage ? q.passage.text : null,
    passage_lines: q.passage && Array.isArray(q.passage.lines) ? q.passage.lines : null,
    answer_choices: JSON.stringify(q.choices || []),
    response_format: 'mcq',
    // The book's own answer explanation, where the extraction recovered one.
    response_details: q.explanation ? JSON.stringify(q.explanation) : null,
    difficulty: q.difficulty || null,
    difficulty_theta: null,
    confidence: a.confidence || null,
    topic: topicForQuestion(q, a.kind),
    topic_source: 'og-book',
    content_domain: null,
    time_sec: a.time_ms != null ? Math.round(a.time_ms / 1000) : null,
    my_answer: a.user_answer || null,
    correct_answer: a.correct_answer || q.correct || null,
    correct: a.is_correct ? 1 : 0,
    corrected_later: 0,
    mistake_type: a.mistake_type || null,
    notes: a.notes || null,
    question_number: a.question_number ?? q.number ?? null,
    attempt_count: tally.n,
    attempt_accuracy_pct: Math.round((100 * tally.ok) / tally.n),
  };
}

async function loadAll() {
  const [sessions, attempts] = await Promise.all([listOgSessions(), listOgAttempts({})]);
  const bySession = new Map();
  const tallies = new Map();
  for (const a of attempts) {
    if (!tallies.has(a.question_id)) tallies.set(a.question_id, { n: 0, ok: 0 });
    const tally = tallies.get(a.question_id);
    tally.n += 1;
    if (a.is_correct) tally.ok += 1;
    if (a.session_id == null) continue;
    if (!bySession.has(a.session_id)) bySession.set(a.session_id, []);
    bySession.get(a.session_id).push(a);
  }
  return { sessions, bySession, tallies };
}

function subjectMatches(subject, kind) {
  if (!subject) return true;
  return subjectForKind(kind) === String(subject).toUpperCase();
}
function dateInRange(iso, startDate, endDate) {
  if (!iso) return true;
  const day = String(iso).slice(0, 10);
  if (startDate && day < startDate) return false;
  if (endDate && day > endDate) return false;
  return true;
}

// Session rows for the Performance by Session table, honoring subject/date filters.
async function listOgDashboardSessions({ subject, startDate, endDate } = {}) {
  const { sessions, bySession } = await loadAll();
  const out = [];
  for (const s of sessions) {
    const atts = bySession.get(s.id) || [];
    if (atts.length === 0) continue; // nothing answered -> nothing to review
    if (subject && !atts.some((a) => subjectMatches(subject, a.kind))) continue;
    if (!dateInRange(s.started_at, startDate, endDate)) continue;
    out.push(buildSessionRow(s, atts));
  }
  return out;
}

// Error rows (incorrect answers only) for the Error Log + review modal.
async function listOgDashboardErrors({ subject, search } = {}) {
  const { sessions, bySession, tallies } = await loadAll();
  const pool = ogPool();
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const out = [];
  for (const [sessionId, atts] of bySession.entries()) {
    const s = sessionById.get(sessionId);
    for (const a of atts) {
      if (a.is_correct) continue;
      if (!subjectMatches(subject, a.kind)) continue;
      const row = buildOgQuestionRow(s, a, pool.byId.get(a.question_id), tallies);
      if (search) {
        const hay = `${row.question_stem} ${row.topic} ${row.q_code}`.toLowerCase();
        if (!hay.includes(String(search).toLowerCase())) continue;
      }
      out.push(row);
    }
  }
  return out;
}

// Session Analysis object for one OG session id ("og-<n>" or numeric).
async function getOgDashboardAnalysis(ogId) {
  const numericId = Number(String(ogId).replace(/^og-/, ''));
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const s = await getOgSession(numericId);
  if (!s) return null;
  const atts = await listOgAttempts({ sessionId: numericId });
  const pool = ogPool();
  const st = attemptStats(atts);

  // All answered questions, wrong-first (same ordering intent as the GMAT analysis).
  const questions = atts
    .map((a) => buildOgQuestionRow(s, a, pool.byId.get(a.question_id)))
    .sort((x, y) => (x.correct - y.correct) || ((y.time_sec || 0) - (x.time_sec || 0)));

  // The OG books print no difficulty, so these bands come from the LLM pass and
  // are a rough RELATIVE ranking (tertiles of an estimated percent-correct), not
  // a calibrated measure. See CLAUDE.md.
  const diffMap = new Map();
  for (const row of questions) {
    const key = row.difficulty || 'Unknown';
    if (!diffMap.has(key)) diffMap.set(key, { difficulty: key, total: 0, wrong: 0, correctN: 0 });
    const e = diffMap.get(key);
    e.total += 1;
    if (row.correct) e.correctN += 1; else e.wrong += 1;
  }

  // Unlike LSAT (one topic per section), an OG set mixes official question types,
  // so the wrong-topic rollup is meaningful here.
  const topicMap = new Map();
  for (const row of questions) {
    if (row.correct) continue;
    topicMap.set(row.topic, (topicMap.get(row.topic) || 0) + 1);
  }

  const confMap = new Map();
  for (const a of atts) {
    const key = a.confidence || 'not selected';
    if (!confMap.has(key)) confMap.set(key, { confidence: key, total: 0, wrong: 0, correctN: 0 });
    const e = confMap.get(key);
    e.total += 1;
    if (a.is_correct) e.correctN += 1; else e.wrong += 1;
  }

  const pct = (e) => (e.total ? Number(((e.correctN * 100) / e.total).toFixed(1)) : null);

  return {
    session: { ...buildSessionRow(s, atts), accuracy_pct: st.accuracy_pct },
    byDifficulty: [...diffMap.values()].map((e) => ({ difficulty: e.difficulty, total: e.total, wrong: e.wrong, accuracy_pct: pct(e) })),
    topWrongTopics: [...topicMap.entries()].map(([topic, wrong]) => ({ topic, wrong })).sort((a, b) => b.wrong - a.wrong),
    confidencePerformance: [...confMap.values()].map((e) => ({ confidence: e.confidence, total: e.total, wrong: e.wrong, accuracy_pct: pct(e) })).sort((a, b) => b.total - a.total),
    slowWrongQuestions: questions,
  };
}

function isOgDashboardId(id) {
  return typeof id === 'string' && id.startsWith('og-');
}

// Save a mistake-tag / notes annotation for an OG error row. The dashboard sends
// the namespaced "og-<attemptId>" id; strip the prefix, delegate the write to
// db.js, and return the namespaced id so the frontend's applyAnnotationLocally
// matches it against annotation.row.id.
async function updateOgDashboardAnnotation(ogId, { mistakeType, notes }) {
  const numericId = Number(String(ogId).replace(/^og-/, ''));
  if (!Number.isInteger(numericId) || numericId <= 0) throw new Error('Invalid error id.');
  const updated = await updateOgAttemptAnnotation(numericId, { mistakeType, notes });
  if (!updated) return null;
  return { id: `og-${updated.id}`, mistake_type: updated.mistake_type, notes: updated.notes };
}

module.exports = {
  listOgDashboardSessions,
  listOgDashboardErrors,
  getOgDashboardAnalysis,
  isOgDashboardId,
  updateOgDashboardAnnotation,
  ogSourceLabel,
  buildOgQuestionRow,
};
