'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { buildOgSet } = require('../../src/og-set-builder.js');

// A deterministic stand-in for Math.random: walks a fixed cycle so shuffles are
// reproducible. Real randomness would make "which passages were drawn"
// untestable.
const seqRng = (values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const q = (id, over = {}) => ({
  id, kind: 'CR', bookCode: 'OG12', typeLabel: 'Argument Construction',
  difficulty: 'Medium', number: Number(id.split('-').pop()), ...over,
});

const crPool = {
  questions: [
    q('OG12-CR-1'),
    q('OG12-CR-2', { difficulty: 'Hard' }),
    q('OG12-CR-3', { typeLabel: 'Argument Evaluation' }),
    q('OG13-CR-4', { bookCode: 'OG13' }),
  ],
};

// Three passages, of 2, 3 and 6 questions.
const rcQuestions = [];
for (const [pid, n] of [['p1', 2], ['p2', 3], ['p3', 6]]) {
  for (let i = 1; i <= n; i += 1) {
    rcQuestions.push(q(`OG12-RC-${pid}-${i}`, {
      kind: 'RC', passageId: pid, number: i,
      typeLabel: i === 1 ? 'Main idea' : 'Inference',
    }));
  }
}
const rcPool = { questions: rcQuestions };
const passageOf = (id) => rcPool.questions.find((x) => x.id === id).passageId;
const groupSize = (pid) => rcPool.questions.filter((x) => x.passageId === pid).length;

const noHistory = { attempted: new Set(), wrong: new Set() };
const base = { books: [], kind: 'CR', typeLabels: [], difficulties: [], historyMode: 'all', count: 2 };

test('an empty axis means no constraint, not nothing', () => {
  const set = buildOgSet({ pool: crPool, filters: { ...base, count: 10 }, history: noHistory, rng: () => 0 });
  assert.strictEqual(set.actual, 4);
  assert.strictEqual(set.shortfall, true);
});

test('filters AND across axes and OR within one', () => {
  const set = buildOgSet({
    pool: crPool,
    filters: { ...base, count: 10, books: ['OG12'], difficulties: ['Medium', 'Hard'] },
    history: noHistory,
    rng: () => 0,
  });
  assert.deepStrictEqual(set.questionIds.slice().sort(), ['OG12-CR-1', 'OG12-CR-2', 'OG12-CR-3']);
});

test('the unseen filter excludes every question already attempted', () => {
  const history = { attempted: new Set(['OG12-CR-1', 'OG12-CR-2']), wrong: new Set(['OG12-CR-1']) };
  const set = buildOgSet({ pool: crPool, filters: { ...base, count: 10, historyMode: 'unseen' }, history, rng: () => 0 });
  assert.deepStrictEqual(set.questionIds.slice().sort(), ['OG12-CR-3', 'OG13-CR-4']);
});

test('the wrong filter keeps only questions missed before', () => {
  const history = { attempted: new Set(['OG12-CR-1', 'OG12-CR-2']), wrong: new Set(['OG12-CR-1']) };
  const set = buildOgSet({ pool: crPool, filters: { ...base, count: 10, historyMode: 'wrong' }, history, rng: () => 0 });
  assert.deepStrictEqual(set.questionIds, ['OG12-CR-1']);
});

test('an over-constrained filter returns a short set rather than relaxing', () => {
  const set = buildOgSet({
    pool: crPool,
    filters: { ...base, count: 10, typeLabels: ['Argument Evaluation'] },
    history: noHistory,
    rng: () => 0,
  });
  assert.strictEqual(set.actual, 1);
  assert.strictEqual(set.requested, 10);
  assert.strictEqual(set.shortfall, true);
});

// RC is practiced a passage at a time. A count-based draw that split a group
// would leave questions referring to a passage the set never shows.
test('RC delivers whole passages and never splits a group', () => {
  const set = buildOgSet({ pool: rcPool, filters: { ...base, kind: 'RC', count: 6 }, history: noHistory, rng: seqRng([0.1, 0.5, 0.9]) });
  const byPassage = {};
  for (const id of set.questionIds) {
    const pid = passageOf(id);
    byPassage[pid] = (byPassage[pid] || 0) + 1;
  }
  for (const [pid, n] of Object.entries(byPassage)) {
    assert.strictEqual(n, groupSize(pid), `passage ${pid} was split: ${n} of ${groupSize(pid)}`);
  }
  assert.ok(set.actual <= 6, `overshot: ${set.actual}`);
  assert.strictEqual(set.passageCount, set.passageIds.length);
});

test('RC questions arrive grouped by passage and ordered within a group', () => {
  const set = buildOgSet({ pool: rcPool, filters: { ...base, kind: 'RC', count: 6 }, history: noHistory, rng: seqRng([0.1, 0.5, 0.9]) });
  const order = set.questionIds.map(passageOf);
  // Each passage's questions are contiguous: the run-length encoding of the
  // passage sequence has exactly one run per passage.
  const runs = order.filter((pid, i) => i === 0 || order[i - 1] !== pid);
  assert.deepStrictEqual(runs, set.passageIds);
  const numbers = set.questionIds
    .filter((id) => passageOf(id) === set.passageIds[0])
    .map((id) => rcPool.questions.find((x) => x.id === id).number);
  assert.deepStrictEqual(numbers, numbers.slice().sort((a, b) => a - b));
});

// The type filter selects PASSAGES containing a match; the whole group still
// comes, because reading a passage for one question is not how RC is practiced.
test('an RC type filter selects passages, and the group arrives whole', () => {
  const set = buildOgSet({
    pool: rcPool,
    filters: { ...base, kind: 'RC', count: 20, typeLabels: ['Main idea'] },
    history: noHistory,
    rng: () => 0,
  });
  assert.strictEqual(set.actual, 11); // every passage has a "Main idea" Q1: 2+3+6
  assert.strictEqual(set.passageCount, 3);
});

test('a passage too large for the remaining count is skipped, not truncated', () => {
  const set = buildOgSet({ pool: rcPool, filters: { ...base, kind: 'RC', count: 3 }, history: noHistory, rng: seqRng([0.9, 0.5, 0.1]) });
  assert.ok(set.actual <= 3);
  assert.ok(set.passageIds.every((pid) => groupSize(pid) <= 3));
});
