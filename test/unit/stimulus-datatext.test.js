'use strict';
/* global require */
const test = require('node:test');
const assert = require('node:assert');
const { deriveStimulusDataText } = require('../../src/scrapers/starttest_scraper.js');

test('dataText includes stimulus text (chart labels/table) then sources', () => {
  const out = deriveStimulusDataText('Prompt\nX axis: 10 20 30', [{ title: 'Source 1', text: 'passage a' }]);
  assert.ok(out.includes('X axis: 10 20 30'), 'chart/table text included');
  assert.ok(out.includes('Source 1'), 'source title included');
  assert.ok(out.includes('passage a'), 'source text included');
});
test('handles empty text and no sources', () => {
  assert.strictEqual(deriveStimulusDataText('', []), '');
  assert.strictEqual(deriveStimulusDataText('  ', undefined), '');
});
