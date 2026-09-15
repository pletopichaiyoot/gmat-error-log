'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { ogSourceLabel, buildOgQuestionRow } = require('../../src/og-dashboard.js');

// The dashboard classifies a row's platform by matching substrings of its source
// label (getSourcePlatform, client/src/App.jsx). Three StartTest presets are
// already called "OG ..." — "OG Verbal Review", "OG Quant Review", "OG 2024-2025
// Main" — so a bare "OG" in this label would put book practice on the StartTest
// chip. The "GMAT OG Book" prefix is what keeps them apart.
test('the source label carries the prefix the platform check keys on', () => {
  assert.strictEqual(ogSourceLabel('OG13'), 'GMAT OG Book · OG13');
  assert.match(ogSourceLabel('VR2'), /^GMAT OG Book/);
  assert.doesNotMatch(ogSourceLabel('OG12'), /Verbal Review|Quant Review/);
});

test('an error row maps to the dashboard question shape', () => {
  const question = {
    id: 'OG12-CR-7', number: 7, bookCode: 'OG12', kind: 'CR',
    stem: 'the stem', choices: [{ label: 'A', text: 'a' }], correct: 'B',
    typeLabel: 'Argument Construction', difficulty: 'Hard', passage: null,
  };
  const attempt = {
    id: 42, question_id: 'OG12-CR-7', book_code: 'OG12', kind: 'CR',
    user_answer: 'C', correct_answer: 'B', is_correct: 0, time_ms: 96000,
    confidence: 'low', session_id: 5, attempted_at: '2026-09-15T04:00:00Z',
    mistake_type: null, notes: null,
  };
  const row = buildOgQuestionRow({ id: 5, started_at: '2026-09-15T03:00:00Z' }, attempt, question, new Map());

  assert.strictEqual(row.id, 'og-42');
  assert.strictEqual(row.session_id, 'og-5');
  assert.strictEqual(row.subject, 'CR');
  assert.strictEqual(row.category_code, 'CR');
  assert.strictEqual(row.q_code, 'og-OG12-CR-7');
  assert.strictEqual(row.q_id, 'og-att-42');
  assert.strictEqual(row.my_answer, 'C');
  assert.strictEqual(row.correct_answer, 'B');
  assert.strictEqual(row.correct, 0);
  assert.strictEqual(row.time_sec, 96);
  assert.strictEqual(row.topic, 'Argument Construction');
  assert.strictEqual(row.difficulty, 'Hard');
  assert.strictEqual(row.answer_choices, JSON.stringify(question.choices));
});

// 100 of the pool's questions carry no type label. The error log still has to
// say what kind of question it was, so the subject name stands in.
test('a question with no type label falls back to its subject name', () => {
  const question = { id: 'OG12-RC-3', number: 3, bookCode: 'OG12', kind: 'RC', stem: 's', choices: [], correct: 'A', typeLabel: null, passage: { text: 'p', lines: [{ n: 1 }] } };
  const attempt = { id: 1, question_id: 'OG12-RC-3', kind: 'RC', user_answer: 'A', correct_answer: 'A', is_correct: 1, attempted_at: 'x' };
  const row = buildOgQuestionRow(null, attempt, question, new Map());
  assert.strictEqual(row.topic, 'Reading Comprehension');
  assert.strictEqual(row.passage_text, 'p');
  assert.deepStrictEqual(row.passage_lines, [{ n: 1 }]);
});
