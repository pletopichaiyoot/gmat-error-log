'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { buildOgPool, buildOgLibrary } = require('../../src/og-data.js');

// A miniature pool in the real file's shape: CR and RC, one unusable question
// that must never reach the pool, and a passage shared by two RC questions.
const choices = 'ABCDE'.split('').map((l) => ({ label: l, text: `option ${l}` }));
const DATA = {
  books: [
    {
      code: 'OG12',
      title: 'The Official Guide for GMAT Review, 12th Edition',
      sections: [
        {
          kind: 'CR',
          passages: [],
          questions: [
            { id: 'OG12-CR-1', number: 1, stem: 'cr one', choices, correct: 'A', typeLabel: 'Argument Construction', difficulty: 'Easy', usable: true },
            { id: 'OG12-CR-2', number: 2, stem: 'cr two', choices, correct: 'B', typeLabel: null, difficulty: 'Hard', usable: true },
            { id: 'OG12-CR-3', number: 3, stem: 'cr three', choices, correct: null, usable: false, unusable: 'no-key' },
          ],
        },
        {
          kind: 'RC',
          passages: [{ id: 'OG12-RC-p358', page: 358, text: 'passage text', lines: [{ n: 1, marker: null, para: 0, text: 'passage text' }] }],
          questions: [
            { id: 'OG12-RC-1', number: 1, stem: 'rc one', choices, correct: 'C', typeLabel: 'Main idea', difficulty: 'Medium', passageId: 'OG12-RC-p358', usable: true },
            { id: 'OG12-RC-2', number: 2, stem: 'rc two', choices, correct: 'D', typeLabel: 'Inference', difficulty: 'Medium', passageId: 'OG12-RC-p358', usable: true },
          ],
        },
      ],
    },
  ],
};

test('the pool carries only usable questions', () => {
  const pool = buildOgPool(DATA);
  assert.deepStrictEqual(pool.questions.map((q) => q.id), ['OG12-CR-1', 'OG12-CR-2', 'OG12-RC-1', 'OG12-RC-2']);
  assert.strictEqual(pool.byId.has('OG12-CR-3'), false);
});

test('each question carries its book, kind and resolved passage', () => {
  const pool = buildOgPool(DATA);
  const cr = pool.byId.get('OG12-CR-1');
  assert.strictEqual(cr.bookCode, 'OG12');
  assert.strictEqual(cr.kind, 'CR');
  assert.strictEqual(cr.passage, null);
  const rc = pool.byId.get('OG12-RC-1');
  assert.strictEqual(rc.kind, 'RC');
  assert.strictEqual(rc.passage.id, 'OG12-RC-p358');
  assert.strictEqual(rc.passage.text, 'passage text');
});

test('the library reports per-subject facets with counts', () => {
  const lib = buildOgLibrary(buildOgPool(DATA));
  assert.deepStrictEqual(lib.totals, { CR: 2, RC: 2, passages: 1 });
  assert.deepStrictEqual(lib.books, [
    { code: 'OG12', title: 'The Official Guide for GMAT Review, 12th Edition', counts: { CR: 2, RC: 2 } },
  ]);
  assert.deepStrictEqual(lib.typeLabels.RC, [
    { label: 'Inference', count: 1 },
    { label: 'Main idea', count: 1 },
  ]);
});

// Difficulty reads as a scale, not a word list, so it must not sort
// alphabetically into Easy / Hard / Medium.
test('difficulty facets keep their scale order', () => {
  const lib = buildOgLibrary(buildOgPool(DATA));
  assert.deepStrictEqual(lib.difficulties.CR, [
    { label: 'Easy', count: 1 },
    { label: 'Hard', count: 1 },
  ]);
  assert.deepStrictEqual(lib.difficulties.RC, [{ label: 'Medium', count: 2 }]);
});

// 100 of the 368 usable questions carry no type label (the explanation that
// would have supplied it was dropped). They must stay selectable, so the facet
// list exposes them under an explicit bucket rather than hiding them.
test('unlabeled questions get their own facet entry, sorted last', () => {
  const lib = buildOgLibrary(buildOgPool(DATA));
  assert.deepStrictEqual(lib.typeLabels.CR, [
    { label: 'Argument Construction', count: 1 },
    { label: '(unlabeled)', count: 1 },
  ]);
});
