/* global require */
const test = require('node:test');
const assert = require('node:assert');
const { classifySetItems, pickBestGradeableRow, parseSetObject } = require('../../src/ai-practice-sets');

const GRADEABLE = '[{"label":"A","text":"1"},{"label":"B","text":"2"},{"label":"C","text":"3"}]';
const BLANK = '[{"label":"A","text":""},{"label":"B","text":"2"},{"label":"C","text":"3"}]';

test('classifySetItems: strings are q_codes, positive ints are ids, order preserved', () => {
  const { ids, qCodes, order } = classifySetItems([7306, '300119', 'ttp-q-1', '  ', 0, -5, 3.5, '']);
  assert.deepEqual(ids, [7306]);
  assert.deepEqual(qCodes, ['300119', 'ttp-q-1']);
  assert.deepEqual(order, [
    { type: 'id', key: 7306 },
    { type: 'qcode', key: '300119' },
    { type: 'qcode', key: 'ttp-q-1' },
  ]); // blank/zero/negative/float dropped
});

test('classifySetItems: numeric-looking string still treated as a q_code (StartTest ids are numeric strings)', () => {
  const { ids, qCodes } = classifySetItems(['700294']);
  assert.deepEqual(ids, []);
  assert.deepEqual(qCodes, ['700294']);
});

test('classifySetItems: non-array input yields empty buckets', () => {
  assert.deepEqual(classifySetItems(null), { ids: [], qCodes: [], order: [] });
});

test('pickBestGradeableRow: prefers a rendered-math stem (question_stem_html)', () => {
  const rows = [
    { id: 1, answer_choices: GRADEABLE, correct_answer: 'B', question_stem: 'a very long plain-text stem '.repeat(5), question_stem_html: null },
    { id: 2, answer_choices: GRADEABLE, correct_answer: 'B', question_stem: 'short', question_stem_html: '<p>x</p>' },
  ];
  assert.equal(pickBestGradeableRow(rows).id, 2);
});

test('pickBestGradeableRow: with no html, picks the longest (most-enriched) stem', () => {
  const rows = [
    { id: 1, answer_choices: GRADEABLE, correct_answer: 'B', question_stem: 'short', question_stem_html: null },
    { id: 2, answer_choices: GRADEABLE, correct_answer: 'B', question_stem: 'this stem is clearly longer', question_stem_html: null },
  ];
  assert.equal(pickBestGradeableRow(rows).id, 2);
});

test('pickBestGradeableRow: skips non-gradeable rows (blank choice, or key not among labels)', () => {
  const rows = [
    { id: 1, answer_choices: BLANK, correct_answer: 'B', question_stem: 'x', question_stem_html: null },
    { id: 2, answer_choices: GRADEABLE, correct_answer: 'Z', question_stem: 'x', question_stem_html: null },
  ];
  assert.equal(pickBestGradeableRow(rows), null);
});

test('pickBestGradeableRow: empty/nullish returns null', () => {
  assert.equal(pickBestGradeableRow([]), null);
  assert.equal(pickBestGradeableRow(null), null);
});

test('parseSetObject keeps q_codes as strings (incl. numeric-looking) and legacy ids as numbers', () => {
  const r = parseSetObject({ slug: 'x', items: ['300263', 'ope-Q187_1', 'ttp-q-5', 12345, 0, '', 3.5, '  '] });
  assert.ok(r.ok);
  // numeric-string q_code stays a STRING (must route by q_code, not row id);
  // prefixed q_codes preserved; positive int kept; junk dropped.
  assert.deepEqual(r.set.items, ['300263', 'ope-Q187_1', 'ttp-q-5', 12345]);
});
