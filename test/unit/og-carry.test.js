// test/unit/og-carry.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { carryRatings } = require('../../scripts/og/carry-ratings');

const prior = () => ({ books: [{ code: 'OG12', sections: [{ kind: 'CR', questions: [
  { id: 'OG12-CR-1', difficulty: 'Hard', difficulty_pct: 44,
    difficulty_source: 'llm', difficulty_model: 'gpt-5.6-luna', difficulty_reason: 'subtle gap' },
  { id: 'OG12-CR-2', difficulty: 'Easy', difficulty_pct: 88,
    difficulty_source: 'llm', difficulty_model: 'gpt-5.6-luna' },
] }] }] });

const fresh = () => ({ books: [{ code: 'OG12', sections: [{ kind: 'CR', questions: [
  { id: 'OG12-CR-1' }, { id: 'OG12-CR-2' }, { id: 'OG12-CR-3' },
] }] }] });

test('a re-parse keeps the ratings already paid for', () => {
  const next = fresh();
  const carried = carryRatings(next, prior());
  assert.equal(carried, 2);
  const q = next.books[0].sections[0].questions[0];
  assert.equal(q.difficulty_pct, 44);
  assert.equal(q.difficulty, 'Hard');
  assert.equal(q.difficulty_model, 'gpt-5.6-luna');
  assert.equal(q.difficulty_reason, 'subtle gap');
});

test('a question new to this parse stays unrated', () => {
  const next = fresh();
  carryRatings(next, prior());
  assert.equal(next.books[0].sections[0].questions[2].difficulty_pct, undefined);
});

test('nothing is carried when there is no prior pool', () => {
  const next = fresh();
  assert.equal(carryRatings(next, null), 0);
  assert.equal(next.books[0].sections[0].questions[0].difficulty_pct, undefined);
});

test('a rating with no estimate behind it is not carried', () => {
  // Those are leftovers from an older labelling scheme.
  const stale = { books: [{ code: 'OG12', sections: [{ kind: 'CR', questions: [
    { id: 'OG12-CR-1', difficulty: 'Easy' },
  ] }] }] };
  const next = fresh();
  assert.equal(carryRatings(next, stale), 0);
  assert.equal(next.books[0].sections[0].questions[0].difficulty, undefined);
});
