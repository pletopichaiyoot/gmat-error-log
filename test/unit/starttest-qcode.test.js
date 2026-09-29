/* global require */
// StartTest names one question two ways — FormQuestionID from a flaky item-list
// request, the ITD item Key from every review frame — and Phase 2 used to write
// whichever a walk got, so a question's q_code swung between them (37897 ↔
// 428442) and AI practice set items dropped out. FormQuestionID is canonical.
const test = require('node:test');
const assert = require('node:assert');
const { pickStartTestQCode } = require('../../src/db');

test('FormQuestionID always wins, and replaces a Key placeholder', () => {
  assert.strictEqual(pickStartTestQCode(37897, '428442', '428442'), '37897');
  assert.strictEqual(pickStartTestQCode('37897', '428442', '37897'), '37897');
});

test('a walk without FormQuestionID keeps the stored code — no swing', () => {
  assert.strictEqual(pickStartTestQCode(null, '428442', '37897'), null); // null = keep (COALESCE)
  assert.strictEqual(pickStartTestQCode(undefined, '428442', '428442'), null);
});

test('the Key is only a placeholder for a row with no code yet', () => {
  assert.strictEqual(pickStartTestQCode(null, '428442', null), '428442');
  assert.strictEqual(pickStartTestQCode(null, null, null), null);
  assert.strictEqual(pickStartTestQCode('  ', '428442', null), '428442');
});
