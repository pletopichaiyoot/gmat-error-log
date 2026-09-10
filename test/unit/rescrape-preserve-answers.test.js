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

// Regression: StartTest Phase 1 supplies the Question History "Item Preview" —
// the stem truncated to ~60 chars. Preferring the incoming value overwrote the
// full stem Phase 2 had captured, so every rescrape silently re-truncated every
// enriched stem (369 of 683 enriched DI rows were stubs when this was found).
test('a Phase 1 preview never overwrites the full stem from Phase 2', () => {
  const { pickRicherStem } = require('../../src/db.js');
  const full = 'For each of the following statements about the 5 companies that were examined by the researchers, select Yes if that statement describes an inference.';
  const preview = 'For each of the following statements about the 5 companies t';

  assert.strictEqual(pickRicherStem(preview, full), full);
  // A genuinely fuller stem from a later scrape still wins.
  assert.strictEqual(pickRicherStem(full, preview), full);
  // Nothing stored yet, or nothing incoming — take whatever exists.
  assert.strictEqual(pickRicherStem(preview, null), preview);
  assert.strictEqual(pickRicherStem(null, full), full);
  assert.strictEqual(pickRicherStem(null, null), null);
  assert.strictEqual(pickRicherStem('   ', full), full);
});

// Regression: the snapshot used to run stored answer_choices back through
// normalizeAnswerChoicesForStorage, which sanitizes INCOMING scraper data down
// to {label, text, textHtml}. On a stored row that stripped matrix/dropdown
// `options` + `headers` and every per-choice flag, so a Phase 1 rescrape
// flattened enriched DI questions into a bare list of sub-question texts.
test('snapshot preserves matrix cells and per-choice flags across a Phase 1 rescrape', () => {
  const enriched = JSON.stringify([
    {
      label: 'Q1',
      text: 'Assemble sales teams',
      headers: ['Yes', 'No'],
      options: [
        { cellId: '1-1-1', isCorrect: true, isUserSelected: false },
        { cellId: '1-2-1', isCorrect: false, isUserSelected: true },
      ],
    },
  ]);
  const index = buildAttemptSnapshotIndex([{ q_id: '288115-seq-6', q_code: '35220', answer_choices: enriched }]);
  const snap = pickAttemptSnapshot(index, { q_id: '288115-seq-6', q_code: null, answer_choices: null });

  const kept = JSON.parse(snap.answer_choices);
  assert.deepStrictEqual(kept[0].headers, ['Yes', 'No']);
  assert.strictEqual(kept[0].options.length, 2);
  assert.strictEqual(kept[0].options[0].isCorrect, true);
  assert.strictEqual(kept[0].options[1].isUserSelected, true);
});
