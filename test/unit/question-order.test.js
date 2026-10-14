'use strict';
/* global require */

const test = require('node:test');
const assert = require('node:assert');

const { questionOrderOf } = require('../../src/db.js');

test('StartTest: Phase 2 item number wins', () => {
  assert.strictEqual(questionOrderOf({ q_id: '410537-seq-1', response_details: '{"itemNumber":6}' }), 6);
});

test('StartTest: older RC/MSR rows read the number out of the captured stimulus', () => {
  const stimulus = JSON.stringify({ kind: 'msr', html: '<div class="its-item-td ITSStemSequence">16.&nbsp;&nbsp;</div>' });
  assert.strictEqual(questionOrderOf({ q_id: '410537-seq-8', response_details: '{"itemNumber":null}', stimulus }), 16);
});

test('StartTest: seq alone is not an order', () => {
  assert.strictEqual(questionOrderOf({ q_id: '410537-seq-3', response_details: null }), null);
});

test('OPE: position within the section from the q_id', () => {
  assert.strictEqual(questionOrderOf({ q_id: 'ope-Q187_006513-p12' }), 12);
});
