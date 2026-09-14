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

test('an OCR-lost question number is recovered, not skipped', () => {
  // VR2's scan drops numbers: its RC section prints 104 questions but only 78
  // survive as "N." lines. The question is still there, so recover it.
  const q = n => [`${n}. Stem ${n}.`, '(A) a', '(B) b', '(C) c', '(D) d', '(E) e'];
  const { questions } = parseQuestions([
    ...q(1), ...q(2),
    'Stem 3 whose number the scanner lost.', '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
    ...q(4), ...q(5),
  ]);
  assert.deepEqual(questions.map(x => x.number), [1, 2, 3, 4, 5]);
  assert.equal(questions[2].numberInferred, true);
  assert.equal(questions[2].stem, 'Stem 3 whose number the scanner lost.');
});

test('a question absent from the text is reported as skipped', () => {
  const q = n => [`${n}. Stem ${n}.`, '(A) a', '(B) b', '(C) c', '(D) d', '(E) e'];
  const { questions, warnings } = parseQuestions([...q(1), ...q(2), ...q(5)]);
  assert.deepEqual(questions.map(x => x.number), [1, 2, 5]);
  assert.ok(warnings.some(w => /skipped question 3, 4/.test(w)));
});

test('a misread number is renumbered in sequence, not trusted', () => {
  // A jump of 46 is a misread digit or a page number caught by the scan, but
  // the choice run beneath it is a real question. Keep it, in sequence.
  const q = n => [`${n}. Stem ${n}.`, '(A) a', '(B) b', '(C) c', '(D) d', '(E) e'];
  const { questions } = parseQuestions([
    ...q(1),
    '47. This is really question 2.',
    '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
  ]);
  assert.deepEqual(questions.map(x => x.number), [1, 2]);
  assert.equal(questions[1].numberInferred, true);
});

test('a stray numbered line with no choices creates no question', () => {
  const q = n => [`${n}. Stem ${n}.`, '(A) a', '(B) b', '(C) c', '(D) d', '(E) e'];
  const { questions } = parseQuestions([...q(1), ...q(2), ...q(3)].concat([
    '2. A repeated number from a footer, with nothing beneath it.',
  ]));
  assert.deepEqual(questions.map(x => x.number), [1, 2, 3]);
});

test('a missing question 1 does not lose the whole section', () => {
  // OG13's RC scan drops the numbers of questions 1-3; the first surviving
  // number is "4.". Seeding strictly at 1 lost all 139 questions.
  const q = n => [`${n}. Stem ${n}.`, '(A) a', '(B) b', '(C) c', '(D) d', '(E) e'];
  const { questions, warnings } = parseQuestions([
    'Prose belonging to questions whose numbers the scanner lost.',
    '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
    ...q(4), ...q(5),
  ]);
  assert.deepEqual(questions.map(x => x.number), [4, 5]);
  assert.ok(warnings.some(w => /skipped question 1, 2, 3/.test(w)));
});

test('a number stranded on its own line is rejoined to its stem', () => {
  // OG13 prints some numbers in a hanging indent that pdftotext emits alone.
  const { questions } = parseQuestions([
    '1. First stem.', '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
    '2.',
    'The second stem, whose number was emitted on its own line.',
    '(A) a', '(B) b', '(C) c', '(D) d', '(E) e',
  ]);
  assert.deepEqual(questions.map(x => x.number), [1, 2]);
  assert.equal(questions[1].stem,
    'The second stem, whose number was emitted on its own line.');
});

test('a second (A) starts a new question even with no number', () => {
  // The scans lose question numbers wholesale — VR2's OCR layer loses nearly
  // all of them — and without this one "question" swallows the rest of the
  // section. A choice run restarting at (A) is the structure that survives.
  const { questions } = parseQuestions([
    '1. First stem.',
    '(A) a1', '(B) b1', '(C) c1', '(D) d1', '(E) e1',
    'Second stem, whose number the scanner lost.',
    '(A) a2', '(B) b2', '(C) c2', '(D) d2', '(E) e2',
  ]);
  assert.equal(questions.length, 2);
  assert.deepEqual(questions.map(q => q.number), [1, 2]);
  assert.equal(questions[1].stem, 'Second stem, whose number the scanner lost.');
  assert.deepEqual(questions[1].choices.map(c => c.text), ['a2', 'b2', 'c2', 'd2', 'e2']);
  assert.equal(questions[1].numberInferred, true);
  assert.equal(questions[0].numberInferred, undefined);
});

test('an inferred split still yields five choices each', () => {
  const run = n => [`(A) a${n}`, `(B) b${n}`, `(C) c${n}`, `(D) d${n}`, `(E) e${n}`];
  const { questions } = parseQuestions([
    '1. Stem one.', ...run(1),
    'Stem two.', ...run(2),
    'Stem three.', ...run(3),
  ]);
  assert.equal(questions.length, 3);
  assert.deepEqual(questions.map(q => q.choices.length), [5, 5, 5]);
});

test('a page footer run onto the end of a line is trimmed', () => {
  const { questions } = parseQuestions([
    '1. The stem ends here. 542',
    '(A) one', '(B) two', '(C) three', '(D) four', '(E) five',
  ]);
  assert.equal(questions[0].stem, 'The stem ends here.');
});
