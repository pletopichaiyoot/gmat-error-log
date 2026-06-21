// test/unit/platform-where.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { _sqlInternals } = require('../../src/db');

test('platformWhereClause separates gmatclub-cat from gmatclub error log', () => {
  const cat = _sqlInternals.platformWhereClause('gmatclub-cat');
  const log = _sqlInternals.platformWhereClause('gmatclub');
  assert.match(cat, /gmat club cat/);
  // The plain gmatclub (Error Log) clause must EXCLUDE the CAT source.
  assert.match(log, /not like '%gmat club cat%'/i);
});
