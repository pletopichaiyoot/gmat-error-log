// test/unit/og-difficulty.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');

// The classifier core is ESM; load it the way src/db.js loads reviewNotes.mjs.
const core = () => import('../../scripts/classify-og-difficulty.core.mjs');

const choices = 'ABCDE'.split('').map(l => ({ label: l, text: `option ${l}` }));
const pool = () => ({ books: [
  { code: 'OG12', sections: [
    { kind: 'CR', questions: [
      { id: 'OG12-CR-1', number: 1, stem: 'Stem one.', choices, usable: true },
      { id: 'OG12-CR-2', number: 2, stem: 'Stem two.', choices, usable: true,
        difficulty: 'Hard', difficulty_pct: 40, difficulty_source: 'llm' },
      { id: 'OG12-CR-3', number: 3, stem: 'Mangled.', choices, usable: false },
    ] },
    { kind: 'RC', passages: [{ id: 'OG12-RC-p358', text: 'A passage.' }], questions: [
      { id: 'OG12-RC-1', number: 1, stem: 'Purpose?', choices, usable: true,
        passageId: 'OG12-RC-p358' },
    ] },
  ] },
] });

test('only usable, unrated questions are collected', async () => {
  const { collectTargets } = await core();
  assert.deepEqual(collectTargets(pool(), {}).map(t => t.id), ['OG12-CR-1', 'OG12-RC-1']);
});

test('--force re-rates everything usable, but never the unusable', async () => {
  const { collectTargets } = await core();
  assert.deepEqual(collectTargets(pool(), { force: true }).map(t => t.id),
    ['OG12-CR-1', 'OG12-CR-2', 'OG12-RC-1']);
});

test('an RC target carries its passage text', async () => {
  const { collectTargets } = await core();
  assert.equal(collectTargets(pool(), {}).find(t => t.kind === 'RC').passageText, 'A passage.');
});

test('RC batches group by passage and send its text once', async () => {
  const { buildBatches, buildUserMessage } = await core();
  const batches = buildBatches([
    { id: 'a', kind: 'RC', passageId: 'p1', passageText: 'First passage.', stem: 's', choices: [] },
    { id: 'b', kind: 'RC', passageId: 'p1', passageText: 'First passage.', stem: 's', choices: [] },
    { id: 'c', kind: 'RC', passageId: 'p2', passageText: 'Second passage.', stem: 's', choices: [] },
  ]);
  assert.equal(batches.length, 2);
  const msg = buildUserMessage(batches[0]);
  assert.equal((msg.match(/First passage\./g) || []).length, 1);
});

test('entries are numbered within their batch', async () => {
  const { buildBatches } = await core();
  const targets = Array.from({ length: 3 }, (_, i) => ({ id: `q${i}`, kind: 'CR', stem: 's', choices: [] }));
  assert.deepEqual(buildBatches(targets)[0].entries.map(e => e.number), [1, 2, 3]);
});

test('an estimate outside 1-99 is refused', async () => {
  const { parseRatings } = await core();
  const { ratings, errors } = parseRatings(
    { ratings: [{ number: 1, pctCorrect: 120, reason: 'x' }, { number: 2, pctCorrect: 70, reason: 'y' }] },
    [1, 2]);
  assert.equal(ratings.size, 1);
  assert.ok(ratings.has(2));
  assert.ok(errors.some(e => /out of range/.test(e)));
});

test('a rating for a number that was not asked for is refused', async () => {
  const { parseRatings } = await core();
  const { ratings, errors } = parseRatings({ ratings: [{ number: 9, pctCorrect: 70, reason: '' }] }, [1]);
  assert.equal(ratings.size, 0);
  assert.ok(errors.some(e => /unexpected number/.test(e)));
});

test('applyRatings stores the estimate but not a label', async () => {
  // A tertile cannot be known from one batch, so labelling waits for the pass.
  const { collectTargets, buildBatches, applyRatings } = await core();
  const p = pool();
  const batch = buildBatches(collectTargets(p, {})).find(b => b.kind === 'CR');
  const { applied } = applyRatings(batch, new Map([[1, { pctCorrect: 64, reason: 'tempting trap' }]]), 'm');
  assert.equal(applied, 1);
  const q = p.books[0].sections[0].questions[0];
  assert.equal(q.difficulty_pct, 64);
  assert.equal(q.difficulty_source, 'llm');
  assert.equal(q.difficulty, undefined);
});

test('tertile cuts split the estimates into thirds, hardest first', async () => {
  const { bucketByTertile, labelForPct } = await core();
  const cuts = bucketByTertile([60, 65, 70, 75, 78, 80, 82, 85, 90]);
  assert.equal(labelForPct(60, cuts), 'Hard');
  assert.equal(labelForPct(78, cuts), 'Medium');
  assert.equal(labelForPct(90, cuts), 'Easy');
});

test('relabelPool cuts CR and RC separately', async () => {
  const { relabelPool } = await core();
  const p = { books: [{ code: 'X', sections: [
    { kind: 'CR', questions: [10, 20, 30, 40, 50, 60].map((v, i) => (
      { id: `X-CR-${i}`, usable: true, difficulty_pct: v })) },
    { kind: 'RC', questions: [70, 75, 80, 85, 90, 95].map((v, i) => (
      { id: `X-RC-${i}`, usable: true, difficulty_pct: v })) },
  ] }] };
  const { labelled, cuts } = relabelPool(p);
  assert.equal(labelled, 12);
  assert.notEqual(cuts.CR.hardMax, cuts.RC.hardMax, 'each subject gets its own scale');
  // The hardest CR (10) and the hardest RC (70) are both Hard despite the gap.
  assert.equal(p.books[0].sections[0].questions[0].difficulty, 'Hard');
  assert.equal(p.books[0].sections[1].questions[0].difficulty, 'Hard');
});

test('a label with no estimate behind it is cleared, not kept', async () => {
  // An earlier scheme left two questions labelled with nothing to re-derive
  // from; keeping them would make a failed batch look rated.
  const { relabelPool } = await core();
  const p = { books: [{ code: 'X', sections: [{ kind: 'CR', questions: [
    { id: 'X-CR-1', usable: true, difficulty_pct: 50 },
    { id: 'X-CR-2', usable: true, difficulty_pct: 60 },
    { id: 'X-CR-3', usable: true, difficulty_pct: 70 },
    { id: 'X-CR-4', usable: true, difficulty: 'Easy', difficulty_model: 'old-model' },
  ] }] }] };
  const { cleared } = relabelPool(p);
  assert.equal(cleared, 1);
  const stale = p.books[0].sections[0].questions[3];
  assert.equal(stale.difficulty, undefined);
  assert.equal(stale.difficulty_model, undefined);
});

test('an unrated question gets no label', async () => {
  const { relabelPool } = await core();
  const p = { books: [{ code: 'X', sections: [{ kind: 'CR', questions: [
    { id: 'X-CR-1', usable: true, difficulty_pct: 50 },
    { id: 'X-CR-2', usable: true, difficulty_pct: 60 },
    { id: 'X-CR-3', usable: true, difficulty_pct: 70 },
    { id: 'X-CR-4', usable: true },
  ] }] }] };
  relabelPool(p);
  assert.equal(p.books[0].sections[0].questions[3].difficulty, undefined);
});

test('the prompt frames these as GMAT questions and gives a centre of scale', async () => {
  const { OG_SYSTEM_PROMPT } = await core();
  assert.match(OG_SYSTEM_PROMPT, /GMAT/);
  assert.doesNotMatch(OG_SYSTEM_PROMPT, /LSAT/);
  assert.match(OG_SYSTEM_PROMPT, /65%/, 'an anchor for where the scale centres');
});
