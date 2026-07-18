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

test('platformWhereClause handles the ai-curated source and excludes it from starttest', () => {
  const ai = _sqlInternals.platformWhereClause('ai-curated');
  const starttest = _sqlInternals.platformWhereClause('starttest');
  assert.match(ai, /like '%ai curated%'/i);
  // starttest is the catch-all and must NOT include AI-curated sessions.
  assert.match(starttest, /not like '%ai curated%'/i);
});

test('platformWhereClause default alias emits s.source; bare alias emits source', () => {
  const withAlias = _sqlInternals.platformWhereClause('gmatclub');
  const bare = _sqlInternals.platformWhereClause('gmatclub', '');
  assert.match(withAlias, /coalesce\(s\.source/i);
  assert.doesNotMatch(bare, /s\.source/i);
  assert.match(bare, /coalesce\(source/i);
});
