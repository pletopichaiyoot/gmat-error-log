// test/unit/og-answer-key.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { parseAnswerKey, detectKeyLayout } = require('../../scripts/og/answer-key');

test('single-column layout, one entry per line (OG12, OG13)', () => {
  const r = parseAnswerKey(['1. C', '2. D', '3. B', '4. E']);
  assert.equal(r.layout, 'single');
  assert.equal(r.keys.get(1), 'C');
  assert.equal(r.keys.get(4), 'E');
  assert.equal(r.keys.size, 4);
});

test('grid layout reads four columns per line (VR2)', () => {
  const r = parseAnswerKey(['1. C 27. B 53. D 79. E', '2. D 28. D 54. E 80. C']);
  assert.equal(r.layout, 'grid');
  assert.equal(r.keys.get(1), 'C');
  assert.equal(r.keys.get(27), 'B');
  assert.equal(r.keys.get(53), 'D');
  assert.equal(r.keys.get(79), 'E');
  assert.equal(r.keys.get(80), 'C');
  assert.equal(r.keys.size, 8);
});

test('grid layout repairs VR2 OCR numerals and the 0-for-D letter', () => {
  // Verbatim lines from the Verbal Review 2e RC key.
  const r = parseAnswerKey([
    'I. C 27. B 53. 0 79. E',
    'II. C 37. C 63. E 89. B',
    '2I. E 47. C 73. A 99. A',
    '25. B 5I. C 77. B 103. E',
    '24. 0 50. B 76. B lOI. B',
  ]);
  assert.equal(r.keys.get(1), 'C');
  assert.equal(r.keys.get(53), 'D', '0 in the letter position is D');
  assert.equal(r.keys.get(11), 'C');
  assert.equal(r.keys.get(21), 'E');
  assert.equal(r.keys.get(51), 'C');
  assert.equal(r.keys.get(24), 'D');
  assert.equal(r.keys.get(101), 'B');
});

test('an unreadable region yields no keys instead of garbage', () => {
  // OG13 section 8.5 is a rotated table; OCR renders it as line noise.
  const noise = [
    'CO CO O UJ GO O O U J O O O O C 0 < O O < O O C 0 O l U L U U J O O L l J C 0 O C 0',
    'r o \' s j - i n i O N o o c j ^ O r - i c v j r o ^ t i n A D N o o o i O H C M o o',
    'O C Q < < L J Q < O Q Q Q O Q Q C Q Q C D Q Q L l J L i J O O Q O < < Q O Q',
  ];
  const r = parseAnswerKey(noise);
  assert.equal(r.layout, 'unreadable');
  assert.equal(r.keys.size, 0);
});

test('letters outside A-E are rejected, not coerced', () => {
  const r = parseAnswerKey(['1. C', '2. Z', '3. B']);
  assert.equal(r.keys.size, 2);
  assert.ok(r.skipped.some(s => s.includes('2. Z')));
});

test('detectKeyLayout distinguishes the three cases', () => {
  assert.equal(detectKeyLayout(['1. C', '2. D']), 'single');
  assert.equal(detectKeyLayout(['1. C 27. B 53. D 79. E']), 'grid');
  assert.equal(detectKeyLayout(['C O < Q L U O Q < Q Q C O L U < < C O U J < l J L j Q']), 'unreadable');
});
