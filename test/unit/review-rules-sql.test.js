'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { _sqlInternals } = require('../../src/db.js');

// My Process reads review notes from both practice tracks: scraped attempts and
// OG Book Practice. Before 2026-10-10 it read question_attempts only, so a rule
// written on an OG attempt never appeared.
test('the rule rollup reads OG Book Practice notes alongside scraped attempts', () => {
  const { rules, unruled } = _sqlInternals.reviewRuleSourcesSql('');
  assert.match(rules, /FROM question_attempts q/);
  assert.match(rules, /UNION ALL/);
  assert.match(rules, /FROM og_attempts a/);
  // OG rows carry the dashboard's own identity for them, so a sample q_code
  // matches the error-log row it came from.
  assert.match(rules, /'og-' \|\| a\.question_id AS q_code/);
  assert.match(unruled, /FROM og_attempts a/);
});

// A `date` column comes back from pg as local midnight, and rollupRules reads
// it with toISOString(), which in Asia/Bangkok is the previous day — every rule
// showed "Last used: yesterday". Both halves must hand over plain text.
test('both halves return session_date as text, not a date', () => {
  const { rules } = _sqlInternals.reviewRuleSourcesSql('');
  const halves = rules.split('UNION ALL');
  assert.strictEqual(halves.length, 2);
  for (const half of halves) assert.match(half, /::text AS session_date/);
});

// toPg rewrites every literal "?" into a positional parameter, so the SQL must
// not contain one (CLAUDE.md, "Writing SQL on Postgres").
test('the scope clause lands in the GMAT half only, and no literal "?" appears', () => {
  const { rules, unruled } = _sqlInternals.reviewRuleSourcesSql('AND s.excluded = 0');
  const [gmatHalf, ogHalf] = rules.split('UNION ALL');
  assert.match(gmatHalf, /AND s\.excluded = 0/);
  assert.doesNotMatch(ogHalf, /s\.excluded/);
  assert.match(unruled, /AND s\.excluded = 0/);
  assert.doesNotMatch(rules + unruled, /\?/);
});
