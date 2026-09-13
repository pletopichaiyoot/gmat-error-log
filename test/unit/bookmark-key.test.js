'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { bookmarkKeyForRow } = require('../../src/db.js');

// A bookmark is stored under ONE key but a question carries two ids. q_code is
// preferred because it identifies the question across sessions; q_id is the
// fallback for Phase-1-only rows, which have no q_code until enrichment runs
// (239 of ~5,500 stored attempts).
test('prefers q_code and records which id was used', () => {
  assert.deepStrictEqual(
    bookmarkKeyForRow({ q_code: '425955', q_id: '288115-seq-6' }),
    { key: '425955', kind: 'q_code' }
  );
});

test('falls back to q_id when the row has no q_code yet', () => {
  assert.deepStrictEqual(
    bookmarkKeyForRow({ q_code: '', q_id: '288115-seq-6' }),
    { key: '288115-seq-6', kind: 'q_id' }
  );
  assert.deepStrictEqual(
    bookmarkKeyForRow({ q_id: '288115-seq-6' }),
    { key: '288115-seq-6', kind: 'q_id' }
  );
});

test('trims, and treats whitespace-only ids as absent', () => {
  assert.deepStrictEqual(
    bookmarkKeyForRow({ q_code: '  425955 ', q_id: 'x' }),
    { key: '425955', kind: 'q_code' }
  );
  assert.deepStrictEqual(
    bookmarkKeyForRow({ q_code: '   ', q_id: ' 288115-seq-6 ' }),
    { key: '288115-seq-6', kind: 'q_id' }
  );
});

test('a row with neither id cannot be bookmarked', () => {
  assert.strictEqual(bookmarkKeyForRow({ q_code: '', q_id: '' }), null);
  assert.strictEqual(bookmarkKeyForRow({}), null);
  assert.strictEqual(bookmarkKeyForRow(null), null);
});

// Numeric ids arrive from JSON as numbers often enough to be worth pinning.
test('accepts a numeric q_code', () => {
  assert.deepStrictEqual(bookmarkKeyForRow({ q_code: 425955 }), { key: '425955', kind: 'q_code' });
});
