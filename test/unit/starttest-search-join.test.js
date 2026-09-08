/* global require */
const test = require('node:test');
const assert = require('node:assert');
const {
  matchSearchRowsToAttempts,
  _internals: { clusterIds, normalizeStemKey, parseSearchSeconds },
} = require('../../src/scrapers/starttest_search_scraper');

const row = (over = {}) => ({
  itemId: '700216',
  date: '8/12/2026',
  correct: 'N',
  preview: '[item contains image] For each of four symptoms, the graph s',
  contentArea: 'Probability',
  timeSpent: '116 Seconds',
  ...over,
});

const attempt = (over = {}) => ({
  id: 1,
  q_code: '425773',
  // Phase 2 replaced the 60-char preview with the full stem (and dropped the
  // "[item contains image]" marker) — the preview must still prefix-match.
  question_stem: 'For each of four symptoms, the graph shows the percentage chances that someone will have that symptom.',
  correct: 0,
  time_sec: 116,
  session_date: '2026-08-12',
  ...over,
});

test('matches an enriched attempt through the truncated preview', () => {
  const out = matchSearchRowsToAttempts([row()], [attempt()]);
  assert.deepEqual(out.assignments, [{ attemptId: 1, itemId: '700216' }]);
  assert.equal(out.byQCode.get('425773'), '700216');
});

test('rejects a mismatched correctness or time', () => {
  assert.equal(matchSearchRowsToAttempts([row()], [attempt({ correct: 1 })]).assignments.length, 0);
  assert.equal(matchSearchRowsToAttempts([row()], [attempt({ time_sec: 40 })]).assignments.length, 0);
});

test('"3+ Minutes" only pairs with a long attempt', () => {
  const long = row({ timeSpent: '3+ Minutes' });
  assert.equal(matchSearchRowsToAttempts([long], [attempt({ time_sec: 240 })]).assignments.length, 1);
  assert.equal(matchSearchRowsToAttempts([long], [attempt({ time_sec: 90 })]).assignments.length, 0);
});

test('identical DI boilerplate previews resolve by answer date, not by luck', () => {
  // Real case: 700153 (8/26) and 700154 (8/12) share the first 60 chars, are
  // both correct, and both ran past 3 minutes.
  const shared = 'For each of the following statements, select Yes if the sta';
  const rows = [
    row({ itemId: '700153', date: '8/26/2026', correct: 'Y', preview: shared, timeSpent: '3+ Minutes' }),
    row({ itemId: '700154', date: '8/12/2026', correct: 'Y', preview: shared, timeSpent: '3+ Minutes' }),
  ];
  const target = attempt({
    question_stem: `${shared}tement is supported.`,
    correct: 1,
    time_sec: 220,
    session_date: '2026-08-12',
  });
  const out = matchSearchRowsToAttempts(rows, [target]);
  assert.deepEqual(out.assignments, [{ attemptId: 1, itemId: '700154' }]);

  // A near-tie (both answered within 3 days of the session) stays unassigned.
  const tie = matchSearchRowsToAttempts(
    [rows[1], row({ itemId: '700157', date: '8/14/2026', correct: 'Y', preview: shared, timeSpent: '3+ Minutes' })],
    [target]
  );
  assert.equal(tie.assignments.length, 0);
  assert.equal(tie.ambiguous, 1);
});

test('an answer date before the session, or long after it, never matches', () => {
  assert.equal(matchSearchRowsToAttempts([row({ date: '8/11/2026' })], [attempt()]).assignments.length, 0);
  assert.equal(matchSearchRowsToAttempts([row({ date: '9/30/2026' })], [attempt()]).assignments.length, 0);
});

test('helpers', () => {
  assert.equal(parseSearchSeconds('116 Seconds'), 116);
  assert.equal(parseSearchSeconds('3+ Minutes'), null);
  assert.equal(normalizeStemKey('[item contains image]  A   B '), 'a b');
  assert.deepEqual(clusterIds([700152, 700153, 100310, 700900]), [
    { min: 100310, max: 100310 },
    { min: 700152, max: 700153 },
    { min: 700900, max: 700900 },
  ]);
});
