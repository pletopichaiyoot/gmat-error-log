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
  stemBeforeChoices, DS_CHOICES, buildDiGridAnswers, parseGraphAnswerKey,
  extractChoicesFromBareLines, formatCodeFromForum,
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

// DI (Graphs & Tables) answer grid. Verified 2026-09-21 against two Table
// Analysis topics: `td.official_answer` marks the correct column and
// `input.selectedAnswer` the user's pick, independently — one topic was
// answered right (both on the same cell) and one wrong (on different cells).
const diGrid = {
  headers: ['Contradicts the hypothesis', 'Does not contradict the hypothesis'],
  rows: [
    { label: 'Participant 6', options: [{ isCorrect: true, isUserSelected: false }, { isCorrect: false, isUserSelected: true }] },
    { label: 'Participant 7', options: [{ isCorrect: false, isUserSelected: false }, { isCorrect: true, isUserSelected: true }] },
    { label: 'Participant 9', options: [{ isCorrect: true, isUserSelected: true }, { isCorrect: false, isUserSelected: false }] },
  ],
};

test('buildDiGridAnswers reports both answers as 1-based column indices per row', () => {
  const out = buildDiGridAnswers(diGrid);
  assert.equal(out.correct_answer, '1,2,1');
  assert.equal(out.my_answer, '2,2,1');
});

test('buildDiGridAnswers keeps the per-cell flags the matrix renderer reads', () => {
  const out = buildDiGridAnswers(diGrid);
  assert.deepEqual(out.choices.map((c) => c.label), ['Q1', 'Q2', 'Q3']);
  assert.equal(out.choices[0].text, 'Participant 6');
  assert.equal(out.choices[0].options[0].isCorrect, true);
  assert.equal(out.choices[0].options[1].isUserSelected, true);
  assert.deepEqual(out.choices[0].headers, diGrid.headers);
});

test('buildDiGridAnswers leaves an unanswered grid null rather than "," padding', () => {
  const unanswered = {
    headers: ['Yes', 'No'],
    rows: diGrid.rows.map((r) => ({ label: r.label, options: r.options.map((o) => ({ ...o, isUserSelected: false })) })),
  };
  const out = buildDiGridAnswers(unanswered);
  assert.equal(out.my_answer, null);
  assert.equal(out.correct_answer, '1,2,1');
});

test('buildDiGridAnswers ignores a page with no grid', () => {
  assert.equal(buildDiGridAnswers(null), null);
  assert.equal(buildDiGridAnswers({ headers: ['Yes', 'No'], rows: [] }), null);
});

// Graphics Interpretation. The official answer sits in the DOM from the start,
// hidden by CSS, as ONE line naming every blank: "Dropdown 1: Positive
// Dropdown 2: less than". The labels are the only separator, which is why it
// cannot be split on anything simpler.
const GRAPH_BLANKS = [
  { label: 'Blank 1', text: '', options: [{ text: 'Positive' }, { text: 'Negative' }, { text: 'Zero' }] },
  { label: 'Blank 2', text: '', options: [{ text: 'less than' }, { text: 'greater than' }, { text: 'equal to' }] },
];

test('parseGraphAnswerKey splits the run of blanks on their labels', () => {
  assert.equal(
    parseGraphAnswerKey('Dropdown 1: Positive Dropdown 2: less than', GRAPH_BLANKS),
    'Positive,less than'
  );
});

test('parseGraphAnswerKey spells the key the way the menu does', () => {
  assert.equal(
    parseGraphAnswerKey('Dropdown 1: POSITIVE Dropdown 2: Less Than', GRAPH_BLANKS),
    'Positive,less than'
  );
});

// Better no key than a wrong one: a half-read line would mis-mark an answer.
test('parseGraphAnswerKey refuses a line that does not name every blank', () => {
  assert.equal(parseGraphAnswerKey('Dropdown 1: Positive', GRAPH_BLANKS), null);
  assert.equal(parseGraphAnswerKey('Official Answer B', GRAPH_BLANKS), null);
  assert.equal(parseGraphAnswerKey('', GRAPH_BLANKS), null);
  assert.equal(parseGraphAnswerKey('Dropdown 1: Positive Dropdown 2: less than', []), null);
});

// An option the menu does not carry is kept rather than dropped — the page is
// the authority on its own answer, and a missing key reads as ungradeable.
test('parseGraphAnswerKey keeps an answer that matches no listed option', () => {
  assert.equal(
    parseGraphAnswerKey('Dropdown 1: Sideways Dropdown 2: equal to', GRAPH_BLANKS),
    'Sideways,equal to'
  );
});

// topic322394 types its first label as a CYRILLIC capital А (U+0410), and
// topic352450 separates with a spaced dash. Both stored a stem with the whole
// choice list (and the poster's trailing junk) glued on, and no choices.
test('a choice label typed with a Cyrillic look-alike still parses', () => {
  const text = 'How many sandwiches should be ordered?\n\nА. 12\nB. 16\nC. 20\nD. 24\nE. 48\n\n\nPS84780.02';
  assert.deepEqual(extractChoicesFromLines(text).map((c) => `${c.label}=${c.text}`), ['A=12', 'B=16', 'C=20', 'D=24', 'E=48']);
  assert.equal(stemBeforeChoices(text), 'How many sandwiches should be ordered?');
});

test('a spaced dash after a capital is a choice label', () => {
  const text = 'answered how many questions correctly?\n\nA - 18\nB - 19\nC - 20\nD - 21\nE - 22\n\nSOURCE: GMAT PREP Exam 5 & 6';
  assert.deepEqual(extractChoicesFromLines(text).map((c) => `${c.label}=${c.text}`), ['A=18', 'B=19', 'C=20', 'D=21', 'E=22']);
  assert.equal(stemBeforeChoices(text), 'answered how many questions correctly?');
});

test('a line of algebra opening with a lowercase letter and a dash is not a label', () => {
  const text = 'If\na - b = 4\nb - c = 2\nwhat is a - c?';
  assert.deepEqual(extractChoicesFromLines(text), []);
  assert.equal(stemBeforeChoices(text), 'If a - b = 4 b - c = 2 what is a - c?');
});

// topic194054 and topic462525 print bare labels, one per line: "A 88%".
test('bare capital labels parse when they run A-D or further, one per line', () => {
  const spaced = 'will be even?\n\nA 88%\n\nB 75%\n\nC 67%\n\nD 63%\n\nE 50%';
  const r = extractChoicesFromBareLines(spaced);
  assert.deepEqual(r.choices.map((c) => `${c.label}=${c.text}`), ['A=88%', 'B=75%', 'C=67%', 'D=63%', 'E=50%']);
  assert.equal(r.stem, 'will be even?');
  const tight = 'at the two remaining stores?\n\nA $40\nB $50\nC $55\nD $65\nE $70\n\n\nThis is a Butler question';
  assert.deepEqual(extractChoicesFromBareLines(tight).choices.map((c) => c.text), ['$40', '$50', '$55', '$65', '$70']);
});

test('a stem that itself opens with a bare "A " does not hide the real list', () => {
  const text = 'A wheel is divided into 5 sectors.\nIf it is spun three times, what is the probability?\n\nA 88%\n\nB 75%\n\nC 67%\n\nD 63%\n\nE 50%';
  const r = extractChoicesFromBareLines(text);
  assert.deepEqual(r.choices.map((c) => c.text), ['88%', '75%', '67%', '63%', '50%']);
  assert.equal(r.stem, 'A wheel is divided into 5 sectors. If it is spun three times, what is the probability?');
});

test('prose lines that happen to open with a capital A or B are not a bare-label run', () => {
  assert.equal(extractChoicesFromBareLines('A certain store sells pens.\nB is twice A.\nWhat is B?'), null);
});

// "DS Retired Questions" is GMAT DS filed under GMAT Club's GRE section; the
// page check missed it, so those topics never got the five standard choices.
test('the forum name in the page title decides DS vs PS, retired DS included', () => {
  assert.equal(formatCodeFromForum('DS Retired Questions'), 'DS');
  assert.equal(formatCodeFromForum('GMAT Data Sufficiency (DS)'), 'DS');
  assert.equal(formatCodeFromForum('GMAT Problem Solving (PS)'), 'PS');
  assert.equal(formatCodeFromForum('Critical Reasoning (CR)'), null);
});
