// test/unit/stimulus-normalize.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { _sqlInternals } = require('../../src/db');

const { normalizeStimulusForStorage } = _sqlInternals;

test('normalizeStimulusForStorage serializes a populated stimulus object to a JSON string', () => {
  const stimulus = { kind: 'msr', html: '<div>tab</div>', dataText: 'row1\trow2', sources: ['a.png'] };
  const stored = normalizeStimulusForStorage(stimulus);
  assert.equal(typeof stored, 'string');
  assert.deepEqual(JSON.parse(stored), stimulus);
});

test('normalizeStimulusForStorage returns null for null/undefined', () => {
  assert.equal(normalizeStimulusForStorage(null), null);
  assert.equal(normalizeStimulusForStorage(undefined), null);
});

test('normalizeStimulusForStorage returns null for an object with no html/dataText/sources content', () => {
  assert.equal(normalizeStimulusForStorage({ kind: 'msr', html: '', dataText: '', sources: [] }), null);
});

test('normalizeStimulusForStorage passes through a non-empty string, trims it, and nulls a blank one', () => {
  assert.equal(normalizeStimulusForStorage('  {"kind":"msr"}  '), '{"kind":"msr"}');
  assert.equal(normalizeStimulusForStorage('   '), null);
});
