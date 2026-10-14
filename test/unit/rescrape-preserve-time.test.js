/* global require */
// A Phase-1 rescrape must not downgrade an enriched row's time. StartTest
// Phase 2 (and OPE Phase 3) store the exact per-question time; Phase 1 has
// only Question History's rounded display, capped at "3+ Minutes" — which
// used to parse as nothing and be stored as 0 s, filing every slow question
// as the fastest. One set of rescrapes rewrote 78 exact times, 25 to zero.
const test = require('node:test');
const assert = require('node:assert');
const { pickTimeSec, buildAttemptSnapshotIndex } = require('../../src/db');
const { parseTimeSpent } = require('../../src/scrapers/starttest_scraper')._internals;

test('"3+ Minutes" is read as its 180 s floor, not as no time', () => {
  assert.strictEqual(parseTimeSpent('3+ Minutes'), 180);
  assert.strictEqual(parseTimeSpent('132 Seconds'), 132);
  assert.strictEqual(parseTimeSpent('1 Minute 5 Seconds'), 65);
  assert.strictEqual(parseTimeSpent(''), null);
});

test('an enriched row keeps its exact time over the Phase-1 reading', () => {
  const enriched = { time_sec: 202, answer_choices: '[{"label":"A"}]' };
  assert.strictEqual(pickTimeSec(180, enriched), 202);
  assert.strictEqual(pickTimeSec(null, enriched), 202);
  assert.strictEqual(pickTimeSec(0, enriched), 202);
});

test('without enrichment the fresh reading wins, and nothing becomes 0', () => {
  assert.strictEqual(pickTimeSec(132, { time_sec: 140 }), 132);
  assert.strictEqual(pickTimeSec(null, { time_sec: 140 }), 140);
  assert.strictEqual(pickTimeSec(null, undefined), null);
  assert.strictEqual(pickTimeSec(0, {}), null);
  // A row a previous rescrape zeroed heals to the floor on the next one.
  assert.strictEqual(pickTimeSec(180, { time_sec: 0, answer_choices: '[]' }), 180);
});

test('the rescrape snapshot carries time_sec', () => {
  const idx = buildAttemptSnapshotIndex([{ q_id: '404605-seq-15', time_sec: 202, answer_choices: '[]' }]);
  assert.strictEqual(idx.byQid.get('404605-seq-15').time_sec, 202);
});
