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
      { id: 'OG12-CR-1', stem: 'Stem one.', choices, usable: true },
      { id: 'OG12-CR-2', stem: 'Stem two.', choices, usable: true,
        difficulty: 'Hard', difficulty_source: 'llm' },
      { id: 'OG12-CR-3', stem: 'Mangled.', choices, usable: false },
    ] },
    { kind: 'RC', passages: [{ id: 'OG12-RC-p358', text: 'A passage.' }], questions: [
      { id: 'OG12-RC-1', stem: 'Purpose?', choices, usable: true, passageId: 'OG12-RC-p358' },
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
  const rc = collectTargets(pool(), {}).find(t => t.kind === 'RC');
  assert.equal(rc.passageText, 'A passage.');
});

test('RC batches group by passage and send its text once', async () => {
  const { buildBatches, buildPromptPayload } = await core();
  const targets = [
    { id: 'a', kind: 'RC', passageId: 'p1', passageText: 'First passage.', stem: 's', choices: [] },
    { id: 'b', kind: 'RC', passageId: 'p1', passageText: 'First passage.', stem: 's', choices: [] },
    { id: 'c', kind: 'RC', passageId: 'p2', passageText: 'Second passage.', stem: 's', choices: [] },
  ];
  const batches = buildBatches(targets);
  assert.equal(batches.length, 2);
  const payload = buildPromptPayload(batches[0]);
  assert.match(payload.user, /First passage\./);
  assert.equal((payload.user.match(/First passage\./g) || []).length, 1);
});

test('entries are numbered within their batch for the shared parser', async () => {
  const { buildBatches } = await core();
  const targets = Array.from({ length: 3 }, (_, i) => (
    { id: `q${i}`, kind: 'CR', stem: 's', choices: [] }));
  assert.deepEqual(buildBatches(targets)[0].entries.map(e => e.number), [1, 2, 3]);
});

test('applyLabels writes the label and its source, and reports what it missed', async () => {
  const { collectTargets, buildBatches, applyLabels } = await core();
  const p = pool();
  const batch = buildBatches(collectTargets(p, {})).find(b => b.kind === 'CR');
  const { applied, missing } = applyLabels(batch, new Map([[1, { difficulty: 'Medium' }]]), 'test-model');
  assert.equal(applied, 1);
  assert.deepEqual(missing, []);
  const q = p.books[0].sections[0].questions[0];
  assert.equal(q.difficulty, 'Medium');
  assert.equal(q.difficulty_source, 'llm');
});

test('a label outside the vocabulary is refused', async () => {
  const { collectTargets, buildBatches, applyLabels } = await core();
  const p = pool();
  const batch = buildBatches(collectTargets(p, {})).find(b => b.kind === 'CR');
  const { applied, missing } = applyLabels(batch, new Map([[1, { difficulty: 'Impossible' }]]), 'm');
  assert.equal(applied, 0);
  assert.deepEqual(missing, ['OG12-CR-1']);
  assert.equal(p.books[0].sections[0].questions[0].difficulty, undefined);
});

test('the prompt frames these as GMAT questions, not LSAT ones', async () => {
  const { OG_SYSTEM_PROMPT } = await core();
  assert.match(OG_SYSTEM_PROMPT, /GMAT/);
  assert.doesNotMatch(OG_SYSTEM_PROMPT, /LSAT/);
});
