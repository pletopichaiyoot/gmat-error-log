// Regression tests for the GMAT Club Phase-2 page scraper's text handling.
//
// The two defects these lock down were found by auditing the scraped error log
// on 2026-08-31 (757 rows):
//   - 29 rows stored math three times over ("20294\frac{20^2}{9^4}") because
//     MathJax v2 renders one expression as a preview span, a CHTML span with an
//     assistive-MathML twin, AND a `math/tex` source script, all of which
//     survived tag-stripping.
//   - 88 rows had the official answer, the promo CTA and the poster's signature
//     appended to the stem. Every one of them was a question with no lettered
//     choices (Data Sufficiency), where nothing cut the stem short.
/* global require */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  latexToText, tidyInline, extractChoicesFromLines, extractChoicesFromInline,
  stemBeforeChoices, DS_CHOICES,
} = require('../../src/scrapers/gmat_club_question_scraper')._internals;

test('latexToText renders a fraction as an inline quotient', () => {
  assert.equal(latexToText('\\frac{20^2}{9^4}'), '(20^2)/(9^4)');
  assert.equal(latexToText('\\dfrac{a+b}{c}'), '(a+b)/(c)');
});

test('latexToText collapses nested fractions', () => {
  assert.equal(latexToText('\\frac{\\frac{1}{2}}{3}'), '((1)/(2))/(3)');
});

test('latexToText handles roots, scripts and symbols', () => {
  assert.equal(latexToText('\\sqrt{x}'), '√(x)');
  assert.equal(latexToText('2^{20}'), '2^(20)');
  assert.equal(latexToText('a_{1}'), 'a_(1)');
  assert.equal(latexToText('3 \\times 4 \\le 20'), '3 × 4 ≤ 20');
});

test('latexToText strips layout-only commands and leftover braces', () => {
  assert.equal(latexToText('\\left( x \\right)'), '( x )');
  assert.equal(latexToText('{abc}'), 'abc');
});

test('latexToText is a no-op on plain expressions', () => {
  assert.equal(latexToText('2(26)^5'), '2(26)^5');
  assert.equal(latexToText(''), '');
  assert.equal(latexToText(null), '');
});

test('tidyInline drops the signature rule GMAT Club prints as a bare text node', () => {
  assert.equal(tidyInline('What is x? _________________ New to the GMAT Club?'),
    'What is x? New to the GMAT Club?');
});

test('stemBeforeChoices cuts at the first choice line', () => {
  const body = 'If x > 0, what is x?\nA. 1\nB. 2\nC. 3\nD. 4\nE. 5';
  assert.equal(stemBeforeChoices(body), 'If x > 0, what is x?');
});

test('stemBeforeChoices keeps the whole body when there are no lettered choices', () => {
  // Data Sufficiency: statements are "(1)"/"(2)", never "A."/"B.". The stem must
  // survive intact — the junk that used to follow it is removed at the DOM level
  // (cleanOpClone), not here.
  const body = 'What is the value of t?\n(1) s + t = 6 + s\n(2) t^3 = 216';
  assert.equal(stemBeforeChoices(body), 'What is the value of t? (1) s + t = 6 + s (2) t^3 = 216');
});

test('extractChoicesFromLines reads A-E and stops at a blank line', () => {
  const body = 'A. 240\nB. 400\nC. 560\nD. 1920\nE. 3360\n\nShowHide Answer Official Answer C';
  const choices = extractChoicesFromLines(body);
  assert.deepEqual(choices.map((c) => c.label), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(choices[4].text, '3360');
});

test('extractChoicesFromLines ignores out-of-sequence letters inside math', () => {
  const body = 'A. x = 1\nC. this is not choice two\nB. x = 2';
  const choices = extractChoicesFromLines(body);
  assert.deepEqual(choices.map((c) => c.label), ['A', 'B']);
  assert.match(choices[0].text, /not choice two/);
});

test('DS_CHOICES is the standard five-option Data Sufficiency set', () => {
  assert.equal(DS_CHOICES.length, 5);
  assert.deepEqual(DS_CHOICES.map((c) => c.label), ['A', 'B', 'C', 'D', 'E']);
  assert.match(DS_CHOICES[3].text, /EACH statement ALONE is sufficient/);
});

test('extractChoicesFromLines accepts lowercase labels and normalizes them', () => {
  // Real page: gmatclub.com/forum/topic316444.html renders "a. One / b. Two / …".
  const body = 'a. One\n\nb. Two\n\nc. Three\n\nd. Four\n\ne. Five';
  const choices = extractChoicesFromLines(body);
  assert.deepEqual(choices.map((c) => c.label), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(choices.map((c) => c.text), ['One', 'Two', 'Three', 'Four', 'Five']);
});

test('stemBeforeChoices cuts at a lowercase first choice too', () => {
  assert.equal(stemBeforeChoices('What is x?\na. One\nb. Two'), 'What is x?');
});

test('tidyInline removes zero-width spaces and soft hyphens', () => {
  assert.equal(tidyInline('Five​­'), 'Five');
});

test('extractChoicesFromInline reads a whole choice list off one line', () => {
  // Real page: .../a-box-contains-11-balls-…-419749.html
  const body = 'A box contains 11 balls. What is the probability? A: 30/121 B: 3/11 C: 1/2 D: 6/11 E: 3/5';
  const got = extractChoicesFromInline(body);
  assert.deepEqual(got.choices.map((c) => c.label), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(got.choices.map((c) => c.text), ['30/121', '3/11', '1/2', '6/11', '3/5']);
  assert.equal(got.stem, 'A box contains 11 balls. What is the probability?');
});

test('extractChoicesFromInline needs three sequential labels from A', () => {
  assert.equal(extractChoicesFromInline('Only two here A. one B. two'), null);
  assert.equal(extractChoicesFromInline('No labels at all in this sentence.'), null);
  // Out of order: only A is kept, so the run is too short.
  assert.equal(extractChoicesFromInline('A. one C. three B. two'), null);
});

test('extractChoicesFromInline rejects a run with an empty choice', () => {
  assert.equal(extractChoicesFromInline('Q? A: 1 B: C: 3'), null);
});
