// test/unit/og-verify.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { verifyPool } = require('../../scripts/og/verify');

const choices = 'ABCDE'.split('').map(l => ({ label: l, text: `option ${l}` }));
const q = (over = {}) => ({
  id: 'OG12-CR-1', number: 1, stem: 'A complete stem.', choices,
  correct: 'B', typeLabel: 'Argument Construction', keyDisputed: false,
  usable: true, ...over,
});

const good = () => ({ books: [{ code: 'OG12', sections: [
  { kind: 'CR', questions: [q()] },
  { kind: 'RC', passages: [{ id: 'OG12-RC-p358', text: 'A passage.' }],
    questions: [q({ id: 'OG12-RC-1', passageId: 'OG12-RC-p358' })] },
] }] });

const failed = r => r.checks.filter(c => !c.ok).map(c => c.name);

test('a clean pool passes every check', () => {
  const r = verifyPool(good());
  assert.equal(r.ok, true, failed(r).join(', '));
});

test('an unkeyed usable question fails', () => {
  const p = good();
  p.books[0].sections[0].questions[0].correct = null;
  assert.ok(failed(verifyPool(p)).includes('every usable question is keyed'));
});

test('a disputed key fails even when a letter is present', () => {
  const p = good();
  p.books[0].sections[0].questions[0].keyDisputed = true;
  assert.ok(failed(verifyPool(p)).includes('no usable question has a disputed key'));
});

test('an RC question with no passage fails', () => {
  const p = good();
  p.books[0].sections[1].questions[0].passageId = null;
  assert.ok(failed(verifyPool(p)).includes('every usable RC question has a passage'));
});

test('an RC question pointing at a missing passage fails', () => {
  const p = good();
  p.books[0].sections[1].passages = [];
  assert.ok(failed(verifyPool(p)).includes('every referenced passage exists'));
});

test('watermark or footer junk left in a stem fails', () => {
  const p = good();
  p.books[0].sections[0].questions[0].stem = 'A stem. QQ:1014347461制作';
  assert.ok(failed(verifyPool(p)).includes('no watermark or footer junk'));
});

test('a usable question without five choices fails', () => {
  const p = good();
  p.books[0].sections[0].questions[0].choices = choices.slice(0, 4);
  assert.ok(failed(verifyPool(p)).includes('every usable question has five choices'));
});

test('a duplicate question id fails', () => {
  const p = good();
  p.books[0].sections[0].questions.push(q());
  assert.ok(failed(verifyPool(p)).includes('question ids are unique'));
});

test('unusable questions are excluded from the checks, not counted against them', () => {
  const p = good();
  p.books[0].sections[0].questions.push(
    q({ id: 'OG12-CR-2', number: 2, correct: null, usable: false, unusable: 'no-key' }));
  assert.equal(verifyPool(p).ok, true);
});
