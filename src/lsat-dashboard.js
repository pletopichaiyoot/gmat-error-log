// Bridges LSAT practice data (lsat_sessions / lsat_attempts + lsat-questions.json)
// into the main GMAT dashboard's row shapes so LSAT shows up in the Performance by
// Session table, the Error Log, and the per-question Session Analysis modal as a
// distinct "LSAT" source. db.js stays pure SQL; all JSON joins + shape-mapping live
// here and are invoked from the server route handlers.
//
// Subject mapping: LSAT Reading Comprehension -> "RC"; Logical Reasoning -> "CR"
// (GMAT's Critical Reasoning analog). Difficulty (Easy/Medium/Hard) comes from the
// gpt-5-nano classifier written into lsat-questions.json; unclassified questions
// stay null (the frontend renders them as "—").

const fs = require('fs');
const path = require('path');
const {
  listLsatSessions,
  listLsatAttempts,
  getLsatSession,
  updateLsatAttemptAnnotation,
} = require('./db');

let _dataCache = null;
function loadLsatData() {
  if (_dataCache) return _dataCache;
  const p = path.join(__dirname, '..', 'data', 'lsat-questions.json');
  try {
    _dataCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    _dataCache = { tests: [] };
  }
  return _dataCache;
}

// Resolve the passage text for one question within a section. RC sections carry a
// `passages` array of { firstQuestion, text } — a question belongs to the passage
// with the largest firstQuestion <= its number. LR sections have an empty passages
// array (the stimulus lives inline in the stem), so this returns null for them.
function passageForQuestion(section, questionNumber) {
  const passages = (Array.isArray(section.passages) ? section.passages : [])
    .filter((p) => p && typeof p.text === 'string' && p.text.trim());
  if (passages.length) {
    const sorted = passages.slice().sort((a, b) => (a.firstQuestion || 0) - (b.firstQuestion || 0));
    let match = null;
    for (const p of sorted) {
      if ((p.firstQuestion || 0) <= questionNumber) match = p;
    }
    return (match || sorted[0]).text;
  }
  if (typeof section.passage === 'string' && section.passage.trim()) return section.passage;
  return null;
}

// `${testNum}|${roman}|${number}` -> { stem, choices:[{label,text}], correct, kind, passage }
let _qIndexCache = null;
function questionIndex() {
  if (_qIndexCache) return _qIndexCache;
  const data = loadLsatData();
  const idx = new Map();
  for (const t of data.tests || []) {
    for (const s of t.sections || []) {
      for (const q of s.questions || []) {
        idx.set(`${t.num}|${s.roman}|${q.number}`, {
          stem: q.stem || '',
          choices: Array.isArray(q.choices) ? q.choices : [],
          correct: q.correct || null,
          kind: s.kind,
          passage: passageForQuestion(s, q.number),
          difficulty: q.difficulty || null,
          difficulty_source: q.difficulty_source || null,
        });
      }
    }
  }
  _qIndexCache = idx;
  return idx;
}

function subjectForKind(kind) {
  return String(kind || '').toUpperCase() === 'RC' ? 'RC' : 'CR';
}
function sourceLabel(s) {
  return `LSAT PrepTest ${s.test_num} · Section ${s.section_roman}`;
}
function topicForKind(kind) {
  return String(kind || '').toUpperCase() === 'RC' ? 'Reading Comprehension' : 'Logical Reasoning';
}

function attemptStats(atts) {
  const answered = atts.length;
  const correct = atts.filter((a) => a.is_correct).length;
  const wrong = answered - correct;
  const avg = (pred) => {
    let t = 0;
    let n = 0;
    for (const a of atts) {
      if (a.time_ms == null) continue;
      if (pred(a)) {
        t += a.time_ms;
        n += 1;
      }
    }
    return n ? Math.round(t / n / 1000) : null;
  };
  return {
    answered,
    correct,
    wrong,
    accuracy_pct: answered ? Number(((correct * 100) / answered).toFixed(1)) : null,
    avg_time_sec: avg(() => true),
    avg_correct_time_sec: avg((a) => a.is_correct),
    avg_incorrect_time_sec: avg((a) => !a.is_correct),
  };
}

// A session-shaped row for the Performance by Session table.
function buildSessionRow(s, atts) {
  const st = attemptStats(atts);
  return {
    id: `lsat-${s.id}`,
    run_id: 'lsat',
    session_external_id: `lsat-${s.id}`,
    session_date: s.started_at,
    source: sourceLabel(s),
    subject: subjectForKind(s.section_kind),
    subject_code: null,
    total_q_api: st.answered,
    total_q_categories: st.answered,
    correct_count: st.correct,
    error_count: st.wrong,
    total_score: null,
    total_percentile: null,
    quant_score: null,
    quant_percentile: null,
    verbal_score: null,
    verbal_percentile: null,
    di_score: null,
    di_percentile: null,
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

// A question_attempts-shaped row for the Error Log + review modal.
function buildQuestionRow(s, a) {
  const idx = questionIndex();
  const q = idx.get(`${a.test_num}|${a.section_roman}|${a.question_number}`) || {};
  const sessionDbId = s ? s.id : a.session_id;
  return {
    id: `lsat-${a.id}`,
    run_id: 'lsat',
    session_id: `lsat-${sessionDbId}`,
    session_external_id: `lsat-${sessionDbId}`,
    session_date: s ? s.started_at : a.attempted_at,
    source: s ? sourceLabel(s) : `LSAT PrepTest ${a.test_num} · Section ${a.section_roman}`,
    subject: subjectForKind(a.section_kind),
    subject_code: null,
    category_code: subjectForKind(a.section_kind),
    subcategory: null,
    q_code: `lsat-${a.test_num}-${a.section_roman}-${a.question_number}`,
    q_id: `lsat-att-${a.id}`,
    cat_id: null,
    question_url: null,
    question_stem: q.stem || '',
    passage_text: q.passage || null,
    answer_choices: JSON.stringify(q.choices || []),
    response_format: 'mcq',
    response_details: null,
    difficulty: q.difficulty || null,
    difficulty_theta: null,
    confidence: a.confidence || null,
    topic: topicForKind(a.section_kind),
    topic_source: 'lsat',
    content_domain: null,
    time_sec: a.time_ms != null ? Math.round(a.time_ms / 1000) : null,
    my_answer: a.user_answer || null,
    correct_answer: a.correct_answer || q.correct || null,
    correct: a.is_correct ? 1 : 0,
    corrected_later: 0,
    mistake_type: a.mistake_type || null,
    notes: a.notes || null,
    question_number: a.question_number,
  };
}

async function loadAll() {
  const [sessions, attempts] = await Promise.all([listLsatSessions(), listLsatAttempts({})]);
  const bySession = new Map();
  for (const a of attempts) {
    if (a.session_id == null) continue;
    if (!bySession.has(a.session_id)) bySession.set(a.session_id, []);
    bySession.get(a.session_id).push(a);
  }
  return { sessions, bySession };
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
async function listLsatDashboardSessions({ subject, startDate, endDate } = {}) {
  const { sessions, bySession } = await loadAll();
  const out = [];
  for (const s of sessions) {
    const atts = bySession.get(s.id) || [];
    if (atts.length === 0) continue; // nothing answered -> nothing to review
    if (!subjectMatches(subject, s.section_kind)) continue;
    if (!dateInRange(s.started_at, startDate, endDate)) continue;
    out.push(buildSessionRow(s, atts));
  }
  return out;
}

// Error rows (incorrect answers only) for the Error Log + review modal.
async function listLsatDashboardErrors({ subject, search } = {}) {
  const { sessions, bySession } = await loadAll();
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const out = [];
  for (const [sessionId, atts] of bySession.entries()) {
    const s = sessionById.get(sessionId);
    for (const a of atts) {
      if (a.is_correct) continue;
      if (!subjectMatches(subject, a.section_kind)) continue;
      const row = buildQuestionRow(s, a);
      if (search) {
        const hay = `${row.question_stem} ${row.topic} ${row.q_code}`.toLowerCase();
        if (!hay.includes(String(search).toLowerCase())) continue;
      }
      out.push(row);
    }
  }
  return out;
}

// Session Analysis object for one LSAT session id ("lsat-<n>" or numeric).
async function getLsatDashboardAnalysis(lsatId) {
  const numericId = Number(String(lsatId).replace(/^lsat-/, ''));
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const s = await getLsatSession(numericId);
  if (!s) return null;
  const atts = await listLsatAttempts({ sessionId: numericId });
  const st = attemptStats(atts);

  const session = {
    ...buildSessionRow(s, atts),
    accuracy_pct: st.accuracy_pct,
  };

  // All answered questions, wrong-first (same ordering intent as the GMAT analysis).
  const questions = atts
    .map((a) => buildQuestionRow(s, a))
    .sort((x, y) => (x.correct - y.correct) || ((y.time_sec || 0) - (x.time_sec || 0)));

  // Confidence breakdown (LSAT attempts carry a confidence rating).
  const confMap = new Map();
  for (const a of atts) {
    const key = a.confidence || 'not selected';
    if (!confMap.has(key)) confMap.set(key, { confidence: key, total: 0, wrong: 0, correctN: 0 });
    const e = confMap.get(key);
    e.total += 1;
    if (a.is_correct) e.correctN += 1; else e.wrong += 1;
  }
  const confidencePerformance = [...confMap.values()]
    .map((e) => ({
      confidence: e.confidence,
      total: e.total,
      wrong: e.wrong,
      accuracy_pct: e.total ? Number(((e.correctN * 100) / e.total).toFixed(1)) : null,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    session,
    byDifficulty: [], // LSAT has no difficulty bands
    topWrongTopics: [], // single topic per section; not meaningful
    confidencePerformance,
    slowWrongQuestions: questions,
  };
}

function isLsatDashboardId(id) {
  return typeof id === 'string' && id.startsWith('lsat-');
}

// Save a mistake-tag / notes annotation for an LSAT error row. The dashboard sends
// the namespaced "lsat-<attemptId>" id (buildQuestionRow's `id`); strip the prefix,
// delegate the write to db.js, and return the row in the same shape as the GMAT path
// ({ id, mistake_type, notes }) but with the namespaced id so the frontend's
// applyAnnotationLocally matches it against annotation.row.id.
async function updateLsatDashboardAnnotation(lsatId, { mistakeType, notes }) {
  const numericId = Number(String(lsatId).replace(/^lsat-/, ''));
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error('Invalid error id.');
  }
  const updated = await updateLsatAttemptAnnotation(numericId, { mistakeType, notes });
  if (!updated) return null;
  return {
    id: `lsat-${updated.id}`,
    mistake_type: updated.mistake_type,
    notes: updated.notes,
  };
}

module.exports = {
  listLsatDashboardSessions,
  listLsatDashboardErrors,
  getLsatDashboardAnalysis,
  isLsatDashboardId,
  updateLsatDashboardAnnotation,
};
