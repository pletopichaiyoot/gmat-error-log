/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { toPg, toTimestamptz } = require('../../src/sql-util');

test('toPg renumbers ? to $1,$2 left-to-right', () => {
  assert.equal(
    toPg('SELECT * FROM t WHERE a = ? AND b = ?'),
    'SELECT * FROM t WHERE a = $1 AND b = $2'
  );
});

test('toPg handles an INSERT placeholder list', () => {
  assert.equal(toPg('INSERT INTO t (a,b,c) VALUES (?, ?, ?)'),
               'INSERT INTO t (a,b,c) VALUES ($1, $2, $3)');
});

test('toPg leaves a no-placeholder query unchanged', () => {
  assert.equal(toPg('SELECT 1'), 'SELECT 1');
});

test('toTimestamptz parses SQLite datetime() UTC format as a Date', () => {
  const d = toTimestamptz('2026-06-13 10:00:00');
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString(), '2026-06-13T10:00:00.000Z');
});

test('toTimestamptz passes through ISO toISOString() format', () => {
  const d = toTimestamptz('2026-06-13T10:00:00.000Z');
  assert.equal(d.toISOString(), '2026-06-13T10:00:00.000Z');
});

test('toTimestamptz maps null/empty to null', () => {
  assert.equal(toTimestamptz(null), null);
  assert.equal(toTimestamptz(''), null);
});
