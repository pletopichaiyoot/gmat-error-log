/* global require */
const test = require('node:test');
const assert = require('node:assert');

let stimulusSortOrder;
let stimulusCellNumber;
test.before(async () => {
  ({ stimulusSortOrder, stimulusCellNumber } = await import('../../client/src/lib/stimulusSort.mjs'));
});

// Column taken from question_attempts.id 21968 (GMAT Club Table Analysis,
// "Probability"), which is what motivated the sort control: reading it in the
// printed order is exactly the work the question is testing.
test('a numeric column sorts by value, not by string', () => {
  const probability = ['0.2', '0.53', '0.63', '0.82', '0.15', '0.1'];
  const order = stimulusSortOrder(probability);
  assert.deepEqual(order.map((i) => probability[i]), ['0.1', '0.15', '0.2', '0.53', '0.63', '0.82']);
});

test('thousands separators and units do not make a column textual', () => {
  const spending = ['€1,200', '€980', '€12,000', '€1,050'];
  const order = stimulusSortOrder(spending);
  assert.deepEqual(order.map((i) => spending[i]), ['€980', '€1,050', '€1,200', '€12,000']);
});

test('negative percentages sort below positive ones', () => {
  const deviation = ['4.5%', '-12%', '0%', '-3.5%'];
  const order = stimulusSortOrder(deviation);
  assert.deepEqual(order.map((i) => deviation[i]), ['-12%', '-3.5%', '0%', '4.5%']);
});

// One unparseable cell is what separates "sort these figures" from "sort these
// labels"; treating the column as numeric would drop the odd one out at 0.
test('a single non-numeric cell makes the whole column sort as text', () => {
  const mixed = ['100', '2', 'n/a'];
  const order = stimulusSortOrder(mixed);
  assert.deepEqual(order.map((i) => mixed[i]), ['2', '100', 'n/a']);
});

test('a text column sorts case-insensitively', () => {
  const subjects = ['physics', 'Art', 'biology'];
  const order = stimulusSortOrder(subjects);
  assert.deepEqual(order.map((i) => subjects[i]), ['Art', 'biology', 'physics']);
});

test('equal cells keep the order the table was printed in', () => {
  const repeated = ['5', '5', '5'];
  assert.deepEqual(stimulusSortOrder(repeated), [0, 1, 2]);
});

test('stimulusCellNumber reads a printed figure and rejects a label', () => {
  assert.equal(stimulusCellNumber('1,200,000'), 1200000);
  assert.equal(stimulusCellNumber('-3.5%'), -3.5);
  assert.equal(stimulusCellNumber(''), null);
  assert.equal(stimulusCellNumber('n/a'), null);
});

test('stimulusSortOrder handles an empty column', () => {
  assert.deepEqual(stimulusSortOrder([]), []);
});
