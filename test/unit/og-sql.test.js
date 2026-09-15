'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { _sqlInternals } = require('../../src/db.js');

// og_sessions stores the builder payload and the resolved id list as JSON text
// (the schema keeps JSON as text throughout this codebase; jsonb is deferred).
// Callers get objects back, and malformed text degrades to null rather than
// throwing a session list out of the dashboard.
test('parses the stored filters and question id list back into values', () => {
  const row = _sqlInternals.parseOgSessionRow({
    id: 3,
    filters: '{"kind":"CR","count":10}',
    question_ids: '["OG12-CR-1","OG12-CR-2"]',
  });
  assert.deepStrictEqual(row.filters, { kind: 'CR', count: 10 });
  assert.deepStrictEqual(row.question_ids, ['OG12-CR-1', 'OG12-CR-2']);
});

test('degrades malformed JSON to null instead of throwing', () => {
  const row = _sqlInternals.parseOgSessionRow({ id: 4, filters: 'not json', question_ids: null });
  assert.strictEqual(row.filters, null);
  assert.strictEqual(row.question_ids, null);
});

test('a null row passes through untouched', () => {
  assert.strictEqual(_sqlInternals.parseOgSessionRow(null), null);
});
