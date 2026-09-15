// test/unit/og-passages.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { linkQuestionsToPassages, passageIdFor } = require('../../scripts/og/passage-link');

const section = () => ({
  kind: 'RC',
  passageRefs: [
    { firstQuestion: 1, lastQuestion: 3, page: 358 },
    { firstQuestion: 4, lastQuestion: 8, page: 360 },
  ],
  questions: [1, 2, 3, 4, 8, 9].map(n => ({ id: `OG13-RC-${n}`, number: n })),
});

test('passageIdFor names a passage by its book, subject and printed page', () => {
  assert.equal(passageIdFor('OG13', 358), 'OG13-RC-p358');
});

test('every question in a printed range gets that passage id', () => {
  const s = linkQuestionsToPassages(section(), 'OG13');
  const byNum = n => s.questions.find(q => q.number === n).passageId;
  assert.equal(byNum(1), 'OG13-RC-p358');
  assert.equal(byNum(3), 'OG13-RC-p358');
  assert.equal(byNum(4), 'OG13-RC-p360');
  assert.equal(byNum(8), 'OG13-RC-p360');
});

test('a question outside every range is left unlinked and reported', () => {
  const s = linkQuestionsToPassages(section(), 'OG13');
  assert.equal(s.questions.find(q => q.number === 9).passageId, null);
  assert.deepEqual(s.unlinked, ['OG13-RC-9']);
});

test('overlapping ranges are refused rather than silently resolved', () => {
  const bad = section();
  bad.passageRefs.push({ firstQuestion: 3, lastQuestion: 5, page: 362 });
  assert.throws(() => linkQuestionsToPassages(bad, 'OG13'), /overlap/i);
});

test('a reference with no page number cannot name a passage', () => {
  const s = linkQuestionsToPassages({
    kind: 'RC',
    passageRefs: [{ firstQuestion: 1, lastQuestion: 2, page: null }],
    questions: [{ id: 'OG13-RC-1', number: 1 }],
  }, 'OG13');
  assert.equal(s.questions[0].passageId, null);
  assert.deepEqual(s.unlinked, ['OG13-RC-1']);
});

test('linking a CR section is a no-op', () => {
  const s = linkQuestionsToPassages({
    kind: 'CR', passageRefs: [], questions: [{ id: 'OG13-CR-1', number: 1 }],
  }, 'OG13');
  assert.equal(s.questions[0].passageId, undefined);
  assert.deepEqual(s.unlinked, []);
});
