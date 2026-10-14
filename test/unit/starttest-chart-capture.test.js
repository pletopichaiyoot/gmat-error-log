/* global require */
const test = require('node:test');
const assert = require('node:assert');
const { imageDataUri } = require('../../src/scrapers/starttest_scraper');

// A GI chart is inlined from bytes the page fetches, so the content type is the
// only thing standing between a real chart and a sign-in page stored as an
// image. Getting this wrong is silent: the row looks enriched and renders a
// broken image, and the screenshot fallback never runs.
test('keeps image bytes, with the charset stripped off the type', () => {
  assert.strictEqual(imageDataUri('image/gif', 'R0lGOD'), 'data:image/gif;base64,R0lGOD');
  assert.strictEqual(imageDataUri('image/png; charset=binary', 'iVBOR'), 'data:image/png;base64,iVBOR');
  assert.strictEqual(imageDataUri('IMAGE/PNG', 'iVBOR'), 'data:image/png;base64,iVBOR');
  assert.strictEqual(imageDataUri('image/svg+xml', 'PHN2Zw'), 'data:image/svg+xml;base64,PHN2Zw');
});

test('rejects a non-image body so the screenshot fallback still runs', () => {
  // What an expired itdmedia URL actually returns: the sign-in page, 200 OK.
  assert.strictEqual(imageDataUri('text/html; charset=utf-8', 'PGh0bWw+'), null);
  assert.strictEqual(imageDataUri('application/json', 'e30='), null);
  assert.strictEqual(imageDataUri(null, 'R0lGOD'), null);
  assert.strictEqual(imageDataUri('', 'R0lGOD'), null);
  assert.strictEqual(imageDataUri('image/png', ''), null);
  assert.strictEqual(imageDataUri('image/png', null), null);
});
