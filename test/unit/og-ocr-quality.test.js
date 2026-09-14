// test/unit/og-ocr-quality.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { scoreText } = require('../../scripts/og/ocr-quality');

test('scoreText counts misread choice labels', () => {
  const s = scoreText([
    '(A) first choice',
    '(8) second choice',
    '(0 third choice',
    '(D) fourth choice',
  ].join('\n'));
  assert.equal(s.badChoiceB, 1);
  assert.equal(s.badChoiceC, 1);
});

test('scoreText counts corrupted answer-key numerals', () => {
  // VR2 reads 1. as I., 11. as II., 21. as 2I., 101. as lOI.
  const s = scoreText('I. C 27. B\nII. C 37. C\n2I. E 47. C\nlOI. B 102. C');
  assert.equal(s.badKeyNumerals, 4);
});

test('scoreText counts glued words and the OG13 watermark', () => {
  const s = scoreText('Theargumentisconcerned with whathappens\nQQ:1014347461制作8.6 Answer Explanations');
  assert.ok(s.glued >= 1, 'expected a glued-word line');
  assert.equal(s.watermark, 1);
});

test('scoreText flags OCR line noise like the rotated OG13 CR key', () => {
  const s = scoreText('CO CO O UJ GO O O U J O O O O C 0 < O O < O O C 0 O l U L U U J\nnormal readable sentence here');
  assert.equal(s.noise, 1);
});

test('scoreText reports zero on clean text', () => {
  const s = scoreText('(A) first choice\n(B) second choice\n1. C\n2. D');
  assert.equal(s.badChoiceB + s.badChoiceC + s.badKeyNumerals + s.noise + s.watermark, 0);
});
