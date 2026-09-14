// test/unit/og-questions.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { parseQuestions } = require('../../scripts/og/questions');

test('parses a question into stem and five choices', () => {
  const { questions } = parseQuestions([
    '36. The growing popularity of computer-based activities',
    'was widely expected to result in a decline in television',
    'viewing.',
    'Which of the following would it be most useful to',
    'determine in order to evaluate the argument?',
    '(A) Whether a large majority watched television',
    '(B) Whether the amount of time spent is declining',
    '(C) Whether the type of programme changes',
    '(D) Whether a large majority of owners reported',
    '(E) Whether the reports included time at work',
  ], { startAt: 36 });
  assert.equal(questions.length, 1);
  assert.equal(questions[0].number, 36);
  assert.match(questions[0].stem, /^The growing popularity/);
  assert.match(questions[0].stem, /evaluate the argument\?$/);
  assert.equal(questions[0].choices.length, 5);
  assert.deepEqual(questions[0].choices[0], { label: 'A', text: 'Whether a large majority watched television' });
  assert.equal(questions[0].choices[4].text, 'Whether the reports included time at work');
});

test('a choice wrapping across lines is joined', () => {
  const { questions } = parseQuestions([
    '1. Stem line.',
    '(A) first part of a choice that wraps',
    'onto a second line',
    '(B) second choice',
    '(C) third', '(D) fourth', '(E) fifth',
  ]);
  assert.equal(questions[0].choices[0].text,
    'first part of a choice that wraps onto a second line');
});

test('a decimal is not read as a question number', () => {
  // "density 4.3 to 4.6." cost the LSAT parser a whole passage.
  const { questions } = parseQuestions([
    '5. A material with a density of',
    '4.3 to 4.6. It is also used widely.',
    '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
  ], { startAt: 5 });
  assert.equal(questions.length, 1);
  assert.equal(questions[0].number, 5);
  assert.match(questions[0].stem, /4\.3 to 4\.6/);
});

test('question numbers must continue the run', () => {
  // A sentence starting "1. " mid-stem must not open a new question.
  const { questions } = parseQuestions([
    '7. Consider the following claim.',
    '1. It is not a question number here.',
    '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
    '8. The next real question.',
    '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
  ], { startAt: 7 });
  assert.deepEqual(questions.map(q => q.number), [7, 8]);
});

test('a question with the wrong number of choices is warned about, not silently kept', () => {
  const { questions, warnings } = parseQuestions([
    '1. Stem.', '(A) one', '(B) two', '(C) three',
  ]);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].choices.length, 3);
  assert.ok(warnings.some(w => /question 1/.test(w) && /3 choices/.test(w)));
});

test('the directions list cannot open the question run', () => {
  // Every chapter's directions are themselves a numbered list. They carry no
  // lettered choices, which is what separates them from real questions.
  const { questions } = parseQuestions([
    'Read the following directions.',
    '1. Read very carefully the set of statements on which a question is based.',
    '2. Analyze each passage carefully, because the questions require detail.',
    '3. Focus on key words and phrases.',
    '1. The first real question.',
    '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
    '2. The second real question.',
    '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
  ]);
  assert.deepEqual(questions.map(q => q.number), [1, 2]);
  assert.equal(questions[0].stem, 'The first real question.');
});

test('the run is seeded at question 1, not at whatever number appears first', () => {
  const { questions } = parseQuestions([
    '7. A stray numbered line with no choices.',
    '1. The real first question.',
    '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
  ]);
  assert.deepEqual(questions.map(q => q.number), [1]);
});

test('a page footer run onto the end of a line is trimmed', () => {
  const { questions } = parseQuestions([
    '1. The stem ends here. 542',
    '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
  ]);
  assert.equal(questions[0].stem, 'The stem ends here.');
});
