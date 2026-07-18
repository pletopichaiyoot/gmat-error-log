/* global require */
const test = require('node:test');
const assert = require('node:assert');
const { buildAiCuratedSessionData, hash53 } = require('../../src/db');

const served = {
  itemId: 1287, qCode: 'gc-q-42', source: 'GMAT Club Error Log', subjectCode: 'Q',
  categoryCode: 'PS', subcategory: 'ARI', topic: 'Arithmetic', difficulty: 'Hard',
  questionUrl: 'https://x', questionStem: 'stem', questionStemHtml: null,
  answerChoices: '[{"label":"A","text":"1"},{"label":"B","text":"2"}]',
  responseFormat: 'single-choice', correctAnswer: 'B',
  priorAttempt: { correct: 0, myAnswer: 'A', sessionDate: '2026-07-01', source: 'GMAT Club Error Log' },
};

test('buildAiCuratedSessionData produces a saveScrapeResult-shaped object', () => {
  const data = buildAiCuratedSessionData({
    slug: 'redo-01', title: 'Redo', subject: 'Quant', nowIso: '2026-07-18T00:00:00Z',
    sessionExternalId: 999,
    gradedItems: [{ served, myAnswer: 'B', correct: 1, timeSec: 45, confidence: 'high' }],
  });
  const s = data.sessions[0];
  assert.equal(s.source, 'AI Curated Practice');
  assert.equal(s.session_id, 999);
  assert.equal(s.subject, 'Quant');
  assert.equal(s.stats.total_q_api, 1);
  assert.equal(s.stats.correct, 1);
  assert.equal(s.stats.errors, 0);
  const q = s.questions[0];
  assert.equal(q.q_code, 'gc-q-42');           // original q_code preserved (linkage)
  assert.equal(q.q_id, 'aic-att-redo-01-1');   // distinct attempt id
  assert.equal(q.topic_source, 'ai-curated');
  assert.equal(q.correct, 1);
  assert.equal(q.my_answer, 'B');
  assert.equal(q.correct_answer, 'B');
  assert.equal(q.difficulty_theta, undefined); // never set theta
});

test('hash53 is deterministic and within 2^53', () => {
  const a = hash53('ai-redo-01-123');
  assert.equal(a, hash53('ai-redo-01-123'));
  assert.ok(a >= 0 && a <= Number.MAX_SAFE_INTEGER);
});
