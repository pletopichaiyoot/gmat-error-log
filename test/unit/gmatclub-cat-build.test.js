// test/unit/gmatclub-cat-build.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSession } = require('../../src/scrapers/gmat_club_cat_scraper')._internals;
const { deriveQuestionMetadata } = require('../../src/question-metadata');

const gridRows = [
  { num: 1, qcode: 'I02-10', instanceId: '43972530', viewUrl: 'https://gmatclub.com/gmat-focus-tests/view-43972530.html',
    typeText: 'Data Insights / TPA / Two-Part Analysis', correct: false, difficulty: 'Hard', timeRaw: '2:15', dateRaw: 'Jun 21, 2026 12:05 AM' },
  { num: 2, qcode: 'M40-66', instanceId: '43972631', viewUrl: 'https://gmatclub.com/gmat-focus-tests/view-43972631.html',
    typeText: 'Quant / PS / Algebra', correct: true, difficulty: 'Medium', timeRaw: '1:00', dateRaw: 'Jun 21, 2026 12:10 AM' },
];
const scoreSummary = { total: { score: 565, percentile: 51 }, quant: { score: 81, percentile: 70 },
  verbal: { score: 79, percentile: 47 }, di: { score: 74, percentile: 41 } };

test('buildSession builds a Mixed session with scoreSummary + questions', () => {
  const s = buildSession({ testId: '2347043', source: 'GMAT Club CAT', scoreSummary, gridRows });
  assert.equal(s.session_id, 2347043);
  assert.equal(s.source, 'GMAT Club CAT');
  assert.equal(s.subject, 'Mixed');
  assert.equal(s.date, '2026-06-21');
  assert.deepEqual(s.scoreSummary, scoreSummary);
  assert.equal(s.stats.total_q_api, 2);
  assert.equal(s.stats.correct, 1);
  assert.equal(s.stats.errors, 1);
  assert.equal(s.questions.length, 2);
  const q1 = s.questions[0];
  assert.equal(q1.q_id, 'gcc-att-43972530');
  assert.equal(q1.q_code, 'gcc-q-I02-10');
  assert.equal(q1.correct, false);
  assert.equal(q1.difficulty, 'Hard');
  assert.equal(q1.time_sec, 135);
  assert.equal(q1.topic, 'Two-Part Analysis');
  assert.equal(q1.subject_sub_raw, 'TPA');
  assert.equal(q1.topic_source, 'gmatclub-canonical');
  assert.equal(q1.question_url, 'https://gmatclub.com/gmat-focus-tests/view-43972530.html');
  assert.equal(s.wrong_q_ids.length, 1);
  assert.equal(s.wrong_q_ids[0].q_id, 'gcc-att-43972530');
});

test('buildSession sets authoritative category_code from the grid Type code', () => {
  const s = buildSession({ testId: '1', source: 'GMAT Club CAT', scoreSummary,
    gridRows: [{ num: 1, qcode: 'M27-04', instanceId: '43973474', viewUrl: 'u',
      typeText: 'Data Insights / DS / Overlapping Sets', correct: false, difficulty: 'Medium', timeRaw: '2:00', dateRaw: 'Jun 21, 2026 12:00 AM' }] });
  assert.equal(s.questions[0].category_code, 'DS');
  assert.equal(s.questions[0].subject_code, 'DI');
});

test('DS question with a Quant-named topic classifies as DI/DS, not Q/PS', () => {
  // Regression: "Overlapping Sets" is also a Quant PS topic. A DS row must keep
  // its authoritative DI/DS code and not get re-inferred to Q/PS from the topic.
  const s = buildSession({ testId: '1', source: 'GMAT Club CAT', scoreSummary,
    gridRows: [{ num: 1, qcode: 'M27-04', instanceId: '43973474', viewUrl: 'u',
      typeText: 'Data Insights / DS / Overlapping Sets', correct: false, difficulty: 'Medium', timeRaw: '2:00', dateRaw: 'Jun 21, 2026 12:00 AM' }] });
  const meta = deriveQuestionMetadata(s.questions[0], s);
  assert.equal(meta.category_code, 'DS');
  assert.equal(meta.subject_code, 'DI');
});
