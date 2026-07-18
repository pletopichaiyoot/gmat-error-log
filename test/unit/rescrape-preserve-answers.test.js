'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { buildAttemptSnapshotIndex, pickAttemptSnapshot } = require('../../src/db.js');

// Regression: a Phase 1 rescrape (StartTest GetQuestionHistoryPage) emits null
// my_answer / correct_answer / confidence for every row — those letters only
// exist after Phase 2 enrichment. The delete+reinsert path must PRESERVE the
// enriched values from the existing row, exactly like it already preserves
// answer_choices / question_stem / difficulty_theta. Before the fix the snapshot
// omitted these fields, so every Phase 1 rescrape blanked answers on already-
// enriched sessions.

test('snapshot preserves Phase-2 answer letters + confidence across a Phase 1 rescrape', () => {
  // Existing DB rows (already Phase-2 enriched).
  const existing = [
    {
      q_id: '210142-seq-0',
      q_code: '34060',
      cat_id: 12,
      question_stem: 'Is the number of members ...',
      answer_choices: JSON.stringify([{ label: 'A', text: 'x' }, { label: 'C', text: 'y' }]),
      my_answer: 'C',
      correct_answer: 'C',
      confidence: 'high',
    },
  ];
  const index = buildAttemptSnapshotIndex(existing);

  // Incoming fresh Phase 1 record for the same question — no answer letters.
  const fresh = { q_id: '210142-seq-0', q_code: null, my_answer: null, correct_answer: null, confidence: null };
  const snap = pickAttemptSnapshot(index, fresh);

  assert.ok(snap, 'snapshot must be found by q_id');
  assert.strictEqual(snap.my_answer, 'C');
  assert.strictEqual(snap.correct_answer, 'C');
  assert.strictEqual(snap.confidence, 'high');

  // Mirror the insert-time fallback used in saveScrapeResult.
  assert.strictEqual(fresh.my_answer || snap.my_answer || null, 'C');
  assert.strictEqual(fresh.correct_answer || snap.correct_answer || null, 'C');
  assert.strictEqual(fresh.confidence || snap.confidence || null, 'high');
});

test('a fresh scrape that DOES supply answers wins over the preserved snapshot', () => {
  // GMAT Club / TTP Phase 1 supply letters directly — the fallback must not override them.
  const existing = [{ q_id: 'gc-att-1', my_answer: 'A', correct_answer: 'A', confidence: 'low' }];
  const index = buildAttemptSnapshotIndex(existing);
  const fresh = { q_id: 'gc-att-1', my_answer: 'D', correct_answer: 'B', confidence: 'high' };
  const snap = pickAttemptSnapshot(index, fresh);

  assert.strictEqual(fresh.my_answer || snap.my_answer || null, 'D');
  assert.strictEqual(fresh.correct_answer || snap.correct_answer || null, 'B');
  assert.strictEqual(fresh.confidence || snap.confidence || null, 'high');
});
