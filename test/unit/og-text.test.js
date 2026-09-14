// test/unit/og-text.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  squash, repairChoiceLabels, repairKeyNumeral, stripWatermark,
  isRunningHead, normalizeLine,
} = require('../../scripts/og/text');

test('squash makes VR2 mangled headings comparable', () => {
  // VR2 OCR breaks its own running heads in a different place on every page.
  assert.equal(squash('3.4 Reading Comprehension Sample Que sti ons'),
               squash('3.4 Reading Comprehension Sample Questions'));
  assert.equal(squash('4.4 Critica l Reasoning Sam ple Questions'),
               squash('4.4 Critical Reasoning Sample Questions'));
});

test('repairChoiceLabels fixes the two systematic misreads', () => {
  assert.equal(repairChoiceLabels('(0 The flute was made from a cave-bear bone'),
               '(C) The flute was made from a cave-bear bone');
  assert.equal(repairChoiceLabels('(8) The flesh of SPK004 differs'),
               '(B) The flesh of SPK004 differs');
});

test('repairChoiceLabels leaves correct labels and mid-line parens alone', () => {
  assert.equal(repairChoiceLabels('(C) already correct'), '(C) already correct');
  assert.equal(repairChoiceLabels('a drop of (0.5) percent'), 'a drop of (0.5) percent');
});

test('repairKeyNumeral rebuilds VR2 key numbers', () => {
  assert.equal(repairKeyNumeral('I'), '1');
  assert.equal(repairKeyNumeral('II'), '11');
  assert.equal(repairKeyNumeral('2I'), '21');
  assert.equal(repairKeyNumeral('5I'), '51');
  assert.equal(repairKeyNumeral('lOI'), '101');
  assert.equal(repairKeyNumeral('104'), '104');
});

test('stripWatermark removes the OG13 mark even when glued to real text', () => {
  assert.equal(stripWatermark('QQ:1014347461制作8.6 Answer Explanations'),
               '8.6 Answer Explanations');
  assert.equal(stripWatermark('ordinary line'), 'ordinary line');
});

test('isRunningHead matches whitespace-insensitively', () => {
  const heads = ['8.4 Critical Reasoning Practice Questions'];
  assert.equal(isRunningHead('8.4 Critical Reasoning PracticeQuestions', heads), true);
  assert.equal(isRunningHead('8.4 Critical Reasoning Practice Questions', heads), true);
  assert.equal(isRunningHead('(A) a real answer choice', heads), false);
});

test('normalizeLine strips the watermark before repairing labels', () => {
  assert.equal(normalizeLine('QQ:1014347461制作(0 a choice'), '(C) a choice');
});
