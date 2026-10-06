'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { alignStartTestRows } = require('../../src/db.js');

// Regression (session 410537, 2026-09-30): StartTest's q_id is `<sid>-seq-<N>`
// and seq indexes the ANSWERED items. Resuming the session added a CR item that
// sorts first, every later seq moved up one, and the Phase-1 rescrape matched
// stored rows by q_id — so the cocoa CR question inherited the asteroid RC
// question's stimulus, and notes moved the same way.

const stored = [
  { q_id: '410537-seq-0', question_stem: 'The discovery of which of the following would call into question the conclusion', passage_text: 'When asteroids collide, some collisions cause an asteroid to spin faster', notes: 'asteroid note' },
  { q_id: '410537-seq-1', question_stem: 'The primary purpose of the passage is to', passage_text: 'When asteroids collide, some collisions cause an asteroid to spin faster' },
  { q_id: '410537-seq-2', question_stem: 'The primary purpose of the passage is to', passage_text: 'Scientists long believed that', notes: 'scientists note' },
  { q_id: '410537-seq-3', question_stem: 'If x = [math], what is x?' },
];

const phase1 = (seq, preview) => ({ q_id: `410537-seq-${seq}`, q_code: null, question_stem: preview });

test('a resumed session realigns stored rows by preview, not by seq', () => {
  const remap = alignStartTestRows([
    phase1(0, 'Supply shortages and signs of growing demand are driving coc'),
    phase1(1, 'The discovery of which of the following would call into ques'),
    phase1(2, 'The primary purpose of the passage is to'),
    phase1(3, 'The primary purpose of the passage is to'),
    phase1(4, 'If x = ..., what is x?'),
  ], stored);
  assert.strictEqual(remap.get('410537-seq-0'), null, 'the new question inherits nothing');
  assert.strictEqual(remap.get('410537-seq-1'), '410537-seq-0');
  // Identical generic prompts resolve by order.
  assert.strictEqual(remap.get('410537-seq-2'), '410537-seq-1');
  assert.strictEqual(remap.get('410537-seq-3'), '410537-seq-2');
  // Too short to verify, but it sits in a gap of matching size.
  assert.strictEqual(remap.get('410537-seq-4'), '410537-seq-3');
});

test('an unshifted rescrape keeps every row on its own q_id', () => {
  const remap = alignStartTestRows([
    phase1(0, 'The discovery of which of the following would call into ques'),
    phase1(1, 'The primary purpose of the passage is to'),
    phase1(2, 'The primary purpose of the passage is to'),
    phase1(3, 'If x = ..., what is x?'),
  ], stored);
  for (let seq = 0; seq < 4; seq += 1) assert.strictEqual(remap.get(`410537-seq-${seq}`), `410537-seq-${seq}`);
});

test('a preview that contradicts its position is never paired with it', () => {
  const remap = alignStartTestRows([phase1(0, 'Supply shortages and signs of growing demand are driving coc')], [stored[0]]);
  assert.strictEqual(remap.get('410537-seq-0'), null);
});

test('rows with real ids are left to the q_id match', () => {
  assert.strictEqual(alignStartTestRows([{ q_id: 'gc-att-5', question_stem: 'x' }], stored).size, 0);
});
