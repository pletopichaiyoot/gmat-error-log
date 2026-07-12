// test/unit/answer-choices-imghtml.test.js
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { _sqlInternals } = require('../../src/db');
const { sanitizeStemHtml, stemHtmlToText } = require('../../src/scrapers/ope-stem');

const { normalizeAnswerChoicesForStorage } = _sqlInternals;

// A tiny self-contained data: gif (1x1) — stands in for a fraction equation image.
const DATA_IMG = 'data:image/gif;base64,R0lGODdhAQABAPAAAP///wAAACwAAAAAAQABAAACAkQBADs=';

test('normalizeAnswerChoicesForStorage preserves textHtml (image-math choices survive Phase-1 rescrape)', () => {
  const stored = normalizeAnswerChoicesForStorage([
    { label: 'A', text: '[math]', value: '1', color: null, isCorrect: false, isUserSelected: false, textHtml: `<img src="${DATA_IMG}">` },
    { label: 'E', text: '[math]', value: '5', color: 'green', isCorrect: true, isUserSelected: true, textHtml: `<img src="${DATA_IMG}">` },
  ]);
  const parsed = JSON.parse(stored);
  assert.equal(parsed.length, 2);
  // label + text kept, per-choice flags dropped (re-derived from row columns), textHtml kept.
  assert.deepEqual(Object.keys(parsed[0]).sort(), ['label', 'text', 'textHtml']);
  assert.equal(parsed[0].textHtml, `<img src="${DATA_IMG}">`);
  assert.equal(parsed[1].label, 'E');
  assert.ok(parsed[1].textHtml.includes(DATA_IMG));
});

test('normalizeAnswerChoicesForStorage keeps a choice that has ONLY textHtml (no label/text)', () => {
  const stored = normalizeAnswerChoicesForStorage([{ textHtml: `<img src="${DATA_IMG}">` }]);
  const parsed = JSON.parse(stored);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].label, null);
  assert.equal(parsed[0].textHtml, `<img src="${DATA_IMG}">`);
});

test('normalizeAnswerChoicesForStorage drops empty choices and text-only choices carry no textHtml', () => {
  const stored = normalizeAnswerChoicesForStorage([
    { label: 'A', text: 'Plain text choice' },
    { label: '', text: '', textHtml: '' },
  ]);
  const parsed = JSON.parse(stored);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].label, 'A');
  assert.ok(!('textHtml' in parsed[0]));
});

// The scraper's node-side transform is a thin composition of ope-stem helpers.
// Assert the contract it relies on: a data: image choice survives sanitize (image
// kept) and its derived text label is the [math] marker.
test('image-math choice pipeline: sanitize keeps data: image, stemHtmlToText yields [math]', () => {
  const raw = `<span class="ITSMCOptionText"><img src="${DATA_IMG}" alt=""></span>`;
  const safe = sanitizeStemHtml(raw);
  assert.ok(safe.includes(DATA_IMG), 'self-contained equation image is preserved');
  assert.ok(!/alt=/.test(safe), 'chrome attributes stripped, only src kept');
  assert.equal(stemHtmlToText(safe), '[math]');
});

test('image-math choice pipeline: auth-only figure URL becomes [figure], not a dead src', () => {
  const raw = '<span><img src="itdmedia.aspx?data=314&GID=abc.gif"></span>';
  const safe = sanitizeStemHtml(raw);
  assert.ok(!/itdmedia/.test(safe), 'expiring auth URL is not stored as a dead image');
  assert.ok(safe.includes('[figure]'));
});
