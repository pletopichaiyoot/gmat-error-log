'use strict';
/* global require */
const test = require('node:test');
const assert = require('node:assert');
const { buildAttemptSnapshotIndex, pickAttemptSnapshot } = require('../../src/db.js');

test('snapshot preserves stimulus across a Phase-1 rescrape', () => {
  const existing = [{ q_id: '161326-seq-1', stimulus: '{"kind":"msr","html":"<svg></svg>","dataText":"x"}' }];
  const index = buildAttemptSnapshotIndex(existing);
  const fresh = { q_id: '161326-seq-1', stimulus: null };
  const snap = pickAttemptSnapshot(index, fresh);
  assert.ok(snap, 'snapshot found by q_id');
  assert.strictEqual(snap.stimulus, '{"kind":"msr","html":"<svg></svg>","dataText":"x"}');
  assert.strictEqual(fresh.stimulus || snap.stimulus || null, existing[0].stimulus);
});
