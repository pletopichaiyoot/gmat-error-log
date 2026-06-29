/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeStemHtml, stemHtmlToText } = require('../../src/scrapers/ope-stem');

const DATA_IMG = 'data:image/gif;base64,R0lGODdhEAAhAPcAAAAA';

test('plain-text stem passes through unchanged (verbal not affected)', () => {
  const raw = '<p>For the executive’s plan to succeed, which of the following must be true?</p>';
  const html = sanitizeStemHtml(raw);
  assert.equal(html, '<p>For the executive’s plan to succeed, which of the following must be true?</p>');
  assert.equal(stemHtmlToText(html), 'For the executive’s plan to succeed, which of the following must be true?');
});

test('keeps inline data: equation image as <img> in html, [math] in text', () => {
  const raw = `Throughout last week, water was leaking at a constant rate of <img src="${DATA_IMG}" onerror="x()" draggable="false">&nbsp;gallon per hour.`;
  const html = sanitizeStemHtml(raw);
  assert.ok(html.includes(`<img src="${DATA_IMG}">`), 'data image kept');
  assert.ok(!/onerror/i.test(html), 'event handler stripped');
  const text = stemHtmlToText(html);
  assert.match(text, /rate of \[math\] gallon per hour\./);
});

test('superscript becomes ^ in text and is preserved as <sup> in html', () => {
  const raw = 'If <i>x</i><sup>2</sup> &gt; <i>y</i><sup>2</sup>, then <img src="' + DATA_IMG + '">';
  const html = sanitizeStemHtml(raw);
  assert.ok(html.includes('<sup>2</sup>'), 'sup preserved in html');
  assert.ok(html.includes('<i>x</i>'), 'italic preserved');
  const text = stemHtmlToText(html);
  assert.equal(text, 'If x^2 > y^2, then [math]');
});

test('multi-char exponent gets parenthesized in text', () => {
  const html = sanitizeStemHtml('<i>x</i><sup>10</sup>');
  assert.equal(stemHtmlToText(html), 'x^(10)');
});

test('strips ACT XML-namespace wrappers but keeps their text', () => {
  const raw = `<x_act_v1p2:materialformatting xmlns:x_act_v1p2="http://www.act.org/schemas/gmac"><x_act_v1p2:materialfont font="Tahoma" size="12"></x_act_v1p2:materialfont></x_act_v1p2:materialformatting><x_act_v1p2:format_flow><x_act_v1p2:format_block skin="gmac"></x_act_v1p2:format_block></x_act_v1p2:format_flow>Which of the following is least?`;
  const html = sanitizeStemHtml(raw);
  assert.ok(!/x_act/i.test(html), 'namespace tags gone');
  assert.equal(stemHtmlToText(html), 'Which of the following is least?');
});

test('auth-only figure image (itdmedia GID) becomes [figure], status icon dropped', () => {
  const fig = '<center><img src="itdmedia.aspx?data=abc&amp;urid=290-224-ENU-ItemPools-Da/GID1263.gif" height="402px"></center>';
  const html = sanitizeStemHtml(fig);
  assert.ok(/\[figure\]/.test(html), 'figure marker present');
  assert.ok(!/<img/i.test(html), 'non-data img not emitted as image');
  // A leftover SVG status icon (should the page-side removal miss it) is dropped.
  const icon = 'X<img alt="" src="itdmedia.aspx?data=zzz&urid=GMAC-TestPrep_IW_ReplacementUI_v1/CATALYST_incorrect_x.svg">Y';
  assert.equal(stemHtmlToText(sanitizeStemHtml(icon)), 'XY');
});

test('null / empty input is safe', () => {
  assert.equal(sanitizeStemHtml(''), '');
  assert.equal(sanitizeStemHtml(null), '');
  assert.equal(stemHtmlToText(''), '');
  assert.equal(stemHtmlToText(undefined), '');
});

test('non-data javascript: image src is dropped (no XSS passthrough)', () => {
  const raw = 'a<img src="javascript:alert(1)">b<img src="https://evil.test/x.png">c';
  const html = sanitizeStemHtml(raw);
  assert.ok(!/javascript:/i.test(html), 'javascript: src dropped');
  assert.ok(!/evil\.test/i.test(html), 'remote http src not kept as image');
});
