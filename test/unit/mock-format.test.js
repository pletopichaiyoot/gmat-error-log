/* global require */
const test = require('node:test');
const assert = require('node:assert');
const { formatMockDate } = require('../../client/src/lib/mockFormat.mjs');

test('formatMockDate renders a scraped ISO timestamp as date-only', () => {
  assert.strictEqual(formatMockDate('2026-08-02T17:00:00.000Z'), 'Aug 2, 2026');
});
test('formatMockDate renders a plain YYYY-MM-DD', () => {
  assert.strictEqual(formatMockDate('2026-08-02'), 'Aug 2, 2026');
});
test('formatMockDate passes through empty/invalid safely', () => {
  assert.strictEqual(formatMockDate(''), '');
  assert.strictEqual(formatMockDate(null), '');
  assert.strictEqual(formatMockDate('garbage'), 'garbage');
});
