/* global require */
const test = require('node:test');
const assert = require('node:assert');
const { deriveQuestionMetadata } = require('../../src/question-metadata');

// GMAT Club Error Log rows: the scraper codes the category chip into
// subject_sub_raw and leaves category_code null, so this is the shape that
// reaches deriveQuestionMetadata.
const gcRow = (topic, raw, stem = '') => ({
  topic, subcategory: topic, subject_sub_raw: raw, category_code: null, cat_id: 0, question_stem: stem,
});
const got = (row, session = {}) => {
  const m = deriveQuestionMetadata(row, session);
  return `${m.subject_code}/${m.category_code}`;
};

const DS_STEM = 'Is x a negative number? (1) 9x > 10x (2) x + 3 is positive';
const PS_STEM = 'The number 75 can be written as the sum of the squares of 3 different integers';

test('every DI format keeps its subject', () => {
  assert.strictEqual(got(gcRow('Two-Part Analysis', 'TPA')), 'DI/TPA');
  assert.strictEqual(got(gcRow('Multi-Source Reasoning', 'MSR')), 'DI/MSR');
  assert.strictEqual(got(gcRow('Graphs,Math Related', 'GI')), 'DI/GI');
  assert.strictEqual(got(gcRow('Tables,Non-Math Related', 'TA')), 'DI/TA');
});

test('Quant and Verbal are unchanged', () => {
  assert.strictEqual(got(gcRow('Number Properties', 'PS', PS_STEM)), 'Q/PS');
  assert.strictEqual(got(gcRow('Word Problems', 'PS', PS_STEM)), 'Q/PS');
  assert.strictEqual(got(gcRow('Strengthen', 'CR')), 'V/CR');
  assert.strictEqual(got(gcRow('Science,Short Passage', 'RC')), 'V/RC');
});

// The bug: the Error Log chip says "Word Problems" for a DS question exactly as
// it does for a PS one, so DS was landing in Quant. Under GMAT Focus it is DI.
test('a DS stem moves the row to Data Insights whatever the quant topic says', () => {
  for (const topic of ['Word Problems', 'Number Properties', 'Algebra', 'Inequalities',
    'Absolute Values', 'Overlapping Sets', 'Sequences', 'Statistics and Sets Problems']) {
    assert.strictEqual(got(gcRow(topic, 'PS', DS_STEM)), 'DI/DS', `topic=${topic}`);
  }
});

test('a session subject cannot drag a question into the wrong section', () => {
  // GMAT Club sessions are one-per-day and mix all three sections.
  assert.strictEqual(got(gcRow('Number Properties', 'PS', PS_STEM), { subject: 'DI' }), 'Q/PS');
  assert.strictEqual(got(gcRow('Graphs', 'GI'), { subject: 'Quant' }), 'DI/GI');
});

// An authoritative category_code (StartTest, GMAT Club CAT) names the format
// outright, so the stem heuristic must never second-guess it.
test('an explicit category_code wins over the stem heuristic', () => {
  const st = { topic: 'Applied Word Problems', subject_sub_raw: 'PS', category_code: 'PS', cat_id: null, question_stem: DS_STEM };
  assert.strictEqual(got(st), 'Q/PS');
  const cat = { topic: 'Two-Part Analysis', subject_sub_raw: null, category_code: 'TPA', cat_id: null, question_stem: '' };
  assert.strictEqual(got(cat), 'DI/TPA');
});

test('a stem truncated before the statements stays put rather than guessing', () => {
  assert.strictEqual(got(gcRow('Number Properties', 'PS', 'Set S contains five different positive integers a, b, c, d, and e. Is')), 'Q/PS');
});
