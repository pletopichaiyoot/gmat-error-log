/* global require */
const { test } = require('node:test');
const assert = require('node:assert');
const { mathmlToText, htmlToReadableText } = require('../../src/scrapers/mathml-text');

const M = 'http://www.w3.org/1998/Math/MathML';
const wrap = (inner) => `<math xmlns="${M}">${inner}</math>`;

test('simple numeric fraction -> a/b', () => {
  assert.equal(mathmlToText(wrap('<mfrac><mn>1</mn><mn>24</mn></mfrac>')), '1/24');
  assert.equal(mathmlToText(wrap('<mfrac><mn>13</mn><mn>56</mn></mfrac>')), '13/56');
});

test('fraction with single-variable parts stays unparenthesized', () => {
  assert.equal(mathmlToText(wrap('<mfrac><mn>1</mn><mi>n</mi></mfrac>')), '1/n');
});

test('compound denominator is parenthesized', () => {
  const ml = wrap('<mfrac><mn>1</mn><mrow><mi>n</mi><mo>&nbsp;</mo><mo>+</mo><mo>&nbsp;</mo><mn>1</mn></mrow></mfrac>');
  assert.equal(mathmlToText(ml), '1/(n + 1)');
});

test('nested compound denominator (real OG choice 1/(n(n+1)))', () => {
  const ml = wrap('<mfrac><mn>1</mn><mrow><mi>n</mi><mo>(</mo><mi>n</mi><mo>&nbsp;</mo><mo>+</mo><mo>&nbsp;</mo><mn>1</mn><mo>)</mo></mrow></mfrac>');
  assert.equal(mathmlToText(ml), '1/(n(n + 1))');
});

test('compound numerator AND denominator (the difference expression)', () => {
  const ml = wrap('<mfrac><mrow><mo>(</mo><mi>n</mi><mo>&nbsp;</mo><mo>+</mo><mo>&nbsp;</mo><mn>1</mn><mo>)</mo><mo>&nbsp;</mo><mo>-</mo><mo>&nbsp;</mo><mi>n</mi></mrow><mrow><mi>n</mi><mo>(</mo><mi>n</mi><mo>&nbsp;</mo><mo>+</mo><mo>&nbsp;</mo><mn>1</mn><mo>)</mo></mrow></mfrac>');
  assert.equal(mathmlToText(ml), '((n + 1) - n)/(n(n + 1))');
});

test('superscript -> base^exp', () => {
  assert.equal(mathmlToText(wrap('<msup><mi>x</mi><mn>2</mn></msup>')), 'x^2');
});

test('subscript -> base_sub', () => {
  assert.equal(mathmlToText(wrap('<msub><mi>a</mi><mn>1</mn></msub>')), 'a_1');
});

test('square root: bare atom vs parenthesized compound', () => {
  assert.equal(mathmlToText(wrap('<msqrt><mn>3</mn></msqrt>')), '√3');
  assert.equal(mathmlToText(wrap('<msqrt><mrow><mi>n</mi><mo>+</mo><mn>1</mn></mrow></msqrt>')), '√(n+1)');
});

test('plain number / variable passthrough', () => {
  assert.equal(mathmlToText(wrap('<mn>5</mn>')), '5');
  assert.equal(mathmlToText(wrap('<mrow><mn>2</mn><mo>&nbsp;</mo><mo>+</mo><mo>&nbsp;</mo><mn>3</mn></mrow>')), '2 + 3');
});

test('entities decoded (minus, times)', () => {
  assert.equal(mathmlToText(wrap('<mrow><mn>5</mn><mo>&#x2212;</mo><mn>2</mn></mrow>')), '5-2');
  assert.equal(mathmlToText(wrap('<mrow><mn>3</mn><mo>&times;</mo><mn>4</mn></mrow>')), '3×4');
});

test('non-math / empty input returns empty string', () => {
  assert.equal(mathmlToText(''), '');
  assert.equal(mathmlToText(null), '');
  assert.equal(mathmlToText(undefined), '');
});

// --- htmlToReadableText (what the scraper actually calls on returned innerHTML) ---

test('htmlToReadableText: choice fragment (letter + math)', () => {
  const html = `<span>A</span><span>)</span> <math xmlns="${M}"><mfrac><mn>1</mn><mn>24</mn></mfrac></math>`;
  assert.equal(htmlToReadableText(html), 'A) 1/24');
});

test('htmlToReadableText: bare math choice', () => {
  const html = `<math xmlns="${M}"><mfrac><mn>1</mn><mn>72</mn></mfrac></math>`;
  assert.equal(htmlToReadableText(html), '1/72');
});

test('htmlToReadableText: stem with inline math and <br>', () => {
  const html = `First the value is <math xmlns="${M}"><mfrac><mn>1</mn><mi>n</mi></mfrac></math><br>then <math xmlns="${M}"><mfrac><mn>1</mn><mrow><mi>n</mi><mo>&nbsp;</mo><mo>+</mo><mo>&nbsp;</mo><mn>1</mn></mrow></mfrac></math>.`;
  assert.equal(htmlToReadableText(html), 'First the value is 1/n\nthen 1/(n + 1).');
});

test('htmlToReadableText: strips tags, decodes entities, no math', () => {
  assert.equal(htmlToReadableText('<p>5 &amp; 6 &lt; 12</p>'), '5 & 6 < 12');
});

test('htmlToReadableText: empty/null', () => {
  assert.equal(htmlToReadableText(''), '');
  assert.equal(htmlToReadableText(null), '');
});
