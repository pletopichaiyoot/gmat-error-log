// test/unit/og-select-source.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { pickRegions, scoreRegions } = require('../../scripts/og/select-source');

const goodPractice = [
  '1. First stem.', '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
  '2. Second stem.', '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
];
const goodKey = ['1. B', '2. C'];
const goodExplanations = [
  '1. First stem.', '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
  'Inference', 'Prose.', 'A n', 'B Correct. y', 'C n', 'D n', 'E n',
];

test('scoreRegions counts what each region is for', () => {
  const s = scoreRegions({ practice: goodPractice, key: goodKey, explanations: goodExplanations });
  assert.equal(s.practice, 2, 'two questions with five choices');
  assert.equal(s.key, 2, 'two keys');
  assert.equal(s.explanations, 1, 'one keyed explanation entry');
});

test('a letterless key table scores zero', () => {
  // OG13 after re-OCR: the numbers survive, the letter column does not.
  const s = scoreRegions({ practice: [], key: ['94.', '95.', '63. 32.'], explanations: [] });
  assert.equal(s.key, 0);
});

test('each region independently takes the layer that parses better', () => {
  const ocr = {
    practice: goodPractice,                 // clean labels
    key: ['94.', '95.', '63. 32.'],         // letters lost
    explanations: ['Stem with no number.'], // numbers lost
  };
  const orig = {
    practice: ['1. Stem.', '(A) a'],        // only one choice recovered
    key: goodKey,
    explanations: goodExplanations,
  };
  const picked = pickRegions([{ tag: 'ocr', regions: ocr }, { tag: 'orig', regions: orig }]);
  assert.equal(picked.sources.practice, 'ocr');
  assert.equal(picked.sources.key, 'orig');
  assert.equal(picked.sources.explanations, 'orig');
  assert.deepEqual(picked.regions.practice, goodPractice);
  assert.deepEqual(picked.regions.key, goodKey);
});

test('ties keep the first candidate, so a single layer needs no special case', () => {
  const only = { practice: goodPractice, key: goodKey, explanations: goodExplanations };
  const picked = pickRegions([{ tag: 'orig', regions: only }]);
  assert.equal(picked.sources.practice, 'orig');
  assert.deepEqual(picked.regions.explanations, goodExplanations);
});

test('a candidate that failed to parse at all is skipped', () => {
  const picked = pickRegions([
    { tag: 'ocr', error: 'Could not locate heading: 8.5 Answer Key' },
    { tag: 'orig', regions: { practice: goodPractice, key: goodKey, explanations: goodExplanations } },
  ]);
  assert.equal(picked.sources.key, 'orig');
});

test('every candidate failing is reported, not silently empty', () => {
  assert.throws(
    () => pickRegions([{ tag: 'ocr', error: 'boom' }, { tag: 'orig', error: 'bang' }]),
    /ocr: boom/);
});
