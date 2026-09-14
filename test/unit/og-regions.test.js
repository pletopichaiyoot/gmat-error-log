// test/unit/og-regions.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { findRegions, headingsFor } = require('../../scripts/og/regions');
const { bookByCode } = require('../../scripts/og/books');

const OG13 = bookByCode('OG13');
const VR2 = bookByCode('VR2');

// A realistic CR chapter: table of contents, then the body. The X.4 heading
// deliberately sits AFTER question 1, as it does in the real books.
const body = (extra = []) => [
  '1. A real question stem.',
  '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
  '8.4 Practice Questions',
  'Directions prose that follows the section opener.',
  '2. The second question.',
  '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
  ...extra,
];

// A realistic table of contents: every chapter's sub-headings listed together
// with page numbers. This is what the region locator has to see past.
const toc = () => [
  '1.0 What Is the GMAT 12',
  '2.0 How to Prepare 20',
  '3.0 Diagnostic Test 30',
  '4.0 Math Review 100',
  '5.0 Problem Solving 140',
  '5.3 Practice Questions 152',
  '5.4 Answer Key 186',
  '5.5 Answer Explanations 188',
  '6.0 Data Sufficiency 270',
  '6.3 Practice Questions 272',
  '6.4 Answer Key 289',
  '6.5 Answer Explanations 290',
  '7.0 Reading Comprehension 358',
  '7.3 The Directions 362',
  '7.4 Practice Questions 364',
  '7.5 Answer Key 418',
  '7.6 Answer Explanations 419',
  '8.0 Critical Reasoning 496',
  '8.3 The Directions 485',
  '8.4 Practice Questions 486',
  '8.5 Answer Key 539',
  '8.6 Answer Explanations 540',
  '9.0 Sentence Correction 660',
  // Real books put thousands of lines of front matter and earlier chapters
  // between the contents and the body; the locator relies on that distance.
  ...Array.from({ length: 200 }, (_, i) => `front matter line ${i}`),
];

const chapter = (extra = []) => [
  ...toc(),
  'front matter, then whole chapters of other material',
  '8.3 The Directions',
  'Read very carefully the set of statements on which a question is based.',
  ...body(extra),
  '8.5 Answer Key',
  '1. B', '2. C',
  '8.6 Answer Explanations',
  '1. A real question stem.',
  '9.0 Sentence Correction',
  'material that belongs to the next chapter',
];

test('headingsFor composes chapter number and suffix per book', () => {
  assert.deepEqual(headingsFor(OG13, 'CR'), {
    directions: '8.3 ',
    practice: '8.4 Practice Questions',
    key: '8.5 Answer Key',
    explanations: '8.6 Answer Explanations',
    nextChapter: '9.0 ',
  });
  assert.equal(headingsFor(VR2, 'RC').practice, '3.4 Sample Questions');
  assert.equal(headingsFor(VR2, 'RC').nextChapter, '4.0 ');
});

test('the practice region starts before the X.4 heading, where question 1 really is', () => {
  const r = findRegions(chapter(), OG13, 'CR');
  assert.equal(r.practice[0], 'Read very carefully the set of statements on which a question is based.');
  assert.ok(r.practice.includes('1. A real question stem.'));
  assert.ok(r.practice.includes('2. The second question.'));
});

test('the table of contents is skipped in favour of the body', () => {
  const r = findRegions(chapter(), OG13, 'CR');
  assert.deepEqual(r.key, ['1. B', '2. C']);
});

test('running heads are stripped from region content', () => {
  const r = findRegions(chapter(['8.4 Critical Reasoning Practice Questions', '(A) trailing']), OG13, 'CR');
  assert.ok(!r.practice.some(l => /Critical Reasoning Practice Questions/.test(l)));
  assert.ok(r.practice.includes('(A) trailing'));
});

test('explanations stop at the next chapter, not end of file', () => {
  const r = findRegions(chapter(), OG13, 'CR');
  assert.deepEqual(r.explanations, ['1. A real question stem.']);
});

test('the OG13 watermark is stripped and misread labels repaired', () => {
  const r = findRegions(chapter(['QQ:1014347461制作(0 a choice']), OG13, 'CR');
  assert.ok(r.practice.includes('(C) a choice'));
});

test('VR2 running heads broken at random points still match', () => {
  const lines = [
    ...toc(),
    '3.3 The Directions',
    '1. The primary purpose of the passage is to',
    '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
    '3.4 Reading Comprehension Sample Que sti ons',
    '(A) trailing',
    '3.5 Answer Key',
    'I. C',
    '3.6 Answer Explanations',
    '1. The primary purpose of the passage is to',
  ];
  const r = findRegions(lines, VR2, 'RC');
  assert.ok(!r.practice.some(l => /Sample Que/.test(l)));
  assert.ok(r.practice.includes('(A) trailing'));
});

test('findRegions throws naming the heading it could not find', () => {
  const lines = [...toc(), '8.3 The Directions', '1. stem', '8.6 Answer Explanations', '1. stem'];
  assert.throws(() => findRegions(lines, OG13, 'CR'), /8\.5 Answer Key/);
});
