// test/unit/gmatclub-cat-enrich-helpers.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { letterForIndex, normLetter, markChoices } = require('../../src/scrapers/gmat_club_cat_question_scraper')._internals;

test('letterForIndex', () => {
  assert.equal(letterForIndex(0), 'A');
  assert.equal(letterForIndex(4), 'E');
});

test('normLetter extracts a single A-H letter, else null', () => {
  assert.equal(normLetter('A'), 'A');
  assert.equal(normLetter(' b '), 'B');
  assert.equal(normLetter('(D)'), 'D');
  assert.equal(normLetter(''), null);
  assert.equal(normLetter('123'), null);
});

test('markChoices flags correct + selected by letter (labels from input values)', () => {
  const raw = [
    { label: 'A', text: 'opt1' },
    { label: 'B', text: 'opt2' },
    { label: 'C', text: 'opt3' },
  ];
  const { choices, correct_answer, my_answer } = markChoices(raw, 'A', 'C');
  assert.equal(correct_answer, 'A');
  assert.equal(my_answer, 'C');
  assert.deepEqual(choices.map((c) => c.label), ['A', 'B', 'C']);
  assert.equal(choices[0].isCorrect, true);
  assert.equal(choices[0].isUserSelected, false);
  assert.equal(choices[2].isUserSelected, true);
  assert.equal(choices[2].isCorrect, false);
});

test('markChoices with no user pick leaves my_answer null and no isUserSelected', () => {
  const raw = [{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }];
  const { choices, correct_answer, my_answer } = markChoices(raw, 'B', null);
  assert.equal(correct_answer, 'B');
  assert.equal(my_answer, null);
  assert.equal(choices[1].isCorrect, true);
  assert.equal(choices.some((c) => c.isUserSelected), false);
});

test('markChoices falls back to positional letters when label missing', () => {
  const { choices } = markChoices([{ text: 'x' }, { text: 'y' }], null, null);
  assert.deepEqual(choices.map((c) => c.label), ['A', 'B']);
});
