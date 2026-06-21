// test/unit/gmatclub-cat-enrich-helpers.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { letterForIndex, deriveAnswerLetters } = require('../../src/scrapers/gmat_club_cat_question_scraper')._internals;

test('letterForIndex', () => {
  assert.equal(letterForIndex(0), 'A');
  assert.equal(letterForIndex(4), 'E');
});

test('deriveAnswerLetters maps correct + selected to letters', () => {
  const choices = [
    { text: 'opt1', isCorrect: true, isUserSelected: false },
    { text: 'opt2', isCorrect: false, isUserSelected: false },
    { text: 'opt3', isCorrect: false, isUserSelected: true },
  ];
  const { labeled, correct_answer, my_answer } = deriveAnswerLetters(choices);
  assert.equal(labeled[0].label, 'A');
  assert.equal(correct_answer, 'A');
  assert.equal(my_answer, 'C');
});
