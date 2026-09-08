/* global require */
const test = require('node:test');
const assert = require('node:assert');

let buildStartTestSearchPhrase;
test.before(async () => {
  ({ buildStartTestSearchPhrase } = await import('../../client/src/lib/starttestSearchPhrase.mjs'));
});

test('quotes the opening words of a stem', () => {
  assert.equal(
    buildStartTestSearchPhrase('For each of four symptoms, the graph shows the percentage chances that someone will have that symptom.'),
    '"For each of four symptoms the graph shows"'
  );
});

test('drops the scrape marker and leading math, keeping real words', () => {
  assert.equal(
    buildStartTestSearchPhrase('[item contains image] The two graphs above show sales by region'),
    '"The two graphs above show sales by region"'
  );
  assert.equal(
    buildStartTestSearchPhrase('4 < x/3 < 9 which of the following must be true'),
    '"which of the following must be true"'
  );
});

test('stops at math once enough words are collected', () => {
  assert.equal(
    buildStartTestSearchPhrase('If the total revenue equals 4x^2 + 3 for every quarter'),
    '"If the total revenue equals"'
  );
});

test('never emits an unbalanced quote or a too-short phrase', () => {
  assert.equal(buildStartTestSearchPhrase('He said "yes" to the offer today'), '"He said yes to the offer today"');
  assert.equal(buildStartTestSearchPhrase(''), '');
  assert.equal(buildStartTestSearchPhrase('   '), '');
  assert.equal(buildStartTestSearchPhrase('$$ ++ %%'), '');
  assert.equal(buildStartTestSearchPhrase('x'), '');
});

test('ends the phrase before an apostrophe once it is long enough', () => {
  assert.equal(
    buildStartTestSearchPhrase('At a craft fair, Ruth’s total revenue from selling'),
    '"At a craft fair"'
  );
  // Too short to stop, so the word is kept with a straight apostrophe.
  assert.equal(buildStartTestSearchPhrase('A student’s average test score'), '"A student\'s average test score"');
});

test('respects maxWords', () => {
  assert.equal(buildStartTestSearchPhrase('one two three four five six', { maxWords: 3 }), '"one two three"');
});
